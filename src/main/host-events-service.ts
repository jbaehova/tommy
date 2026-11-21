import { randomBytes } from "node:crypto";
import type { WorkflowTriggerInput, WorkflowWebhookSecret } from "@tommy/contracts/ipc";
import type {
  EventJsonValue,
  EventRoutine,
  EventRoutineOwner,
  EventRoutineRef,
  SaveEventRoutineInput,
} from "@tommy/contracts/ipc-events";
import { isEventJsonValue } from "@tommy/contracts/ipc-events";
import { isDynamicRecord, isString } from "@tommy/contracts/runtime-values";
import {
  WEBHOOK_DELIVERY_BODY_BYTES_LIMIT,
  type WebhookDeliveryStatus,
} from "@tommy/contracts/signal-protocol/messages";
import { WEBHOOK_ROUTES_LIMIT } from "@tommy/contracts/signal-protocol/webhook-route";
import { sourceText } from "@tommy/i18n/source";
import { createTommyLogger, registerSecretValue } from "@tommy/logging";
import { Effect, Semaphore } from "effect";
import { RoutineOperationFailed } from "../backend/agent/routine-scheduler";
import type { WebhookRoutineWriter } from "../backend/agent/webhook-routine-tool";
import { causeHelpers } from "../backend/effect-boundary";
import type { RoutineRecords } from "../backend/routine-records";
import { RoutineInputError } from "../backend/routine-schedule";
import type { OwnedRoutineRecord, RoutineRecordInput, WebhookReceiveResult } from "../backend/routine-store";
import type { WebhookRouteOwner } from "../backend/webhook-route-store";
import { WEBHOOK_EVENT_TYPE_MAX_LENGTH } from "../backend/webhook-trigger";
import type { WorkflowWebhookDelivery, WorkflowWebhookResult } from "../backend/workflows/workflows";
import { HostEventsFailure, hostEventsFailureMessage } from "./host-events-api";
import type { SecretCipher } from "./provider-credential-store";
import { isStandardWebhookSecret, verifyStandardWebhookSignature, verifyWebhookSignature } from "./webhook-security";

const logger = createTommyLogger("host-events");

export interface HostWebhookRelay {
  /** False only when this host has explicitly disabled public routes. */
  configured(): boolean;
  registerRoute(routeId: string): Effect.Effect<string, { readonly cause: unknown }>;
}

/** The webhook triggers of workflows: they share the routes, the relay and the route limit. */
interface HostWorkflowWebhooks {
  receive(delivery: WorkflowWebhookDelivery): Effect.Effect<WorkflowWebhookResult, { readonly cause: unknown }>;
  /** The workflow whose webhook address changed. */
  changed(workflowId: string): void;
}

export interface HostEventsServiceOptions {
  /** Only the public owner-neutral operations cross into this service. */
  routines: Pick<RoutineRecords, keyof RoutineRecords>;
  workflows?: HostWorkflowWebhooks;
  cipher: SecretCipher;
  relay: HostWebhookRelay;
}

const { sync: eventStep, rewrap: toHostEventsFailure } = causeHelpers(HostEventsFailure);

function eventFailure(message: string): HostEventsFailure {
  return new HostEventsFailure({ cause: new Error(message) });
}

function eventRoutine(owner: EventRoutineOwner, record: OwnedRoutineRecord): EventRoutine {
  const { ownerId: _ownerId, trigger, ...fields } = record;
  return {
    ...fields,
    owner,
    trigger:
      trigger.kind === "schedule"
        ? { kind: "schedule", schedule: trigger.schedule }
        : { kind: "webhook", url: trigger.url, eventType: trigger.eventType, filters: trigger.filters },
  };
}

/** A random signing secret. The prefix makes a leaked value easy to recognize and to scan for. */
function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

type ReceivedDelivery = WebhookReceiveResult<unknown> | WorkflowWebhookResult | { kind: "unavailable" };

function deliveryStatus(result: ReceivedDelivery) {
  switch (result.kind) {
    case "started":
    case "ignored":
      return 202;
    case "duplicate":
      return 200;
    case "gone":
      return 404;
    case "too-large":
      return 413;
    case "unavailable":
      return 503;
  }
}

interface DecodedWebhookBody {
  type: string;
  occurredAt: string | null;
  data: EventJsonValue;
}

function decodeWebhookBody(body: Uint8Array, standard = false): DecodedWebhookBody | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
  if (!isDynamicRecord(value) || !isString(value.type)) return null;
  if (value.type.length < 1 || value.type.length > WEBHOOK_EVENT_TYPE_MAX_LENGTH) return null;
  if (value.occurredAt !== undefined && (!isString(value.occurredAt) || Number.isNaN(Date.parse(value.occurredAt))))
    return null;
  // Standard Webhooks carries the sender's complete event. Tommy's released envelope keeps `data`.
  const data = standard ? value : (value.data ?? null);
  if (!isEventJsonValue(data)) return null;
  return { type: value.type, occurredAt: value.occurredAt ?? null, data };
}

/**
 * Owns webhook routines on this host: the trigger settings, the host-made signing secret, the relay
 * routes and authenticated receipts. A secret leaves the host only once, in
 * the result of the save or rotation that made it.
 */
export interface WebhookIngressDelivery {
  routeId: string;
  deliveryId: string;
  timestamp: string;
  signature: string;
  body: Uint8Array;
  /** Absent for the released Tommy envelope and signature. */
  format?: "standard";
}

export class HostEventsService {
  readonly #options: HostEventsServiceOptions;
  /** Serializes routine writes, so the route limit check and the write are one step. */
  readonly #writes = Semaphore.makeUnsafe(1);
  /** Serialize route reconciliation to avoid stale URL writes. */
  readonly #sync = Semaphore.makeUnsafe(1);

  constructor(options: HostEventsServiceOptions) {
    this.#options = options;
  }

  readonly saveRoutine = Effect.fn("HostEvents.saveRoutine")(function* (
    this: HostEventsService,
    input: SaveEventRoutineInput,
  ) {
    const { saved, secret } = yield* this.#saveRecord(input);
    // The relay sync runs after the write lock is released, so a slow relay does not block writes.
    yield* this.syncRoutes({ all: false });
    // The sync can add the URL. A save that the relay did not confirm keeps a null URL.
    const current = yield* eventStep(() => this.#options.routines.get(input.owner, saved.id) ?? saved);
    return { routine: eventRoutine(input.owner, current), secret };
  }).bind(this);

  /** Deletes the routine. The routine change event starts the sync that revokes its route. */
  readonly deleteRoutine = Effect.fn("HostEvents.deleteRoutine")(
    function* (this: HostEventsService, input: EventRoutineRef) {
      yield* toHostEventsFailure(this.#options.routines.delete(input.owner, input.id));
    },
    (operation) => this.#writes.withPermit(operation),
  ).bind(this);

  /** Uses the sender's Standard Webhooks key. It remains encrypted in the existing route record. */
  readonly setRoutineSenderSecret = Effect.fn("HostEvents.setRoutineSenderSecret")(
    function* (this: HostEventsService, input: EventRoutineRef & { secret: string }) {
      if (!isStandardWebhookSecret(input.secret))
        return yield* eventFailure(sourceText("error.backend.webhookSettingsInvalid"));
      const routine = yield* this.#requireRoutine(input);
      if (routine.trigger.kind !== "webhook")
        return yield* eventFailure(sourceText("error.backend.webhookSettingsInvalid"));
      const encrypted = yield* this.#encrypt(input.secret);
      yield* eventStep(() => this.#options.routines.routes.rotateSecret(input.owner, input.id, encrypted));
    },
    (operation) => this.#writes.withPermit(operation),
  ).bind(this);

  readonly setWorkflowSenderSecret = Effect.fn("HostEvents.setWorkflowSenderSecret")(
    function* (this: HostEventsService, input: WorkflowTriggerInput & { secret: string }) {
      if (!isStandardWebhookSecret(input.secret))
        return yield* eventFailure(sourceText("error.backend.webhookSettingsInvalid"));
      const routes = this.#options.routines.routes;
      const known = yield* eventStep(() => routes.hasWorkflowRoute(input.workflowId, input.nodeId));
      if (!known && (yield* eventStep(() => routes.list())).length >= WEBHOOK_ROUTES_LIMIT)
        return yield* eventFailure(sourceText("error.backend.webhookRouteLimit", { limit: WEBHOOK_ROUTES_LIMIT }));
      const encrypted = yield* this.#encrypt(input.secret);
      const written = yield* eventStep(() => routes.rotateWorkflowSecret(input.workflowId, input.nodeId, encrypted));
      if (!written) return yield* eventFailure(sourceText("error.workflow.webhookMissing"));
      yield* this.syncRoutes({ all: false });
      this.#options.workflows?.changed(input.workflowId);
    },
    (operation) => this.#writes.withPermit(operation),
  ).bind(this);

  readonly rotateSecret = Effect.fn("HostEvents.rotateSecret")(
    function* (this: HostEventsService, input: EventRoutineRef) {
      const routine = yield* this.#requireRoutine(input);
      if (routine.trigger.kind !== "webhook")
        return yield* eventFailure(sourceText("error.backend.webhookSettingsInvalid"));
      const secret = newWebhookSecret();
      const secretCiphertext = yield* this.#encrypt(secret);
      yield* eventStep(() => this.#options.routines.routes.rotateSecret(input.owner, input.id, secretCiphertext));
      return { secret };
    },
    (operation) => this.#writes.withPermit(operation),
  ).bind(this);

  /**
   * Gives a webhook trigger of a workflow a new signing secret. The first secret makes its route, so
   * the route limit counts it then. The secret leaves the host only in this result.
   */
  readonly rotateWorkflowSecret = Effect.fn("HostEvents.rotateWorkflowSecret")(function* (
    this: HostEventsService,
    input: WorkflowTriggerInput,
  ): Effect.fn.Return<WorkflowWebhookSecret, HostEventsFailure> {
    const secret = yield* this.#writeWorkflowSecret(input);
    // Reconcile after releasing the write lock.
    yield* this.syncRoutes({ all: false });
    this.#options.workflows?.changed(input.workflowId);
    return { secret };
  }).bind(this);

  /** Rebuild public URLs on startup. A removed route is already rejected by the local ingress. */
  readonly syncRoutes = Effect.fn("HostEvents.syncRoutes")(
    function* (this: HostEventsService, options: { all: boolean }) {
      const { relay, routines } = this.#options;
      const routes = routines.routes;
      for (const id of yield* eventStep(() => routes.pendingRevocations())) {
        yield* eventStep(() => routes.clearRevocation(id));
      }
      const current = yield* eventStep(() => routes.list());
      const configured = relay.configured();
      const updatedOwners = new Map<string, WebhookRouteOwner>();
      let failed = false;
      for (const route of current) {
        if (configured && !options.all && route.url !== null) continue;
        let url: string | null = null;
        if (configured) {
          const registered = yield* Effect.result(relay.registerRoute(route.routeId));
          if (registered._tag === "Failure") {
            failed = true;
            continue;
          }
          url = registered.success;
        }
        if (url === route.url) continue;
        yield* eventStep(() => routes.setUrl(route.routeId, url));
        updatedOwners.set(`${route.owner.kind}:${route.owner.id}`, route.owner);
      }
      // Route changes can affect a scheduled workflow or routine.
      for (const owner of updatedOwners.values()) {
        if (owner.kind === "workflow") this.#options.workflows?.changed(owner.id);
        else this.#options.routines.changed(owner);
      }
      if (failed) logger.warn("Some webhook routes are not ready. Local settings were retained.");
      return !failed;
    },
    (operation) =>
      this.#sync.withPermit(operation).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            logger.warn("Webhook routes could not be read. Local settings were retained.");
            return false;
          }),
        ),
      ),
  ).bind(this);

  /**
   * Verify a direct request before sending its event to the stored routine or workflow.
   */
  readonly receive = Effect.fn("HostEvents.receive")(function* (
    this: HostEventsService,
    input: WebhookIngressDelivery,
  ): Effect.fn.Return<{ status: WebhookDeliveryStatus }, HostEventsFailure> {
    if (input.body.byteLength > WEBHOOK_DELIVERY_BODY_BYTES_LIMIT) return { status: 413 };
    const route = yield* eventStep(() => this.#options.routines.routes.find(input.routeId));
    if (!route) return { status: 404 };
    const secret = yield* Effect.result(
      eventStep(() => {
        const value = this.#options.cipher.decrypt(Buffer.from(route.secretCiphertext, "base64"));
        registerSecretValue(value);
        return value;
      }),
    );
    // The sender's request is not at fault, so it can retry when the host can read the secret again.
    if (secret._tag === "Failure") {
      logger.warn("A webhook signing secret could not be decrypted.");
      return { status: 503 };
    }
    const authenticated = yield* Effect.result(
      eventStep(() =>
        input.format === "standard"
          ? verifyStandardWebhookSignature(secret.success, input, input.signature)
          : verifyWebhookSignature(secret.success, input, input.signature),
      ),
    );
    if (authenticated._tag === "Failure") return { status: 401 };
    const body = decodeWebhookBody(input.body, input.format === "standard");
    if (!body) return { status: 400 };
    const receivedAt = new Date().toISOString();
    const event = {
      deliveryId: input.deliveryId,
      eventType: body.type,
      data: body.data,
      occurredAt: body.occurredAt ?? receivedAt,
      receivedAt,
    };
    const { owner } = route;
    const received: ReceivedDelivery =
      owner.kind === "workflow"
        ? yield* this.#receiveWorkflow({ workflowId: owner.id, nodeId: route.routineId, event })
        : yield* toHostEventsFailure(this.#options.routines.receiveWebhook(owner, route.routineId, event));
    return { status: deliveryStatus(received) };
  }).bind(this);

  /** A route of a workflow while this host has no workflows is gone, as a deleted routine is. */
  #receiveWorkflow(delivery: WorkflowWebhookDelivery): Effect.Effect<ReceivedDelivery, HostEventsFailure> {
    const workflows = this.#options.workflows;
    if (!workflows) return Effect.succeed({ kind: "gone" });
    return toHostEventsFailure(workflows.receive(delivery));
  }

  /** Writes the routine under the write lock, so the route limit check and the write are one step. */
  readonly #saveRecord = Effect.fn("HostEvents.saveRecord")(
    function* (this: HostEventsService, input: SaveEventRoutineInput) {
      const { owner, trigger } = input;
      const routines = this.#options.routines;
      yield* this.#requireOwner(owner);
      const existing = input.id ? yield* this.#requireRoutine({ owner, id: input.id }) : null;
      let secret: string | null = null;
      let recordTrigger: RoutineRecordInput["trigger"];
      if (trigger.kind === "schedule") {
        recordTrigger = { kind: "schedule", schedule: trigger.schedule };
      } else {
        let secretCiphertext: string | null = null;
        if (existing?.trigger.kind !== "webhook") {
          if ((yield* eventStep(() => routines.routes.list())).length >= WEBHOOK_ROUTES_LIMIT) {
            return yield* eventFailure(sourceText("error.backend.webhookRouteLimit", { limit: WEBHOOK_ROUTES_LIMIT }));
          }
          secret = newWebhookSecret();
          secretCiphertext = yield* this.#encrypt(secret);
        }
        recordTrigger = { kind: "webhook", eventType: trigger.eventType, filters: trigger.filters, secretCiphertext };
      }
      const saved = yield* eventStep(() =>
        routines.save(owner, input.id, {
          name: input.name,
          instruction: input.instruction,
          active: input.active,
          timezone: input.timezone,
          trigger: recordTrigger,
          ...(input.limitPolicy === undefined ? {} : { limitPolicy: input.limitPolicy }),
          ...(input.missedPolicy === undefined ? {} : { missedPolicy: input.missedPolicy }),
          ...(input.runIn === undefined ? {} : { runIn: input.runIn }),
        }),
      );
      return { saved, secret };
    },
    (operation) => this.#writes.withPermit(operation),
  );

  readonly #writeWorkflowSecret = Effect.fn("HostEvents.writeWorkflowSecret")(
    function* (this: HostEventsService, input: WorkflowTriggerInput) {
      const routes = this.#options.routines.routes;
      const known = yield* eventStep(() => routes.hasWorkflowRoute(input.workflowId, input.nodeId));
      if (!known && (yield* eventStep(() => routes.list())).length >= WEBHOOK_ROUTES_LIMIT)
        return yield* eventFailure(sourceText("error.backend.webhookRouteLimit", { limit: WEBHOOK_ROUTES_LIMIT }));
      const secret = newWebhookSecret();
      const secretCiphertext = yield* this.#encrypt(secret);
      const written = yield* eventStep(() =>
        routes.rotateWorkflowSecret(input.workflowId, input.nodeId, secretCiphertext),
      );
      if (!written) return yield* eventFailure(sourceText("error.workflow.webhookMissing"));
      return secret;
    },
    (operation) => this.#writes.withPermit(operation),
  );

  readonly #requireOwner = Effect.fn("HostEvents.requireOwner")(function* (
    this: HostEventsService,
    owner: EventRoutineOwner,
  ) {
    if (yield* eventStep(() => this.#options.routines.ownerExists(owner))) return;
    return yield* eventFailure(
      sourceText(owner.kind === "agent" ? "error.storage.agentMissing" : "error.backend.channelNotFound"),
    );
  });

  readonly #requireRoutine = Effect.fn("HostEvents.requireRoutine")(function* (
    this: HostEventsService,
    ref: EventRoutineRef,
  ) {
    const routine = yield* eventStep(() => this.#options.routines.get(ref.owner, ref.id));
    if (routine) return routine;
    return yield* eventFailure(sourceText("error.backend.routineGone"));
  });

  readonly #encrypt = Effect.fn("HostEvents.encrypt")(function* (this: HostEventsService, secret: string) {
    return yield* eventStep(() => {
      registerSecretValue(secret);
      return this.#options.cipher.encrypt(secret).toString("base64");
    });
  });
}

/**
 * The webhook routine tools of an agent, through the events service. A new routine's save makes the
 * first secret, and this drops it: the tool result goes to the model provider. The chat card makes
 * a new secret for the user.
 */
export function agentWebhookRoutineWriter(events: HostEventsService): WebhookRoutineWriter {
  const toolFailure = (failure: HostEventsFailure) => {
    // A reason the model can correct, such as the route limit, comes back as a tool failure.
    const message = hostEventsFailureMessage(failure);
    return new RoutineOperationFailed({ cause: message === null ? failure : new RoutineInputError(message) });
  };
  return {
    save: ({ routineId, agentId, eventType, filters, ...routine }) =>
      events
        .saveRoutine({
          ...routine,
          ...(routineId === undefined ? {} : { id: routineId }),
          owner: { kind: "agent", id: agentId },
          trigger: { kind: "webhook", eventType, filters },
        })
        .pipe(
          Effect.map((saved) => saved.routine),
          Effect.mapError(toolFailure),
        ),
    delete: ({ agentId, routineId }) =>
      events.deleteRoutine({ owner: { kind: "agent", id: agentId }, id: routineId }).pipe(Effect.mapError(toolFailure)),
  };
}

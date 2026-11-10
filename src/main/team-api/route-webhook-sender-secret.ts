import {
  WEBHOOK_SENDER_SECRET_CAPABILITY,
  WEBHOOK_SENDER_SECRET_ROUTES,
} from "@tommy/contracts/team-protocol/webhook-sender-secret-v1";
import { sourceText } from "@tommy/i18n/source";
import { registerSecretValue } from "@tommy/logging";
import { parseEventRoutineRef } from "../host-events-inputs";
import { parseWorkflowTrigger } from "../ipc/workflow-inputs";
import { isStandardWebhookSecret } from "../webhook-security";
import type { TeamApiOptions } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";
import { runEventsEffect } from "./route-events";

export async function routeWebhookSenderSecret(
  context: TeamApiRequestContext,
  service: TeamApiOptions["webhookSenderSecrets"],
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (
    method !== "POST" ||
    (url.pathname !== WEBHOOK_SENDER_SECRET_ROUTES.routine && url.pathname !== WEBHOOK_SENDER_SECRET_ROUTES.workflow)
  )
    return "unmatched";
  if (!service || !capabilities.has(WEBHOOK_SENDER_SECRET_CAPABILITY))
    throw new HttpError(400, sourceText("error.backend.eventsUnavailable"));
  requireAdmin(member);
  const body = await readJson(request);
  if (typeof body.secret !== "string" || body.secret.length > 1_024 || !isStandardWebhookSecret(body.secret))
    throw new HttpError(400, sourceText("error.backend.webhookSettingsInvalid"));
  registerSecretValue(body.secret);
  if (url.pathname === WEBHOOK_SENDER_SECRET_ROUTES.routine) {
    const ref = parse(() => parseEventRoutineRef(body));
    await runEventsEffect(service.setRoutineSenderSecret({ ...ref, secret: body.secret }));
  } else {
    const ref = parse(() => parseWorkflowTrigger(body));
    await runEventsEffect(service.setWorkflowSenderSecret({ ...ref, secret: body.secret }));
  }
  return json(200, {});
}
function parse<A>(decode: () => A): A {
  try {
    return decode();
  } catch {
    throw new HttpError(400, sourceText("error.backend.webhookSettingsInvalid"));
  }
}

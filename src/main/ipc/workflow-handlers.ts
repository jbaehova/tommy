import type { WorkflowIntegrationCatalog } from "@tommy/contracts/ipc";
import { parseSetWorkflowSenderSecret } from "@tommy/contracts/ipc-webhook-sender-secret";
import type { TeamCurrentCapability } from "@tommy/contracts/team-protocol/current";
import {
  WEBHOOK_SENDER_SECRET_CAPABILITY,
  WEBHOOK_SENDER_SECRET_ROUTES,
} from "@tommy/contracts/team-protocol/webhook-sender-secret-v1";
import {
  WORKFLOWS_EXTENSIONS_CAPABILITY,
  WORKFLOWS_EXTENSIONS_ROUTES,
} from "@tommy/contracts/team-protocol/workflows-extensions-v1";
import { registerSecretValue } from "@tommy/logging";
import type { WorkflowGitHubApi } from "../../backend/workflows/workflow-github-api";
import { decodeWorkflowIntegrationCatalogFromHost } from "../remote-extension-decoding";
import { isStandardWebhookSecret } from "../webhook-security";
import type { WorkflowConnectors } from "../workflow-connectors";
// Workflows: graphs of steps drawn on a canvas. This computer's host answers from its own runtime,
// and its events service owns webhook secrets. A joined server answers through `workflows-v1`, and
// its GitHub catalog, options, event history and last-event runs through `workflows-github-v1`.

import {
  WORKFLOWS_GITHUB_CAPABILITY,
  WORKFLOWS_GITHUB_ROUTES,
} from "@tommy/contracts/team-protocol/workflows-github-v1";
import { WORKFLOWS_CAPABILITY, WORKFLOWS_ROUTES } from "@tommy/contracts/team-protocol/workflows-v1";
import { sourceText } from "@tommy/i18n/source";
import {
  decodeRemoteWorkflowDetail,
  decodeRemoteWorkflowGitHubCatalog,
  decodeRemoteWorkflowGitHubHistory,
  decodeRemoteWorkflowGitHubOptions,
  decodeRemoteWorkflowList,
  decodeRemoteWorkflowRunDetail,
  decodeRemoteWorkflowRunPage,
  decodeRemoteWorkflowSaveResult,
  decodeRemoteWorkflowSecret,
  decodeRemoteWorkflowStep,
  decodeRemoteWorkflowSummary,
  decodeRemoteWorkflowVersionGraph,
  decodeRemoteWorkflowVersions,
} from "@tommy/team-client/workflow-decoding";
import { Effect } from "effect";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { WorkflowsHandle } from "../../backend/workflows/workflows";
import type { HostEventsService } from "../host-events-service";
import { acceptEmpty, type ResponseDecoder } from "../remote-host-decoding";
import type { RemoteRequestInit } from "../remote-server-client";
import { RemoteWorkflowError } from "../remote-service-effects";
import type { IpcGroupHandlers } from "./define-ipc-group";
import { scopedHandler, scopedQueryHandler } from "./scoped-handler";
import {
  parseCreateWorkflow,
  parseDecideWorkflowStep,
  parseRenameWorkflow,
  parseRetryWorkflowStep,
  parseRunWorkflowStep,
  parseSaveWorkflowGraph,
  parseStartWorkflowRun,
  parseWorkflowGitHubLastEvent,
  parseWorkflowGitHubRepository,
  parseWorkflowId,
  parseWorkflowRunId,
  parseWorkflowRuns,
  parseWorkflowStepId,
  parseWorkflowTrigger,
  parseWorkflowVersion,
} from "./workflow-inputs";

interface WorkflowRemoteServers {
  supportsCapability(serverId: string, capability: TeamCurrentCapability): boolean;
  request<T>(
    serverId: string,
    path: string,
    decoder: ResponseDecoder<T>,
    init?: RemoteRequestInit,
  ): Effect.Effect<T, RemoteWorkflowError>;
}

interface WorkflowIpcDependencies {
  workflows: WorkflowsHandle;
  integrationCatalog: () => WorkflowIntegrationCatalog;
  githubCatalog: WorkflowConnectors["githubCatalog"];
  githubOptions: WorkflowGitHubApi["options"];
  events: Pick<HostEventsService, "rotateWorkflowSecret" | "setWorkflowSenderSecret">;
  /** This computer's GitHub repositories, labels and people for the editor. The user is the owner. */
  remoteServers: WorkflowRemoteServers;
}

export function workflowIpcHandlers({
  workflows,
  integrationCatalog,
  githubCatalog,
  githubOptions,
  events,
  remoteServers,
}: WorkflowIpcDependencies): Pick<IpcGroupHandlers, "workflows"> {
  function remote<T>(serverId: string, path: string, decoder: ResponseDecoder<T>, body: unknown): Promise<T> {
    if (!remoteServers.supportsCapability(serverId, WORKFLOWS_CAPABILITY))
      throw new Error(sourceText("error.workflow.serverTooOld"));
    return runCauseEffect(remoteServers.request(serverId, path, decoder, { method: "POST", body }));
  }
  /** A `workflows-github-v1` route of a joined server, which needs `workflows-v1` too. */
  function remoteGitHub<T>(serverId: string, path: string, decoder: ResponseDecoder<T>, body: unknown): Promise<T> {
    if (!remoteServers.supportsCapability(serverId, WORKFLOWS_GITHUB_CAPABILITY))
      throw new Error(sourceText("error.workflow.serverTooOld"));
    return remote(serverId, path, decoder, body);
  }
  return {
    workflows: {
      setSenderSecret: scopedHandler(parseSetWorkflowSenderSecret, {
        local: (input) => runCauseEffect(events.setWorkflowSenderSecret(input)),
        remote: (input, serverId) => {
          if (!remoteServers.supportsCapability(serverId, WEBHOOK_SENDER_SECRET_CAPABILITY))
            throw new Error(sourceText("error.backend.eventsUnavailable"));
          if (!isStandardWebhookSecret(input.secret))
            throw new Error(sourceText("error.backend.webhookSettingsInvalid"));
          registerSecretValue(input.secret);
          return runCauseEffect(
            remoteServers.request(serverId, WEBHOOK_SENDER_SECRET_ROUTES.workflow, acceptEmpty, {
              method: "POST",
              body: input,
            }),
          );
        },
      }),
      integrationCatalog: scopedQueryHandler({
        local: integrationCatalog,
        remote: (serverId) =>
          remoteServers.supportsCapability(serverId, WORKFLOWS_EXTENSIONS_CAPABILITY)
            ? remote(
                serverId,
                WORKFLOWS_EXTENSIONS_ROUTES.integrationCatalog,
                decodeWorkflowIntegrationCatalogFromHost,
                {},
              )
            : {
                github: remoteServers.supportsCapability(serverId, WORKFLOWS_GITHUB_CAPABILITY),
                places: [],
                slack: [],
                telegram: [],
                discord: [],
              },
      }),
      list: scopedQueryHandler({
        local: () => runCauseEffect(workflows.list()),
        remote: (serverId) => remote(serverId, WORKFLOWS_ROUTES.list, decodeRemoteWorkflowList, {}),
      }),
      get: scopedHandler(parseWorkflowId, {
        local: (id) => runCauseEffect(workflows.get(id)),
        remote: (workflowId, serverId) =>
          remote(serverId, WORKFLOWS_ROUTES.get, decodeRemoteWorkflowDetail, { workflowId }),
      }),
      create: scopedHandler(parseCreateWorkflow, {
        local: (input) => runCauseEffect(workflows.create(input)),
        remote: (input, serverId) => remote(serverId, WORKFLOWS_ROUTES.create, decodeRemoteWorkflowDetail, input),
      }),
      rename: scopedHandler(parseRenameWorkflow, {
        local: (input) => runCauseEffect(workflows.rename(input)),
        remote: (input, serverId) => remote(serverId, WORKFLOWS_ROUTES.rename, decodeRemoteWorkflowSummary, input),
      }),
      delete: scopedHandler(parseWorkflowId, {
        local: (id) => runCauseEffect(workflows.remove(id)),
        remote: (workflowId, serverId) => remote(serverId, WORKFLOWS_ROUTES.delete, acceptEmpty, { workflowId }),
      }),
      saveGraph: scopedHandler(parseSaveWorkflowGraph, {
        local: (input) => runCauseEffect(workflows.saveGraph(input)),
        remote: (input, serverId) =>
          remote(serverId, WORKFLOWS_ROUTES.saveGraph, decodeRemoteWorkflowSaveResult, input),
      }),
      versions: scopedHandler(parseWorkflowId, {
        local: (id) => runCauseEffect(workflows.versions(id)),
        remote: (workflowId, serverId) =>
          remote(serverId, WORKFLOWS_ROUTES.versions, decodeRemoteWorkflowVersions, { workflowId }),
      }),
      versionGraph: scopedHandler(parseWorkflowVersion, {
        local: (input) => runCauseEffect(workflows.versionGraph(input)),
        remote: (input, serverId) =>
          remote(serverId, WORKFLOWS_ROUTES.versionGraph, decodeRemoteWorkflowVersionGraph, input),
      }),
      restoreVersion: scopedHandler(parseWorkflowVersion, {
        local: (input) => runCauseEffect(workflows.restoreVersion(input)),
        remote: (input, serverId) =>
          remote(serverId, WORKFLOWS_ROUTES.restoreVersion, decodeRemoteWorkflowDetail, input),
      }),
      startRun: scopedHandler(parseStartWorkflowRun, {
        local: (input) => runCauseEffect(workflows.startRun(input)),
        remote: (input, serverId) => remote(serverId, WORKFLOWS_ROUTES.startRun, decodeRemoteWorkflowRunDetail, input),
      }),
      runStep: scopedHandler(parseRunWorkflowStep, {
        local: (input) => runCauseEffect(workflows.runStep(input)),
        remote: (input, serverId) => remote(serverId, WORKFLOWS_ROUTES.runStep, decodeRemoteWorkflowStep, input),
      }),
      stopStep: scopedHandler(parseWorkflowStepId, {
        local: (id) => runCauseEffect(workflows.stopStep(id)),
        remote: (stepId, serverId) => remote(serverId, WORKFLOWS_ROUTES.stopStep, acceptEmpty, { stepId }),
      }),
      stopRun: scopedHandler(parseWorkflowRunId, {
        local: (id) => runCauseEffect(workflows.stopRun(id)),
        remote: (runId, serverId) => remote(serverId, WORKFLOWS_ROUTES.stopRun, acceptEmpty, { runId }),
      }),
      retryStep: scopedHandler(parseRetryWorkflowStep, {
        local: (input) => runCauseEffect(workflows.retryStep(input)),
        remote: (input, serverId) => remote(serverId, WORKFLOWS_ROUTES.retryStep, decodeRemoteWorkflowStep, input),
      }),
      decide: scopedHandler(parseDecideWorkflowStep, {
        local: (input) => runCauseEffect(workflows.decide(input)),
        remote: (input, serverId) => remote(serverId, WORKFLOWS_ROUTES.decide, acceptEmpty, input),
      }),
      runs: scopedHandler(parseWorkflowRuns, {
        local: (input) => runCauseEffect(workflows.runs(input)),
        remote: (input, serverId) => remote(serverId, WORKFLOWS_ROUTES.runs, decodeRemoteWorkflowRunPage, input),
      }),
      run: scopedHandler(parseWorkflowRunId, {
        local: (id) => runCauseEffect(workflows.run(id)),
        remote: (runId, serverId) => remote(serverId, WORKFLOWS_ROUTES.run, decodeRemoteWorkflowRunDetail, { runId }),
      }),
      rotateWebhookSecret: scopedHandler(parseWorkflowTrigger, {
        local: (input) => runCauseEffect(events.rotateWorkflowSecret(input)),
        remote: (input, serverId) =>
          remote(serverId, WORKFLOWS_ROUTES.rotateWebhookSecret, decodeRemoteWorkflowSecret, input),
      }),
      githubCatalog: scopedQueryHandler({
        local: () =>
          runCauseEffect(
            githubCatalog().pipe(
              Effect.mapError((failure) => new RemoteWorkflowError({ cause: new Error(failure.message) })),
            ),
          ),
        remote: (serverId) =>
          remoteGitHub(serverId, WORKFLOWS_GITHUB_ROUTES.catalog, decodeRemoteWorkflowGitHubCatalog, {}),
      }),
      githubOptions: scopedHandler(parseWorkflowGitHubRepository, {
        local: (input) =>
          runCauseEffect(
            githubOptions(input.repository).pipe(
              Effect.mapError((failure) => new RemoteWorkflowError({ cause: new Error(failure.message) })),
            ),
          ),
        remote: (input, serverId) =>
          remoteGitHub(serverId, WORKFLOWS_GITHUB_ROUTES.options, decodeRemoteWorkflowGitHubOptions, input),
      }),
      githubHistory: scopedHandler(parseWorkflowId, {
        local: (id) => runCauseEffect(workflows.githubHistory(id)),
        remote: (workflowId, serverId) =>
          remoteGitHub(serverId, WORKFLOWS_GITHUB_ROUTES.history, decodeRemoteWorkflowGitHubHistory, { workflowId }),
      }),
      githubRunLastEvent: scopedHandler(parseWorkflowGitHubLastEvent, {
        local: (input) => runCauseEffect(workflows.githubLastEvent(input)),
        remote: (input, serverId) =>
          remoteGitHub(serverId, WORKFLOWS_GITHUB_ROUTES.runLastEvent, decodeRemoteWorkflowRunDetail, input),
      }),
    },
  };
}

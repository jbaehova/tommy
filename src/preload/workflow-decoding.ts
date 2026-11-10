// What main answers for workflows: the list, one workflow, a save, the version history, runs, and
// the GitHub catalog, options and event history.

import {
  isWorkflowDetail,
  isWorkflowGitHubCatalog,
  isWorkflowGitHubHistory,
  isWorkflowGitHubRepositoryOptions,
  isWorkflowGraph,
  isWorkflowIntegrationCatalog,
  isWorkflowRunDetail,
  isWorkflowRunPage,
  isWorkflowSaveResult,
  isWorkflowStep,
  isWorkflowSummary,
  isWorkflowVersion,
  isWorkflowWebhookSecret,
} from "@tommy/contracts/ipc";
import { guardedDecoder, guardedListDecoder } from "@tommy/contracts/ipc-decoding";

export const decodeWorkflowSummaries = guardedListDecoder(isWorkflowSummary, "workflow list response");
export const decodeWorkflowSummary = guardedDecoder(isWorkflowSummary, "workflow summary response");
export const decodeWorkflowDetail = guardedDecoder(isWorkflowDetail, "workflow response");
export const decodeWorkflowGraph = guardedDecoder(isWorkflowGraph, "workflow version response");
export const decodeWorkflowSaveResult = guardedDecoder(isWorkflowSaveResult, "workflow save response");
export const decodeWorkflowVersions = guardedListDecoder(isWorkflowVersion, "workflow versions response");
export const decodeWorkflowRunDetail = guardedDecoder(isWorkflowRunDetail, "workflow run response");
export const decodeWorkflowRunPage = guardedDecoder(isWorkflowRunPage, "workflow runs response");
export const decodeWorkflowStep = guardedDecoder(isWorkflowStep, "workflow step response");
export const decodeWorkflowWebhookSecret = guardedDecoder(isWorkflowWebhookSecret, "workflow webhook secret response");
export const decodeWorkflowGitHubCatalog = guardedDecoder(isWorkflowGitHubCatalog, "workflow GitHub catalog response");
export const decodeWorkflowGitHubOptions = guardedDecoder(
  isWorkflowGitHubRepositoryOptions,
  "workflow GitHub options response",
);
export const decodeWorkflowGitHubHistory = guardedDecoder(isWorkflowGitHubHistory, "workflow GitHub history response");

export function decodeWorkflowIntegrationCatalogFromMain(value: unknown) {
  if (!isWorkflowIntegrationCatalog(value)) throw new Error("Invalid workflow integration catalog from main.");
  return {
    github: value.github,
    places: value.places.map((place) => ({
      connectionId: place.connectionId,
      placeId: place.placeId,
      label: place.label,
      platform: place.platform,
      connection: place.connection,
      name: place.name,
    })),
    slack: value.slack.map((connection) => ({
      connectionId: connection.connectionId,
      name: connection.name,
      channels: connection.channels.map(({ id, name }) => ({ id, name })),
    })),
    telegram: value.telegram.map(({ connectionId, name }) => ({ connectionId, name })),
    discord: value.discord.map((connection) => ({
      connectionId: connection.connectionId,
      name: connection.name,
      channels: connection.channels.map(({ id, name }) => ({ id, name })),
      roles: connection.roles.map(({ id, name }) => ({ id, name })),
    })),
  };
}

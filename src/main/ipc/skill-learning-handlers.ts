import {
  type HostSkillLearning,
  parseLearnedSkillRevision,
  parseRestoreLearnedSkill,
  parseSaveSkillSuggestion,
  parseSkillLearningPreference,
  type RestoreLearnedSkillInput,
  type RestoreLearnedSkillResult,
  type SaveSkillSuggestionInput,
  type SkillLearningPreference,
} from "@tommy/contracts/ipc-skill-learning";
import type { LocalSkillRevisionInput, MarketplaceSkillDetail } from "@tommy/contracts/ipc-skills";
import type { TeamCurrentCapability } from "@tommy/contracts/team-protocol/current";
import { SKILL_LEARNING_CAPABILITY, SKILL_LEARNING_ROUTES } from "@tommy/contracts/team-protocol/skill-learning-v1";
import { sourceText } from "@tommy/i18n/source";
import type { Effect } from "effect";
import type { SkillLearningFailed } from "../../backend/agent/skill-learning";
import type { AgentLifecycleFailed } from "../../backend/agent-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import {
  decodeLearnedSkillFromHost,
  decodeLearnedSkillsFromHost,
  decodeRestoredLearnedSkillFromHost,
  decodeSavedSkillSuggestionFromHost,
  decodeSkillLearningFromHost,
} from "../remote-extension-decoding";
import type { ResponseDecoder } from "../remote-host-decoding";
import type { RemoteRequestInit } from "../remote-server-client";
import type { RemoteWorkflowError } from "../remote-service-effects";
import type { IpcGroupHandlers } from "./define-ipc-group";
import { scopedHandler, scopedQueryHandler } from "./scoped-handler";

export interface SkillLearningIpcDependencies {
  skillLearning: {
    listLocalSkills(): Effect.Effect<MarketplaceSkillDetail[], SkillLearningFailed>;
    readLocalSkill(input: LocalSkillRevisionInput): Effect.Effect<MarketplaceSkillDetail, SkillLearningFailed>;
    snapshot(): HostSkillLearning;
    set(input: SkillLearningPreference): Effect.Effect<HostSkillLearning, SkillLearningFailed>;
    restore(input: RestoreLearnedSkillInput): Effect.Effect<RestoreLearnedSkillResult, SkillLearningFailed>;
  };
  saveSuggestion(input: SaveSkillSuggestionInput): Effect.Effect<boolean, AgentLifecycleFailed>;
  remoteServers: {
    supportsCapability(serverId: string, capability: TeamCurrentCapability): boolean;
    request<T>(
      serverId: string,
      path: string,
      decoder: ResponseDecoder<T>,
      init?: RemoteRequestInit,
    ): Effect.Effect<T, RemoteWorkflowError>;
  };
}

export function skillLearningIpcHandlers({
  skillLearning,
  saveSuggestion,
  remoteServers,
}: SkillLearningIpcDependencies): Pick<IpcGroupHandlers, "skillLearning"> {
  function remote<T>(
    serverId: string,
    path: string,
    decoder: ResponseDecoder<T>,
    body?: SkillLearningPreference | SaveSkillSuggestionInput | RestoreLearnedSkillInput | LocalSkillRevisionInput,
  ): Promise<T> {
    if (!remoteServers.supportsCapability(serverId, SKILL_LEARNING_CAPABILITY))
      throw new Error(sourceText("error.team.agentSettingsUnsupported"));
    return runCauseEffect(remoteServers.request(serverId, path, decoder, { method: "POST", body: body ?? {} }));
  }
  return {
    skillLearning: {
      listLocal: scopedQueryHandler({
        local: () => runCauseEffect(skillLearning.listLocalSkills()),
        remote: (serverId) => remote(serverId, SKILL_LEARNING_ROUTES.listLocal, decodeLearnedSkillsFromHost),
      }),
      readLocal: scopedHandler(parseLearnedSkillRevision, {
        local: (input) => runCauseEffect(skillLearning.readLocalSkill(input)),
        remote: (input, serverId) =>
          remote(serverId, SKILL_LEARNING_ROUTES.readLocal, decodeLearnedSkillFromHost, input),
      }),
      get: scopedQueryHandler({
        local: () => skillLearning.snapshot(),
        remote: (serverId) => remote(serverId, SKILL_LEARNING_ROUTES.settings, decodeSkillLearningFromHost),
      }),
      set: scopedHandler(parseSkillLearningPreference, {
        local: (input) => runCauseEffect(skillLearning.set(input)),
        remote: (input, serverId) => remote(serverId, SKILL_LEARNING_ROUTES.update, decodeSkillLearningFromHost, input),
      }),
      save: scopedHandler(parseSaveSkillSuggestion, {
        local: async (input) => ({ saved: await runCauseEffect(saveSuggestion(input)) }),
        remote: (input, serverId) =>
          remote(serverId, SKILL_LEARNING_ROUTES.save, decodeSavedSkillSuggestionFromHost, input),
      }),
      restore: scopedHandler(parseRestoreLearnedSkill, {
        local: (input) => runCauseEffect(skillLearning.restore(input)),
        remote: (input, serverId) =>
          remote(serverId, SKILL_LEARNING_ROUTES.restore, decodeRestoredLearnedSkillFromHost, input),
      }),
    },
  };
}

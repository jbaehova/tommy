import type { Effect } from "effect";
import type { RemoteWorkflowError } from "../remote-service-effects";
// Access, auto-approve and skills of one agent, and adding an agent from the marketplace or a
// shared template. On a joined server they belong to the host, so the request goes there, and the
// host answers only an owner or admin.

import {
  type AgentAdminSettings,
  decodeAgentAdminSettings,
  decodeAgentBackupModelSettings,
  decodeAgentBrowserProfile,
  decodeAgentPlanCardSettings,
  decodeAgentTaskLimitSettings,
  decodeBrowserProfileList,
  decodeBrowserProfileSummary,
  decodeHostBrowserTabProfiles,
  decodeInstalledSkills,
  type InstalledSkill,
  parseBrowserProfileId,
  parseBrowserProfileName,
  parseClearBrowserDataInput,
  parseUpdateAgentAdminSettingsInput,
  parseUpdateAgentBackupModelsInput,
  parseUpdateAgentBrowserProfileInput,
  parseUpdateAgentFastModeInput,
  parseUpdateAgentHostSettingsInput,
  parseUpdateAgentNewChatInput,
  parseUpdateAgentPlanCardInput,
  parseUpdateAgentTaskLimitInput,
  parseUpdateBrowserProfileInput,
} from "@tommy/contracts/ipc";
import { AGENT_ADMIN_CAPABILITY, AGENT_ADMIN_ROUTES } from "@tommy/contracts/team-protocol/agent-admin-v1";
import {
  AGENT_BACKUP_MODELS_CAPABILITY,
  AGENT_BACKUP_MODELS_ROUTES,
} from "@tommy/contracts/team-protocol/agent-backup-models-v1";
import { AGENT_FAST_MODE_CAPABILITY, AGENT_FAST_MODE_ROUTES } from "@tommy/contracts/team-protocol/agent-fast-mode-v1";
import {
  AGENT_HOST_SETTINGS_CAPABILITY,
  AGENT_HOST_SETTINGS_ROUTES,
} from "@tommy/contracts/team-protocol/agent-host-settings-v1";
import { AGENT_NEW_CHAT_CAPABILITY, AGENT_NEW_CHAT_ROUTES } from "@tommy/contracts/team-protocol/agent-new-chat-v1";
import { AGENT_PLAN_CARD_CAPABILITY, AGENT_PLAN_CARD_ROUTES } from "@tommy/contracts/team-protocol/agent-plan-card-v1";
import {
  AGENT_TASK_LIMIT_CAPABILITY,
  AGENT_TASK_LIMIT_ROUTES,
} from "@tommy/contracts/team-protocol/agent-task-limit-v1";
import {
  BROWSER_PROFILES_CAPABILITY,
  BROWSER_PROFILES_ROUTES,
} from "@tommy/contracts/team-protocol/browser-profiles-v1";
import type { TeamCurrentCapability } from "@tommy/contracts/team-protocol/current";
import { SKILLS_ADMIN_CAPABILITY, SKILLS_ADMIN_ROUTES } from "@tommy/contracts/team-protocol/skills-admin-v1";
import { sourceText } from "@tommy/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { AgentAdminSettingsService } from "../agent-admin-settings";
import type { AgentHostSettingsService } from "../agent-host-settings";
import type { BrowserProfileService } from "../browser-profile-service";
import {
  decodeAgentHostSettingsFromHost,
  decodeRemoteAgentFastModeSettings,
  decodeRemoteAgentNewChatSettings,
} from "../remote-agent-decoding";
import { acceptEmpty, type ResponseDecoder } from "../remote-host-decoding";
import type { RemoteRequestInit } from "../remote-server-client";
import type { SkillMarketplaceService } from "../skill-marketplace-service";
import { parseInstallSkill, parseSetEnabledSkill, parseUninstallSkill } from "./app-inputs";
import type { IpcGroupHandlers } from "./define-ipc-group";
import { scopedHandler, scopedQueryHandler } from "./scoped-handler";
import { requireString } from "./validation";

interface AgentAdminRemoteServers {
  supportsCapability(serverId: string, capability: TeamCurrentCapability): boolean;
  request<T>(
    serverId: string,
    path: string,
    decoder: ResponseDecoder<T>,
    init?: RemoteRequestInit,
  ): Effect.Effect<T, RemoteWorkflowError>;
}

interface AgentAdminIpcDependencies {
  settings: AgentAdminSettingsService;
  hostSettings: AgentHostSettingsService;
  browserProfiles: BrowserProfileService;
  skills: Pick<SkillMarketplaceService, "listInstalled" | "install" | "uninstall" | "setEnabled">;
  remoteServers: AgentAdminRemoteServers;
}

function decodeRemoteInstalledSkill(value: unknown): InstalledSkill {
  const [skill] = decodeInstalledSkills([value]);
  if (!skill) throw new Error("Invalid installed skill.");
  return skill;
}

export function agentAdminIpcHandlers({
  settings,
  hostSettings,
  browserProfiles,
  skills,
  remoteServers,
}: AgentAdminIpcDependencies): Pick<IpcGroupHandlers, "agentAdmin"> {
  function remote(serverId: string, path: string, body: unknown): Promise<AgentAdminSettings> {
    if (!remoteServers.supportsCapability(serverId, AGENT_ADMIN_CAPABILITY))
      throw new Error(sourceText("error.agent.settingsLocalOnly"));
    return runCauseEffect(remoteServers.request(serverId, path, decodeAgentAdminSettings, { method: "POST", body }));
  }

  function remoteSkills<T>(serverId: string, path: string, body: unknown, decoder: ResponseDecoder<T>): Promise<T> {
    if (!remoteServers.supportsCapability(serverId, SKILLS_ADMIN_CAPABILITY))
      throw new Error(sourceText("error.agent.skillsLocalOnly"));
    return runCauseEffect(remoteServers.request(serverId, path, decoder, { method: "POST", body }));
  }

  return {
    agentAdmin: {
      getAgentHostSettings: scopedHandler((value) => requireString(value, "agentId"), {
        local: (agentId) => hostSettings.read(agentId),
        remote: (agentId, serverId) => remoteHostSettings(serverId, AGENT_HOST_SETTINGS_ROUTES.settings, { agentId }),
      }),
      updateAgentHostSettings: scopedHandler(parseUpdateAgentHostSettingsInput, {
        local: (input) => runCauseEffect(hostSettings.update(input)),
        remote: (input, serverId) => remoteHostSettings(serverId, AGENT_HOST_SETTINGS_ROUTES.update, input),
      }),
      getAgentBackupModels: scopedHandler((value) => requireString(value, "agentId"), {
        local: (agentId) => hostSettings.readBackupModels(agentId),
        remote: (agentId, serverId) => remoteBackupModels(serverId, AGENT_BACKUP_MODELS_ROUTES.settings, { agentId }),
      }),
      updateAgentBackupModels: scopedHandler(parseUpdateAgentBackupModelsInput, {
        local: (input) => runCauseEffect(hostSettings.updateBackupModels(input)),
        remote: (input, serverId) => remoteBackupModels(serverId, AGENT_BACKUP_MODELS_ROUTES.update, input),
      }),
      getAgentTaskLimit: scopedHandler((value) => requireString(value, "agentId"), {
        local: (agentId) => hostSettings.readTaskLimit(agentId),
        remote: (agentId, serverId) => remoteTaskLimit(serverId, AGENT_TASK_LIMIT_ROUTES.settings, { agentId }),
      }),
      updateAgentTaskLimit: scopedHandler(parseUpdateAgentTaskLimitInput, {
        local: (input) => runCauseEffect(hostSettings.updateTaskLimit(input)),
        remote: (input, serverId) => remoteTaskLimit(serverId, AGENT_TASK_LIMIT_ROUTES.update, input),
      }),
      getAgentNewChat: scopedHandler((value) => requireString(value, "agentId"), {
        local: (agentId) => hostSettings.readNewChat(agentId),
        remote: (agentId, serverId) => remoteNewChat(serverId, AGENT_NEW_CHAT_ROUTES.settings, { agentId }),
      }),
      updateAgentNewChat: scopedHandler(parseUpdateAgentNewChatInput, {
        local: (input) => runCauseEffect(hostSettings.updateNewChat(input)),
        remote: (input, serverId) => remoteNewChat(serverId, AGENT_NEW_CHAT_ROUTES.update, input),
      }),
      getAgentPlanCard: scopedHandler((value) => requireString(value, "agentId"), {
        local: (agentId) => hostSettings.readPlanCard(agentId),
        remote: (agentId, serverId) => remotePlanCard(serverId, AGENT_PLAN_CARD_ROUTES.settings, { agentId }),
      }),
      updateAgentPlanCard: scopedHandler(parseUpdateAgentPlanCardInput, {
        local: (input) => runCauseEffect(hostSettings.updatePlanCard(input)),
        remote: (input, serverId) => remotePlanCard(serverId, AGENT_PLAN_CARD_ROUTES.update, input),
      }),
      getAgentFastMode: scopedHandler((value) => requireString(value, "agentId"), {
        local: (agentId) => hostSettings.readFastMode(agentId),
        remote: (agentId, serverId) => remoteFastMode(serverId, AGENT_FAST_MODE_ROUTES.settings, { agentId }),
      }),
      updateAgentFastMode: scopedHandler(parseUpdateAgentFastModeInput, {
        local: (input) => runCauseEffect(hostSettings.updateFastMode(input)),
        remote: (input, serverId) => remoteFastMode(serverId, AGENT_FAST_MODE_ROUTES.update, input),
      }),
      listBrowserProfiles: scopedQueryHandler({
        local: () => browserProfiles.list(),
        remote: (serverId) =>
          remoteBrowserProfiles(serverId, BROWSER_PROFILES_ROUTES.list, {}, decodeBrowserProfileList),
      }),
      createBrowserProfile: scopedHandler(parseBrowserProfileName, {
        local: (name) => runCauseEffect(browserProfiles.create(name)),
        remote: (name, serverId) =>
          remoteBrowserProfiles(serverId, BROWSER_PROFILES_ROUTES.create, { name }, decodeBrowserProfileSummary),
      }),
      updateBrowserProfile: scopedHandler(parseUpdateBrowserProfileInput, {
        local: (input) => runCauseEffect(browserProfiles.update(input)),
        remote: (input, serverId) =>
          remoteBrowserProfiles(serverId, BROWSER_PROFILES_ROUTES.update, input, decodeBrowserProfileSummary),
      }),
      clearBrowserData: scopedHandler(parseClearBrowserDataInput, {
        local: (input) => runCauseEffect(browserProfiles.clear(input)),
        remote: (input, serverId) => remoteBrowserProfiles(serverId, BROWSER_PROFILES_ROUTES.clear, input, acceptEmpty),
      }),
      deleteBrowserProfile: scopedHandler(parseBrowserProfileId, {
        local: (profileId) => runCauseEffect(browserProfiles.delete(profileId)),
        remote: (profileId, serverId) =>
          remoteBrowserProfiles(serverId, BROWSER_PROFILES_ROUTES.delete, { profileId }, acceptEmpty),
      }),
      getAgentBrowserProfile: scopedHandler((value) => requireString(value, "agentId"), {
        local: (agentId) => browserProfiles.readAgent(agentId),
        remote: (agentId, serverId) =>
          remoteBrowserProfiles(serverId, BROWSER_PROFILES_ROUTES.agent, { agentId }, decodeAgentBrowserProfile),
      }),
      updateAgentBrowserProfile: scopedHandler(parseUpdateAgentBrowserProfileInput, {
        local: (input) => runCauseEffect(browserProfiles.updateAgent(input)),
        remote: (input, serverId) =>
          remoteBrowserProfiles(serverId, BROWSER_PROFILES_ROUTES.updateAgent, input, decodeAgentBrowserProfile),
      }),
      listBrowserTabProfiles: scopedQueryHandler({
        local: () => browserProfiles.tabProfiles(),
        // A host without the capability shows no label: its tabs are all in its one shared session.
        remote: (serverId) =>
          remoteServers.supportsCapability(serverId, BROWSER_PROFILES_CAPABILITY)
            ? remoteBrowserProfiles(serverId, BROWSER_PROFILES_ROUTES.tabs, {}, decodeHostBrowserTabProfiles)
            : [],
      }),
      getAgentAdminSettings: scopedHandler((value) => requireString(value, "agentId"), {
        local: (agentId) => settings.read(agentId),
        remote: (agentId, serverId) => remote(serverId, AGENT_ADMIN_ROUTES.settings, { agentId }),
      }),
      updateAgentAdminSettings: scopedHandler(parseUpdateAgentAdminSettingsInput, {
        local: (input) => runCauseEffect(settings.update(input)),
        remote: (input, serverId) => remote(serverId, AGENT_ADMIN_ROUTES.update, input),
      }),
      listAgentSkills: scopedHandler((value) => requireString(value, "agentId"), {
        local: (agentId) => runCauseEffect(skills.listInstalled(agentId)),
        remote: (agentId, serverId) =>
          remoteSkills(serverId, SKILLS_ADMIN_ROUTES.list, { agentId }, decodeInstalledSkills),
      }),
      installAgentSkill: scopedHandler(parseInstallSkill, {
        local: (input) => runCauseEffect(skills.install(input)),
        remote: (input, serverId) =>
          remoteSkills(serverId, SKILLS_ADMIN_ROUTES.install, input, decodeRemoteInstalledSkill),
      }),
      uninstallAgentSkill: scopedHandler(parseUninstallSkill, {
        local: (input) => runCauseEffect(skills.uninstall(input)),
        remote: (input, serverId) => remoteSkills(serverId, SKILLS_ADMIN_ROUTES.uninstall, input, acceptEmpty),
      }),
      setAgentSkillEnabled: scopedHandler(parseSetEnabledSkill, {
        local: (input) => runCauseEffect(skills.setEnabled(input)),
        remote: (input, serverId) =>
          remoteSkills(serverId, SKILLS_ADMIN_ROUTES.setEnabled, input, decodeRemoteInstalledSkill),
      }),
    },
  };

  function remoteHostSettings(serverId: string, path: string, body: unknown) {
    if (!remoteServers.supportsCapability(serverId, AGENT_HOST_SETTINGS_CAPABILITY))
      throw new Error(sourceText("error.team.agentSettingsUnsupported"));
    return runCauseEffect(
      remoteServers.request(serverId, path, decodeAgentHostSettingsFromHost, { method: "POST", body }),
    );
  }

  function remoteBackupModels(serverId: string, path: string, body: unknown) {
    if (!remoteServers.supportsCapability(serverId, AGENT_BACKUP_MODELS_CAPABILITY))
      throw new Error(sourceText("error.team.agentSettingsUnsupported"));
    return runCauseEffect(
      remoteServers.request(serverId, path, decodeAgentBackupModelSettings, { method: "POST", body }),
    );
  }

  // A joined server has no browser profile routes yet.
  function remoteBrowserProfiles<A>(serverId: string, path: string, body: unknown, decode: ResponseDecoder<A>) {
    if (!remoteServers.supportsCapability(serverId, BROWSER_PROFILES_CAPABILITY))
      throw new Error(sourceText("error.team.agentSettingsUnsupported"));
    return runCauseEffect(remoteServers.request(serverId, path, decode, { method: "POST", body }));
  }

  function remoteTaskLimit(serverId: string, path: string, body: unknown) {
    if (!remoteServers.supportsCapability(serverId, AGENT_TASK_LIMIT_CAPABILITY))
      throw new Error(sourceText("error.team.agentSettingsUnsupported"));
    return runCauseEffect(
      remoteServers.request(serverId, path, decodeAgentTaskLimitSettings, { method: "POST", body }),
    );
  }

  function remotePlanCard(serverId: string, path: string, body: unknown) {
    if (!remoteServers.supportsCapability(serverId, AGENT_PLAN_CARD_CAPABILITY))
      throw new Error(sourceText("error.team.agentSettingsUnsupported"));
    return runCauseEffect(remoteServers.request(serverId, path, decodeAgentPlanCardSettings, { method: "POST", body }));
  }

  function remoteNewChat(serverId: string, path: string, body: unknown) {
    if (!remoteServers.supportsCapability(serverId, AGENT_NEW_CHAT_CAPABILITY))
      throw new Error(sourceText("error.team.agentSettingsUnsupported"));
    return runCauseEffect(
      remoteServers.request(serverId, path, decodeRemoteAgentNewChatSettings, { method: "POST", body }),
    );
  }

  function remoteFastMode(serverId: string, path: string, body: unknown) {
    if (!remoteServers.supportsCapability(serverId, AGENT_FAST_MODE_CAPABILITY))
      throw new Error(sourceText("error.team.agentSettingsUnsupported"));
    return runCauseEffect(
      remoteServers.request(serverId, path, decodeRemoteAgentFastModeSettings, { method: "POST", body }),
    );
  }
}

import {
  type BrowserProfileProxySummary,
  browserProfileProxyAddress,
  parseBrowserProfileProxy,
} from "@tommy/contracts/browser-profile-proxy";
import { isBrowserProfileId } from "@tommy/contracts/ipc";
import type { AgentSpeedModels, AgentSpeedSettings } from "@tommy/contracts/ipc-agent-speed";
import { decodeRecord, requiredString } from "@tommy/contracts/ipc-decoding";
import { isDynamicRecord } from "@tommy/contracts/runtime-values";

export function decodeBrowserProfileProxyFromMain(value: unknown): BrowserProfileProxySummary {
  if (
    !isDynamicRecord(value) ||
    !isBrowserProfileId(value.profileId) ||
    typeof value.hasPassword !== "boolean" ||
    "password" in value
  )
    throw new Error("Invalid browser profile proxy from main.");
  if (value.address === null) return { profileId: value.profileId, address: null, hasPassword: value.hasPassword };
  if (typeof value.address !== "string") throw new Error("Invalid browser profile proxy from main.");
  const proxy = parseBrowserProfileProxy(value.address);
  if (!proxy || proxy.password !== null) throw new Error("Invalid browser profile proxy from main.");
  return { profileId: value.profileId, address: browserProfileProxyAddress(proxy), hasPassword: value.hasPassword };
}

export function decodeAgentSpeedSettingsFromMain(value: unknown): AgentSpeedSettings {
  if (
    !isDynamicRecord(value) ||
    (value.fastMode !== null && typeof value.fastMode !== "boolean") ||
    typeof value.ultrafast !== "boolean" ||
    (value.ultrafast && value.fastMode !== true)
  )
    throw new Error("Invalid agent speed settings from main.");
  return { fastMode: value.fastMode, ultrafast: value.ultrafast };
}

export function decodeAgentSpeedModelsFromMain(value: unknown): AgentSpeedModels {
  if (!isDynamicRecord(value) || !Array.isArray(value.models) || value.models.length > 1_000)
    throw new Error("Invalid agent speed models from main.");
  return {
    models: value.models.map((value) => {
      const model = decodeRecord(value, "agent speed model from main");
      const provider = requiredString(model, "provider");
      const id = requiredString(model, "id");
      const fastServiceTier = requiredString(model, "fastServiceTier");
      const ultrafastServiceTier =
        model.ultrafastServiceTier === undefined ? undefined : requiredString(model, "ultrafastServiceTier");
      if (
        !provider ||
        provider.length > 128 ||
        !id ||
        id.length > 160 ||
        !fastServiceTier ||
        fastServiceTier.length > 64 ||
        (ultrafastServiceTier !== undefined && (!ultrafastServiceTier || ultrafastServiceTier.length > 64))
      )
        throw new Error("Invalid agent speed model from main.");
      return { provider, id, fastServiceTier, ...(ultrafastServiceTier === undefined ? {} : { ultrafastServiceTier }) };
    }),
  };
}

/** Shared primitive for the client-side file-save action. It has no remote response boundary. */
export function decodeBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid boolean result from main.");
  return value;
}

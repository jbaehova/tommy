import { basename, dirname } from "node:path";
import type { DynamicRecord } from "@tommy/contracts/runtime-values";
import { getArray, getRecord, getString, isRecord } from "../protocol";

/**
 * Skills that Codex lists in each request but that are about a host Tommy is not: `openai-docs`
 * tells the model that "you" and "this app" mean Codex, the ChatGPT account's `work-pets` skills
 * manage pets of ChatGPT Work mode, and `plugin-management` installs Codex plugins. These instructions do not describe Tommy.
 */
export const CODEX_UNFIT_SKILLS = [
  "openai-docs",
  "plugin-management:plugin-management",
  "work-pets:create-pet",
  "work-pets:pets",
  "work-pets:update-pet",
] as const;

export interface CodexPromptSettings {
  /**
   * `tool_suggest` lists the account's plugins and ChatGPT apps that are not installed and declares
   * `list_available_plugins_to_install` and `request_plugin_install` (about 430 tokens).
   * `recommended_plugins` lists them in the first message. Tommy cannot install a Codex plugin or
   * connect a ChatGPT app, so the agent tells the user about a prompt that never shows.
   * Always off, also when the user's `config.toml` turns them on: no Tommy thread can use them.
   */
  "features.tool_suggest": false;
  "features.recommended_plugins": false;
  /** `[[skills.config]]` entries: Codex selects a skill by `name` or by the `path` of its `SKILL.md`. */
  "skills.config"?: DynamicRecord[];
}

/**
 * The prompt settings of a Tommy thread. The plugin install features are always off. `read` is the
 * `config/read` answer with its layers; null when Codex did not answer, and then Tommy changes only
 * the plugin install features.
 *
 * A thread value for `skills.config` replaces the whole merged list, so the user's entries go first,
 * as they are, and Tommy adds only the skills that no entry names. An entry by `path` names the
 * skill of its folder, as `…/create-pet/SKILL.md` names `work-pets:create-pet`.
 */
export function codexPromptSettings(read: DynamicRecord | null): CodexPromptSettings {
  const settings: CodexPromptSettings = {
    "features.tool_suggest": false,
    "features.recommended_plugins": false,
  };
  if (!read) return settings;
  const own = getArray(getRecord(getRecord(read, "config"), "skills"), "config").filter(isRecord);
  const named = new Set(own.map((entry) => getString(entry, "name")));
  const folders = new Set(
    own.flatMap((entry) => getString(entry, "path") ?? []).map((path) => basename(dirname(path))),
  );
  const added = CODEX_UNFIT_SKILLS.filter(
    (name) => !named.has(name) && !folders.has(name.slice(name.lastIndexOf(":") + 1)),
  ).map((name) => ({ name, enabled: false }));
  if (added.length > 0) settings["skills.config"] = [...own, ...added];
  return settings;
}

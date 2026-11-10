// Frozen optional skill-learning-v1 wire contract.
//
// What it grants, recorded here because freezing it makes it permanent: an owner or admin of a
// server can read and set what that server's background memory reviews do when a chat teaches an
// agent a skill: `automatic` writes and installs the skill, `ask` asks the user in the chat first,
// `off` does neither. The snapshot gives the value and the values the host permits, so a client
// offers only those. The host refuses any other value. A member cannot use these two routes;
// `requireAdmin` on the host is the only gate.
//
// A skill question in a chat (a `skill-suggestion:*` message, see `ipc-skill-learning.ts`) gets
// one more key on the wire: `skillSuggestion` ({ name }), the skill that the question saves or
// changes. The host adds it after the frozen projection, only for a client that advertises this
// capability, in every conversation response, page and event. The frozen codecs leave it out in both
// directions, so a client copies it back from the wire value after it decodes. A value that
// `isConversationSkillSuggestion` refuses stays out, and the client shows the question as text.
//
// A member who can chat with an agent can press Save on a skill question of that agent's chat
// (`save`): the host writes the skill with its background model, with no tools, saves it in its
// library and installs it for the agent, and the skill line comes in the chat. The request names the
// question message only; the host reads the question and the chat itself. `saved: false` means the
// host saved nothing, and the client can keep Save available to retry. A protocol 9
// capability only. Widening any of it needs a second capability string.
// An owner or admin can restore an earlier local revision with `restore`. It needs the revision
// the caller last read and a stable request id. The host publishes the selected content as a new
// revision, installs it for the agent, and retains all existing revisions. Off still permits this
// explicit user action.

import {
  isConversationSkillSuggestion,
  LEARNED_SKILL_READ_LIMITS,
  SKILL_SUGGESTION_ITEM_TYPE_PREFIX,
} from "../ipc-skill-learning";
import { SKILL_CATEGORIES } from "../ipc-skills";
import { isDynamicRecord, isString } from "../runtime-values";
import {
  adminRoute,
  boolean,
  count,
  empty,
  fields,
  identifier,
  list,
  nullable,
  type OptionalRouteCodec,
  oneOf,
  string,
} from "./admin-wire";
import { decodeTeamProtocolV2Json } from "./v2";

export const SKILL_LEARNING_CAPABILITY = "skill-learning-v1";

export const SKILL_LEARNING_ROUTES = {
  settings: "/v1/admin/host/skill-learning",
  update: "/v1/admin/host/skill-learning/update",
  save: "/v1/skill-suggestions/save",
  restore: "/v1/skills/local/restore",
  listLocal: "/v1/skills/local/revisions/list",
  readLocal: "/v1/skills/local/revisions/read",
} as const;

const mode = string(32);
const snapshot = fields({ mode, choices: list(mode, 16) });

const localSkill = fields(
  {
    id: identifier,
    slug: string(128),
    name: string(200),
    description: string(1_024),
    category: oneOf(...SKILL_CATEGORIES),
    creatorName: string(256),
    version: count,
    installs: count,
    featured: boolean,
    iconUrl: nullable(string(LEARNED_SKILL_READ_LIMITS.icon)),
    updatedAt: string(160),
    versionId: string(128),
    bundleSha256: string(64),
    files: list(string(LEARNED_SKILL_READ_LIMITS.fileName), LEARNED_SKILL_READ_LIMITS.files),
    instructions: string(LEARNED_SKILL_READ_LIMITS.instructions),
  },
  { examplePrompt: string(1_000) },
);

export const SKILL_LEARNING_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [SKILL_LEARNING_ROUTES.listLocal, adminRoute(empty, list(localSkill, LEARNED_SKILL_READ_LIMITS.list))],
  [SKILL_LEARNING_ROUTES.readLocal, adminRoute(fields({ skillId: identifier }, { revision: count }), localSkill)],
  [SKILL_LEARNING_ROUTES.settings, adminRoute(empty, snapshot)],
  [SKILL_LEARNING_ROUTES.update, adminRoute(fields({ mode }), snapshot)],
  [
    SKILL_LEARNING_ROUTES.save,
    adminRoute(
      fields({ agentId: identifier, messageId: identifier }, { threadId: identifier }),
      fields({ saved: boolean }),
    ),
  ],
  [
    SKILL_LEARNING_ROUTES.restore,
    adminRoute(
      fields({
        agentId: identifier,
        skillId: identifier,
        revision: count,
        expectedRevision: count,
        requestId: identifier,
      }),
      fields({ action: string(16), skillId: identifier, revision: count, skillName: string(200) }),
    ),
  ],
]);

/** Deeper than any conversation snapshot, page or event of the Team API. */
const MAXIMUM_DEPTH = 12;

/** The message id of a skill question, or undefined for any other value. */
function skillQuestionId(value: unknown): string | undefined {
  if (!isDynamicRecord(value) || !isString(value.id) || !isString(value.itemType)) return undefined;
  return value.itemType.startsWith(SKILL_SUGGESTION_ITEM_TYPE_PREFIX) ? value.id : undefined;
}

function collect(value: unknown, into: Map<string, string>, depth: number): void {
  if (depth > MAXIMUM_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into, depth + 1);
    return;
  }
  if (!isDynamicRecord(value)) return;
  const id = skillQuestionId(value);
  if (id !== undefined && isConversationSkillSuggestion(value.skillSuggestion))
    into.set(id, value.skillSuggestion.name);
  for (const child of Object.values(value)) collect(child, into, depth + 1);
}

function apply(value: unknown, names: ReadonlyMap<string, string>, depth: number): void {
  if (depth > MAXIMUM_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) apply(item, names, depth + 1);
    return;
  }
  if (!isDynamicRecord(value)) return;
  const id = skillQuestionId(value);
  const name = id === undefined ? undefined : names.get(id);
  if (name !== undefined) Object.assign(value, { skillSuggestion: { name } });
  for (const child of Object.values(value)) apply(child, names, depth + 1);
}

/**
 * Sets `skillSuggestion` on each skill question in `target` from the message with the same id in
 * `source`. `target` is a value that its caller owns, such as a fresh encoder or decoder result: it
 * changes in place. A message that `target` does not send stays out.
 */
export function addSkillSuggestionNames(target: unknown, source: unknown): void {
  const names = new Map<string, string>();
  collect(source, names, 0);
  if (names.size > 0) apply(target, names, 0);
}

/**
 * `encoded`, a Team API body or event as JSON text, with the skill names of `source`, the value
 * before the protocol adapter projected it. Text without a skill question comes back unchanged.
 */
export function withSkillSuggestionNames(encoded: string, source: unknown): string {
  const names = new Map<string, string>();
  collect(source, names, 0);
  if (names.size === 0) return encoded;
  const value = decodeTeamProtocolV2Json(JSON.parse(encoded));
  apply(value, names, 0);
  return JSON.stringify(value);
}

import type { AgentProviderId } from "@tommy/contracts/agent-providers";
import type { DynamicRecord } from "@tommy/contracts/runtime-values";
import { sourceText } from "@tommy/i18n/source";
import { z } from "zod";
import { BROWSER_DYNAMIC_TOOLS, TOMMY_BROWSER_NAMESPACE } from "../browser-tools";
import { type DynamicToolCallParams, isRecord } from "../protocol";
import { TOMMY_DYNAMIC_TOOLS, TOMMY_TOOL_DEFINITIONS } from "../tommy-tools";
import { advertisedJsonSchema } from "./advertised-json-schema";
import { toolGuidance } from "./tool-guidance";

/** Discovery changes visibility only. Original definitions and execution owners stay authoritative. */
export const BUILTIN_TOOL_CATALOG = [TOMMY_DYNAMIC_TOOLS, ...BROWSER_DYNAMIC_TOOLS].flatMap((namespace) =>
  namespace.tools.map((tool) => ({
    namespace: namespace.name,
    tool: tool.name,
    name: `${namespace.name}.${tool.name}`,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
);

const DIRECT_NAMES = new Set([
  "ask_user",
  "attach_files_to_response",
  "list_agents",
  "send_message",
  "search_memories",
  "routine_no_update",
  "routine_report_failure",
  "remember",
  "forget_memory",
  "react_to_user_message",
  "request_api_key",
]);

const BROWSER_SCRIPT_TOOL = requireTool(`${TOMMY_BROWSER_NAMESPACE}.run_script`);

/** Pi has no native web search. The other three Tommy providers retain their own search. */
export function providerNeedsWebSearch(provider: AgentProviderId): boolean {
  return provider === "pi";
}

const NATIVE_SEARCH_CATALOG = BUILTIN_TOOL_CATALOG.filter((entry) => entry.name !== "tommy.web_search");
function catalogFor(provider: AgentProviderId) {
  return providerNeedsWebSearch(provider) ? BUILTIN_TOOL_CATALOG : NATIVE_SEARCH_CATALOG;
}

function catalogNames(catalog: typeof BUILTIN_TOOL_CATALOG): string {
  const groups = new Map<string, string[]>();
  for (const entry of catalog) groups.set(entry.namespace, [...(groups.get(entry.namespace) ?? []), entry.tool]);
  return [...groups].map(([namespace, names]) => `${namespace}.{${names.join(", ")}}`).join("; ");
}
const qualifiedName = z.string().trim().min(1).max(160);
const searchQuery = z.string().trim().min(1).max(200);
// Models often send one query string, so search accepts `query` as well as `queries`.
const searchShape = {
  queries: z.array(searchQuery).min(1).max(10).optional(),
  query: searchQuery.optional(),
  limit: z.number().int().min(1).max(10).optional(),
};
// Models often send one name, and a rejected call costs a model step, so describe accepts `name` as well as `names`.
const describeShape = { names: z.array(qualifiedName).min(1).max(10).optional(), name: qualifiedName.optional() };
// Claude's bundled schema converter does not support the current Zod record processor, and Muse
// rejects recursive schemas. Arguments arrive as JSON, and the target tool validates them.
const callShape = { name: qualifiedName, arguments: z.object({}).catchall(z.unknown()) };
const searchSchema = z
  .strictObject(searchShape)
  .refine((input) => input.queries !== undefined || input.query !== undefined);
const describeSchema = z
  .strictObject(describeShape)
  .refine((input) => input.names !== undefined || input.name !== undefined);
const callSchema = z.strictObject(callShape);

function toolDefinitions(catalog: typeof BUILTIN_TOOL_CATALOG) {
  return [
    ...TOMMY_TOOL_DEFINITIONS.filter((tool) => DIRECT_NAMES.has(tool.name)),
    {
      name: "tool_search",
      description: `Find built-in tools by keywords or qualified name. Pass queries (an array) or query (one string). Returns names and short descriptions, default 5, maximum 10. The strongest matches also include inputSchema and guidance, ready for tool_call. Describe other results before first use. Catalog: ${catalogNames(catalog)}`,
      shape: searchShape,
    },
    {
      name: "tool_describe",
      description: "Load schemas and guidance for up to ten qualified tool names. Pass names, or one name.",
      shape: describeShape,
    },
    {
      name: "tool_call",
      description:
        "Call one original built-in tool by its qualified name and JSON arguments. Uses normal permissions and approvals. Cannot call discovery tools.",
      shape: callShape,
    },
  ];
}

function dynamicTools(definitions: ReturnType<typeof toolDefinitions>) {
  return [
    {
      type: "namespace" as const,
      name: "tommy",
      description: "Tommy tools. Search, then call other built-in and browser tools.",
      tools: definitions.map((definition) => ({
        type: "function" as const,
        name: definition.name,
        description: definition.description,
        inputSchema: advertisedJsonSchema(z.strictObject(definition.shape)),
      })),
    },
  ];
}

const ALL_TOOL_DEFINITIONS = toolDefinitions(BUILTIN_TOOL_CATALOG);
const NATIVE_SEARCH_TOOL_DEFINITIONS = toolDefinitions(NATIVE_SEARCH_CATALOG);
const ALL_DYNAMIC_TOOLS = dynamicTools(ALL_TOOL_DEFINITIONS);
const NATIVE_SEARCH_DYNAMIC_TOOLS = dynamicTools(NATIVE_SEARCH_TOOL_DEFINITIONS);

/** Existing native-search adapters keep the same exported entry point. */
export const VISIBLE_TOOL_DEFINITIONS = NATIVE_SEARCH_TOOL_DEFINITIONS;
export const VISIBLE_DYNAMIC_TOOLS = NATIVE_SEARCH_DYNAMIC_TOOLS;

export function visibleToolDefinitions(provider: AgentProviderId) {
  return providerNeedsWebSearch(provider) ? ALL_TOOL_DEFINITIONS : NATIVE_SEARCH_TOOL_DEFINITIONS;
}

export function visibleDynamicTools(provider: AgentProviderId) {
  return providerNeedsWebSearch(provider) ? ALL_DYNAMIC_TOOLS : NATIVE_SEARCH_DYNAMIC_TOOLS;
}

/**
 * Claude names a bridge call `mcp__tommy__tool_call`. Readers of its items get the name of the tool it
 * calls, in the form Claude gives a direct tool. A name outside the catalog is model text and stays out.
 */
export function claudeBridgedToolName(name: string, input: unknown): string {
  if (name !== "mcp__tommy__tool_call" || typeof input !== "object" || input === null || !("name" in input))
    return name;
  const entry = BUILTIN_TOOL_CATALOG.find((tool) => tool.name === input.name);
  return entry ? `mcp__${entry.namespace}__${entry.tool}` : name;
}

/**
 * Search matches whole words, so a query that names a web service, such as "gmail" or "read mail",
 * finds no browser tool. Without this note the agent reports that it has no tool for that service.
 */
const CALL_NOTE = "Run these tools with tool_call {name, arguments}.";

const BROWSER_SEARCH_NOTE =
  "No browser tool is in these results. A website or web app with no dedicated tool, such as mail or a calendar, is reached through tommy_browser. Call tommy_browser.list_tabs first: your signed-in tabs stay open across sessions.";

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Each step to describe a tool sends the full context again, so search includes the schemas of its best matches. */
const READY_SEARCH_RESULTS = 3;

function requireTool(name: string, catalog = BUILTIN_TOOL_CATALOG) {
  const tool = catalog.find((entry) => entry.name === name);
  if (!tool) throw new Error(sourceText("error.agent.toolRequestInvalid"));
  return tool;
}

/**
 * Codex defers the tools of the user's MCP servers, except Computer Use: behind its own
 * `tool_search`, or, for a code-mode-only model, into `ALL_TOOLS` in `exec`.
 */
export const CODEX_DEFERRED_MCP_NOTE =
  "The tools of your MCP servers are not in this catalog. Find them with the separate tool named exactly tool_search. When you have exec instead, read ALL_TOOLS in an exec cell, where MCP tool names start with mcp__, and call the tool on tools.";

const JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);
const PATH_ESCAPES = new Set(["b", "f", "n", "r", "t"]);

function startsUnicodeEscape(text: string, index: number): boolean {
  return text.charAt(index + 1) === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6));
}

/**
 * The end of the word at `start`, up to a space or a quote, and whether it holds an escaped backslash
 * or a backslash that starts no valid escape, as a path such as `C:\Users` does. In such a word, `\n` or
 * `\t` is part of the path, such as `C:\new`.
 */
function pathWord(text: string, start: number): { end: number; path: boolean } {
  let index = start;
  let path = false;
  while (index < text.length && !/[\s"]/.test(text.charAt(index))) {
    if (text.charAt(index) === "\\") {
      const next = text.charAt(index + 1);
      if (next === "\\" || (!JSON_ESCAPES.has(next) && !startsUnicodeEscape(text, index))) path = true;
      index++;
    }
    index++;
  }
  return { end: index, path };
}

/**
 * Inside the strings of JSON text, escapes each control character and each backslash that does not
 * start a valid escape. In a word with such a backslash, it also escapes the backslash of `\b`, `\f`,
 * `\n`, `\r` and `\t`. Models write a Windows path such as `C:\Users` or a line break in `arguments`
 * text without the escape that JSON needs, so the text did not parse (#6243).
 */
function repairJsonText(text: string): string {
  let repaired = "";
  let inString = false;
  let word = { end: 0, path: false };
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    if (char === '"') inString = !inString;
    if (inString && index >= word.end) word = pathWord(text, index);
    if (!inString || char === '"') {
      repaired += char;
    } else if (char === "\\") {
      const next = text.charAt(index + 1);
      const path = word.path && PATH_ESCAPES.has(next);
      if (!path && (JSON_ESCAPES.has(next) || startsUnicodeEscape(text, index))) {
        repaired += char + next;
        index++;
      } else {
        repaired += "\\\\";
      }
    } else {
      const code = char.charCodeAt(0);
      repaired += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : char;
    }
  }
  return repaired;
}

/** The object in `arguments` text, also after a repair, or null when the text holds no object. */
function decodeArgumentsText(text: string): DynamicRecord | null {
  for (const candidate of [text, repairJsonText(text)]) {
    try {
      const value = JSON.parse(candidate);
      return isRecord(value) ? value : null;
    } catch {
      // The repaired text is tried next.
    }
  }
  return null;
}

/** Decodes a `tool_call` envelope. Models send `arguments` as JSON text, so the text is decoded first. */
function parseCall(params: DynamicToolCallParams) {
  const raw = params.arguments;
  const envelope =
    isRecord(raw) && raw.name === undefined && typeof raw.tool === "string"
      ? { name: raw.tool, arguments: raw.arguments }
      : raw;
  if (!isRecord(envelope) || typeof envelope.arguments !== "string") return callSchema.safeParse(envelope);
  return callSchema.safeParse({ ...envelope, arguments: decodeArgumentsText(envelope.arguments) });
}

/**
 * The error for a `tool_call` that `resolveDeferredTool` refused because its `arguments` is not an
 * object, or null for another reason. A general error made the agent send the same text again.
 */
export function deferredCallArgumentsError(params: DynamicToolCallParams): string | null {
  const parsed = parseCall(params);
  const sent = isRecord(params.arguments) && params.arguments.arguments !== undefined;
  return sent && !parsed.success && parsed.error.issues.some(({ path }) => path[0] === "arguments")
    ? sourceText("error.agent.toolCallArgumentsNotObject")
    : null;
}

/** Returns null for an invalid envelope. No supplied values are echoed into errors or logs. */
export function resolveDeferredTool(
  params: DynamicToolCallParams,
  provider: AgentProviderId = "codex",
): DynamicToolCallParams | null {
  const parsed = parseCall(params);
  if (!parsed.success) return null;
  const entry = catalogFor(provider).find((tool) => tool.name === parsed.data.name);
  if (!entry) return null;
  return { ...params, namespace: entry.namespace, tool: entry.tool, arguments: parsed.data.arguments };
}

/** The lowercase queries of a tool search and their words, or `null` for invalid arguments. */
function searchTerms(params: DynamicToolCallParams) {
  const parsed = searchSchema.safeParse(params.arguments);
  if (!parsed.success) return null;
  const queries = [...(parsed.data.queries ?? []), ...(parsed.data.query ? [parsed.data.query] : [])].map((query) =>
    query.toLowerCase(),
  );
  return { queries, terms: new Set(queries.flatMap(words)), limit: parsed.data.limit };
}

/** The names that a tool search names with each of their words, such as an MCP server's name. */
export function namesInSearch(params: DynamicToolCallParams, names: readonly string[]): string[] {
  const search = params.tool === "tool_search" ? searchTerms(params) : null;
  if (!search) return [];
  return names.filter((name) => {
    const nameWords = words(name);
    return nameWords.length > 0 && nameWords.every((word) => search.terms.has(word));
  });
}

function toolGuidanceFor(entries: readonly (typeof BUILTIN_TOOL_CATALOG)[number][]): string[] {
  return [...new Set(entries.flatMap((entry) => toolGuidance(entry.namespace, entry.tool)))];
}

export function discoverTools(params: DynamicToolCallParams, provider: AgentProviderId = "codex") {
  const catalog = catalogFor(provider);
  if (params.tool === "tool_search") {
    const search = searchTerms(params);
    if (!search) throw new Error(sourceText("error.agent.toolRequestInvalid"));
    const { queries, terms } = search;
    if (terms.has("workflow") || terms.has("workflows")) {
      const entries = catalog.filter(
        (entry) =>
          (entry.namespace === "tommy" &&
            (entry.tool.endsWith("_workflow") ||
              entry.tool === "list_workflows" ||
              entry.tool === "read_workflow_runs")) ||
          queries.some((query) => query === entry.name || query === entry.tool),
      );
      return {
        tools: entries.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        guidance: toolGuidanceFor(entries),
        call: CALL_NOTE,
      };
    }
    const matches = catalog
      .map((entry, index) => {
        const nameWords = new Set(words(entry.name));
        const descriptionWords = new Set(words(entry.description));
        const exact = queries.some((query) => query === entry.name || query === entry.tool);
        // A strong result matches each word of its tool name. Namespace words, such as "browser", match a whole
        // namespace, and one shared verb, such as "read", matches many unrelated tools.
        const strong = exact || words(entry.tool).every((word) => terms.has(word));
        const score = [...terms].reduce(
          (sum, term) => sum + (nameWords.has(term) ? 3 : descriptionWords.has(term) ? 1 : 0),
          0,
        );
        return { entry, index, exact, strong, score };
      })
      .filter((result) => result.exact || result.score > 0)
      .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || a.index - b.index);
    const found = matches.slice(0, search.limit ?? 5).map(({ entry, strong }) => ({ entry, strong }));
    const ready = new Set(
      found
        .filter((result) => result.strong)
        .slice(0, READY_SEARCH_RESULTS)
        .map(({ entry }) => entry),
    );
    // Agents search for the single actions that they know, such as click and navigate, and then use
    // one model turn per action. A browser result therefore always brings the multi-step tool.
    if ([...ready].some((entry) => entry.namespace === TOMMY_BROWSER_NAMESPACE)) {
      if (!found.some(({ entry }) => entry === BROWSER_SCRIPT_TOOL))
        found.push({ entry: BROWSER_SCRIPT_TOOL, strong: true });
      ready.add(BROWSER_SCRIPT_TOOL);
    }
    const tools = found.map(({ entry }) =>
      ready.has(entry)
        ? { name: entry.name, description: entry.description, inputSchema: entry.inputSchema }
        : { name: entry.name, description: entry.description.slice(0, 180) },
    );
    const guidance = toolGuidanceFor([...ready]);
    const result = guidance.length > 0 ? { tools, guidance, call: CALL_NOTE } : { tools, call: CALL_NOTE };
    return found.some(({ entry }) => entry.namespace === TOMMY_BROWSER_NAMESPACE)
      ? result
      : { ...result, note: BROWSER_SEARCH_NOTE };
  }
  const parsed = describeSchema.safeParse(params.arguments);
  if (!parsed.success) throw new Error(sourceText("error.agent.toolRequestInvalid"));
  const names = [...(parsed.data.names ?? []), ...(parsed.data.name ? [parsed.data.name] : [])];
  const entries = [...new Set(names)].map((name) => requireTool(name, catalog));
  return {
    call: CALL_NOTE,
    tools: entries.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    guidance: toolGuidanceFor(entries),
  };
}

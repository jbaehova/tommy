import { isDynamicRecord, isString } from "@tommy/contracts/runtime-values";

/**
 * When an agent may work with T3 Code.
 *
 * `tommy t3 link` adds each linked computer as the MCP server row `t3-<name>` (`src/main/t3-code-link.ts`),
 * so every agent gets the tools that T3 Code gives an outside client. The owner decides when Tommy
 * and T3 Code interact: an agent starts, messages, reads, stops or sends files to a T3 Code session
 * only in a turn that a person's own message started, and only when that message asks for it. A
 * routine run or a teammate message never reaches T3 Code. An agent once read "I will use every
 * means to build the Claude connector" as a request to open a session on the owner's Mac.
 *
 * The instructions carry the rule for every provider (`developerInstructions`). Claude also refuses
 * the tools in a turn that no person started, with a PreToolUse hook (`claude-client.ts`).
 */
export const T3_MCP_SERVER_PREFIX = "t3-";

export function isT3McpServerName(name: string): boolean {
  return name.startsWith(T3_MCP_SERVER_PREFIX) && name.length > T3_MCP_SERVER_PREFIX.length;
}

/** Claude names an MCP tool `mcp__<server>__<tool>`. */
const CLAUDE_T3_TOOL = /^mcp__t3-[^_]/u;
/** A shell command that reaches T3 Code without the MCP row: the `t3` CLI or a host wrapper of it. */
const T3_COMMAND = /(?:^|[\s;&|(`'"/])(?:(?:vps-t3|tommy-t3)\b|t3\s+(?:thread|pair|environment|project)\b)/u;

/** Whether this Claude tool call works with T3 Code. */
export function isClaudeT3ToolCall(toolName: string, toolInput: unknown): boolean {
  if (CLAUDE_T3_TOOL.test(toolName)) return true;
  if (toolName !== "Bash" || !isDynamicRecord(toolInput) || !isString(toolInput.command)) return false;
  return T3_COMMAND.test(toolInput.command);
}

export const T3_TURN_REFUSAL =
  "T3 Code is off in this turn: no person's message started it. Work with T3 Code only when the user asks for it in their own message. Tell the user what you would send to T3 Code and let them decide.";

/** The instruction for an agent that has T3 Code tools. */
export function t3Instruction(servers: readonly string[]): string {
  return `The MCP servers ${servers.join(", ")} reach T3 Code. Start, message, read, stop, configure, or send files to a T3 Code session, or use the t3, vps-t3, or tommy-t3 commands, only when the user's own message in this turn asks you to work with T3 Code. A plan, a wish, a goal, a hard task, a routine run, or a teammate message is not that request, and neither is your own idea that T3 Code could help. Otherwise do the work yourself, or offer T3 Code in one sentence and wait.`;
}

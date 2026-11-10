import { redactText } from "@tommy/logging";
import type { AgentTasks } from "../agent-tasks/agent-tasks";
import type { TommyDatabase } from "../tommy-database";

type TaggedThreadState = "working" | "queued" | "done" | "failed" | "stopped" | "idle";

/** A host lookup. A stored tag name cannot authorize a tab or a thread. */
export interface TagReferenceSource {
  tab(tabId: string): { title: string; url: string } | null;
  thread(taskId: string): { title: string; state: TaggedThreadState; detail: string | null } | null;
}

export interface TaggedBrowser {
  shareTab(tabId: string, target: { agentId: string; threadId: string }): void;
  agentTab(tabId: string, agentId: string): { title: string; url: string } | null;
}

interface AgentTagReferenceOptions {
  agentId: string;
  threadId: string | null;
  browser: TaggedBrowser;
  tasks: Pick<AgentTasks, "has" | "require" | "publicTask">;
  database: Pick<TommyDatabase, "readAgentHistory">;
  redact(text: string): string;
}

/**
 * Construct for the authenticated recipient and the public thread that gets the prompt. Call only
 * at delivery, after edits and queue moves. Agent-authored and external text must not grant shares.
 */
export function agentTagReferences(options: AgentTagReferenceOptions): TagReferenceSource {
  const { agentId, threadId, browser, tasks, database, redact } = options;
  return {
    tab: (tabId) => {
      if (!safeTargetId(tabId)) return null;
      const tab = browser.agentTab(tabId, agentId);
      if (!tab) return null;
      if (threadId) browser.shareTab(tabId, { agentId, threadId });
      return { title: redact(tab.title), url: redact(tab.url) };
    },
    thread: (taskId) => {
      if (!safeTargetId(taskId) || !tasks.has(agentId, taskId)) return null;
      const task = tasks.publicTask(tasks.require(agentId, taskId));
      const detail = (text: string | null | undefined) => (text ? redact(text) : null);
      if (task.state === "running") return { title: task.title, state: "working", detail: detail(task.progress) };
      if (task.state === "queued") return { title: task.title, state: "queued", detail: null };
      if (task.outcome === "failed") return { title: task.title, state: "failed", detail: detail(task.error) };
      if (task.outcome === null) return { title: task.title, state: "idle", detail: null };
      const answer = database.readAgentHistory(agentId, task.threadId, { author: "assistant", limit: 1 }).messages[0]
        ?.message.text;
      return {
        title: task.title,
        state: task.outcome === "completed" ? "done" : "stopped",
        detail: detail(answer),
      };
    },
  };
}

/** IDs are tool arguments, not page text. Keep them out of prompt syntax. */
function safeTargetId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/u.test(id);
}

function tagLine(text: string, limit: number): string {
  const line = redactText(text)
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
    .replaceAll('"', "'")
    .trim();
  const characters = Array.from(line);
  return characters.length <= limit
    ? line
    : `${characters
        .slice(0, limit - 1)
        .join("")
        .trimEnd()}…`;
}

/** Credentials, queries and fragments are unnecessary to identify the selected page. */
function tagUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return tagLine(`${url.host.replace(/^www\./iu, "")}${url.pathname.replace(/\/$/u, "")}`, 60);
  } catch {
    return "";
  }
}

/** Provider text. Without a host source, a tag is only the name that the person wrote. */
export function taggedReference(
  reference: { kind: "tab" | "thread"; id: string; name: string },
  source: TagReferenceSource | undefined,
  seen: Set<string>,
): string {
  const storedTitle = `"${tagLine(reference.name, 80)}"`;
  if (!source || !safeTargetId(reference.id)) return storedTitle;
  const key = `${reference.kind}:${reference.id}`;
  const repeat = seen.has(key);
  seen.add(key);
  if (reference.kind === "tab") {
    const tab = source.tab(reference.id);
    const title = `"${tagLine(tab?.title || reference.name, 80)}"`;
    if (!tab) return `${title} (unavailable browser tab)`;
    if (repeat) return title;
    const url = tagUrl(tab.url);
    return `${title} (browser tabId ${reference.id}${url ? `, ${url}` : ""})`;
  }
  const thread = source.thread(reference.id);
  const title = `"${tagLine(thread?.title || reference.name, 80)}"`;
  if (!thread) return `${title} (unavailable thread)`;
  if (repeat) return title;
  const detail = thread.detail ? `: ${tagLine(thread.detail, 300)}` : "";
  return `${title} (thread taskId ${reference.id}, ${thread.state}${detail})`;
}

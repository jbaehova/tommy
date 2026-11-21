import type { BrowserControlSession, BrowserControlState } from "@tommy/contracts/ipc";
import { browserControlAction, browserControlDetailAction, controlSessionId } from "./browser-control";
import type { BrowserToolCall } from "./browser-tools";
import type { DynamicToolCallParams } from "./protocol";

/**
 * Owns the record of which agent turn is controlling the browser: one session per thread and turn,
 * Browser status reports `acting` during the tool call and `waiting` between calls in the same turn.
 */
export class BrowserControlSessions {
  static readonly IDLE_GRACE_MS = 1_200;
  readonly #sessions = new Map<string, BrowserControlSession>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  state(): BrowserControlState {
    return {
      sessions: [...this.#sessions.values()]
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
        .map((session) => ({ ...session })),
    };
  }

  end(threadId: string, turnId: string): void {
    const id = controlSessionId(threadId, turnId);
    const timer = this.#timers.get(id);
    if (timer) clearTimeout(timer);
    this.#timers.delete(id);
    this.#sessions.delete(id);
  }

  clear(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#sessions.clear();
  }

  begin(params: DynamicToolCallParams, call: BrowserToolCall): void {
    const id = controlSessionId(params.threadId, params.turnId);
    const timer = this.#timers.get(id);
    if (timer) clearTimeout(timer);
    this.#timers.delete(id);
    const previous = this.#sessions.get(id);
    const detailAction = browserControlDetailAction(params.tool);
    this.#sessions.set(id, {
      id,
      threadId: params.threadId,
      turnId: params.turnId,
      callId: params.callId,
      tabId: "tabId" in call.args ? call.args.tabId : null,
      action: browserControlAction(call),
      ...(detailAction === undefined ? {} : { detailAction }),
      phase: "acting",
      startedAt: previous?.startedAt ?? new Date().toISOString(),
    });
  }

  finish(params: DynamicToolCallParams): void {
    const id = controlSessionId(params.threadId, params.turnId);
    const current = this.#sessions.get(id);
    if (!current || current.callId !== params.callId) return;
    this.#sessions.set(id, { ...current, phase: "waiting" });
    const timer = setTimeout(() => {
      this.#timers.delete(id);
      const latest = this.#sessions.get(id);
      if (!latest || latest.callId !== params.callId || latest.phase !== "waiting") return;
      this.#sessions.delete(id);
    }, BrowserControlSessions.IDLE_GRACE_MS);
    timer.unref();
    this.#timers.set(id, timer);
  }

  updateTab(params: DynamicToolCallParams, tabId: string): void {
    const id = controlSessionId(params.threadId, params.turnId);
    const current = this.#sessions.get(id);
    if (!current || current.callId !== params.callId) return;
    this.#sessions.set(id, { ...current, tabId });
  }
}

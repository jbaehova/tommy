import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type ConversationMessage, decodeUsageTokens, type UsageTokens } from "@tommy/contracts/ipc";

import { estimateUsageCost } from "../agent/usage-pricing";
import type { DatabaseCore } from "./database-core";
import { databaseRow, databaseRows, optionalNumberColumn, requiredStringColumn } from "./database-rows";

export interface UsageSample {
  agentId: string;
  sessionId: string;
  turnId: string;
  provider: string;
  model: string;
  counterId: string;
  tokens: UsageTokens;
  baseline: boolean;
  reportedCost?: number | null;
  occurredAt?: string;
  /** The prompt of the last request in this update, when the provider reports it. */
  lastRequestInputTokens?: number | null;
  /** The smallest prompt of all the requests in this update, when the provider reports each request. */
  smallestRequestInputTokens?: number | null;
  /**
   * The provider's totals before this update. A counter with no checkpoint starts from them, so its
   * first update records only the new requests.
   */
  previousTokens?: UsageTokens | null;
  /**
   * The counter whose checkpoint keeps `reportedCost`, when the provider reports tokens per prompt but
   * cost for the whole session. Without one, the cost is kept with the tokens.
   */
  costCounterId?: string;
  /** A turn that adds 0 to `reportedCost` used a model with no rates, so it stays unpriced. */
  zeroCostUnpriced?: boolean;
}
const TOKEN_KEYS = ["uncachedInput", "cachedInput", "cacheCreation", "output"] as const;

/** One skill an agent loaded, from the finished tool step that loaded it. */
export interface SkillLoadSample {
  agentId: string;
  sessionId: string;
  turnId: string;
  /** The provider's id of the tool step. With the skill, it makes a step that comes again count once. */
  itemId: string;
  provider: string;
  model: string;
  skill: string;
  /** The estimated tokens of its SKILL.md, or null when the file was not found. */
  tokens: number | null;
  occurredAt: string;
}

/** Owns numeric analytics and cumulative checkpoints. Conversation deletion does not erase usage. */
export class AgentUsage {
  readonly #core: DatabaseCore;
  constructor(core: DatabaseCore) {
    this.#core = core;
  }

  collectionStartedAt(): string {
    const row = databaseRow(
      this.#core.connection.prepare("SELECT applied_at FROM schema_migrations WHERE version = 15").get(),
    );
    if (!row) throw new Error("Analytics schema is unavailable.");
    return requiredStringColumn(row, "applied_at");
  }

  reroute(agentId: string, sessionId: string, turnId: string, model: string): void {
    this.#core.connection
      .prepare("UPDATE agent_usage_activity SET model = ? WHERE agent_id = ? AND activity_id = ?")
      .run(model, agentId, `turn:${sessionId}:${turnId}`);
  }

  turnModel(agentId: string, sessionId: string, turnId: string): string | null {
    const row = databaseRow(
      this.#core.connection
        .prepare("SELECT model FROM agent_usage_activity WHERE agent_id = ? AND activity_id = ?")
        .get(agentId, `turn:${sessionId}:${turnId}`),
    );
    return row ? requiredStringColumn(row, "model") : null;
  }

  record(sample: UsageSample): void {
    const tokens = decodeUsageTokens(sample.tokens);
    const digest = createHash("sha256")
      .update(JSON.stringify([sample.counterId, sample.turnId, tokens, sample.reportedCost]))
      .digest("hex");
    this.#core.dispatch(
      `analytics:${sample.agentId}:${digest}`,
      [{ aggregateType: "agent-usage", aggregateId: sample.agentId, eventType: "usage.recorded", payload: { digest } }],
      (db) => {
        const previous = databaseRow(
          db
            .prepare("SELECT tokens_json FROM agent_usage_checkpoints WHERE agent_id = ? AND counter_id = ?")
            .get(sample.agentId, sample.counterId),
        );
        const costCheckpoint = sample.costCounterId
          ? databaseRow(
              db
                .prepare("SELECT tokens_json FROM agent_usage_checkpoints WHERE agent_id = ? AND counter_id = ?")
                .get(sample.agentId, sample.costCounterId),
            )
          : previous;
        const previousValue = costCheckpoint
          ? databaseRow(JSON.parse(requiredStringColumn(costCheckpoint, "tokens_json")))
          : null;
        const previousCost = previousValue?.reportedCost;
        const reportedCost =
          sample.reportedCost == null
            ? typeof previousCost === "number"
              ? previousCost
              : null
            : Math.max(sample.reportedCost, typeof previousCost === "number" ? previousCost : 0);
        const before = previous
          ? decodeUsageTokens(JSON.parse(requiredStringColumn(previous, "tokens_json")))
          : sample.baseline
            ? null
            : (sample.previousTokens ?? null);
        const delta: UsageTokens = { ...tokens };
        for (const key of TOKEN_KEYS) {
          const current = tokens[key];
          const prior = before?.[key];
          // Counter resets need an explicit new counter id, never a negative delta treated as fresh usage.
          delta[key] =
            current === null || (before && prior === null)
              ? null
              : prior === undefined
                ? current
                : Math.max(0, current - (prior ?? 0));
          if (prior !== null && prior !== undefined) tokens[key] = current === null ? prior : Math.max(current, prior);
        }
        db.prepare(
          "INSERT INTO agent_usage_checkpoints VALUES (?, ?, ?) ON CONFLICT(agent_id, counter_id) DO UPDATE SET tokens_json = excluded.tokens_json",
        ).run(
          sample.agentId,
          sample.counterId,
          JSON.stringify(sample.costCounterId ? tokens : { ...tokens, reportedCost }),
        );
        // A session that has records but no cost checkpoint ran before its costs were kept. Its
        // first cost report also counts that earlier use, so the report is only the start.
        const costStartUnknown =
          sample.costCounterId && sample.reportedCost != null && typeof previousCost !== "number"
            ? databaseRow(
                db
                  .prepare("SELECT 1 FROM agent_usage_records WHERE agent_id = ? AND session_id = ? LIMIT 1")
                  .get(sample.agentId, sample.sessionId),
              ) !== null
            : false;
        if (sample.costCounterId && sample.reportedCost != null)
          db.prepare(
            "INSERT INTO agent_usage_checkpoints VALUES (?, ?, ?) ON CONFLICT(agent_id, counter_id) DO UPDATE SET tokens_json = excluded.tokens_json",
          ).run(sample.agentId, sample.costCounterId, JSON.stringify({ reportedCost }));
        if ((!before && sample.baseline) || sample.turnId === "baseline") return null;
        // A resumed Claude process reports its cost from 0, so the cost of its first turn is unknown.
        // That turn, and a Claude report with no cost, are priced from list rates instead.
        const reportedDelta =
          sample.reportedCost === undefined ||
          sample.reportedCost === null ||
          costStartUnknown ||
          (!sample.costCounterId && before && typeof previousCost !== "number")
            ? null
            : Math.max(0, sample.reportedCost - (typeof previousCost === "number" ? previousCost : 0));
        const reported =
          reportedDelta === null || (sample.zeroCostUnpriced && reportedDelta === 0)
            ? null
            : { cost: reportedDelta, basis: reportedCostBasis(sample.provider) };
        const turn = databaseRow(
          db
            .prepare("SELECT occurred_at FROM agent_usage_activity WHERE agent_id = ? AND activity_id = ?")
            .get(sample.agentId, `turn:${sample.sessionId}:${sample.turnId}`),
        );
        const occurredAt =
          sample.occurredAt ?? (turn ? requiredStringColumn(turn, "occurred_at") : new Date().toISOString());
        const estimate =
          reported ??
          estimateUsageCost(
            sample.provider,
            sample.model,
            delta,
            sample.lastRequestInputTokens ?? null,
            sample.smallestRequestInputTokens ?? null,
            occurredAt,
          );
        db.prepare("INSERT INTO agent_usage_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          sample.agentId,
          digest,
          sample.sessionId,
          sample.turnId,
          sample.provider,
          sample.model,
          occurredAt,
          JSON.stringify(delta),
          estimate.cost,
          estimate.basis,
          new Date().toISOString(),
        );
        return null;
      },
    );
  }

  /**
   * Keeps one skill load. Its tokens are priced as uncached input of the turn's model, which is
   * what the skill adds when it enters the context; later requests read it from the cache.
   */
  recordSkillLoad(sample: SkillLoadSample): void {
    const cost =
      sample.tokens === null
        ? null
        : estimateUsageCost(
            sample.provider,
            sample.model,
            { uncachedInput: sample.tokens, cachedInput: 0, cacheCreation: 0, output: 0 },
            null,
            null,
            sample.occurredAt,
          ).cost;
    this.#core.connection
      .prepare("INSERT OR IGNORE INTO agent_usage_skill_loads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        sample.agentId,
        JSON.stringify([sample.sessionId, sample.itemId, sample.skill]),
        sample.sessionId,
        sample.turnId,
        sample.provider,
        sample.model,
        sample.skill,
        sample.tokens,
        cost,
        sample.occurredAt,
      );
  }

  startTurn(agentId: string, sessionId: string, turnId: string, provider: string, model: string): void {
    this.#core.connection
      .prepare("INSERT OR IGNORE INTO agent_usage_activity VALUES (?, ?, ?, ?, ?, ?, 'turn', ?)")
      .run(agentId, `turn:${sessionId}:${turnId}`, sessionId, turnId, provider, model, new Date().toISOString());
  }

  /**
   * All the tokens of one turn and its cost, summed over its records, or `null` when the provider
   * reported none. The tokens add the known counts, as the analytics total does. The cost is `null`
   * when one record has no cost, so a partial sum never reads as complete.
   */
  readTurnTotals(agentId: string, turnId: string, since: string): { tokens: number; costUsd: number | null } | null {
    const rows = databaseRows(
      this.#core.connection
        .prepare(
          "SELECT tokens_json, estimated_cost_usd FROM agent_usage_records WHERE agent_id = ? AND occurred_at >= ? AND turn_id = ?",
        )
        .all(agentId, since, turnId),
    );
    if (rows.length === 0) return null;
    let tokens = 0;
    let costUsd: number | null = 0;
    for (const row of rows) {
      const counts = decodeUsageTokens(JSON.parse(requiredStringColumn(row, "tokens_json")));
      for (const key of TOKEN_KEYS) tokens += counts[key] ?? 0;
      const cost = optionalNumberColumn(row, "estimated_cost_usd");
      costUsd = costUsd === null || cost === null ? null : costUsd + cost;
    }
    return { tokens, costUsd };
  }
}

/** Called inside the conversation writer's transaction; only message identity and counts survive. */
export function recordUsageMessage(
  db: DatabaseSync,
  agentId: string,
  message: ConversationMessage,
  provider: string,
  model: string,
): void {
  if (message.author !== "user" && message.author !== "assistant") return;
  if (
    message.author === "assistant" &&
    (message.status !== "completed" ||
      (message.itemType && message.itemType !== "agentMessage" && message.itemType !== "final_answer"))
  )
    return;
  db.prepare(`INSERT OR IGNORE INTO agent_usage_activity
    SELECT ?, ?, '', ?, ?, ?, ?, ? WHERE ? >= (SELECT applied_at FROM schema_migrations WHERE version = 15)`).run(
    agentId,
    `message:${message.id}`,
    message.turnId ?? "",
    provider,
    model,
    message.author,
    message.createdAt,
    message.createdAt,
  );
}

function reportedCostBasis(provider: string) {
  if (provider === "opencode") return "OpenCode session cost report; API-equivalent rates, not subscription charges";
  if (provider === "pi") return "Pi session cost report; rates of Pi's model list, not subscription charges";
  return "Claude SDK list-price estimate; https://platform.claude.com/docs/en/about-claude/pricing; verified 2026-09-07";
}

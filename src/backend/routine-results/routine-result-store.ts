import { databaseRow, databaseRows, optionalStringColumn, requiredStringColumn } from "../database/database-rows";
import type { TommyDatabase } from "../tommy-database";

interface FinishedRun {
  runId: string;
  routineId: string;
  agentId: string;
  routineName: string;
  deliveryId: string | null;
}

const DELIVERY_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Keeps the delivery history of routines with a destination from a previous installation. */
export class RoutineResultStore {
  constructor(private readonly database: TommyDatabase) {}

  /** A reported failure can have an answer. A provider failure never has one. */
  runsWithoutDelivery(since: string): FinishedRun[] {
    return databaseRows(
      this.database.connection
        .prepare(
          `SELECT run.run_id, run.routine_id, run.agent_id, run.routine_name, run.delivery_id
         FROM projection_routine_runs AS run
         JOIN routine_result_destinations AS destination ON destination.routine_id = run.routine_id
         WHERE (run.status = 'succeeded'
             OR (run.status = 'failed' AND EXISTS (SELECT 1 FROM projection_deliveries AS queued
               WHERE queued.delivery_id = run.delivery_id AND queued.status = 'completed')))
           AND run.updated_at >= ? AND run.updated_at >= destination.updated_at
           AND NOT EXISTS (SELECT 1 FROM routine_result_deliveries AS delivery WHERE delivery.run_id = run.run_id)
         ORDER BY run.updated_at, run.run_id`,
        )
        .all(since),
    ).map((row) => ({
      runId: requiredStringColumn(row, "run_id"),
      routineId: requiredStringColumn(row, "routine_id"),
      agentId: requiredStringColumn(row, "agent_id"),
      routineName: requiredStringColumn(row, "routine_name"),
      deliveryId: optionalStringColumn(row, "delivery_id"),
    }));
  }

  /** Copy the original destination verbatim. A quiet run keeps its own terminal row. */
  createDelivery(run: FinishedRun, text: string | null, now: Date): void {
    const at = now.toISOString();
    this.database.connection
      .prepare(
        `INSERT OR IGNORE INTO routine_result_deliveries
         (run_id, routine_id, agent_id, connection_id, platform, connection_name, place_id, place_name, text,
          status, next_attempt_at, expires_at, created_at, updated_at)
       SELECT ?, routine_id, ?, connection_id, platform, connection_name, place_id, place_name, ?,
              ?, ?, ?, ?, ?
       FROM routine_result_destinations WHERE routine_id = ?`,
      )
      .run(
        run.runId,
        run.agentId,
        text,
        text === null ? "quiet" : "pending",
        text === null ? null : at,
        text === null ? null : new Date(now.getTime() + DELIVERY_LIFETIME_MS).toISOString(),
        at,
        at,
        run.routineId,
      );
  }

  /** The old host returned connection-gone on each due attempt. Expired items never made an attempt. */
  finishDue(now: string): void {
    this.database.connection
      .prepare(
        `UPDATE routine_result_deliveries
       SET status = 'failed', reason = CASE WHEN expires_at <= ? THEN 'expired' ELSE 'connection-gone' END,
           attempts = attempts + CASE WHEN expires_at <= ? THEN 0 ELSE 1 END, next_attempt_at = NULL, updated_at = ?
       WHERE status = 'pending' AND next_attempt_at <= ? AND text IS NOT NULL`,
      )
      .run(now, now, now, now);
  }

  nextAttemptAt(): string | null {
    const row = databaseRow(
      this.database.connection
        .prepare(
          "SELECT MIN(next_attempt_at) AS next FROM routine_result_deliveries WHERE status = 'pending' AND text IS NOT NULL",
        )
        .get(),
    );
    return row ? optionalStringColumn(row, "next") : null;
  }

  /** A send interrupted in an older version may already have reached its destination. */
  interruptSending(now: string): void {
    this.database.connection
      .prepare(
        `UPDATE routine_result_deliveries SET status = 'uncertain', reason = 'restart', next_attempt_at = NULL,
         updated_at = ? WHERE status = 'sending'`,
      )
      .run(now);
  }
}

import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { addDiscordWorkflows } from "./workflows/workflow-discord-schema";
import { WORKFLOW_SCHEMA_SQL } from "./workflows/workflow-schema";

/** Stable SQL values copied from a migration fixture. */
export type MigrationFixtureRows = Record<string, Record<string, SQLOutputValue>[]>;

/** The only row changes made by versions 53 and 54. Other columns retain their exact values. */
export function withRoutineSchemaColumns(rows: MigrationFixtureRows): MigrationFixtureRows {
  return Object.fromEntries(
    Object.entries(rows).map(([table, values]) => [
      table,
      values.map((row) =>
        table === "projection_agent_routines"
          ? { run_in: "chat", ...row }
          : table === "projection_agent_threads"
            ? { routine_id: null, ...row }
            : row,
      ),
    ]),
  );
}

/** New optional features add empty tables. They never synthesize user records during an upgrade. */
export function withImprovementSchema(rows: MigrationFixtureRows): MigrationFixtureRows {
  return {
    browser_profile_proxies: [],
    projection_deleted_thread_messages: [],
    projection_deleted_provider_history_sources: [],
    ...withRoutineSchemaColumns(rows),
  };
}

/** Test-only inverse for scratch fixtures that reconstruct a released schema before version 53. */
export function removeImprovementSchemaFixture(db: DatabaseSync): void {
  const foreignKeys = db.prepare("PRAGMA foreign_keys").get()?.foreign_keys === 1;
  const outputTable = WORKFLOW_SCHEMA_SQL.indexOf("  CREATE TABLE IF NOT EXISTS workflow_output_deliveries");
  if (outputTable < 0) throw new Error("Missing released workflow output fixture schema.");
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    // Versions 56 and 58 rebuild tables. Restore their released CHECK and FK too, rather than
    // deleting only their markers and leaving a newer schema underneath an older fixture.
    addDiscordWorkflows(db);
    db.exec(`
      ALTER TABLE workflow_output_deliveries RENAME TO workflow_output_deliveries_v58_fixture;
      ${WORKFLOW_SCHEMA_SQL.slice(outputTable)}
      INSERT INTO workflow_output_deliveries
        (rowid, step_id, connection_id, place_id, text, status, reason, attempts, sent_at, created_at, updated_at)
      SELECT rowid, step_id, connection_id, place_id, text, status, reason, attempts, sent_at, created_at, updated_at
      FROM workflow_output_deliveries_v58_fixture;
      DROP TABLE workflow_output_deliveries_v58_fixture;
      DROP TABLE projection_deleted_thread_messages;
      DROP TABLE projection_deleted_provider_history_sources;
      DROP TABLE browser_profile_proxies;
      DROP INDEX agent_threads_routine;
      ALTER TABLE projection_agent_threads DROP COLUMN routine_id;
      ALTER TABLE projection_agent_routines DROP COLUMN run_in;
      DELETE FROM schema_migrations WHERE version >= 53;
    `);
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}

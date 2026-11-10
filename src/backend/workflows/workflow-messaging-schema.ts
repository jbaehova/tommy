import type { DatabaseSync } from "node:sqlite";

// Appended migration: Slack and Telegram workflow runs. The root schema registry assigns the version.
// The latest schema uses the same source CHECK.
//
// SQLite cannot extend a CHECK in place. Rebuild the table with both new source values and retain
// every run id, so steps, output deliveries and GitHub references stay valid. The run payload keeps
// each message. Posts and reactions use the existing `workflow_output_deliveries` table.
export const MESSAGING_WORKFLOW_RUN_SOURCE_SQL =
  "source TEXT NOT NULL CHECK(source IN ('manual', 'schedule', 'webhook', 'github', 'discord', 'telegram', 'slack')),";

const MESSAGING_WORKFLOW_RUN_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS workflow_runs_recent ON workflow_runs(workflow_id, started_at DESC, run_id);
  CREATE INDEX IF NOT EXISTS workflow_runs_open
    ON workflow_runs(status) WHERE status IN ('running', 'approval', 'stopping');
`;

/**
 * The appended migration. The caller pauses foreign keys: the old table is dropped while steps point to its runs,
 * and the new one takes its name and every run id.
 */
export function addMessagingWorkflows(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE workflow_runs_messaging (
      run_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id) ON DELETE CASCADE,
      number INTEGER NOT NULL CHECK(number >= 1),
      trigger_node_id TEXT,
      from_node_id TEXT,
      ${MESSAGING_WORKFLOW_RUN_SOURCE_SQL}
      scheduled_for TEXT,
      idempotency_key TEXT NOT NULL,
      graph_revision INTEGER NOT NULL CHECK(graph_revision >= 0),
      graph_json TEXT NOT NULL CHECK(json_valid(graph_json)),
      payload TEXT,
      status TEXT NOT NULL CHECK(status IN ('running', 'approval', 'stopping', 'done', 'failed', 'stopped')),
      error TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(workflow_id, number),
      UNIQUE(workflow_id, idempotency_key)
    );
    INSERT INTO workflow_runs_messaging (
      run_id, workflow_id, number, trigger_node_id, from_node_id, source, scheduled_for, idempotency_key,
      graph_revision, graph_json, payload, status, error, started_at, ended_at, updated_at
    ) SELECT
      run_id, workflow_id, number, trigger_node_id, from_node_id, source, scheduled_for, idempotency_key,
      graph_revision, graph_json, payload, status, error, started_at, ended_at, updated_at
    FROM workflow_runs;
    DROP TABLE workflow_runs;
    ALTER TABLE workflow_runs_messaging RENAME TO workflow_runs;
  `);
  db.exec(MESSAGING_WORKFLOW_RUN_INDEXES_SQL);
}

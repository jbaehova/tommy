// A native workflow connector belongs to the host configuration, not the retired messaging runtime.
// An output still belongs to its step. Its connection id is resolved and checked by the host adapter.
export const LEGACY_WORKFLOW_OUTPUT_CONNECTION_COLUMN_SQL =
  "connection_id TEXT NOT NULL REFERENCES projection_messaging_connections(connection_id),";
export const HOST_WORKFLOW_OUTPUT_CONNECTION_COLUMN_SQL = "connection_id TEXT NOT NULL,";

/**
 * Appended migration 58. Preserve every outbox field, including uncertain sends and their attempt
 * count. Removing a host connector must not remove its delivery record. The central migration
 * transaction pauses foreign keys so existing orphan rows are retained and checked, not discarded.
 */
export const HOST_WORKFLOW_OUTPUT_MIGRATION_SQL = `
  CREATE TABLE workflow_output_deliveries_host (
    step_id TEXT PRIMARY KEY REFERENCES workflow_steps(step_id) ON DELETE CASCADE,
    ${HOST_WORKFLOW_OUTPUT_CONNECTION_COLUMN_SQL}
    place_id TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'uncertain')),
    reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
    sent_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO workflow_output_deliveries_host
    (rowid, step_id, connection_id, place_id, text, status, reason, attempts, sent_at, created_at, updated_at)
  SELECT rowid, step_id, connection_id, place_id, text, status, reason, attempts, sent_at, created_at, updated_at
  FROM workflow_output_deliveries;
  DROP TABLE workflow_output_deliveries;
  ALTER TABLE workflow_output_deliveries_host RENAME TO workflow_output_deliveries;
`;

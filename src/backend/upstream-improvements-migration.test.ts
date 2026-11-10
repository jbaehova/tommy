// @vitest-environment node
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { type MigrationFixtureRows, withImprovementSchema } from "./migration-fixture-rows";
import { migrateTommyDatabase } from "./tommy-database-schema";

// These fixtures exercise only scratch databases. The new migrations must preserve all existing
// rows, commit their marker with their DDL, restore FK enforcement on failure and support a retry.
const connections: DatabaseSync[] = [];
const stamp = "2026-10-01T09:00:00.000Z";
const profileId = "0123456789abcdef0123456789abcdef";

afterEach(() => {
  for (const db of connections.splice(0)) db.close();
});

function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  connections.push(db);
  return db;
}

function migrateUpTo(db: DatabaseSync, version: number): void {
  db.exec(`CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateTommyDatabase(db)).toThrow(`migration to version ${version + 1} failed`);
  db.exec("DROP TRIGGER stop_at_version");
}

function databaseAt(version: number): DatabaseSync {
  const db = openDatabase();
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  migrateUpTo(db, version);
  return db;
}

/** The original columns of the v8 schema, before any of the new optional features. */
function seedCommon(db: DatabaseSync): void {
  db.prepare(`INSERT INTO projection_threads
    (thread_id, agent_id, title, active_turn_id, created_at, updated_at, last_event_sequence)
    VALUES ('thread-main', 'chief', 'Keep this history 한국어', NULL, ?, ?, 1)`).run(stamp, stamp);
  db.prepare(`INSERT INTO projection_agents
    (agent_id, thread_id, model, updated_at, sort_order, agent_json, last_event_sequence)
    VALUES ('chief', 'thread-main', 'gpt-5', ?, 0, '{"id":"chief","name":"Chief"}', 1)`).run(stamp);
  db.prepare(`INSERT INTO projection_thread_messages
    (thread_id, message_id, turn_id, author, status, item_type, created_at, ordinal, message_json, last_event_sequence)
    VALUES ('thread-main', 'message-1', NULL, 'user', 'completed', NULL, ?, 0, ?, 1)`).run(
    stamp,
    JSON.stringify({
      id: "message-1",
      author: "user",
      source: "user",
      text: "Keep my data 한국어",
      createdAt: stamp,
      status: "completed",
    }),
  );
  db.prepare(`INSERT INTO projection_agent_routines
    (routine_id, agent_id, name, instruction, active, timezone, created_at, updated_at, last_event_sequence)
    VALUES ('routine-1', 'chief', 'Keep this routine', 'Keep its instruction.', 1, 'UTC', ?, ?, 1)`).run(stamp, stamp);
  db.prepare(`INSERT INTO projection_agent_memories
    (memory_id, agent_id, text, normalized_text, origin, source_turn_id, created_at, updated_at, last_event_sequence)
    VALUES ('memory-1', 'chief', 'Keep this fact.', 'keep this fact.', 'manual', NULL, ?, ?, 1)`).run(stamp, stamp);
}

/** A cross-feature fixture at the last shipped schema, including every dependent workflow row. */
function seedFeatureRows(db: DatabaseSync): void {
  db.prepare(`INSERT INTO browser_profiles (profile_id, name, hue, created_at, updated_at)
    VALUES (?, 'Work 한국어', 215, ?, ?)`).run(profileId, stamp, stamp);
  db.prepare(`INSERT INTO projection_threads
    (thread_id, agent_id, title, active_turn_id, created_at, updated_at, last_event_sequence)
    VALUES ('thread-side', 'chief', 'Keep this side thread', NULL, ?, ?, 2)`).run(stamp, stamp);
  db.prepare(`INSERT INTO projection_agent_threads
    (thread_id, agent_id, legacy_task_id, origin, title, title_source, outcome, error, created_at, updated_at,
      archived_at, last_event_sequence, branch_source_thread_id, branch_source_message_id, branch_through_message_id)
    VALUES ('thread-side', 'chief', NULL, 'user', 'Keep this side thread', 'user', NULL, NULL, ?, ?, NULL, 2,
      'thread-main', 'message-1', 'message-1')`).run(stamp, stamp);
  db.prepare(`INSERT INTO projection_provider_sessions
    (id, thread_id, provider, external_session_id, model, effort, state, created_at, updated_at, resume_cursor,
      last_event_sequence)
    VALUES ('provider-1', 'thread-main', 'codex', 'external-1', 'gpt-5', 'medium', 'active', ?, ?, NULL, 2)`).run(
    stamp,
    stamp,
  );
  db.prepare(`INSERT INTO projection_attachments
    (attachment_id, owner_kind, owner_id, name, path, metadata_json, created_at, last_event_sequence)
    VALUES ('attachment-1', 'thread-message', 'thread-main:message-1', 'Keep.txt', '/Users/user/files/Keep.txt',
      '{"id":"attachment-1","name":"Keep.txt"}', ?, 2)`).run(stamp);
  db.prepare(`INSERT INTO file_deletion_outbox (id, path, reason, created_at)
    VALUES ('outbox-1', '/Users/user/files/old.txt', 'existing-request', ?)`).run(stamp);
  db.prepare(`INSERT INTO orchestration_events
    (event_id, command_id, aggregate_type, aggregate_id, event_type, occurred_at, payload_json)
    VALUES ('event-1', 'command-1', 'fixture', 'fixture-1', 'fixture.retained', ?, '{"text":"Keep this event."}')`).run(
    stamp,
  );
  db.prepare(`INSERT INTO orchestration_command_receipts
    (command_id, accepted_at, first_sequence, last_sequence, result_json)
    VALUES ('command-1', ?, 1, 1, '{"kept":true}')`).run(stamp);
  db.prepare(`INSERT INTO projection_messaging_connections
    (connection_id, platform, workspace_id, workspace_name, enabled, bot_user_id, app_id, orchestrator_agent_id,
      last_error_code, created_at, updated_at)
    VALUES ('connection-1', 'discord', '100', 'Workspace', 1, '200', '300', 'chief', NULL, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO workflows (workflow_id, title, created_at, updated_at)
    VALUES ('workflow-1', 'Keep this workflow', ?, ?)`).run(stamp, stamp);
  db.exec(`INSERT INTO workflow_nodes (workflow_id, node_id, position, kind, x, y, fields_json)
    VALUES ('workflow-1', 'trigger', 0, 'trigger', 0, 0, '{"trigger":"github"}'),
      ('workflow-1', 'output', 1, 'output', 320, 0, '{"target":"channel"}')`);
  const insertRun = db.prepare(`INSERT INTO workflow_runs
    (run_id, workflow_id, number, trigger_node_id, source, idempotency_key, graph_revision, graph_json, payload,
      status, started_at, updated_at)
    VALUES (?, 'workflow-1', ?, 'trigger', ?, ?, 0, '{"nodes":[],"edges":[],"strokes":[]}', 'Keep this payload 한국어',
      'done', ?, ?)`);
  for (const [index, source] of ["manual", "schedule", "webhook", "github", "discord"].entries()) {
    const runId = `run-${source}`;
    insertRun.run(runId, index + 1, source, `key-${source}`, stamp, stamp);
    db.prepare(`INSERT INTO workflow_steps
      (step_id, workflow_id, run_id, node_id, attempt, request_id, kind, status, input, output, created_at, updated_at)
      VALUES (?, 'workflow-1', ?, 'output', 1, ?, 'output', 'done', 'Keep this input.', 'Keep this output.', ?, ?)`).run(
      `step-${source}`,
      runId,
      `request-${source}`,
      stamp,
      stamp,
    );
  }
  db.prepare(`INSERT INTO workflow_output_deliveries
    (step_id, connection_id, place_id, text, status, created_at, updated_at)
    VALUES ('step-manual', 'connection-1', 'place-1', 'Keep this delivery.', 'sent', ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO workflow_github_runs
    (run_id, workflow_id, node_id, repository, number, pull_request, title, caused_by_bot, started_at)
    VALUES ('run-github', 'workflow-1', 'trigger', 'example/repository', 1, 0, 'Keep this issue', 0, ?)`).run(stamp);
  db.prepare(`INSERT INTO workflow_github_actions
    (action_key, workflow_id, run_id, step_id, repository, number, action, status, created_at, updated_at)
    VALUES ('action-1', 'workflow-1', 'run-github', 'step-github', 'example/repository', 1, 'comment', 'done', ?, ?)`).run(
    stamp,
    stamp,
  );
}

function rows(db: DatabaseSync): MigrationFixtureRows {
  return Object.fromEntries(
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'
    AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' AND name NOT LIKE 'agent_memory_search%'
    ORDER BY name`)
      .all()
      .map((table) => {
        const name = String(table.name);
        const values = db.prepare(`SELECT * FROM "${name}"`).all();
        return [name, values.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))];
      }),
  );
}

function declarations(db: DatabaseSync) {
  return db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
}

function healthy(db: DatabaseSync): void {
  expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 58 });
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}

describe("optional feature migrations 53 to 58", () => {
  it.each(Array.from({ length: 50 }, (_, index) => index + 8))(
    "preserves user rows from released source schema %i",
    (version) => {
      const db = databaseAt(version);
      seedCommon(db);
      // Earlier migrations have their own frozen fixtures. Snapshot their result before the new DDL.
      if (version < 52) migrateUpTo(db, 52);
      seedFeatureRows(db);
      const before = rows(db);
      migrateTommyDatabase(db);
      expect(rows(db)).toEqual(withImprovementSchema(before));
      expect(db.prepare("SELECT text FROM projection_agent_memories WHERE memory_id='memory-1'").get()).toEqual({
        text: "Keep this fact.",
      });
      healthy(db);
      // A clean subsequent start runs no DDL and changes no user row.
      const after = rows(db);
      const schema = declarations(db);
      migrateTommyDatabase(db, { closedCleanly: true });
      expect(rows(db)).toEqual(after);
      expect(declarations(db)).toEqual(schema);
    },
  );

  it.each([
    ["v0.1.12", 3],
    ["v0.1.15", 4],
    ["v0.1.18", 4],
    ["v0.2.1", 6],
  ] as const)("upgrades the frozen %s schema without replacing its user rows", (tag, marker) => {
    const db = openDatabase();
    db.exec(readFileSync(new URL(`./released-schemas/${tag}.sql`, import.meta.url), "utf8"));
    db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(marker, stamp);
    db.prepare(`INSERT INTO projection_threads
        (thread_id, agent_id, title, active_turn_id, created_at, updated_at, last_event_sequence)
        VALUES ('old-thread', 'chief', 'Old history 한국어', NULL, ?, ?, 1)`).run(stamp, stamp);
    migrateUpTo(db, 52);
    seedCommon(db);
    seedFeatureRows(db);
    const before = rows(db);
    migrateTommyDatabase(db);
    expect(rows(db)).toEqual(withImprovementSchema(before));
    expect(db.prepare("SELECT title FROM projection_threads WHERE thread_id='old-thread'").get()).toEqual({
      title: "Old history 한국어",
    });
    healthy(db);
  });

  it.each([53, 54, 55, 56, 57, 58])("rolls back migration %i and its marker, then retries", (version) => {
    const db = databaseAt(version - 1);
    seedCommon(db);
    seedFeatureRows(db);
    const before = rows(db);
    const schemaBefore = declarations(db);
    db.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version=${version}
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);
    expect(() => migrateTommyDatabase(db)).toThrow(`migration to version ${version} failed`);
    expect(rows(db)).toEqual(before);
    expect(declarations(db)).toEqual(schemaBefore);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version=?").all(version)).toEqual([]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    // The failed version remains retryable, with no duplicate column or staging table.
    db.exec("DROP TRIGGER fail_marker");
    migrateTommyDatabase(db);
    expect(rows(db)).toEqual(withImprovementSchema(before));
    healthy(db);
  });

  it("rolls back the workflow rebuild when it introduces a broken reference", () => {
    const db = databaseAt(55);
    seedCommon(db);
    seedFeatureRows(db);
    const before = rows(db);
    const schemaBefore = declarations(db);
    db.exec(`CREATE TEMP TRIGGER break_reference AFTER INSERT ON schema_migrations WHEN new.version=56
      BEGIN UPDATE workflow_steps SET run_id='missing-run' WHERE step_id='step-manual'; END;`);
    expect(() => migrateTommyDatabase(db)).toThrow("migration to version 56 failed");
    expect(rows(db)).toEqual(before);
    expect(declarations(db)).toEqual(schemaBefore);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.exec("DROP TRIGGER break_reference");
    migrateTommyDatabase(db);
    expect(rows(db)).toEqual(withImprovementSchema(before));
    healthy(db);
  });

  it("preserves an existing broken reference without creating another one", () => {
    const db = databaseAt(55);
    seedCommon(db);
    seedFeatureRows(db);
    db.exec("PRAGMA foreign_keys=OFF; UPDATE workflow_steps SET run_id='missing-run' WHERE step_id='step-manual'");
    db.exec("PRAGMA foreign_keys=ON");
    const before = rows(db);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    expect(violations).toHaveLength(1);
    migrateTommyDatabase(db);
    expect(rows(db)).toEqual(withImprovementSchema(before));
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual(violations);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("rejects newer and incomplete histories before changing the schema", () => {
    const db = databaseAt(55);
    seedCommon(db);
    seedFeatureRows(db);
    const before = rows(db);
    const schemaBefore = declarations(db);
    db.exec("INSERT INTO schema_migrations VALUES (59, 'now')");
    expect(() => migrateTommyDatabase(db)).toThrow("newer than this application supports");
    db.exec("DELETE FROM schema_migrations WHERE version=59; DELETE FROM schema_migrations WHERE version=54");
    expect(() => migrateTommyDatabase(db)).toThrow("missing version 54");
    expect(rows(db)).toEqual(before);
    expect(declarations(db)).toEqual(schemaBefore);
  });

  it("enforces optional data constraints and keeps their parent deletion behavior", () => {
    const db = databaseAt(52);
    seedCommon(db);
    seedFeatureRows(db);
    migrateTommyDatabase(db);
    expect(db.prepare("SELECT run_in FROM projection_agent_routines").all()).toEqual([{ run_in: "chat" }]);
    expect(() => db.exec("UPDATE projection_agent_routines SET run_in='elsewhere'")).toThrow("CHECK constraint failed");
    db.exec("UPDATE projection_agent_routines SET run_in='thread'");
    db.exec("UPDATE projection_agent_threads SET routine_id='routine-1' WHERE thread_id='thread-side'");
    db.prepare(`INSERT INTO projection_threads
      (thread_id, agent_id, title, active_turn_id, created_at, updated_at, last_event_sequence)
      VALUES ('another-side', 'chief', 'Another', NULL, ?, ?, 3)`).run(stamp, stamp);
    expect(() =>
      db
        .prepare(`INSERT INTO projection_agent_threads
      (thread_id, agent_id, origin, title, title_source, created_at, updated_at, last_event_sequence, routine_id)
      VALUES ('another-side', 'chief', 'user', 'Another', 'user', ?, ?, 3, 'routine-1')`)
        .run(stamp, stamp),
    ).toThrow("UNIQUE constraint failed");

    db.prepare("INSERT INTO browser_profile_proxies VALUES (?, 'fixture-ciphertext', ?)").run(profileId, stamp);
    expect(() =>
      db.prepare("INSERT INTO browser_profile_proxies VALUES ('missing', 'fixture-ciphertext', ?)").run(stamp),
    ).toThrow("FOREIGN KEY constraint failed");
    db.prepare(
      "INSERT INTO projection_deleted_thread_messages(thread_id,message_id,deleted_at,turn_id,message_kind) VALUES ('thread-main','deleted-1',?,'turn-1','claude-answer')",
    ).run(stamp);
    db.prepare(
      "INSERT INTO projection_deleted_provider_history_sources VALUES ('thread-main','claude','source-1',?)",
    ).run(stamp);
    expect(() =>
      db
        .prepare(
          "INSERT INTO projection_deleted_thread_messages(thread_id,message_id,deleted_at) VALUES ('missing','x',?)",
        )
        .run(stamp),
    ).toThrow("FOREIGN KEY constraint failed");
    expect(() =>
      db
        .prepare(
          "INSERT INTO projection_deleted_thread_messages(thread_id,message_id,deleted_at,message_kind) VALUES ('thread-main','x',?,'invalid')",
        )
        .run(stamp),
    ).toThrow("CHECK constraint failed");
    const insertRun = db.prepare(`INSERT INTO workflow_runs
      (run_id, workflow_id, number, source, idempotency_key, graph_revision, graph_json, status, started_at, updated_at)
      VALUES (?, 'workflow-1', ?, ?, ?, 0, '{"nodes":[],"edges":[],"strokes":[]}', 'done', ?, ?)`);
    insertRun.run("run-slack", 6, "slack", "key-slack", stamp, stamp);
    insertRun.run("run-telegram", 7, "telegram", "key-telegram", stamp, stamp);
    expect(() => insertRun.run("run-bad", 8, "other", "key-other", stamp, stamp)).toThrow("CHECK constraint failed");

    db.prepare("DELETE FROM browser_profiles WHERE profile_id=?").run(profileId);
    expect(db.prepare("SELECT * FROM browser_profile_proxies").all()).toEqual([]);
    db.exec("DELETE FROM projection_threads WHERE thread_id='thread-main'");
    expect(db.prepare("SELECT * FROM projection_deleted_thread_messages").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM projection_deleted_provider_history_sources").all()).toEqual([]);
    // Workflow children still refer to the same runs after the rebuild.
    db.exec("DELETE FROM workflow_runs WHERE run_id='run-github'");
    expect(db.prepare("SELECT * FROM workflow_github_runs").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM workflow_github_actions").all()).toEqual([]);
    healthy(db);
  });
});

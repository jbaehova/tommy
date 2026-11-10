// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateTommyDatabase } from "./tommy-database-schema";

const databases: DatabaseSync[] = [];
const stamp = "2026-10-01T09:00:00.000Z";
const statuses = ["pending", "sending", "sent", "failed", "uncertain"] as const;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function databaseAt57(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TEMP TRIGGER stop_at_57 BEFORE INSERT ON schema_migrations WHEN new.version > 57
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;
  `);
  expect(() => migrateTommyDatabase(database)).toThrow("migration to version 58 failed");
  database.exec("DROP TRIGGER stop_at_57");
  return database;
}

function seedOutbox(database: DatabaseSync): void {
  database
    .prepare(`INSERT INTO workflows(workflow_id, title, created_at, updated_at)
    VALUES ('workflow-1', 'Keep all output states 한국어', ?, ?)`)
    .run(stamp, stamp);
  database
    .prepare(`INSERT INTO projection_messaging_connections
    (connection_id, platform, workspace_id, workspace_name, enabled, created_at, updated_at)
    VALUES ('legacy-connection', 'discord', 'example-workspace', 'Example workspace', 1, ?, ?)`)
    .run(stamp, stamp);
  for (const [index, status] of statuses.entries()) {
    const stepId = `step-${status}`;
    database
      .prepare(`INSERT INTO workflow_steps
      (step_id, workflow_id, node_id, attempt, request_id, kind, status, input, created_at, updated_at)
      VALUES (?, 'workflow-1', ?, 1, ?, 'output', 'running', 'Keep this input.', ?, ?)`)
      .run(stepId, `output-${status}`, `request-${status}`, stamp, stamp);
    database
      .prepare(`INSERT INTO workflow_output_deliveries
      (rowid, step_id, connection_id, place_id, text, status, reason, attempts, sent_at, created_at, updated_at)
      VALUES (?, ?, 'legacy-connection', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        100 + index * 7,
        stepId,
        `place-${status}`,
        `Keep ${status} output 한국어`,
        status,
        status === "failed" || status === "uncertain" ? "existing-outcome" : null,
        index + 1,
        status === "sent" ? stamp : null,
        stamp,
        "2026-10-01T10:00:00.000Z",
      );
  }
}

function rows(database: DatabaseSync) {
  return database.prepare("SELECT rowid AS storage_id, * FROM workflow_output_deliveries ORDER BY step_id").all();
}

function declarations(database: DatabaseSync) {
  return database.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
}

function assertHealthy(database: DatabaseSync): void {
  expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 58 });
}

describe("native workflow output migration 58", () => {
  it("keeps every outbox state, identifier, text, count, time and rowid through upgrade and restart", () => {
    const database = databaseAt57();
    seedOutbox(database);
    const before = rows(database);
    const columns = database.prepare("PRAGMA table_info(workflow_output_deliveries)").all();
    const steps = database.prepare("SELECT * FROM workflow_steps ORDER BY step_id").all();

    migrateTommyDatabase(database);

    expect(rows(database)).toEqual(before);
    expect(database.prepare("PRAGMA table_info(workflow_output_deliveries)").all()).toEqual(columns);
    expect(database.prepare("SELECT * FROM workflow_steps ORDER BY step_id").all()).toEqual(steps);
    assertHealthy(database);
    const schema = declarations(database);
    migrateTommyDatabase(database, { closedCleanly: true });
    expect(rows(database)).toEqual(before);
    expect(declarations(database)).toEqual(schema);
    assertHealthy(database);
  });

  it("accepts a host-configured connection without making a legacy messaging record", () => {
    const database = databaseAt57();
    seedOutbox(database);
    const update = database.prepare(
      "UPDATE workflow_output_deliveries SET connection_id=? WHERE step_id='step-pending'",
    );
    expect(() => update.run("slack-example")).toThrow("FOREIGN KEY constraint failed");
    migrateTommyDatabase(database);

    update.run("slack-example");
    expect(
      database.prepare("SELECT connection_id FROM workflow_output_deliveries WHERE step_id='step-pending'").get(),
    ).toEqual({ connection_id: "slack-example" });
    expect(
      database.prepare("SELECT * FROM projection_messaging_connections WHERE connection_id='slack-example'").all(),
    ).toEqual([]);
    // Removing a connector must keep the record of a send, including an uncertain send.
    const before = rows(database);
    database.exec("DELETE FROM projection_messaging_connections WHERE connection_id='legacy-connection'");
    expect(rows(database)).toEqual(before);
    assertHealthy(database);
  });

  it("keeps the step foreign key, uniqueness, state checks and cascade", () => {
    const database = databaseAt57();
    seedOutbox(database);
    migrateTommyDatabase(database);

    expect(database.prepare("PRAGMA foreign_key_list(workflow_output_deliveries)").all()).toEqual([
      expect.objectContaining({ table: "workflow_steps", from: "step_id", to: "step_id", on_delete: "CASCADE" }),
    ]);
    expect(() =>
      database
        .prepare(`INSERT INTO workflow_output_deliveries
      (step_id, connection_id, place_id, text, status, created_at, updated_at)
      VALUES ('missing-step', 'telegram-example', 'place', 'Keep', 'pending', ?, ?)`)
        .run(stamp, stamp),
    ).toThrow("FOREIGN KEY constraint failed");
    expect(() =>
      database.exec("UPDATE workflow_output_deliveries SET status='invalid' WHERE step_id='step-pending'"),
    ).toThrow("CHECK constraint failed");
    expect(() =>
      database.exec("UPDATE workflow_output_deliveries SET attempts=-1 WHERE step_id='step-pending'"),
    ).toThrow("CHECK constraint failed");
    expect(() =>
      database.exec("UPDATE workflow_output_deliveries SET step_id='step-sent' WHERE step_id='step-pending'"),
    ).toThrow("UNIQUE constraint failed");
    database.exec("DELETE FROM workflow_steps WHERE step_id='step-uncertain'");
    expect(database.prepare("SELECT * FROM workflow_output_deliveries WHERE step_id='step-uncertain'").all()).toEqual(
      [],
    );
    expect(rows(database)).toHaveLength(statuses.length - 1);
    assertHealthy(database);
  });

  it("rolls back the rebuilt outbox and marker together, then retries", () => {
    const database = databaseAt57();
    seedOutbox(database);
    const before = rows(database);
    const schema = declarations(database);
    database.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version=58
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);

    expect(() => migrateTommyDatabase(database)).toThrow("migration to version 58 failed");
    expect(rows(database)).toEqual(before);
    expect(declarations(database)).toEqual(schema);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.prepare("SELECT version FROM schema_migrations WHERE version=58").all()).toEqual([]);
    database.exec("DROP TRIGGER fail_marker");
    migrateTommyDatabase(database);
    expect(rows(database)).toEqual(before);
    assertHealthy(database);
  });

  it("rejects a new broken step reference and restores the old outbox on failure", () => {
    const database = databaseAt57();
    seedOutbox(database);
    const before = rows(database);
    const steps = database.prepare("SELECT * FROM workflow_steps ORDER BY step_id").all();
    const schema = declarations(database);
    database.exec(`CREATE TEMP TRIGGER break_reference AFTER INSERT ON schema_migrations WHEN new.version=58
      BEGIN UPDATE workflow_output_deliveries SET step_id='missing-step' WHERE step_id='step-pending'; END;`);

    expect(() => migrateTommyDatabase(database)).toThrow("migration to version 58 failed");
    expect(rows(database)).toEqual(before);
    expect(database.prepare("SELECT * FROM workflow_steps ORDER BY step_id").all()).toEqual(steps);
    expect(declarations(database)).toEqual(schema);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    database.exec("DROP TRIGGER break_reference");
    migrateTommyDatabase(database);
    expect(rows(database)).toEqual(before);
    assertHealthy(database);
  });

  it("preserves an existing orphan row while removing only its obsolete connection constraint", () => {
    const database = databaseAt57();
    seedOutbox(database);
    database.exec(`PRAGMA foreign_keys=OFF;
      INSERT INTO workflow_output_deliveries
        (rowid, step_id, connection_id, place_id, text, status, reason, attempts, created_at, updated_at)
      VALUES (987, 'old-missing-step', 'old-missing-connection', 'old-place', 'Keep orphan output 한국어',
        'uncertain', 'interrupted', 4, '${stamp}', '${stamp}');
      PRAGMA foreign_keys=ON;`);
    const before = rows(database);
    expect(database.prepare("PRAGMA foreign_key_check(workflow_output_deliveries)").all()).toHaveLength(2);

    migrateTommyDatabase(database);

    expect(rows(database)).toEqual(before);
    expect(database.prepare("PRAGMA foreign_key_check(workflow_output_deliveries)").all()).toEqual([
      expect.objectContaining({ table: "workflow_output_deliveries", rowid: 987, parent: "workflow_steps" }),
    ]);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    migrateTommyDatabase(database, { closedCleanly: true });
    expect(rows(database)).toEqual(before);
  });
});

// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateTommyDatabase } from "./tommy-database-schema";

// Failure modes: migration 52 misses a saved server whose name differs from `agent_desktop` only in case, gives two
// servers one name, changes what the user configured, renames a server that migration 21 already moved, or keeps a
// rename after a failure.
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function databaseAt(version: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateTommyDatabase(db)).toThrow(`migration to version ${version + 1} failed`);
  db.exec("DROP TRIGGER stop_at_version");
  return db;
}

// The name index is case-sensitive, so each of these names is a separate server. Only the first two name
// agent-desktop. The third holds, in a different case, the first name that the migration tries. The fourth is a
// name that migration 21 gave a server, and the fifth is an ordinary server.
function seedServers(db: DatabaseSync): void {
  db.exec(`INSERT INTO projection_mcp_servers
      (mcp_server_id, name, transport, enabled, command, args_json, env_json, env_passthrough_json,
       working_directory, url, headers_json, position, created_at, updated_at)
    VALUES
      ('mcp-1', 'Agent_Desktop', 'stdio', 1, 'agent-desktop', '["mcp"]', '[{"name":"MODE","value":"fast"}]', '[]',
        '/Users/user/tools', '', '[]', 0, '2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.000Z'),
      ('mcp-2', 'agent_desktop', 'http', 0, '', '[]', '[]', '[]', '', 'https://example.com/mcp',
        '[{"name":"X-Team","value":"core"}]', 1, '2026-09-14T10:01:00.000Z', '2026-09-14T10:01:00.000Z'),
      ('mcp-3', 'AGENT_DESKTOP_SAVED', 'stdio', 1, 'other', '[]', '[]', '["HOME"]', '', '', '[]', 2,
        '2026-09-14T10:02:00.000Z', '2026-09-14T10:02:00.000Z'),
      ('mcp-4', 'computer_use_saved', 'stdio', 1, 'my-driver', '["--serve"]', '[]', '[]', '', '', '[]', 3,
        '2026-09-14T10:03:00.000Z', '2026-09-14T10:03:00.000Z'),
      ('mcp-5', 'github', 'stdio', 1, 'github-mcp', '[]', '[]', '[]', '', '', '[]', 4,
        '2026-09-14T10:04:00.000Z', '2026-09-14T10:04:00.000Z');`);
}

function servers(db: DatabaseSync) {
  return db
    .prepare("SELECT * FROM projection_mcp_servers ORDER BY mcp_server_id")
    .all()
    .map((row) => ({ ...row }));
}

function expectRenamed(db: DatabaseSync, before: ReturnType<typeof servers>): void {
  const after = servers(db);
  // Only the name of a colliding server changes.
  expect(after.map(({ name: _name, ...rest }) => rest)).toEqual(before.map(({ name: _name, ...rest }) => rest));
  expect(after.slice(2).map((server) => server.name)).toEqual(["AGENT_DESKTOP_SAVED", "computer_use_saved", "github"]);
  expect(
    after
      .slice(0, 2)
      .map((server) => server.name)
      .sort(),
  ).toEqual(["agent_desktop_saved_2", "agent_desktop_saved_3"]);
}

function expectHealthy(db: DatabaseSync): void {
  expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 52 });
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}

describe("agent-desktop server name migration", () => {
  // Migration 20 made the table. 20 is the first released schema with saved servers, 21 the first after the old
  // driver name was freed, and 50 the last released schema.
  it.each([20, 21, 35, 50])("moves every case of the agent-desktop name from released schema %i", (version) => {
    const db = databaseAt(version);
    seedServers(db);
    const before = servers(db);
    migrateTommyDatabase(db);
    expectRenamed(db, before);
    expectHealthy(db);
  });

  it("changes nothing when no saved server has the name", () => {
    const db = databaseAt(50);
    db.exec(`INSERT INTO projection_mcp_servers
        (mcp_server_id, name, transport, enabled, command, args_json, env_json, env_passthrough_json,
         working_directory, url, headers_json, position, created_at, updated_at)
      VALUES ('mcp-1', 'agent_desktop_tools', 'stdio', 1, 'x', '[]', '[]', '[]', '', '', '[]', 0,
        '2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.000Z');`);
    const before = servers(db);
    migrateTommyDatabase(db);
    expect(servers(db)).toEqual(before);
    expectHealthy(db);
  });

  it("rolls back the renames after a failure, then retries", () => {
    const db = databaseAt(50);
    seedServers(db);
    const before = servers(db);
    db.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version = 52
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);
    expect(() => migrateTommyDatabase(db)).toThrow("migration to version 52 failed");
    expect(servers(db)).toEqual(before);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 52").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.exec("DROP TRIGGER fail_marker");
    migrateTommyDatabase(db);
    expectRenamed(db, before);
    expectHealthy(db);
  });
});

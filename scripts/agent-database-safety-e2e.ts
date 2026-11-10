// Drives the real database host process with scratch files. No Tommy instance or user database is used.
// Run: bun scripts/agent-database-safety-e2e.ts
// Artifact: .tommy-build/agent-database-safety-e2e/report.json
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Effect, Schema } from "effect";
import {
  AGENT_DATABASE_LIMITS,
  type AgentDatabaseHostMessage,
  type AgentDatabaseHostProcess,
  type AgentDatabaseRequest,
  type AgentDatabaseRequestInput,
  type AgentDatabaseResponse,
  type AgentDatabaseStatement,
} from "../src/backend/agent-data/agent-database-protocol";
import {
  type AgentDatabaseOutcome,
  AgentDatabaseSupervisor,
} from "../src/backend/agent-data/agent-database-supervisor";

const OUT = resolve(import.meta.dirname, "../.tommy-build/agent-database-safety-e2e");
const HOST = resolve(import.meta.dirname, "../src/backend/agent-data/agent-database-host.ts");
const NOT_STARTED = "The database process did not start. Nothing was run. Try the call again.";
const NODE = process.platform === "win32" ? "node.exe" : "node";

const Cell = Schema.Union([Schema.Null, Schema.Number, Schema.String, Schema.Struct({ blobBytes: Schema.Number })]);
const HostMessage = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready") }),
  Schema.Struct({
    id: Schema.Number,
    ok: Schema.Literal(true),
    result: Schema.Struct({
      columns: Schema.Array(Schema.String),
      rows: Schema.Array(Schema.Array(Cell)),
      truncated: Schema.Boolean,
      changes: Schema.Number,
      lastInsertRowid: Schema.NullOr(Schema.Number),
    }),
  }),
  Schema.Struct({
    id: Schema.Number,
    ok: Schema.Literal(false),
    failure: Schema.Struct({
      kind: Schema.Literals(["sqlite", "not-authorized", "size-limit", "busy", "missing", "internal"]),
      message: Schema.String,
      sqliteCode: Schema.optionalKey(Schema.Number),
    }),
  }),
]);
const decodeHostMessage = Schema.decodeUnknownSync(HostMessage);

function hostMessage(line: string): AgentDatabaseHostMessage {
  const message = decodeHostMessage(JSON.parse(line));
  if ("kind" in message || !message.ok) return message;
  return {
    ...message,
    result: {
      ...message.result,
      columns: [...message.result.columns],
      rows: message.result.rows.map((row) => [...row]),
    },
  };
}

interface HostOptions {
  holdReady?: boolean;
  holdResponseSql?: string;
  args?: string[];
}

/** Only the transport is gated. Every statement still runs in the real host against SQLite. */
class StdioHost implements AgentDatabaseHostProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready = Promise.withResolvers<void>();
  readonly responseHeld = Promise.withResolvers<void>();
  readonly exited = Promise.withResolvers<void>();
  readonly #listeners: ((message: AgentDatabaseHostMessage) => void)[] = [];
  readonly #exitListeners: (() => void)[] = [];
  readonly #options: HostOptions;
  #readyHeld = false;
  #responseId: number | null = null;
  #heldResponse: AgentDatabaseResponse | null = null;
  sent = 0;
  invalidMessage: string | null = null;

  constructor(options: HostOptions = {}) {
    this.#options = options;
    this.child = spawn(NODE, options.args ?? ["--disable-warning=ExperimentalWarning", HOST], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.once("exit", () => {
      this.exited.resolve();
      for (const listener of this.#exitListeners) listener();
    });
    this.child.once("error", (error) => {
      this.invalidMessage = error.message;
      this.exited.resolve();
      for (const listener of this.#exitListeners) listener();
    });
    // Drain stderr without copying unbounded child output into the artifact.
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const message = hostMessage(line);
        if ("kind" in message) {
          this.ready.resolve();
          if (this.#options.holdReady) {
            this.#readyHeld = true;
            return;
          }
        } else if (message.id === this.#responseId) {
          this.#heldResponse = message;
          this.responseHeld.resolve();
          return;
        }
        this.#deliver(message);
      } catch (error) {
        this.invalidMessage = error instanceof Error ? error.message : String(error);
        this.kill();
      }
    });
  }

  send(request: AgentDatabaseRequest): void {
    this.sent += 1;
    if (request.kind === "statement" && request.sql === this.#options.holdResponseSql) this.#responseId = request.id;
    this.child.stdin.write(`${JSON.stringify(request)}\n`);
  }

  onMessage(listener: (message: AgentDatabaseHostMessage) => void): void {
    this.#listeners.push(listener);
  }

  onExit(listener: () => void): void {
    this.#exitListeners.push(listener);
  }

  kill(): void {
    this.child.kill("SIGKILL");
  }

  releaseReady(): void {
    assert.ok(this.#readyHeld, "the host did not reach its ready gate");
    this.#readyHeld = false;
    this.#deliver({ kind: "ready" });
  }

  releaseResponse(): void {
    const response = this.#heldResponse;
    assert.ok(response, "the host did not return the held statement");
    this.#heldResponse = null;
    this.#deliver(response);
  }

  #deliver(message: AgentDatabaseHostMessage): void {
    for (const listener of this.#listeners) listener(message);
  }
}

interface Report {
  passed: boolean;
  gatedReady?: { sentBeforeReady: number; starts: number; statements: number };
  neverReady?: { starts: number; failure: string | null };
  exitBeforeReady?: { starts: number; failure: string | null };
  prewarm?: { starts: number; statements: number };
  uncertainWrite?: { failure: string | null; committedRows: number; starts: number };
  hotJournal?: { journalBytes: number; recoveredValue: string; protectedTableKept: boolean };
  failure?: string;
}

await mkdir(OUT, { recursive: true });
const scratch = await mkdtemp(join(OUT, "case-"));
const hosts: StdioHost[] = [];
const supervisors: AgentDatabaseSupervisor[] = [];
const writers: ChildProcessWithoutNullStreams[] = [];
const report: Report = { passed: false };

function request(path: string, sql: string, mode: "read" | "write" = "read"): Omit<AgentDatabaseStatement, "id"> {
  return {
    kind: "statement",
    databasePath: path,
    mode,
    provision: mode === "write",
    protectedTables: [],
    sql,
    parameters: [],
    limits: AGENT_DATABASE_LIMITS,
  };
}

function run(supervisor: AgentDatabaseSupervisor, input: AgentDatabaseRequestInput): Promise<AgentDatabaseOutcome> {
  return Effect.runPromise(supervisor.send(input));
}

function supervisor(options: HostOptions = {}, statementDeadlineMs = 1_000, hostStartDeadlineMs = 15_000) {
  const started: StdioHost[] = [];
  const settledMs: number[] = [];
  const value = new AgentDatabaseSupervisor({
    spawnHost: () => {
      const host = new StdioHost(started.length === 0 ? options : {});
      started.push(host);
      hosts.push(host);
      return host;
    },
    statementDeadlineMs,
    hostStartDeadlineMs,
    onStatementSettled: (durationMs) => settledMs.push(durationMs),
  });
  supervisors.push(value);
  return { value, started, settledMs };
}

function failure(outcome: AgentDatabaseOutcome): string | null {
  return outcome.ok ? null : outcome.failure.message;
}

async function gateOrOutcome(
  gate: Promise<void>,
  outcome: Promise<AgentDatabaseOutcome>,
  label: string,
): Promise<void> {
  await Promise.race([
    gate,
    outcome.then((result) => {
      throw new Error(`${label}: ${failure(result) ?? "the request completed before the transport gate"}`);
    }),
  ]);
}

function firstHost(started: readonly StdioHost[]): StdioHost {
  const host = started[0];
  assert.ok(host, "no host was started");
  return host;
}

const JOURNAL_WRITER = `
import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.argv[1]);
database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=8");
database.exec("CREATE TABLE journal_probe (id INTEGER PRIMARY KEY, payload BLOB)");
database.exec("INSERT INTO journal_probe VALUES (1, zeroblob(524288))");
database.exec("BEGIN IMMEDIATE");
database.exec("UPDATE journal_probe SET payload = randomblob(524288)");
process.stdout.write("dirty\\n");
process.stdin.resume();
`;

try {
  const path = join(scratch, "ready.db");
  const gated = supervisor({ holdReady: true });
  const pending = run(gated.value, request(path, "CREATE TABLE probe (id INTEGER PRIMARY KEY)", "write"));
  const gatedHost = firstHost(gated.started);
  await gateOrOutcome(gatedHost.ready.promise, pending, "the real host did not report ready");
  assert.equal(gatedHost.sent, 0, "a statement reached the host before ready was delivered");
  assert.deepEqual(gated.settledMs, [], "startup was reported as statement time");
  gatedHost.releaseReady();
  assert.equal(failure(await pending), null);
  assert.equal(gated.settledMs.length, 1);
  report.gatedReady = { sentBeforeReady: 0, starts: gated.started.length, statements: gatedHost.sent };
  gated.value.dispose();
  await gatedHost.exited.promise;

  const never = supervisor({ args: ["-e", "process.stdin.resume()"] }, 1_000, 100);
  const neverOutcome = await run(never.value, request(path, "SELECT count(*) FROM probe"));
  assert.equal(failure(neverOutcome), NOT_STARTED);
  assert.equal(never.started.length, 1, "startup failure restarted in a loop");
  assert.deepEqual(never.settledMs, []);
  await firstHost(never.started).exited.promise;
  report.neverReady = { starts: never.started.length, failure: failure(neverOutcome) };

  const early = supervisor({ args: ["-e", "process.exit(1)"] });
  const earlyOutcome = await run(early.value, request(path, "SELECT count(*) FROM probe"));
  assert.equal(failure(earlyOutcome), NOT_STARTED);
  assert.equal(early.started.length, 1);
  assert.deepEqual(early.settledMs, []);
  report.exitBeforeReady = { starts: early.started.length, failure: failure(earlyOutcome) };

  const warm = supervisor();
  warm.value.prewarm();
  const warmHost = firstHost(warm.started);
  assert.equal(failure(await run(warm.value, request(path, "SELECT count(*) FROM probe"))), null);
  assert.equal(warm.started.length, 1, "a prewarmed host was replaced");
  report.prewarm = { starts: warm.started.length, statements: warmHost.sent };
  warm.value.dispose();
  await warmHost.exited.promise;

  // The real host commits this write. Hold only its reply to exercise the ambiguous timeout.
  const insert = "INSERT INTO probe VALUES (1)";
  const uncertain = supervisor({ holdResponseSql: insert }, 500);
  const write = run(uncertain.value, request(path, insert, "write"));
  const committedHost = firstHost(uncertain.started);
  await gateOrOutcome(committedHost.responseHeld.promise, write, "the real write did not reach its reply gate");
  const read = run(uncertain.value, request(path, "SELECT count(*) FROM probe"));
  const writeOutcome = await write;
  assert.match(failure(writeOutcome) ?? "", /may have been saved.*read the rows/i);
  const readOutcome = await read;
  assert.ok(readOutcome.ok, failure(readOutcome) ?? "the queued read failed");
  const count = readOutcome.result.rows[0]?.[0];
  assert.equal(count, 1, "the timed-out write was lost or replayed");
  // A reply from the discarded generation must not settle a newer request.
  committedHost.releaseResponse();
  const afterStale = await run(uncertain.value, request(path, "SELECT count(*) FROM probe"));
  assert.ok(afterStale.ok);
  assert.equal(afterStale.result.rows[0]?.[0], 1);
  report.uncertainWrite = {
    failure: failure(writeOutcome),
    committedRows: Number(count),
    starts: uncertain.started.length,
  };

  const journalPath = join(scratch, "journal.db");
  const writer = spawn(NODE, ["--input-type=module", "--eval", JOURNAL_WRITER, journalPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  writers.push(writer);
  writer.stderr.resume();
  await new Promise<void>((done, reject) => {
    const lines = createInterface({ input: writer.stdout });
    lines.on("line", (line) => {
      if (line === "dirty") {
        lines.close();
        done();
      }
    });
    writer.once("error", reject);
    writer.once("exit", () => reject(new Error("the journal writer ended before it wrote dirty pages")));
  });
  const writerExited = new Promise<void>((done) => writer.once("exit", () => done()));
  writer.kill("SIGKILL");
  await writerExited;
  const journalBytes = (await stat(`${journalPath}-journal`)).size;
  assert.ok(journalBytes > 0, "the interrupted writer left no journal");
  const recovered = await run(
    uncertain.value,
    request(journalPath, "SELECT hex(substr(payload, 1, 8)) FROM journal_probe"),
  );
  assert.ok(recovered.ok, failure(recovered) ?? "read-only recovery failed");
  const recoveredValue = recovered.result.rows[0]?.[0];
  assert.equal(recoveredValue, "0000000000000000", "the uncommitted pages were not rolled back");
  const denied = await run(uncertain.value, {
    ...request(journalPath, "DROP TABLE journal_probe", "write"),
    kind: "statement",
    provision: false,
    protectedTables: ["journal_probe"],
  });
  assert.equal(denied.ok, false, "recovery bypassed the table authorizer");
  const kept = await run(uncertain.value, request(journalPath, "SELECT count(*) FROM journal_probe"));
  assert.ok(kept.ok);
  assert.equal(kept.result.rows[0]?.[0], 1);
  report.hotJournal = { journalBytes, recoveredValue: String(recoveredValue), protectedTableKept: true };

  for (const host of hosts) assert.equal(host.invalidMessage, null, "the host sent an invalid message");
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  for (const value of supervisors) value.dispose();
  for (const host of hosts) host.kill();
  await Promise.all(hosts.map((host) => host.exited.promise));
  await Promise.all(
    writers.map(async (writer) => {
      if (writer.exitCode !== null || writer.signalCode !== null) return;
      const exited = new Promise<void>((done) => writer.once("exit", () => done()));
      writer.kill("SIGKILL");
      await exited;
    }),
  );
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(scratch, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

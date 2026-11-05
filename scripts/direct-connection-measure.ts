// Measures the direct connection to a real server, over its public address and TLS, with the transport
// of the app. It pairs one device with a code of `tommy pair` and connects again and again.
// Revoke the device afterwards: `tommy devices`, then `tommy revoke-device <id>`.
// Run: `bun scripts/direct-connection-measure.ts <address> <code>`.
// Writes .tommy-build/direct-connection-measure/report.json.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TEAM_API_ROUTES } from "@tommy/contracts/team-api-routes";
import { Effect, Schema } from "effect";
import { DirectClientBridge } from "../src/main/direct-client-bridge";
import { DirectPairedServer } from "../src/main/direct-paired-server";
import { TeamWebRtcClientTransport } from "../src/main/team-webrtc-client-transport";

const CONNECTS = 10;
const READS = 20;
const FILE_BYTES = 2 * 1024 * 1024;

const [address, code] = process.argv.slice(2);
if (!address || !code) throw new Error("Usage: bun scripts/direct-connection-measure.ts <address> <code>");

const summary = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    minimum: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    maximum: sorted.at(-1),
  };
};

const root = await mkdtemp(join(tmpdir(), "direct-connection-measure-"));
const paired = new DirectPairedServer({
  path: join(root, "paired-server.bin"),
  deviceName: () => "connection-measure",
  encrypt: (value) => Buffer.from(value),
  decrypt: (value) => value.toString("utf8"),
});
await Effect.runPromise(paired.pair({ address, code }));

const source = paired.transportSource;
const transport = new TeamWebRtcClientTransport({
  bridge: new DirectClientBridge(),
  ...source,
  getPrincipalId: () => "local-owner",
  transferDirectory: join(root, "transfers"),
});
const [host] = await Effect.runPromise(source.listHosts());
if (!host?.devicePublicKey) throw new Error("The host list holds no host key.");
const hostId = host.hostId;
transport.pinHostKey(hostId, host.devicePublicKey);

const connects: number[] = [];
const firstReads: number[] = [];
for (let index = 0; index < CONNECTS; index += 1) {
  const started = performance.now();
  await Effect.runPromise(transport.connect(hostId));
  connects.push(Math.round(performance.now() - started));
  await Effect.runPromise(transport.request(hostId, "/v1/agents"));
  firstReads.push(Math.round(performance.now() - started));
  // Not on the last one: the checks below use this connection.
  if (index < CONNECTS - 1) await Effect.runPromise(transport.disconnect(hostId));
}

const reads: number[] = [];
for (let index = 0; index < READS; index += 1) {
  const started = performance.now();
  await Effect.runPromise(transport.request(hostId, "/v1/agents"));
  reads.push(Math.round(performance.now() - started));
}

const sent = Buffer.from(randomBytes(FILE_BYTES).toString("base64url")).subarray(0, FILE_BYTES);
const uploadStarted = performance.now();
const uploaded = await Effect.runPromise(
  transport.requestResponse(hostId, `${TEAM_API_ROUTES.attachments}?name=measure.txt&mime=text/plain`, {
    method: "POST",
    body: new Uint8Array(sent),
    contentType: "text/plain",
  }),
);
const uploadMs = Math.round(performance.now() - uploadStarted);
if (uploaded.status !== 201) throw new Error(`The upload answered ${uploaded.status}.`);
const attachmentId = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(uploaded.body).id;
const downloadStarted = performance.now();
const downloaded = await Effect.runPromise(transport.requestResponse(hostId, TEAM_API_ROUTES.attachment(attachmentId)));
const downloadMs = Math.round(performance.now() - downloadStarted);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
if (!downloaded.file || hash(downloaded.file.bytes) !== hash(sent)) throw new Error("The file came back different.");

await Effect.runPromise(transport.disconnect(hostId));
await rm(root, { recursive: true, force: true });

const report = {
  address,
  connectMs: summary(connects),
  connectAndFirstReadMs: summary(firstReads),
  readMs: summary(reads),
  file: { bytes: FILE_BYTES, uploadMs, downloadMs, sameHash: true },
};
const out = resolve(import.meta.dirname, "../.tommy-build/direct-connection-measure");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(0);

import { generateKeyPairSync } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import {
  DIRECT_CONNECT_PATH,
  DIRECT_DEVICE_QUERY,
  DIRECT_PAIR_PATH,
  DIRECT_SESSION_EXPIRES_AT_SECONDS,
  DirectPairResponse,
  directSessionId,
} from "@tommy/contracts/direct-connection";
import { sourceText } from "@tommy/i18n/source";
import { Effect, Result, Schema } from "effect";
import { writeFileAtomically } from "../backend/atomic-json-file";
import { CentralAuthOperationError } from "./central-auth-effects";
import type { RemoteHostSummary } from "./central-auth-records";
import { RemoteWorkflowError } from "./remote-service-effects";

const PAIR_TIMEOUT_MS = 15_000;
const MAXIMUM_DEVICE_NAME_LENGTH = 128;
/** The name until the host sends its own name. */
const DIRECT_SERVER_NAME = "Tommy";

const StoredPairing = Schema.Struct({
  version: Schema.Literal(1),
  url: Schema.String,
  hostId: Schema.String,
  hostPublicKey: Schema.String,
  deviceId: Schema.String,
  publicKey: Schema.String,
  privateKey: Schema.String,
});
type StoredPairing = typeof StoredPairing.Type;

const decodeStoredPairing = Schema.decodeUnknownSync(StoredPairing);
const decodePairResponse = Schema.decodeUnknownSync(DirectPairResponse);

export interface DirectPairedServerOptions {
  path: string;
  encrypt: (value: string) => Buffer;
  decrypt: (value: Buffer) => string;
  /** Development only: permits `http://` on loopback, so that a local host can pair. */
  allowLoopbackHttp?: boolean;
  fetch?: typeof fetch;
  deviceName?: () => string;
}

type PairingFailureKey =
  | "error.remote.pairingInvalidAddress"
  | "error.remote.pairingInvalidCode"
  | "error.remote.pairingRateLimited"
  | "error.remote.pairingUnreachable";

function pairingFailure(key: PairingFailureKey): RemoteWorkflowError {
  return new RemoteWorkflowError({ cause: new Error(sourceText(key, {})) });
}

/** A value with no scheme reads as HTTPS. Other schemes, and a URL that holds credentials, read as none. */
export function readPairingOrigin(value: string, allowLoopbackHttp: boolean): string | null {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (url.username || url.password) return null;
    if (url.protocol === "https:") return url.origin;
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    return allowLoopbackHttp && loopback && url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The one server that this computer controls, and the device key that proves this computer to it.
 * The file holds a private key, so it is encrypted with the operating-system storage. A file that
 * cannot be read now stays on disk: a locked Keychain can open it at the next start.
 *
 * It takes the place of the account service for the client: the host list, the session and the
 * address of each connection come from here, and no request leaves for another server.
 */
export class DirectPairedServer {
  readonly #options: DirectPairedServerOptions;
  #pairing: StoredPairing | null = null;

  constructor(options: DirectPairedServerOptions) {
    this.#options = options;
  }

  get paired(): boolean {
    return this.#pairing !== null;
  }

  readonly load = Effect.fn("DirectPairedServer.load")(function* (this: DirectPairedServer) {
    const read = yield* Effect.result(
      Effect.tryPromise(async () =>
        decodeStoredPairing(JSON.parse(this.#options.decrypt(await readFile(this.#options.path)))),
      ),
    );
    this.#pairing = Result.isSuccess(read) ? read.success : null;
  });

  /** Spends a code of `tommy pair`. The device key is made here, and only its public half leaves. */
  readonly pair = Effect.fn("DirectPairedServer.pair")(function* (
    this: DirectPairedServer,
    input: { address: string; code: string },
  ): Effect.fn.Return<{ hostId: string }, RemoteWorkflowError> {
    const url = readPairingOrigin(input.address, this.#options.allowLoopbackHttp ?? false);
    if (!url) return yield* pairingFailure("error.remote.pairingInvalidAddress");
    const code = input.code.replace(/[\s-]/g, "").toUpperCase();
    if (!code) return yield* pairingFailure("error.remote.pairingInvalidCode");
    const keys = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const name = (this.#options.deviceName?.() ?? hostname()).slice(0, MAXIMUM_DEVICE_NAME_LENGTH);
    const send = this.#options.fetch ?? fetch;
    // A redirect could send the code to another origin, and TLS proves only this one.
    const response = yield* Effect.tryPromise({
      try: () =>
        send(`${url}${DIRECT_PAIR_PATH}`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(PAIR_TIMEOUT_MS),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, publicKey: keys.publicKey, name }),
        }),
      catch: () => pairingFailure("error.remote.pairingUnreachable"),
    });
    if (response.status === 403) return yield* pairingFailure("error.remote.pairingInvalidCode");
    if (response.status === 429) return yield* pairingFailure("error.remote.pairingRateLimited");
    if (!response.ok) return yield* pairingFailure("error.remote.pairingUnreachable");
    const paired = yield* Effect.tryPromise({
      try: async () => decodePairResponse(await response.json()),
      catch: () => pairingFailure("error.remote.pairingUnreachable"),
    });
    const pairing: StoredPairing = {
      version: 1,
      url,
      hostId: paired.hostId,
      hostPublicKey: paired.hostPublicKey,
      deviceId: paired.deviceId,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    };
    yield* Effect.try({
      try: () => this.#options.encrypt(JSON.stringify(pairing)),
      catch: (cause) => new RemoteWorkflowError({ cause }),
    }).pipe(
      Effect.flatMap((encrypted) =>
        writeFileAtomically(this.#options.path, encrypted, { createDirectory: true }).pipe(
          Effect.mapError((cause) => new RemoteWorkflowError({ cause })),
        ),
      ),
    );
    this.#pairing = pairing;
    return { hostId: paired.hostId };
  });

  /** The private key goes with the file. The host keeps the device until `tommy revoke-device`. */
  readonly forget = Effect.fn("DirectPairedServer.forget")(function* (this: DirectPairedServer) {
    this.#pairing = null;
    yield* Effect.tryPromise({
      try: () => rm(this.#options.path, { force: true }),
      catch: (cause) => new RemoteWorkflowError({ cause }),
    });
  });

  /** What `TeamWebRtcClientTransport` asks the account service for. */
  readonly transportSource = {
    deviceKeys: (): { publicKey: string; privateKey: string } => {
      const pairing = this.#pairing;
      if (!pairing) throw new Error(sourceText("error.remote.serverNotFound"));
      return { publicKey: pairing.publicKey, privateKey: pairing.privateKey };
    },
    listHosts: (): Effect.Effect<RemoteHostSummary[], CentralAuthOperationError> =>
      Effect.sync(() => {
        const pairing = this.#pairing;
        if (!pairing) return [];
        const host: RemoteHostSummary = {
          hostId: pairing.hostId,
          name: DIRECT_SERVER_NAME,
          logoKey: null,
          devicePublicKey: pairing.hostPublicKey,
          keyHandovers: [],
          authEpoch: 0,
          membershipId: pairing.deviceId,
          role: "owner",
        };
        return [host];
      }),
    startSession: (hostId: string) =>
      Effect.gen({ self: this }, function* () {
        const pairing = yield* this.#pairingOf(hostId);
        return {
          sessionId: directSessionId(pairing.deviceId),
          hostId: pairing.hostId,
          expiresAt: DIRECT_SESSION_EXPIRES_AT_SECONDS * 1_000,
        };
      }),
    issueTicket: (_sessionId: string, _clientPublicKey: string) =>
      Effect.gen({ self: this }, function* () {
        const pairing = yield* this.#pairingOf(this.#pairing?.hostId ?? "");
        const url = new URL(DIRECT_CONNECT_PATH, pairing.url);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set(DIRECT_DEVICE_QUERY, pairing.deviceId);
        return {
          ticket: pairing.deviceId,
          expiresAt: DIRECT_SESSION_EXPIRES_AT_SECONDS * 1_000,
          signalUrl: url.toString(),
        };
      }),
    /** A device keeps its one session for as long as it stays paired. */
    endSession: (_sessionId: string): Effect.Effect<void, CentralAuthOperationError> => Effect.void,
  };

  #pairingOf(hostId: string): Effect.Effect<StoredPairing, CentralAuthOperationError> {
    const pairing = this.#pairing;
    return pairing?.hostId === hostId
      ? Effect.succeed(pairing)
      : Effect.fail(new CentralAuthOperationError({ cause: new Error(sourceText("error.remote.serverNotFound")) }));
  }
}

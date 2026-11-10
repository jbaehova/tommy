import { Effect, Schema } from "effect";

export type ConnectorJson = typeof Schema.Json.Type;
export type WorkflowConnectorFetch = (url: string, init: RequestInit) => Promise<Response>;
const MAXIMUM_API_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const API_DEADLINE_MS = 20_000;

/** No request URL, credential, response body or native error can leave this adapter as an error. */
export class WorkflowConnectorHttpFailure extends Schema.TaggedError<WorkflowConnectorHttpFailure>()(
  "WorkflowConnectorHttpFailure",
  { status: Schema.Number, sent: Schema.Boolean },
) {}

export interface WorkflowConnectorRequest {
  url: string;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  headers?: Readonly<Record<string, string>>;
  body?: ConnectorJson;
}

/** The fetch port is injectable for local E2E checks. Production requests have fixed official API origins. */
export class WorkflowConnectorHttp {
  readonly #fetch: WorkflowConnectorFetch;

  constructor(request: WorkflowConnectorFetch = fetch) {
    this.#fetch = request;
  }

  /** A bounded public attachment download. Callers must allowlist the origin before this method. */
  readonly bytes = Effect.fn("WorkflowConnectorHttp.bytes")(function* (
    this: WorkflowConnectorHttp,
    url: string,
    maximum: number,
  ) {
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await this.#fetch(url, {
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(API_DEADLINE_MS)]),
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new WorkflowConnectorHttpFailure({ status: response.status, sent: true });
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > maximum) throw new WorkflowConnectorHttpFailure({ status: 0, sent: true });
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel();
        }
        return Buffer.concat(chunks);
      },
      catch: (error) =>
        error instanceof WorkflowConnectorHttpFailure
          ? error
          : new WorkflowConnectorHttpFailure({ status: 0, sent: true }),
    });
  }).bind(this);

  readonly json = Effect.fn("WorkflowConnectorHttp.json")(function* (
    this: WorkflowConnectorHttp,
    input: WorkflowConnectorRequest,
  ) {
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await this.#fetch(input.url, {
          method: input.method ?? "GET",
          headers: { ...input.headers, ...(input.body === undefined ? {} : { "Content-Type": "application/json" }) },
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(API_DEADLINE_MS)]),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new WorkflowConnectorHttpFailure({ status: response.status, sent: true });
        }
        if (response.status === 204) return null;
        const reader = response.body?.getReader();
        if (!reader) return null;
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAXIMUM_API_RESPONSE_BYTES) throw new WorkflowConnectorHttpFailure({ status: 0, sent: true });
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel();
        }
        const text = Buffer.concat(chunks).toString("utf8");
        return text.length === 0 ? null : Schema.decodeUnknownSync(Schema.Json)(JSON.parse(text));
      },
      catch: (error) =>
        error instanceof WorkflowConnectorHttpFailure
          ? error
          : new WorkflowConnectorHttpFailure({ status: 0, sent: true }),
    });
  }).bind(this);
}

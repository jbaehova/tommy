import { open } from "node:fs/promises";
import { Effect } from "effect";
import { runCauseEffect } from "../backend/effect-boundary";
import { RemoteWorkflowError, remoteCall } from "./remote-service-effects";

const CHUNK_BYTES = 64 * 1_024;

/** Invalid or multiple ranges are ignored. A valid range beyond EOF answers 416. */
export function attachmentByteRange(
  header: string | null | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/u);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  if (first !== null && last !== null && last < first) return null;
  const start = first ?? Math.max(0, size - (last ?? 0));
  const end = first === null ? size - 1 : Math.min(last ?? size - 1, size - 1);
  return start > end ? "unsatisfiable" : { start, end };
}

/** The remote attachment cache already holds bytes. Use the same single-range rules for its media. */
export function attachmentBytesResponse(
  bytes: Uint8Array,
  headers: Record<string, string>,
  range: string | null,
): Response {
  const requested = attachmentByteRange(range, bytes.byteLength);
  const responseHeaders = { ...headers, "Accept-Ranges": "bytes" };
  if (requested === "unsatisfiable")
    return new Response(null, {
      status: 416,
      headers: { ...responseHeaders, "Content-Range": `bytes */${bytes.byteLength}`, "Content-Length": "0" },
    });
  const body = requested ? bytes.subarray(requested.start, requested.end + 1) : bytes;
  return new Response(new Uint8Array(body), {
    status: requested ? 206 : 200,
    headers: {
      ...responseHeaders,
      "Content-Length": String(body.byteLength),
      ...(requested ? { "Content-Range": `bytes ${requested.start}-${requested.end}/${bytes.byteLength}` } : {}),
    },
  });
}

/** Streams a managed file. Only the caller resolves the attachment ID to a path. */
export const fileResponse = Effect.fn("FileResponse.open")(function* (
  path: string,
  headers: Record<string, string>,
  range?: string | null,
) {
  let transferred = false;
  return yield* Effect.acquireUseRelease(
    remoteCall(() => open(path, "r")),
    (file) =>
      Effect.gen(function* () {
        let closed = false;
        const close = Effect.fn("FileResponse.close")(function* () {
          if (closed) return;
          closed = true;
          yield* remoteCall(() => file.close());
        });
        const stats = yield* remoteCall(() => file.stat());
        if (!stats.isFile()) return yield* new RemoteWorkflowError({ cause: new Error("Not a regular file.") });
        const requested = attachmentByteRange(range, stats.size);
        const responseHeaders = { ...headers, ...(range !== undefined ? { "Accept-Ranges": "bytes" } : {}) };
        if (requested === "unsatisfiable")
          return new Response(null, {
            status: 416,
            headers: { ...responseHeaders, "Content-Range": `bytes */${stats.size}`, "Content-Length": "0" },
          });
        let position = requested?.start ?? 0;
        const end = requested?.end ?? stats.size - 1;
        const length = Math.max(0, end + 1 - position);
        const pull = Effect.fn("FileResponse.read")(function* (
          controller: ReadableStreamDefaultController<Uint8Array>,
        ) {
          if (closed) return;
          const remaining = end + 1 - position;
          if (remaining <= 0) {
            controller.close();
            yield* close();
            return;
          }
          const chunk = new Uint8Array(Math.min(CHUNK_BYTES, remaining));
          const { bytesRead } = yield* remoteCall(() => file.read(chunk, 0, chunk.length, position));
          if (closed) return;
          if (bytesRead === 0)
            return yield* new RemoteWorkflowError({ cause: new Error("The file ended before its declared length.") });
          position += bytesRead;
          controller.enqueue(chunk.subarray(0, bytesRead));
          if (position > end) {
            controller.close();
            yield* close();
          }
        });
        const body = new ReadableStream<Uint8Array>({
          pull: (controller) =>
            runCauseEffect(
              pull(controller).pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    if (!closed) controller.error(error.cause);
                    yield* close().pipe(Effect.catch(() => Effect.void));
                  }),
                ),
              ),
            ),
          cancel: () => runCauseEffect(close()),
        });
        const response = new Response(body, {
          status: requested ? 206 : 200,
          headers: {
            ...responseHeaders,
            "Content-Length": String(length),
            ...(requested ? { "Content-Range": `bytes ${requested.start}-${requested.end}/${stats.size}` } : {}),
          },
        });
        transferred = true;
        return response;
      }),
    (file) => (transferred ? Effect.void : remoteCall(() => file.close()).pipe(Effect.catch(() => Effect.void))),
  );
});

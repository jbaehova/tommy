const LINE_MAX_BYTES = 64 * 1024;

/** The body of one plain HTTP proxy request. Later requests must use a new exit connection. */
export class BrowserProxyRelayBody {
  #remaining: number;
  #state: "length" | "size" | "data" | "separator" | "trailers" | "done";
  #line = "";
  #separator = 0;
  #trailerBytes = 0;
  #refused = false;

  constructor(length: number | "chunked") {
    this.#remaining = length === "chunked" ? 0 : length;
    this.#state = length === "chunked" ? "size" : length === 0 ? "done" : "length";
  }

  /** Refuses the entire buffer if it contains malformed framing or any byte after this body. */
  accept(bytes: Buffer): boolean {
    if (this.#refused) return false;
    if (this.#consume(bytes)) return true;
    this.#refused = true;
    return false;
  }

  #consume(bytes: Buffer): boolean {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.#state === "done") return false;
      if (this.#state === "length" || this.#state === "data") {
        const taken = Math.min(this.#remaining, bytes.length - offset);
        this.#remaining -= taken;
        offset += taken;
        if (this.#remaining === 0) {
          this.#state = this.#state === "length" ? "done" : "separator";
          this.#separator = 0;
        }
        continue;
      }
      if (this.#state === "separator") {
        if (bytes[offset++] !== (this.#separator === 0 ? 13 : 10)) return false;
        if (++this.#separator === 2) this.#state = "size";
        continue;
      }
      const byte = bytes[offset++];
      if (byte === undefined) return false;
      this.#line += String.fromCharCode(byte);
      if (this.#line.length > LINE_MAX_BYTES) return false;
      if (this.#state === "trailers" && ++this.#trailerBytes > LINE_MAX_BYTES) return false;
      if (byte !== 10) continue;
      if (!this.#line.endsWith("\r\n")) return false;
      const line = this.#line.slice(0, -2);
      this.#line = "";
      if (this.#state === "size") {
        const size = line.split(";", 1)[0] ?? "";
        if (!/^[0-9a-f]+$/iu.test(size)) return false;
        this.#remaining = Number.parseInt(size, 16);
        if (!Number.isSafeInteger(this.#remaining)) return false;
        this.#state = this.#remaining === 0 ? "trailers" : "data";
      } else if (line.length === 0) {
        this.#state = "done";
      } else if (!/^[!#$%&'*+.^_`|~0-9a-z-]+:[^\r\n]*$/iu.test(line)) {
        return false;
      }
    }
    return true;
  }
}

/** A single unambiguous framing. Duplicate lengths and CL plus TE are refused by the caller. */
export function browserProxyRelayBody(
  contentLength: string | undefined,
  transferEncoding: string | undefined,
): BrowserProxyRelayBody | null {
  if (transferEncoding !== undefined) {
    if (contentLength !== undefined || transferEncoding.toLowerCase() !== "chunked") return null;
    return new BrowserProxyRelayBody("chunked");
  }
  if (contentLength === undefined) return new BrowserProxyRelayBody(0);
  if (!/^\d+$/u.test(contentLength)) return null;
  const length = Number(contentLength);
  return Number.isSafeInteger(length) ? new BrowserProxyRelayBody(length) : null;
}

// The HTTP adapter of the Team API. The host and its clients are one release, so there is one protocol.
// Routes of a side protocol are not here: they use `teamSideRouteCodec`, which a caller checks first.

import { TEAM_API_ROUTES } from "../team-api-routes";
import {
  decodeTeamProtocolV8CurrentHttpRequest,
  decodeTeamProtocolV8CurrentHttpResponse,
  encodeTeamProtocolV8CurrentHttpRequest,
  encodeTeamProtocolV8CurrentHttpResponse,
} from "./v8-adapter";
import { decodeTeamProtocolSupportV9 } from "./v9";

export interface TeamHttpCodecOptions {
  preserveSemanticTags?: boolean;
  /** Read only by V4 to V8, which accept a model in an agent create request. */
  agentCreateModel?: boolean;
  /** Read only by V7 and V8 responses: the negotiated history-extent-v1 capability. */
  historyExtent?: boolean;
  /** Read only by V7 and V8 responses: the negotiated ui-blocks-v1 capability. */
  uiBlocks?: boolean;
  /** Read only by V7 and V8 responses: the negotiated subagents-v1 capability. */
  subagents?: boolean;
  /** Read only by V7 responses: the negotiated prompt-multi-select-v1 capability. */
  promptMultiSelect?: boolean;
}

type DecodedRequest = ReturnType<typeof decodeTeamProtocolV8CurrentHttpRequest>;
type DecodedResponse = ReturnType<typeof decodeTeamProtocolV8CurrentHttpResponse>;

export interface TeamHttpCodec {
  encodeRequest(method: string, path: string, value: unknown, options: TeamHttpCodecOptions): string;
  decodeRequest(method: string, path: string, value: unknown, options: TeamHttpCodecOptions): DecodedRequest;
  encodeResponse(method: string, path: string, status: number, value: unknown, options: TeamHttpCodecOptions): string;
  decodeResponse(method: string, path: string, status: number, value: unknown): DecodedResponse;
}

const V8_CODEC: TeamHttpCodec = {
  encodeRequest: encodeTeamProtocolV8CurrentHttpRequest,
  decodeRequest: decodeTeamProtocolV8CurrentHttpRequest,
  encodeResponse: encodeTeamProtocolV8CurrentHttpResponse,
  decodeResponse: decodeTeamProtocolV8CurrentHttpResponse,
};

/** Protocol 9 is the protocol 8 wire. Only its compatibility response has up to 256 capabilities. */
const V9_CODEC: TeamHttpCodec = {
  ...V8_CODEC,
  encodeResponse: (method, path, status, value, options) =>
    isCompatibilityRead(method, path, status)
      ? JSON.stringify(decodeTeamProtocolSupportV9(value))
      : V8_CODEC.encodeResponse(method, path, status, value, options),
  decodeResponse: (method, path, status, value) =>
    isCompatibilityRead(method, path, status)
      ? { ...decodeTeamProtocolSupportV9(value) }
      : V8_CODEC.decodeResponse(method, path, status, value),
};

function isCompatibilityRead(method: string, path: string, status: number): boolean {
  return (
    method === "GET" &&
    status === 200 &&
    new URL(path, "http://tommy.invalid").pathname === TEAM_API_ROUTES.compatibility
  );
}

/** The HTTP adapter. The argument stays until the callers stop reading a protocol header. */
export function teamHttpCodec(_protocol?: number): TeamHttpCodec {
  return V9_CODEC;
}

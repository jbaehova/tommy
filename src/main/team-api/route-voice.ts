import { HOST_VOICE_ROUTES, HostVoiceAppend, HostVoiceSetKey, HostVoiceStream } from "@tommy/contracts/host-voice";
import { canAdministerServer } from "@tommy/contracts/ipc";
import { sourceText } from "@tommy/i18n/source";
import { Schema } from "effect";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { HostVoice } from "../host-voice";
import { VoiceStreamFailure } from "../voice-openai-stream";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson } from "./request-helpers";

const decodeSetKey = Schema.decodeUnknownSync(HostVoiceSetKey);
const decodeStream = Schema.decodeUnknownSync(HostVoiceStream);
const decodeAppend = Schema.decodeUnknownSync(HostVoiceAppend);

function parsed<T>(decode: (value: unknown) => T, value: unknown): T {
  try {
    return decode(value);
  } catch {
    throw new HttpError(400, sourceText("error.voice.transcriptionFailed"));
  }
}

/** A failed stream is the message of the client. The text never holds the key. */
async function answering<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof VoiceStreamFailure) throw new HttpError(502, error.message);
    throw error;
  }
}

/** Dictation for each member. Only an owner or an admin saves the key, and no route gives it back. */
export async function routeVoice(context: TeamApiRequestContext, voice: HostVoice | undefined): Promise<RouteOutcome> {
  const { method, url, request, json, member } = context;
  if (method !== "POST" || !Object.values(HOST_VOICE_ROUTES).some((path) => path === url.pathname)) return "unmatched";
  if (!voice) throw new HttpError(400, sourceText("error.voice.transcriptionFailed"));
  const body = await readJson(request);
  switch (url.pathname) {
    case HOST_VOICE_ROUTES.status:
      return json(200, { keySaved: voice.keySaved() });
    case HOST_VOICE_ROUTES.setKey: {
      if (!canAdministerServer(member.role)) throw new HttpError(403, sourceText("error.team.adminRequired"));
      await runCauseEffect(voice.setKey(parsed(decodeSetKey, body).key));
      return json(200, { keySaved: voice.keySaved() });
    }
    case HOST_VOICE_ROUTES.start:
      return json(200, { streamId: await answering(() => voice.start()) });
    case HOST_VOICE_ROUTES.append: {
      const input = parsed(decodeAppend, body);
      const pcm = Buffer.from(input.audio, "base64");
      return json(200, { text: await answering(() => voice.append(input.streamId, pcm)) });
    }
    case HOST_VOICE_ROUTES.finish:
      return json(200, { text: await answering(() => voice.finish(parsed(decodeStream, body).streamId)) });
    case HOST_VOICE_ROUTES.cancel:
      voice.cancel(parsed(decodeStream, body).streamId);
      return json(200, {});
    default:
      return "unmatched";
  }
}

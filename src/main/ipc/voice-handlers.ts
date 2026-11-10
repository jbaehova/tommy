import { type LiveVoiceIpcService, voiceLiveIpcHandlers } from "./voice-live-handlers";
// Dictation. The host holds the OpenAI API key and the stream to OpenAI, so each call goes to the host.

import { HOST_VOICE_ROUTES, HostVoiceStatus, HostVoiceStream, HostVoiceText } from "@tommy/contracts/host-voice";
import type {
  VoiceModelStatus,
  VoiceSettings,
  VoiceStream,
  VoiceStreamTranscript,
  VoiceTranscriptionResult,
} from "@tommy/contracts/ipc";
import { DEFAULT_VOICE_SETTINGS, OPENAI_VOICE_MODEL_ID } from "@tommy/contracts/ipc";
import { sourceText } from "@tommy/i18n/source";
import { Schema } from "effect";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { RemoteServerManager } from "../remote-server-manager";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { parseVoiceApiKey, parseVoiceStream, parseVoiceStreamAudio } from "./voice-inputs";

const decodeStatus = Schema.decodeUnknownSync(HostVoiceStatus);
const decodeStream = Schema.decodeUnknownSync(HostVoiceStream);
const decodeText = Schema.decodeUnknownSync(HostVoiceText);

export interface VoiceIpcDependencies {
  remoteServers: Pick<RemoteServerManager, "activeServerId" | "request" | "supportsCapability">;
  liveVoice: LiveVoiceIpcService;
  forwardTranscript: (transcript: VoiceStreamTranscript) => void;
}

export function voiceIpcHandlers({
  remoteServers,
  liveVoice,
  forwardTranscript,
}: VoiceIpcDependencies): Pick<IpcGroupHandlers, "voice"> {
  const post = <T>(path: string, decode: (value: unknown) => T, body: unknown): Promise<T> =>
    runCauseEffect(remoteServers.request(remoteServers.activeServerId, path, decode, { method: "POST", body }));
  const status = (keySaved: boolean): VoiceModelStatus => ({
    modelId: OPENAI_VOICE_MODEL_ID,
    phase: keySaved ? "ready" : "missing",
    progress: null,
    message: keySaved ? null : sourceText("error.voice.cloud.keyRequired"),
  });
  const readStatus = async () => status((await post(HOST_VOICE_ROUTES.status, decodeStatus, {})).keySaved);
  return {
    voice: {
      ...voiceLiveIpcHandlers({ liveVoice, remoteServers }),
      getModelStatus: handler(readStatus),
      prepareModel: handler(readStatus),
      getSettings: handler((): VoiceSettings => DEFAULT_VOICE_SETTINGS),
      setApiKey: payloadHandler(parseVoiceApiKey, async ({ key }) =>
        status((await post(HOST_VOICE_ROUTES.setKey, decodeStatus, { key })).keySaved),
      ),
      startStream: handler((): Promise<VoiceStream> => post(HOST_VOICE_ROUTES.start, decodeStream, {})),
      appendStream: payloadHandler(parseVoiceStreamAudio, async ({ streamId, pcm }) => {
        const audio = Buffer.from(pcm).toString("base64");
        const { text } = await post(HOST_VOICE_ROUTES.append, decodeText, { streamId, audio });
        forwardTranscript({ streamId, text });
      }),
      finishStream: payloadHandler(
        parseVoiceStream,
        ({ streamId }): Promise<VoiceTranscriptionResult> => post(HOST_VOICE_ROUTES.finish, decodeText, { streamId }),
      ),
      cancelStream: payloadHandler(parseVoiceStream, async ({ streamId }) => {
        await post(HOST_VOICE_ROUTES.cancel, () => undefined, { streamId });
      }),
    },
  };
}

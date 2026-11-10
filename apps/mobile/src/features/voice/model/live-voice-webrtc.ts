import { NativeModules } from "react-native";
import { currentText } from "@/shared/lib/text";

/**
 * `react-native-webrtc`, for GPT live voice. Null in a build without its native module, such as Expo
 * Go or an app binary from before it, which an update can still reach: the library throws when it
 * loads there, so it loads only when the module exists. The chat then keeps the voice conversation
 * of the phone, and Settings does not show GPT live voice.
 */
export const liveVoiceWebRtc: typeof import("react-native-webrtc") | null = NativeModules.WebRTCModule
  ? require("react-native-webrtc")
  : null;

/** The SDP uses gathered candidates. Cancellation closes this wait before a stale call can start. */
export function waitForVoiceIce(
  peer: import("react-native-webrtc").RTCPeerConnection,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("Live voice start was cancelled."));
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", changed);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const changed = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const abort = () => finish(new Error("Live voice start was cancelled."));
    const timeout = setTimeout(() => finish(new Error(currentText().t("mobile.chat.liveVoice.gptFailed"))), 10_000);
    peer.addEventListener("icegatheringstatechange", changed);
    signal.addEventListener("abort", abort, { once: true });
    changed();
  });
}

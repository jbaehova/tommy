import type { AgentEvent } from "@tommy/contracts/ipc";

/** Tommy dictates and does not speak, so these calls have nothing to do. */
export type SpeechAgent = { serverId: string; agentId: string };
type Source = SpeechAgent & { messageId: string };

export function noteDictatedMessage(_agent: SpeechAgent, _transcript: string, _options?: { always: boolean }): void {}
export const claimDictatedSend: (agent: SpeechAgent) => ((messageId: string) => void) | undefined = () => undefined;
export function forgetDictatedMessage(_agent: SpeechAgent): void {}
export function stopSpokenReply(): void {}
export function readDictatedReplies(_event: AgentEvent, _serverId: string): void {}
export function toggleReadAloud(_source: Source, _markdown: string): void {}
export function toggleRecording(_messageId: string, _url: string): void {}
export function toggleSpokenReply(_source: Source, _markdown: string): void {}
export function seekSpokenReply(_messageId: string, _seconds: number): void {}
export function seekRecording(_messageId: string, _url: string, _seconds: number): void {}
export const recordingWaveform: (url: string) => { peaks: readonly number[]; duration: number } | undefined = () =>
  undefined;

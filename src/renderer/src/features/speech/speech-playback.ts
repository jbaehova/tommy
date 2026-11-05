/** A reply that is read aloud. Tommy has no spoken replies, so there is never one. */
export interface SpeechReading {
  messageId: string;
  agentId: string;
  serverId: string;
  paused: boolean;
  elapsed: number;
  duration: number | null;
  levels: readonly number[];
}

export const speechReading: () => SpeechReading | null = () => null;

export function recordingGone(_url: string): boolean {
  return false;
}

export const spokenReply: (messageId: string) => { peaks: readonly number[]; duration: number } | undefined = () =>
  undefined;

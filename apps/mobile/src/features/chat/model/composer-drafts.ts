import { type SetStateAction, useCallback, useMemo } from "react";
import { create } from "zustand";

interface DraftChat {
  kind: "agent" | "channel" | "thread";
  serverId: string;
  id: string;
}

function draftChatKey(chat: DraftChat): string {
  return JSON.stringify([chat.kind, chat.serverId, chat.id]);
}

interface Draft {
  serverId: string;
  text: string;
}

interface DraftState {
  drafts: Readonly<Record<string, Draft>>;
  generation: number;
  serverGenerations: Readonly<Record<string, number>>;
}

/** Unsent text stays in memory only. It is never part of the phone's read-only workspace cache. */
const useComposerDrafts = create<DraftState>(() => ({ drafts: {}, generation: 0, serverGenerations: {} }));

/** Each mounted composer owns a generation, so late picker callbacks cannot restore removed text. */
export function useComposerDraft(chat: DraftChat): [string, (value: SetStateAction<string>) => void] {
  const { serverId } = chat;
  const key = draftChatKey(chat);
  const generation = useComposerDrafts((state) => state.generation);
  const serverGeneration = useComposerDrafts((state) => state.serverGenerations[serverId] ?? 0);
  const owner = useMemo(() => ({ generation, serverGeneration }), [generation, serverGeneration]);
  const draft = useComposerDrafts((state) => state.drafts[key]?.text ?? "");
  const setDraft = useCallback(
    (value: SetStateAction<string>) => {
      useComposerDrafts.setState((state) => {
        if (
          state.generation !== owner.generation ||
          (state.serverGenerations[serverId] ?? 0) !== owner.serverGeneration
        )
          return state;
        const current = state.drafts[key]?.text ?? "";
        const text = typeof value === "function" ? value(current) : value;
        if (text === current) return state;
        const { [key]: _previous, ...rest } = state.drafts;
        return { drafts: text ? { ...rest, [key]: { serverId, text } } : rest };
      });
    },
    [key, serverId, owner],
  );
  return [draft, setDraft];
}

/** Read the latest text after an await when an outbox message enters editing. */
export function getComposerDraft(chat: DraftChat): string {
  return useComposerDrafts.getState().drafts[draftChatKey(chat)]?.text ?? "";
}

export function deleteServerDrafts(serverIds: ReadonlySet<string>): void {
  useComposerDrafts.setState((state) => {
    const serverGenerations = { ...state.serverGenerations };
    for (const serverId of serverIds) serverGenerations[serverId] = (serverGenerations[serverId] ?? 0) + 1;
    return {
      drafts: Object.fromEntries(Object.entries(state.drafts).filter(([, draft]) => !serverIds.has(draft.serverId))),
      serverGenerations,
    };
  });
}

export function deleteComposerDrafts(): void {
  useComposerDrafts.setState((state) => ({ drafts: {}, generation: state.generation + 1, serverGenerations: {} }));
}

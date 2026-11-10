import type { SaveSkillSuggestionInput, SaveSkillSuggestionResult } from "@tommy/contracts/ipc-skill-learning";
import type { SkillSuggestionState } from "@tommy/ui/features/conversation/SkillSuggestionCard";
import { currentText } from "@tommy/ui/text";
import { createStore } from "solid-js";

export interface SkillSuggestionScope extends SaveSkillSuggestionInput {
  serverId?: string;
}
interface SuggestionState {
  state: SkillSuggestionState;
  error: string | null;
}
type SaveSuggestion = (input: SaveSkillSuggestionInput, serverId?: string) => Promise<SaveSkillSuggestionResult>;

function suggestionKey(scope: SkillSuggestionScope): string {
  return JSON.stringify([scope.serverId ?? null, scope.agentId, scope.threadId ?? null, scope.messageId]);
}

/** Owns transient card state. The transcript and the host's immutable receipt remain the truth. */
export function createSkillLearningStore(saveSuggestion: SaveSuggestion) {
  const [states, setStates] = createStore<Record<string, SuggestionState>>({});
  const pending = new Map<string, Promise<boolean>>();
  const settled = new Set<string>();
  let generation = 0;

  function publish(key: string, state: SkillSuggestionState, error: string | null = null): void {
    setStates((current) => {
      current[key] = { state, error };
    });
  }

  function save(scope: SkillSuggestionScope): Promise<boolean> {
    const key = suggestionKey(scope);
    if (settled.has(key)) return Promise.resolve(true);
    const running = pending.get(key);
    if (running) return running;
    const before = generation;
    publish(key, "saving");
    const operation = Promise.resolve()
      .then(() =>
        saveSuggestion(
          {
            agentId: scope.agentId,
            messageId: scope.messageId,
            ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
          },
          scope.serverId,
        ),
      )
      .then(({ saved }) => {
        if (generation !== before) return saved;
        if (saved) {
          settled.add(key);
          publish(key, "saved");
        } else publish(key, "failed");
        return saved;
      })
      .catch((error: unknown) => {
        if (generation === before) {
          const text = currentText();
          publish(key, "failed", text.errorMessage(error, text.t("chat.skillSuggestion.failed")));
        }
        return false;
      })
      .finally(() => {
        if (pending.get(key) === operation) pending.delete(key);
      });
    pending.set(key, operation);
    return operation;
  }

  return {
    read: (scope: SkillSuggestionScope): SuggestionState =>
      states[suggestionKey(scope)] ?? { state: "ready", error: null },
    save,
    markSaved(scope: SkillSuggestionScope): void {
      const key = suggestionKey(scope);
      settled.add(key);
      publish(key, "saved");
    },
    skip(scope: SkillSuggestionScope): void {
      const key = suggestionKey(scope);
      if (!pending.has(key)) publish(key, "skipped");
    },
    /** Call on a preference change or disconnect. Late replies cannot change another session's card. */
    invalidate(): void {
      generation += 1;
      for (const key of pending.keys()) publish(key, "ready");
      pending.clear();
    },
  };
}

export type SkillLearningStore = ReturnType<typeof createSkillLearningStore>;

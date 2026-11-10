import type { AgentModelOption, AgentProviderId } from "@tommy/contracts/ipc";
import { create } from "zustand";

/**
 * The model list that the Model row opens. The form under it keeps the unsaved provider, model and
 * effort, so the list only names them and gives the pick back to the form.
 */
export interface AgentModelPickerRequest {
  serverId: string;
  provider: AgentProviderId;
  model: string | undefined;
  /** An account-specific catalog. An empty list is authoritative. */
  models?: readonly AgentModelOption[];
  /** Gets the option from the list on the page, which can be newer than the list of the form. */
  choose: (option: AgentModelOption) => void;
}

export const useAgentModelPicker = create<{
  request: AgentModelPickerRequest | null;
  open: (request: AgentModelPickerRequest) => void;
  close: (request: AgentModelPickerRequest) => void;
}>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: (request) => set((state) => (state.request === request ? { request: null } : state)),
}));

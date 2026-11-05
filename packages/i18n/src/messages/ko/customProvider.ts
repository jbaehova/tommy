import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/customProvider";

export const messages = {
  // Form validation. Each message names one field of the custom provider form.
  // The note after a save or a removal. It tells the user when the provider reads the new list.
  // The add dialog.
  // Model discovery. Tommy asks the endpoint for its model list, and the user picks from it.
  // The first step of the add flow: a preset fills the form that comes next.
  // Automatic detection on the provider step and in Settings. Tommy looks for local model servers
  // at their default addresses and for known ACP agent commands on the PATH.
  // Where the scan looks. The default addresses and PATH are always part of it.
  // The custom ACP agent form.
  // The user's own ACP agents in Settings. Each is a command that Tommy starts on this computer.
  // The list of saved endpoints.
} as const satisfies PartialTranslation<typeof source>;

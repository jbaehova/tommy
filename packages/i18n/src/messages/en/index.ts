import type { MessageCatalog } from "../../message";
import { messages as browser } from "./browser";
import { messages as common } from "./common";
import { messages as sidebar } from "./sidebar";
import { source } from "./source";

/** The English catalog supplies the key types and the fallback for missing translations. */
export const en = {
  ...common,
  ...source,
  ...browser,
  ...sidebar,
} as const satisfies MessageCatalog;

export type AppMessages = typeof en;

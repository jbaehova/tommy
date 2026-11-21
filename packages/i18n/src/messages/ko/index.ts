import type { PartialTranslation } from "../../message";
import type { AppMessages } from "../en/index";
import { messages as browser } from "./browser";
import { messages as common } from "./common";
import { messages as sidebar } from "./sidebar";
import { source } from "./source";

/** Korean uses English for keys that do not yet have a translation. */
export const ko = {
  ...common,
  ...source,
  ...browser,
  ...sidebar,
} as const satisfies PartialTranslation<AppMessages>;

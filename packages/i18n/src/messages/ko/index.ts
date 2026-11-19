import type { PartialTranslation } from "../../message";
import type { AppMessages } from "../en/index";
import { messages as agentTemplate } from "./agentTemplate";
import { messages as billing } from "./billing";
import { messages as browser } from "./browser";
import { messages as computerUse } from "./computerUse";
import { messages as connector } from "./connector";
import { messages as customProvider } from "./customProvider";
import { messages as messaging } from "./messaging";
import { messages as plugin } from "./plugin";
import { messages as remoteDesktop } from "./remoteDesktop";
import { shared } from "./shared";
import { messages as sidebar } from "./sidebar";
import { source } from "./source";
import { messages as team } from "./team";

/**
 * Korean. Written from the English source and not yet reviewed by a native speaker: read it as a
 * first draft that is safe to ship behind an explicit language choice, not as final copy. A key that
 * is missing here renders its English source.
 *
 * Notes for a reviewer. Sentences use 해요체 and buttons, tabs and labels use short plain nouns, as
 * docs/i18n.md says. Product names stay in Latin script: Tommy is
 * the application name, and ZIP and JSON are the file formats a picker shows.
 *
 * This is the desktop catalog: shared keys, source text, and every desktop area.
 */
export const ko = {
  ...shared,
  ...source,
  ...billing,
  ...browser,
  ...plugin,
  ...customProvider,
  ...team,
  ...remoteDesktop,
  ...messaging,
  ...sidebar,
  ...agentTemplate,
  ...computerUse,
  ...connector,
} as const satisfies PartialTranslation<AppMessages>;

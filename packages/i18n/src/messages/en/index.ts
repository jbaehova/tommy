import type { MessageCatalog } from "../../message";
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
 * The English source catalog. It is the key list every translation must satisfy and the text a
 * translation falls back to, so a string is written here first and translated second.
 *
 * Keys are `area.thing`, and the area is the surface a reader would go looking in. Each area is one
 * module; `defineMessages` makes every key in it start with the module's prefix. Nothing here is a
 * protocol value: provider identifiers, analytics event names, log lines and agent prompts stay in
 * English in the code that owns them. See docs/i18n.md.
 *
 * This is the desktop catalog: shared keys, source text, and every desktop area.
 */
export const en = {
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
} as const satisfies MessageCatalog;

export type AppMessages = typeof en;

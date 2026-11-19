import { messages as errorAgent } from "./error/agent";
import { messages as errorApp } from "./error/app";
import { messages as errorAttachment } from "./error/attachment";
import { messages as errorBackend } from "./error/backend";
import { messages as errorBilling } from "./error/billing";
import { messages as errorComputerUse } from "./error/computerUse";
import { messages as errorHost } from "./error/host";
import { messages as errorKind } from "./error/kind";
import { messages as errorMarketplace } from "./error/marketplace";
import { messages as errorMcp } from "./error/mcp";
import { messages as errorMessaging } from "./error/messaging";
import { messages as errorProvider } from "./error/provider";
import { messages as errorSite } from "./error/site";
import { messages as errorSkill } from "./error/skill";
import { messages as errorStorage } from "./error/storage";
import { messages as errorTeam } from "./error/team";
import { messages as errorVault } from "./error/vault";
import { messages as errorVoice } from "./error/voice";
import { messages as errorWorkflow } from "./error/workflow";
import { messages as statusAgent } from "./status/agent";
import { messages as statusComputerUse } from "./status/computerUse";
import { messages as statusHost } from "./status/host";
import { messages as statusMessaging } from "./status/messaging";
import { messages as statusProvider } from "./status/provider";
import { messages as statusUpdate } from "./status/update";

/** Text the main process, a host or the team client sends as English and a screen translates. */
export const source = {
  ...errorKind,
  ...errorApp,
  ...errorTeam,
  ...errorHost,
  ...errorAgent,
  ...errorProvider,
  ...errorComputerUse,
  ...errorVoice,
  ...errorWorkflow,
  ...errorBackend,
  ...errorSkill,
  ...errorMarketplace,
  ...errorSite,
  ...errorBilling,
  ...errorAttachment,
  ...errorVault,
  ...errorMcp,
  ...errorStorage,
  ...errorMessaging,
  ...statusHost,
  ...statusMessaging,
  ...statusAgent,
  ...statusProvider,
  ...statusComputerUse,
  ...statusUpdate,
} as const;

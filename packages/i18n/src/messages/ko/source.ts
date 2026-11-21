import { messages as errorAgent } from "./error/agent";
import { messages as errorApp } from "./error/app";
import { messages as errorAttachment } from "./error/attachment";
import { messages as errorBackend } from "./error/backend";
import { messages as errorHost } from "./error/host";
import { messages as errorKind } from "./error/kind";
import { messages as errorMcp } from "./error/mcp";
import { messages as errorProvider } from "./error/provider";
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

/** English templates for server messages and stored errors. */
export const source = {
  ...errorKind,
  ...errorApp,
  ...errorTeam,
  ...errorHost,
  ...errorAgent,
  ...errorProvider,
  ...errorVoice,
  ...errorWorkflow,
  ...errorBackend,
  ...errorSkill,
  ...errorAttachment,
  ...errorVault,
  ...errorMcp,
  ...errorStorage,
  ...statusHost,
  ...statusMessaging,
  ...statusAgent,
  ...statusProvider,
  ...statusComputerUse,
} as const;

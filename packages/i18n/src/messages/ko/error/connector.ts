import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/connector";

export const messages = {
  // The built-in GitHub connection: the device flow, the token refresh and the stored file.
  // The 1Password connection: the CLI that creates the service account, the token and the stored file.
} as const satisfies PartialTranslation<typeof source>;

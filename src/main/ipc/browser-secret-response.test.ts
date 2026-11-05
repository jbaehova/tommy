// @vitest-environment node

import {
  parseLocalBrowserSecretResponse,
  type RespondToBrowserSecretInput,
  remoteBrowserSecretResponse,
} from "@tommy/contracts/ipc";
import { describe, expect, it } from "vitest";

const SUBMIT: RespondToBrowserSecretInput = { requestId: "r1", agentId: "a1", decision: "submit", secret: "hunter2" };

describe("parseLocalBrowserSecretResponse", () => {
  it("keeps Save to Vault only for a submitted secret", () => {
    expect(parseLocalBrowserSecretResponse({ ...SUBMIT, saveToVault: true })).toEqual({ ...SUBMIT, saveToVault: true });
    expect(parseLocalBrowserSecretResponse(SUBMIT)).toEqual(SUBMIT);
    expect(() =>
      parseLocalBrowserSecretResponse({ requestId: "r1", agentId: "a1", decision: "cancel", saveToVault: true }),
    ).toThrow();
  });

  it.each([false, "true", 1, null])("refuses saveToVault %j without the secret in the error", (saveToVault) => {
    expect(() => parseLocalBrowserSecretResponse({ ...SUBMIT, saveToVault })).toThrow(
      "Invalid secure authentication response.",
    );
  });
});

describe("parseLocalBrowserSecretResponse with an account name", () => {
  it("keeps the account name of a submit", () => {
    expect(parseLocalBrowserSecretResponse({ ...SUBMIT, username: "me@example.com" })).toEqual({
      ...SUBMIT,
      username: "me@example.com",
    });
  });

  it("refuses an account name on another decision, or one of another type or size", () => {
    const cancel = { requestId: 2, agentId: "a1", decision: "cancel" };
    expect(() => parseLocalBrowserSecretResponse({ ...cancel, username: "me" })).toThrow();
    expect(() => parseLocalBrowserSecretResponse({ ...SUBMIT, username: 7 })).toThrow();
    expect(() => parseLocalBrowserSecretResponse({ ...SUBMIT, username: "x".repeat(513) })).toThrow();
  });
});

describe("remoteBrowserSecretResponse", () => {
  it("sends only the released fields to a remote server", () => {
    expect(remoteBrowserSecretResponse({ ...SUBMIT, saveToVault: true })).toEqual(SUBMIT);
    expect(remoteBrowserSecretResponse({ requestId: 2, agentId: "a1", decision: "takeover" })).toEqual({
      requestId: 2,
      agentId: "a1",
      decision: "takeover",
    });
  });
});

import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { BrowserManualStepRequest } from "../backend/browser-tools";
import { telegramBrowserReport } from "./telegram-browser-report";

const request: BrowserManualStepRequest = {
  requestId: "request",
  agentId: "delegated",
  threadId: "thread",
  turnId: "turn",
  tabId: "tab",
  step: "passkey",
};

function fixture() {
  const original = { id: 10, operationId: "original" };
  let binding: typeof original | undefined = original;
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const capture = vi.fn(() => Effect.succeed({ bytes, current: (): boolean => true }));
  const sendFile = vi.fn(() => Effect.void);
  const sendMessage = vi.fn(() => Effect.void);
  const reporter = telegramBrowserReport({
    browser: { captureOwnerTab: capture },
    requestChat: (agentId, turnId) => (agentId === request.agentId && turnId === request.turnId ? binding : undefined),
    tokenFor: () => Effect.succeed("fixture"),
    ownerId: 100,
    api: { sendFile, sendMessage },
    language: () => "en",
  });
  return {
    reporter,
    bytes,
    capture,
    sendFile,
    sendMessage,
    rebind: () => {
      binding = { ...original, operationId: "replacement" };
    },
  };
}

describe("Telegram browser screenshots", () => {
  it("sends the still and the reason together to the owner of the delegated turn", async () => {
    const f = fixture();
    expect(await Effect.runPromise(f.reporter(request))).toBe(true);
    expect(f.sendFile).toHaveBeenCalledWith("fixture", 100, {
      bytes: f.bytes,
      name: "browser.jpg",
      mimeType: "image/jpeg",
      caption: expect.stringMatching(/passkey/i),
    });
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it("drops the screenshot and notice when the chat is rebound during capture", async () => {
    const f = fixture();
    f.capture.mockImplementation(() =>
      Effect.sync(() => {
        f.rebind();
        return { bytes: f.bytes, current: (): boolean => true };
      }),
    );
    expect(await Effect.runPromise(f.reporter(request))).toBe(false);
    expect(f.sendFile).not.toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it("sends only the reason when protection or navigation invalidates the frame", async () => {
    const f = fixture();
    f.capture.mockReturnValue(Effect.succeed({ bytes: f.bytes, current: () => false }));
    expect(await Effect.runPromise(f.reporter(request))).toBe(false);
    expect(f.sendFile).not.toHaveBeenCalled();
    expect(f.sendMessage).toHaveBeenCalledOnce();
  });

  it("skips capture for an unrelated turn or a cancelled request", async () => {
    const f = fixture();
    expect(await Effect.runPromise(f.reporter({ ...request, turnId: "other" }))).toBe(false);
    expect(await Effect.runPromise(f.reporter(request, AbortSignal.abort()))).toBe(false);
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
});

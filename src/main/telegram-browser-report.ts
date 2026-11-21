import { sourceTranslateFor } from "@tommy/i18n/source";
import { Effect } from "effect";
import type { BrowserHost } from "../backend/browser-host";
import type { BrowserManualStepRequest } from "../backend/browser-tools";
import type { TelegramApi } from "./telegram-api";

interface Options {
  browser: Pick<BrowserHost, "captureOwnerTab">;
  requestChat(agentId: string, turnId: string): { id: number; operationId: string } | undefined;
  tokenFor(id: number): Effect.Effect<string | null>;
  ownerId: number;
  api: Pick<TelegramApi, "sendFile" | "sendMessage">;
  language(): "en" | "ko";
}

const manualStepCaption = {
  captcha: "status.messaging.telegramManualCaptcha",
  passkey: "status.messaging.telegramManualPasskey",
  "account-selection": "status.messaging.telegramManualAccount",
  "payment-confirmation": "status.messaging.telegramManualPayment",
} as const;

/** A delegated turn can send one still to its originating chat. A new binding cannot receive it. */
export function telegramBrowserReport(options: Options) {
  return Effect.fn("TelegramBrowser.reportManualStep")(function* (
    request: BrowserManualStepRequest,
    signal?: AbortSignal,
  ) {
    const chat = options.requestChat(request.agentId, request.turnId);
    if (!chat || signal?.aborted) return false;
    const current = () => {
      const next = options.requestChat(request.agentId, request.turnId);
      return !signal?.aborted && next?.id === chat.id && next.operationId === chat.operationId;
    };
    const token = yield* options.tokenFor(chat.id);
    if (!current() || !token) return false;
    const caption = sourceTranslateFor(options.language())(
      request.reason === "sign-in-blocked"
        ? "status.messaging.telegramBlockedLogin"
        : request.step
          ? manualStepCaption[request.step]
          : "status.messaging.telegramManualStep",
    );
    const frame = yield* options.browser
      .captureOwnerTab(request.tabId, request.agentId, request.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (!current()) return false;
    if (!frame?.current()) {
      yield* options.api.sendMessage(token, options.ownerId, caption).pipe(Effect.ignore);
      return false;
    }
    return yield* options.api
      .sendFile(token, options.ownerId, {
        name: "browser.jpg",
        mimeType: "image/jpeg",
        bytes: frame.bytes,
        caption,
      })
      .pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
  });
}

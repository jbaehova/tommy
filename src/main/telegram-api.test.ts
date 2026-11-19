// @vitest-environment node
import { redactText } from "@tommy/logging";
import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";
import { decodeTelegramUpdate, TelegramApi } from "./telegram-api";

const human = { id: 1001, first_name: "Owner", is_bot: false, language_code: "ko" };
const agent = { id: 2002, first_name: "Research", is_bot: true, username: "example_research_bot" };
const managerToken = "3003:example_manager_credential_123456789";
const managedToken = "2002:example_managed_credential_123456789";
const privateMessage = {
  message_id: 42,
  chat: { type: "private", id: human.id },
  from: human,
  text: "hello",
};

describe("Telegram transport trust boundary", () => {
  it("checks account roles and discards ambiguous updates and delegated senders", () => {
    const managed = { update_id: 30, managed_bot: { user: human, bot: agent } };
    expect(decodeTelegramUpdate(managed)).toEqual(managed);
    expect(decodeTelegramUpdate({ update_id: 31, message: privateMessage })?.message?.from.language_code).toBe("ko");
    expect(decodeTelegramUpdate({ ...managed, message: privateMessage })).toBeNull();
    expect(decodeTelegramUpdate({ ...managed, managed_bot: { user: agent, bot: human } })).toBeNull();
    expect(decodeTelegramUpdate({ ...managed, update_id: 0.5 })).toBeNull();
    expect(decodeTelegramUpdate({ update_id: 32, message: { ...privateMessage, sender_chat: {} } })).toBeNull();
    expect(
      decodeTelegramUpdate({ update_id: 33, message: { ...privateMessage, business_connection_id: "another" } }),
    ).toBeNull();
    expect(decodeTelegramUpdate({ update_id: 34, message: { ...privateMessage, from: undefined } })).toBeNull();
    expect(
      decodeTelegramUpdate({ update_id: 36, message: { ...privateMessage, text: undefined, managed_bot_created: {} } }),
    ).toBeNull();
    expect(decodeTelegramUpdate({ update_id: 37, message: privateMessage })).not.toBeNull();
    expect(
      decodeTelegramUpdate({ update_id: 35, message: { ...privateMessage, from: { ...human, id: Number.MAX_VALUE } } }),
    ).toBeNull();
  });

  it("keeps tokens out of chat, photo captions, and failure reports", async () => {
    const requests: RequestInit[] = [];
    const api = new TelegramApi(async (url, request) => {
      requests.push(request);
      if (url.endsWith("/getManagedBotToken")) return Response.json({ ok: true, result: managedToken });
      return Response.json({ ok: true, result: { message_id: 1 } });
    });
    expect(await Effect.runPromise(api.getManagedBotToken(managerToken, agent.id))).toBe(managedToken);
    expect(redactText(managedToken)).not.toContain(managedToken);
    await Effect.runPromise(api.sendMessage(managedToken, human.id, `Status ${managerToken} ${managedToken}`));
    expect(requests[1]?.body).not.toContain(managerToken);
    expect(requests[1]?.body).not.toContain(managedToken);
    expect(requests[1]?.redirect).toBe("error");
    const marked = await Effect.runPromise(
      Effect.result(
        api.sendMessage(managerToken, human.id, "Open", {
          inline_keyboard: [[{ text: "Open", url: `https://example.com/${managedToken}` }]],
        }),
      ),
    );
    expect(Result.isFailure(marked)).toBe(true);
    expect(requests).toHaveLength(2);

    await Effect.runPromise(
      api.sendPhoto(managedToken, human.id, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), managedToken),
    );
    const form = requests[2]?.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) throw new Error("Expected multipart body");
    expect(form.get("caption")).not.toContain(managedToken);
    expect(new Headers(requests[2]?.headers).has("content-type")).toBe(false);
    expect(form.get("photo")).toBeInstanceOf(Blob);

    const offline = new TelegramApi(async () => {
      throw new Error(managedToken);
    });
    const denied = new TelegramApi(async () => new Response(managedToken, { status: 403 }));
    for (const [adapter, kind] of [
      [offline, "transport"],
      [denied, "api"],
    ] as const) {
      const result = await Effect.runPromise(Effect.result(adapter.getMe(managedToken)));
      if (Result.isSuccess(result)) throw new Error("Expected a failure");
      expect(result.failure.kind).toBe(kind);
      expect(JSON.stringify(result.failure)).not.toContain(managedToken);
      expect(String(result.failure)).not.toContain(managedToken);
    }
  });

  it("checks the identity of a returned token before a caller can use it", async () => {
    const api = new TelegramApi(async () => Response.json({ ok: true, result: managedToken }));
    const result = await Effect.runPromise(Effect.result(api.getManagedBotToken(managerToken, 7777)));
    if (Result.isSuccess(result)) throw new Error("Expected a mismatched account");
    expect(result.failure.kind).toBe("response");
    expect(JSON.stringify(result.failure)).not.toContain(managedToken);
  });
});

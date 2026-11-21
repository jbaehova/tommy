# Server trust boundaries

Follow each changed entry point from its caller to the operation. Check the Telegram webhook secret,
the chat owner's identity, signed Mini App launch data and the credential of the bot that sent it.
Confirm authorization again when a pending action resumes after a connection changes. Check the
public nginx route and the local-only operator interfaces separately.

For browser and command changes check navigation policy, Electron sandboxing, attachment realpaths
and the separate database process. A production browser has no privileged preload. A background
web preview must not gain access to credentials or application APIs. Check both a valid request
and an untrusted caller, including after a restart or revoked connection. Select the matching check.

```sh
bun run test:desktop -- src/main/telegram-mini-app.test.ts
bun run test:desktop -- src/main/telegram-agent-host-security.test.ts
bun run test:desktop -- src/main/chat-visual-protocol.test.ts
bun scripts/agent-database-safety-e2e.ts
```

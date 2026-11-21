# Repository structure

## Workspace map

| Path | Responsibility |
| --- | --- |
| `src/main` | Electron lifecycle, sandboxed browser windows, system keyring, Telegram and HTTP entry points |
| `src/backend` | Agent queues, provider adapters, workflows, SQLite persistence and browser tools |
| `src/backend/agent-data` | Isolated process for queries on agent-created tables |
| `packages/contracts` | Shared types, input validation and released protocol codecs |
| `packages/i18n` | English source messages and Korean translations |
| `packages/logging` and `packages/user-errors` | Secret redaction and errors for users |
| `scripts/hosting` | Service installation, virtual displays, nginx template and operator CLI |
| `resources` | Managed skills, packaged CLI and runtime support |
| `scripts` | Build tools and isolated end-to-end checks |

## Dependency direction

Main constructs the backend and supplies privileged services. The backend can run with test adapters for provider processes and external APIs. The separate agent database host has its own entry point in the bundle. It accepts a narrow SQL protocol and has no access to the application database through that protocol.

Components at each entry point verify the caller before they read a conversation or change an agent. The Mini App verifies Telegram launch data. Signed webhook receivers verify the original body. The local scripts listener verifies its bearer token and each agent's automation grant.

## State ownership

The host owns the conversations, message queues, provider session bindings, browser profiles and files. An agent can change provider without changing its workspace or the public thread ID. The owner can unlink a Telegram connection while the agent continues to exist.

[Storage and lifecycle](servers.md) and [Telegram delivery](channels-and-messaging.md) describe the boundaries between stored state and external messages.

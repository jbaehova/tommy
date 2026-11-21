# Server lifecycle and storage

## Startup and shutdown

The installer creates a systemd service that runs under its own Linux account. The [launcher](../../scripts/hosting/tommy-server) starts the keyring and virtual displays. The Electron main process hosts the agent browser and supplies services to the backend.

[Application services](../../src/main/application-services.ts) loads persistent state and starts the queues, browser, connectors and listeners. Each service registers its shutdown function when it starts. Shutdown stops incoming work, settles service resources and closes SQLite. The systemd stop action signals the Tommy process while its displays are still available.

## Storage and files

| Location in the standard install | Contents |
| --- | --- |
| `/var/lib/tommy/.config/Tommy/tommy.db` | Events and projections for agents, conversation messages, deliveries, provider sessions and routines |
| `/var/lib/tommy/Tommy/Agents` | Per-agent workspaces |
| `/var/lib/tommy/Tommy/Shared` | Files agents share, including managed transfers |
| `/var/lib/tommy/Tommy/Downloads` | Embedded-browser downloads |
| `/etc/tommy/server.env` | Operator settings for this installation |

Transfers have ownership, size and digest metadata. The transport checks stored attachments before sending them. The work queues record progress durably. On startup the server reconciles work it accepted before it stopped. An operation that might already have acted on an external service needs its own recovery rule.

The agent database process handles user-created tables separately from `tommy.db`. The database host applies its SQL authorizer and resource limits. Only the owning agent can remove an agent-owned table through its tools.

Stored provider sign-ins depend on the service account's keyring. Preserve the account, data directory, keyring and browser profiles across upgrades. For recovery, use the [read-only diagnostic queries](../TROUBLESHOOTING.md#a-chat-is-missing-after-an-update).

### Attachment deletion and recovery

The mailbox owns attachments referenced by stored messages. When deleting messages it commits the metadata changes and queues eligible paths in the file-deletion outbox. It preserves a path still referenced by another live record. Outbox processing checks the managed transfer directory, then removes the individual file. A restart drains outstanding entries. Workspace files do not become eligible simply because a message names them.

The database records agent and thread identity separately from provider-native sessions. A released task ID can still name the same side thread after a migration. Recover the database with its corresponding user data, including transfer files, provider-session captures and the service account's secret storage. A database query can establish whether the stored conversation exists before anyone changes the live installation.

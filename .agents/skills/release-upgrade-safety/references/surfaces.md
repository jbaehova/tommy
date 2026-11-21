# Server data and package inventory

Use this list to find the storage owners in each revision. Inspect the resolved paths for the
running service and for a disposable checkout.

| Surface | Current owner |
| --- | --- |
| SQLite migrations, schema history and fresh installations | `src/backend/tommy-database-schema.ts`, `src/backend/tommy-database-schema-history.json`, `src/backend/database/` |
| Agent workspaces, generated attachments and transfer ownership | `src/backend/workspace-paths.ts`, `src/backend/mailbox-store.ts`, `src/backend/attachment-files.ts` |
| Provider credentials, Vault, OAuth grants, secrets and server preferences | Service construction in `src/main/application-services.ts` and the stores it opens |
| Telegram connection identity, update receipts, pending outgoing files and retry cursors | `src/main/telegram-runtime.ts`, `src/main/telegram-directory.ts`, `src/main/telegram-delivery.ts` |
| Provider installations and active-version stamps shared by processes | `src/main/provider-runtime-manager.ts`, `src/main/provider-runtime-descriptors.ts` |
| Released protocol shapes and their imported decoders | `packages/contracts/src/team-protocol/`, `packages/contracts/src/` |
| Installed service and package identity | `electron-builder.yml`, `scripts/hosting/`, `.github/workflows/release.yml` |

Look at removed paths with `git show <tag>:<path>`. Retiring a client may remove its code while its
stored data, dependencies of a released codec and historical identifiers still require preservation.

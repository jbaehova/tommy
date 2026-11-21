# Change rules and verification

## Effect service execution

Use the version of Effect in the workspace catalog. A service returns an Effect for each asynchronous operation. Framework and SDK callbacks run it at the boundary. Keep typed failures, deadlines and cancellation at the service that owns the operation.

Long-lived services own their runtime. Register cleanup when a service starts. Keep file reads, temporary files and provider processes in a scope that can finish on interruption. SQLite transactions remain synchronous. A failed response to an external mutation can mean the mutation completed.

## Change rules

- Put shared limits, decoders and wire types in `packages/contracts`. Translate provider-specific payloads in the adapter.
- Keep the meaning of each released Team request and response. An old client can still have a stored record or depend on a decoder's rejection behavior.
- Keep all released database migrations. Exercise every affected upgrade fixture and compare the upgraded schema with the fresh schema.
- Preserve browser sandboxing, private input, attachment ownership, secret redaction and Telegram authentication. A change in the chat bound to an agent must invalidate its pending private interactions.
- Send logs through `@tommy/logging`. Store and register credentials at the service that owns them. Keep secrets out of errors, URLs in access logs and agent-visible messages.

See [contributor guidance](../../CONTRIBUTING.md) for the security boundaries.

## Required verification

Run the focused project type check and tests for the changed entry point. Use an isolated directory to test an actual turn, failure, restart or revocation. For a text change, run `bun run i18n:check`. CI runs the full checks. See [development checks](../development-checks.md).

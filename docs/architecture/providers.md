# Provider adapters

Tommy runs Claude, Codex, Cursor and Pi. Each adapter translates its provider's native requests and events into Tommy's turn lifecycle. The server reads the account and model before starting a turn. Provider credentials stay under the service account.

## Built-in tool discovery

`agent/tool-catalog.ts` exposes eleven direct tools and three discovery tools to every adapter.
Claude uses its native question tool instead of `ask_user`. The direct tools are `ask_user`,
`attach_files_to_response`, `list_agents`, `send_message`, `search_memories`, `remember`,
`forget_memory`, `react_to_user_message`, `request_api_key`, `routine_no_update`, and
`routine_report_failure`. External plugin registration stays with each provider adapter.

`tool_search` uses local keyword matching. Exact names come first, then word matches, with stable
catalog order for ties. It returns five results by default and at most ten. It accepts `queries`, or
one `query` string, because models often send one string. Up to three strong results, an exact name or
queries that contain each word of the tool name without its namespace, include the original schema and guidance, so the agent can call them
without a describe step. Each model step sends the full context again, so one step less saves more
input than the added schema costs. A query word that is only in the namespace, or one shared verb
such as "read", does not make a result strong. The other results have a short description only. When a
strong result is an `tommy_browser` tool, the results also include `tommy_browser.run_script` with its
schema. Agents search for the single actions that they know, such as click, and otherwise do not find the
multi-step tool (see [Browser](browser.md)). The instructions
tell the agent to describe a tool only when no search result gave its schema. `tool_describe` accepts `names`, or
one `name` string, and returns the original schemas for up to ten qualified names, plus guidance from
`agent/tool-guidance.ts`. Identical guidance appears once per response. The initial catalog lists
names without schemas.

`tool_call` accepts `{ name: "namespace.tool", arguments: { ... } }`. The router resolves only
original built-in names. It preserves the request, thread, turn, and call identifiers and the abort
signal, then enters the same dispatch as a direct call. Existing decoders, secure browser input,
approval cards, image results, cancellation, and message idempotency remain at their existing owners.
A discovery tool cannot call another discovery tool. Old direct calls still reach their handlers.

The visible definitions are part of the session's tool configuration fingerprint. A catalog change can replace the provider session. The public thread, stored messages and agent identity remain. Claude builds its SDK MCP server from those definitions. Cursor and Pi use the local MCP bridge.

`agent/developer-instructions.ts` puts stable rules first, profile and workspace settings next,
and memories last. Detailed browser, administration, routine, hosting, data, and visual guidance
loads through `tool_search` or `tool_describe`. Essential secret handling and untrusted-content rules stay in the
permanent instructions. Each rule has one place: the Vault, wait, and memory-selection details are in
their tool guidance or descriptions, and the teammate reply format and the rule against
acknowledgement loops come with each teammate message (`agent/delivery-content.ts`).

## Sessions and recovery

An agent owns a stable workspace and Tommy thread. Its provider session binding can change when the provider, account or model changes. On restart the host reconciles pending turns against provider history and the mailbox. Retrying a failed turn that already acted can duplicate external changes.

## History retrieval and replacement sessions

A replacement provider session receives a handoff of at most 32,000 characters, including headers
and message identifiers. The budget reserves 24,000 for recent messages, 4,000 for older excerpts,
2,000 for captured work steps, and 2,000 for instructions and references. Unused space can hold more
recent text. Large latest user and assistant messages keep their start and end. Excerpts are not
semantic summaries. Handoff construction stops reading pages when its packet is full and does not
start old provider processes to get work steps. Existing stored conversations and summaries remain.

Two deferred tools recover omitted text without model calls for search or summarization:

- `history_search` searches the calling conversation, with five results by default and ten maximum.
  Each excerpt is at most 400 characters. Its serialized tool result is at most 8,000 characters.
- `history_read` returns recent messages, a named message, or a page before a returned cursor.
  It returns ten messages by default and twenty maximum, within a 16,000-character serialized result.
  `nextOffset` continues a large message. With `includeWorkSteps`, `nextWorkStepsOffset` can be passed
  as `workStepsOffset` to continue a large or heavily escaped capture. Captures contain selected work
  steps, not raw provider reasoning or full tool results. Missing or corrupt captures do not block chat.

New captures use `provider-work-steps/v2` and the unique database session ID. Two providers can
use the same native session and turn IDs without sharing captures. Legacy capture files have no
ownership record. They remain on disk while their sessions remain recorded, but are not served as
history or handoff evidence. A new capture restores work-step access; saved chat text is unchanged.

The router requires an exact native-thread binding and the loaded client. It never falls back to
the personal conversation. Database reads check thread ownership and canonical conversation order.
The latest context-reset marker excludes earlier messages. Cursors name a stored anchor and the
current reset; supplied ordering values are not trusted. File reads are followed by another check
of reset, message existence, and message content. Channel history continues through `channel_history`
and its assignment checks.

Claude model and effort changes use its live setters at the next turn, without replacing the
native session or restarting its query. Standing instruction or access changes retain the existing
refresh path. No-op profile saves do not unload sessions. Logs count provider-session starts by
reason and Claude configuration restarts, without conversation text.

## Background memory review

`agent/memory-review.ts` reviews an agent's memories in the background. Each conversation has its
own count: the agent's own chat and each side thread. A review starts after 20 completed turns of a
conversation, after 15 minutes with no turn in a conversation that has 3 or more new turns, when
the user clears the chat, and when a side thread with new turns closes. Turns of channels
and routine runs do not count. A turn in which the agent changes its memories
itself starts the count again. A deleted side thread is not reviewed, and its running review ends.
The counts and the last reviewed message are in memory only; after a restart, a review reads the
latest messages.

The server loads the saved review interval from `tommy-memory-review-v1.json`. The supported intervals are 10, 20 (default), 40 turns and Off. The agent service reads the interval when it considers a review. Off suppresses all triggers while preserving the counts.

The review is one profile-client generation without tools, on the agent's own provider. It uses
the provider's default model (`defaultProviderModel`) when that model is listed and its standard
input price in `usage-pricing.ts` is lower than the price of the agent's model, with that model's
default reasoning effort. Otherwise, also when a price is not known, it uses the agent's own model
and reasoning effort. The review
does not reuse the main chat's prompt cache: its prompt and tools are not the chat's, so its input
is billed at the full rate. It reads the agent's profile, its memories, and the conversation since the last review and after
the latest context reset, with the side-question transcript budget. The prompt holds every
essential memory and as many searchable memories as fit 12,000 characters: first those that share
the most words with the reviewed conversation, then the newest. It states how many are not shown,
so a review stays the same size at any memory limit. Chat and memory text pass through
the secret redaction before the prompt is made. The model answers `add`, `update` and `forget`
operations as JSON. `AgentMemories.applyReview` commits them as one turn through the checks of the
memory tools: the memory limit, the essential budget, duplicates and the user's selections. A
review does not change a memory that the user wrote or whose inclusion the user chose, a memory
whose text changed after the review read it, or a memory whose text the redaction changed. A memory
clear during the review drops all of its changes.

Only one review runs at a time, and only when a profile-client slot stays free for the user. A
review that cannot start waits, and starts when the running review ends or at the next turn. A
clear's review that waits for longer reads the new chat, not the chat that the clear ended. A failed generation or an answer that is not JSON is logged
and shows nothing. A usage limit is skipped silently and does not mark the model. The changes show as a
memory-changes line with its own `memory-review-` turn id, in the conversation that was reviewed.
While a turn of that conversation runs, the line waits for the turn to end. Agent deletion and service stop end a running review.

## Compaction ownership

Codex completes explicit compaction through turn events. Pi completes it through the request response. Claude manages compaction natively. The scheduler avoids holding the queue for a client without an explicit compact operation. When an explicit request ends it releases the hold and keeps the minimum-growth guard.

Codex retains the 80% threshold based on its last reported token usage and context-window size.
Cumulative account usage is not context occupancy. A missing report is not zero usage. No fixed
200,000-token context window, per-turn model summary, or new automatic model call is added.

A compaction progress estimate uses elapsed time and the duration of the preceding compaction. The terminal provider event determines the outcome. Context occupancy belongs to one native session. A new session, a reset or a provider switch drops its previous occupancy. A side thread uses its own session.

## Model catalog

`ModelCatalog.refresh` in [model-catalog.ts](../../src/backend/agent/model-catalog.ts) reads `model/list` from a running provider. The [provider driver](../../src/backend/provider-drivers.ts) owns provider-specific discovery. Codex pages through model results and supports a Fast tier. Claude supplies its model names. Pi lists the models that its running CLI can use.

## Provider CLI updates

The [runtime manager](../../src/main/provider-runtime-manager.ts) manages installation, version selection and cleanup. [Runtime descriptors](../../src/main/provider-runtime-descriptors.ts) define the supported providers and binaries. The public runtime blocklist also serves installed releases. Keep its format readable to them.

Use [installation and provider setup](../INSTALL.md) for credentials. A provider login is separate from an MCP tool's [OAuth sign-in](integrations.md#mcp-sign-in). For an unresponsive process, inspect the service logs and the provider CLI under the service account.

The runtime manager reads upstream release metadata, checks the pinned target and checks each published artifact digest where the source provides one. The version blocklist on `main` suppresses new offers for a broken version. It preserves installed copies. An explicit provider executable path takes precedence over managed and discovered copies.

The provider runtime holds new turns while it installs and activates that managed executable. It
keeps the previous client until the candidate is ready; activation failure removes the rejected
artifact and preserves the old runtime, so a release that does not start leaves the last working CLI
in use. Download status stays `finishing` until activation succeeds.

A version is staged separately from the installed copy. An install that finds the destination occupied verifies it and adopts it if valid. A replacement first claims the destination, then verifies it again. This prevents competing instances from replacing a copy that another instance has just installed. A running provider holds new turns during replacement. An active turn, an in-flight delivery or compaction must settle before activation. Both success and failure release held deliveries. Replacing a CLI uses the resume hook, since restart reconciliation would incorrectly mark active deliveries on other providers interrupted.

## Cursor

Cursor runs `cursor-agent acp`. `resolveCursorCli` searches for `cursor-agent`. The executable named `cursor` starts the editor. The managed runtime is downloaded to the host. A confined process uses `CURSOR_CONFIG_DIR` under its own configuration directory. Cursor also supports `CURSOR_API_KEY` in the service environment.

The CLI reports no usage over ACP. [Cursor usage](../../src/backend/cursor-usage.ts) reads the account's plan under the service account and asks for current-period usage without starting a CLI process. Where the plan reports separate allowances, Auto and API models have separate windows for the same billing cycle. A missing token, rejected credentials or a response with no percentages yields no reading.

## Pi

Pi uses its native `--mode rpc` interface. It does not use an ACP wrapper. Requests have IDs;
`agent_settled` completes a turn. A successful `prompt` response only accepts the prompt. Cancellation
clears queued work before abort. Session paths and the active conversation branch are preserved.
Models come from the running CLI. A small extension uses Pi's `registerMcpServer` interface to
register configured MCP servers and Tommy tools. Secrets are supplied through process state,
not copied into the extension source.

The managed Pi archive comes from an official release and uses its published SHA-256 digest. See the installation guide for the host account's provider sign-in.

## Backup models and failover

An agent keeps an ordered list of backup models (`AgentBackupModels`, at most 8) in `agent_json`.
The `update_profile` tool can set this list.
When the list is automatic, `UsageLimitGate` and `AgentService.#usageLimitMove` move the agent to the
first ready model in the order that no hold covers. `usageLimitReturn` keeps the model the agent
left, and the agent goes back to it when its hold ends. A model the user picks drops the return.

Two holds move an agent:

- A plan usage limit holds the queue of every agent on that provider account and model until the
  reset. A usage reset that the user starts also ends it (see [Usage reset credits](#usage-reset-credits)).
- A provider error holds nothing. `TurnLifecycle` checks the turn's error with `classifyFailure`.
  The causes are `billing`, `provider_unavailable`, `rate_limit`, `authentication`, `network` and
  `timeout`. When the turn did no work yet (`!acted`) and the agent has a ready backup, the turn's
  messages go back to the queue and `UsageLimitGate.failed` passes over that model for 10 minutes.
  The next drain moves the agent, and the turn runs again on the backup with no error banner. The
  hold also ends when a turn on the model completes. A restart clears the holds, so the first drain
  after it goes back. The return is marked `cause: "provider-error"`, so the notes read
  `model-switch:provider-error` and `model-switch:provider-error-ended`.

A turn that wrote text or ran a tool fails with its error, as with no backup. Tasks, channel tasks,
a refused `turn/start`, and a provider that fails to start do not fail over. A message runs again at
most once for each model that failed it, so a move that cannot happen shows the error on the next
failure; the check for a ready backup runs again when the turn ends.

## Usage read pacing

`UsageReadGate` in [usage-read-gate.ts](../../src/backend/agent/usage-read-gate.ts) coordinates reads for the provider sign-in and each additional account. Concurrent requests share one read. A successful reading can answer for four minutes. A limit window that resets after the reading can cause an earlier refresh. On failure, the wait starts at five minutes and doubles to one hour. The last reading remains available while the gate waits.

A new credential or sign-in clears the cached reading and reset credits. A read started before the reset cannot set the next read time for the new account. Direct reads after a provider start, a plan limit or a usage reset update the relevant gate. This keeps an account's stale reading out of a later sign-in.

## Usage reset credits

Codex can give an account usage reset credits: one restores the spent usage limits of the account at
once (issue #2859). `account/rateLimits/read` counts them in `rateLimitResetCredits.availableCount`,
and `account/rateLimitResetCredit/consume` spends one; both are stable Codex app-server methods since
0.156.0. `ProviderRuntime.#refreshUsage` keeps the count of each client with its usage reading.
`usageResets` reads the provider's own sign-in again while its process runs, and keeps the last count
while it is released; an account after the first uses the reading that the account runtime keeps (see
[Usage read pacing](#usage-read-pacing)). An account whose reading has no count is left out. `resetUsage` sends the consume with a new
`idempotencyKey` for each reset the user asks for, through the running client, an agent's process or a
short one in the account's folder. Then it reads the account's usage again and sends `usage-changed`.
After the answer `reset`, or `nothingToReset` (no limit of the account is spent), `AgentService` calls
`UsageLimitGate.accountReset`, which ends each limit of that account, so its held agents start again. Other providers have no credits: `resetUsage` refuses them.

Only Codex exposes this operation. A reset consumes a real account credit. The server must associate the request, subsequent usage read and released holds with the same account.

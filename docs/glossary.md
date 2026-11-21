# Glossary

The product terms Tommy uses, and the identifiers each one owns. Read this when naming a new type,
table, IPC channel or product string, or when a term in the code disagrees with the term in the UI.
[CONTRIBUTING.md](../CONTRIBUTING.md#terms) carries the two naming rules that are decisions rather than lookup.

- An **agent** owns an identity (`AgentStore`, `AgentSummary`, `agent-${uuid}`), workspace and entry in `projection_agents`. **Teammate** is a word the agent can use when speaking to the user. Released template records can still contain the name, instructions, skills and routines of an agent.
- A **browser profile** is the persistent browser session used by one or more agents. Named profiles have a `browser_profiles` row and a `persist:tommy-browser-profile-<id>` partition. The shared partition and agent-specific partitions have no profile row. An **agent profile** stores the agent's identity and description.
- **bot**: do not use for new product code. Keep released names: Team API v1-v3
  `bot`/`botId`/`bots-changed` (`current-agent-keys.ts` translates), `bots.json`, `mailbox.json`,
  `legacy-import:bots:v1`, and readable `~/Tommy/Bots` path prefixes. Accept `bot-<uuid>` IDs from
  databases that did not run migration v13. `"first-bot"` is a released avatar seed.
- A **channel** is a shared multi-agent chat (`ChannelStore`, `ChannelSummary`, `projection_channels`, `channel-chats-v1`). A **section** groups agents in the directory. **Group** is a user-facing word.
- A **workflow connector** connects a workflow trigger or output to an external service configured on the host. The GitHub, Slack and Telegram connectors each have their own credentials. A connected **MCP server** supplies callable tools.
- A **messaging connection** or **messaging thread** in historical records identifies an external chat workspace or conversation. The original tables and released wire names preserve those identities. Current private Telegram chats use the owner and agent bindings on the host.
- The **server** is the Linux host that runs Tommy and keeps its database. The **manager chat** is the owner's private Telegram conversation that manages agents. An agent can have its own bound chat.
- **thread**: durable `projection_threads` record. **conversation**: its read projection, with no
  separate table. **provider session**: private CLI resume state (`projection_provider_sessions`).
  **team session**: authenticated remote connection. **turn**: one exchange in a thread.
- **side thread**: a second conversation of one agent next to its own chat, the **main thread**
  (`projection_agent_threads`, `AgentThreadRecord`). The UI calls both a thread. Code and the
  `agent-tasks-v1` wire still call a side thread a **task** (`AgentTask`, `taskId`), and its task id
  is `legacy_task_id ?? thread_id`. To **archive** a side thread closes it (`closed`, `archived_at`) and preserves its messages. A stored **branch** is a side thread that starts with a copy of another thread through one finished turn (`AgentTaskBranch`, `branch_*` columns).
- **Agent access** determines the runtime permissions of an agent. Released role names describe the access that an earlier client or member held.
- **routine**: a saved instruction for an agent or channel, with one schedule or webhook trigger
  (`EventRoutineTrigger`). Agent routines use `projection_agent_routines`. This is not Claude Code
  `/schedule`.
- **webhook routine**: a routine with a webhook trigger (`RoutineWebhookTrigger`). A signed request
  to its URL starts a run. The trigger can require one event type and data filters
  (`projection_routine_webhooks`, `projection_channel_routine_webhooks`). There is no shared event
  source.
- A **webhook route** associates an opaque ID with its routine or workflow on the host. A **receipt** records a delivery ID for deduplication in SQLite.
- **workflow**: a stored graph whose nodes can name several agents, models,
  conditions, approvals and outputs (`WorkflowStore`, `Workflows`, `workflows`, `workflows-v1`). It
  is not a **routine flow**, which hands the answer of one agent's routine on to other agents
  (`routine-flows-v1`). A **workflow run** is one pass through a copy of the graph
  (`workflow_runs`); a **workflow step** is one try of one node, in a run or alone
  (`workflow_steps`). A **workflow version** is a saved copy of the graph that the user can restore
  (`workflow_versions`). A **workflow webhook trigger** is a trigger node with a webhook route of
  the `workflow` owner kind (`workflow_trigger_webhooks`).
- **shared memory**: a saved fact that every agent of this server has, such as who the user is or a
  decision for all agents. It is a row of `projection_agent_memories` whose owner is
  `SHARED_MEMORY_OWNER_ID` (`tommy-shared-memory`) in place of an agent id, so it has no table,
  aggregate type or tool of its own: `remember` with `scope: "shared"` saves one. It is not a
  **channel memory** (`projection_channel_memories`), which only the members of one channel get, and
  not a **shared table**.
- **shared table**: a table an agent created in the one file every agent shares
  (`~/Tommy/Shared/Data/agent-data.db`, `SharedTable`, `AgentTables`). `tommy.db` is the
  application's database and holds none of these. **owner**: the agent whose id
  `tommy_metadata` records for a table, and the only agent that can drop or alter it; other agents can still read and write its rows.

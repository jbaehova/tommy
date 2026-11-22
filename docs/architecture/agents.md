# Agents

## Agent identities and threads

Each agent owns a workspace, instructions, memory and one main conversation. An agent can also have side threads with their own provider session, message queue and results. Work can change provider or resume after restart without creating another public agent.

A section groups agents. Telegram agent creation records the new agent's section and an operation receipt. A retried creation can reuse that receipt. Unlinking an agent's Telegram connection keeps its work and stored identity on the host.

Side threads use an independent drain lane. A stored side thread from the earlier task schema keeps its legacy task ID. Older mailbox messages can still identify its work. Reopening the thread, draining an interrupted queue or changing the provider must preserve this mapping.

## Agent threads

A side thread (in code and on the wire still a **task**) is a separate execution thread of one agent.
The agent keeps one identity, workspace and provider settings; each side thread has its own provider
thread, conversation, queue, progress and result. The agent's own chat is its main thread and has no
side thread row. `projection_agent_threads` (`src/backend/agent-threads/agent-thread-schema.ts`,
migration 47) holds one row for each side thread, with its title and the source of the title
(`auto`, `agent` or `user`). Migration 47 moved every task of `projection_agent_tasks` (migration 38)
there: a closed task became an archived thread, and the task id stays as `legacy_task_id`. The task id
of a side thread is `legacy_task_id ?? thread_id`, so a stored mailbox message and a released client
that name the task still find it. A mailbox message with a `taskId` belongs to that side thread, and `DrainScheduler` drains each task as its own lane. The main chat
lane does not count toward the task limit. At most `limit` task turns of one agent run at the same
time. `agentTaskLimit` gives the limit: the agent's local `taskLimit` setting (1 to
`AGENT_TASK_LIMIT_MAX`, in `agent_json`), else `AGENT_TASK_LIMIT_DEFAULT` (2).

Once the task limit is reached, additional task deliveries wait. Queued tasks resume after boot recovery. When a provider session ends, a new session receives the transcript of that task. The main chat has a separate lane.

Shared writes: each task thread owns its own browser tabs and tab queue. Computer Use is an MCP
server that the provider starts, so Tommy cannot queue its calls; `ThreadLifecycle` starts a task
session without it, and the instructions send desktop work to the agent's own chat. Tasks share the
workspace, and Tommy does not lock files; the `start_task` guidance warns the agent about this.

A pending provider or account change is stored on the agent as `pendingRuntime` while work is running. The next drain applies a queued change before it starts the next message when the agent is idle. It retires the chat and task provider sessions so that each receives its own handoff. A failed queued change is cleared. Automatic backup moves also check the agent's active work.

## Agent communication policy

Agents send work through the local mailbox. A delivery records who sent it and which turn received it. The Telegram runtime uses that chain to locate the owner of a delegated turn. An agent's own chat can mirror its exchanges with other agents, subject to the current chat binding and redaction rules.

The shared developer instructions keep routine teammate exchanges internal by default. Agents
should start or resume work without narrating setup, context loading, discovery, or readiness.
Progress updates focus on meaningful outcomes, completed work, material changes, blockers, failures,
and required user input or approval. Delegated work still needs an explicit reply to the requesting
teammate; acknowledgements must not become loops. Relevant findings belong in the task result, and
the user can ask for a detailed coordination report.

An agent does not refuse a task, or say that it has no access to a service, before it tries each
path. When the task is outside its profile, or names a service that a teammate may own, it calls
`tommy.list_agents` first and delegates to a teammate whose name, title or description covers
the work. In a channel task it delegates only to a channel member. MCP servers are host-global, so
a specialist teammate differs only by its profile, skills and memories. Otherwise the agent uses its
connected MCP servers, its skills, the embedded browser and Computer Use.

An agent also shares news without a request. When the user, a routine run or a tool result gives a
new fact that clearly falls in the remit of another teammate, such as a deadline or a decision on its
topic, the agent sends that fact once with `send_message` and `expectsReply` false, and tells the
user in one line which teammates it told. It does not pass on facts that a teammate sent it, so a
fact does not go round. The recipient saves a lasting fact with `tommy.remember`. A fact that every
agent needs does not go by message: it becomes a shared memory (see [Shared memories](#shared-memories)).

Tommy does not depend on the agent for this. `NewsShare` (`src/backend/agent/news-share.ts`) checks
each completed turn that the user or a routine started, outside a channel. One generation without
tools, on the model and the reasoning effort of the agent, reads what was said, the tool steps,
the answer, the remits of the other agents, and the latest messages that the agent sent. For each
fact that a teammate needs, Tommy queues a message in the agent's name with `expectsReply` false,
so both chats show it as a message between agents. The check sends nothing to a teammate that the
agent told in that turn, nothing when the user asks to keep the turn private, and it does not read
a turn that a teammate's message started. Text is redacted before the model reads it and before a
message goes out. The provider's smaller background model is not used here: the user chose the
model of the agent, and which smaller model can make this decision changes with the provider and
with time. The turns that wait for their check are in memory only, so a restart
drops them. `bun scripts/news-share-e2e.ts` checks this path with a scripted model answer.

An agent that delegates work can follow and stop it. `tommy.list_agents` reports each agent's
description to 300 characters (`read_agent` returns all of it), its
`status` (a starting delivery and a context compaction count as `working`), `queuedMessages`
(channel work excluded), `turnStartedAt`, and `lastActivityAt`. The last two come from the provider
notifications that `TurnLifecycle` sees; they are in memory only, so after a restart
`lastActivityAt` falls back to the newest message for the agent. Tommy does not record which
files a turn changed. `tommy.interrupt_agent` (`src/backend/agent/agent-interrupt-tool.ts`)
refuses the caller itself, a channel turn, and a turn that any delivery other than the caller's
started, so an agent cannot stop work from the user, a routine, or another agent. It cancels the
caller's queued requests to the target before it sends `turn/interrupt`, because the interrupted
turn drains the queue as it completes. It keeps the caller's answers, because the target can hold
them (see below). Then it queues a notice from the caller with `expectsReply` false. The notice
starts one short turn on an idle target, so the provider thread records why the work stopped.

An answer to a request that went to two or more teammates waits in the requester's queue while
another teammate's copy of that request is queued, starting or running (`MailboxStore.nextQueued`).
When the last copy ends, the waiting answers start in one turn, and the prompt names each teammate
whose copy ended with no answer. A message from the person does not wait: it starts at once and
takes the answers that are already in. Each end of a copy schedules a drain for the requester.

The busy-message mode says what a message sent while the agent works does. The host default is
"steer" (`DEFAULT_BUSY_MESSAGE_MODE`), so the message goes into the running turn. A saved host
default or an agent's own setting can choose "queue". A provider that does not steer natively
queues the message in both modes.

An incoming agent message can steer a running chat only if its provider supports steering and the recipient's mode permits it. Task and channel deliveries remain queued. When several agents answer a common request, their replies wait for the group as described above.

## Shared memories

Each agent has its own memories, which no other agent reads. The shared memories are the facts that
every agent of the server has: who the user is, how the user wants every agent to answer, the user's
environment and accounts, and decisions for all agents.

- A shared memory is a row of `projection_agent_memories` with the owner `SHARED_MEMORY_OWNER_ID`
  (`@tommy/contracts/agent-memory-context`) in place of an agent id. So there is no migration and no
  second store: `AgentMemoryStore` and `AgentMemories` (`src/backend/agent/agent-memories.ts`) give
  it the selection, the search index, the staging in a turn and the checks of an agent memory. An
  agent id starts with `agent-` or `bot-`, so no agent has that id, and the removal of an agent
  deletes only the rows of its own id.
- An agent writes one with `tommy.remember` and `scope: "shared"`. A `memoryId` names its owner, so
  an agent corrects or forgets a shared memory as it does its own, and it cannot name a memory of
  another agent. `search_memories` reads the agent's own and the shared memories in one query, and
  a shared result has `scope: "shared"`. `list_memories` takes `scope`.
- The essential shared memories go into the saved-memory block of every agent, after its own, each
  with `"scope":"shared"`. They have a budget of their own, `SHARED_MEMORY_CONTEXT_BUDGET_BYTES`
  (4,096 bytes), because every prompt carries them. The others are found by search only.
- A change of the essential shared memories unloads the threads of every agent, as a change of its
  own memories does for one agent, so the next turn of each gets the new block. A change that only
  search finds unloads nothing.
- The background memory review reads the shared memories with the agent's own, and its `add` takes
  `scope`. It keeps a fact of the agent's own work as an own memory, and does not add an own copy of
  a fact that a shared memory says. As for own memories, it never changes a memory that the user
  wrote or chose.
- The memory changes of a turn show in the chat of the agent whose turn made them, also for a
  shared memory. In Telegram, `/memory` lists the agent's memories and then the shared ones.
- An isolated channel still saves `tommy.remember` as a channel memory, with any scope: what its
  members learn there does not leave it.
- A shared memory is untrusted data for the agent that reads it, as each saved memory is: another
  agent can have written it. The rules tell an agent to put no secret and no private data that the
  other agents do not need in one.
- Memory search (`AgentMemoryStore.search`) matches a Korean word by its prefix and by its stem
  without the last one or two syllables, because the `unicode61` tokenizer keeps a word and its
  particles as one token.

`scripts/shared-memory-e2e.ts` runs these rules against the real store and database.

## Scheduled routine changes

The agent scheduler reads the due list once per pass. It reads each routine again before it starts
that occurrence, because queueing an earlier run can yield. A paused or deleted routine, a replaced
trigger, or a moved due time leaves the old list without starting work. An edit that keeps the same
trigger and due time uses the current instruction and policies. The run row still commits before
the trigger advances or completes, so restart recovery keeps the same run and mailbox delivery.

## Quiet routine runs

A scheduled, script or webhook run of an agent routine can end without news, in two ways. No person
waits for the answer of such a run (`quietRoutineRun`). The run history stores what started a manual
run in `run_source` (`test`, `script` or `webhook`); a manual run from before migration 35 has none
and is read as a Test run. The agent calls the
`routine_no_update` tool, which the run prompt names, or the user asks in the routine task
for an answer of only `[[no-update]]`. Models often write a short sentence instead of an exact
token, so the tool is the main path. There is no setting. The tool and the marker do not
depend on the language of the answer (`src/backend/agent/routine-quiet-runs.ts`). The tool call is
held in memory until the turn completes; the history import finds it again by the tool name, as
it finds the marker by its text. When a turn that ran only quiet routine runs completes and every
answer is the marker, or the agent called the tool and the turn gave no file, image or question, the
turn drops its markers, thinking and plan from the conversation. Each other text answer stays with the
item type `routine_quiet_answer`.

A quiet turn keeps a run record. It restores the prior agent preview when available and marks completion as quiet, which suppresses an empty Telegram reply. A longer answer containing the marker is shown. A Test run is never quiet.

## Failed routine runs

A run's status comes from its queue delivery (`routineStatusForDelivery`), so a completed turn is a
`succeeded` run, also when the task inside it failed. Every run prompt names the
`routine_report_failure` tool, the Test run and a flow handoff too. The agent calls it with a short
`reason` when the task could not be done. The reason is held in memory until the turn completes.
When the turn completes, each routine delivery of the turn ends `completed` with the reason in its
`error` column (redacted as other errors). The agent did answer, so the answer, the chat digest and
the notification are as before. `routineStatusForDelivery` maps a completed delivery with an error to
a `failed` run with that error, so the run goes from `running` to `failed` in one step, and every
later reconcile keeps it failed. No column was added. A failed run is never quiet, also after a call
to `routine_no_update`: that call then answers `shown`, and the history import keeps the answers. A provider error or an interrupt still wins: the delivery then ends `failed`
or `interrupted` with its own error. The run history shows the error of a failed run. A result
destination gets the answer of a failed run whose delivery completed; a provider failure has no
answer and sends nothing. Outside a routine run the tool returns the same error as
`routine_no_update`.

A routine run whose last answer is only the marker, also a Test run that shows it in the chat, does
not put the marker in the preview either. The provider history import
(`src/backend/provider-history-import.ts`) decides from the staged items alone: in a turn that a
routine delivery started, it skips each answer that is only the marker, and when every answer is
the marker it skips the turn's thinking too, so a later import does not bring a quiet turn back.

## Routine sessions

A routine run in an agent's own chat (no task or channel delivery) does not resume the
chat's provider session. `DrainScheduler.startDelivery` starts a new session for it with
`ThreadLifecycle.startRoutineThread`: the chat's thread parameters, with `ephemeral: true` and
`persistSession: false`. `ConversationRuntime` binds the session to the agent's public thread, so the
run's items show in the chat, and `registerRoutineSession` marks it. The first message reads a short
handoff of the newest chat messages (`renderRoutineHandoff`, 8,000 characters). Interrupt and steer
go to the routine session while it runs. Usage records of the run use the session id
`routine:<external id>`; their origin stays `routine`.

When the turn ends, `TurnLifecycle` closes the session (`closeRoutineThread`). A non-quiet run adds a
short digest of its answer to the chat session's pending handoff (`appendRoutineDigest`: 1,500
characters for each run, 6,000 in total), so the next chat turn reads it. The chat session keeps its
id and its context. A restart during a run marks the run interrupted: the session is not saved.

## Routine flows

- `src/backend/routine-flows/` owns the three tables of migration 31: links, node positions and steps.
  The rows are written directly, not through `dispatch`, because a step holds the text that one agent
  gave another, and the event log is never deleted from. `hardDeleteAgent` removes the rows of a
  deleted agent; a deleted routine or run takes its rows by foreign key.
- `RoutineFlows` (`routine-flows.ts`) is an Effect service on its own managed runtime. It never
  listens to a provider. On a turn, queue or routine event it sweeps: it records the answer of a run
  that ended, settles each step whose delivery ended, and sends the next messages. Sweeps run one at
  a time, and one more after a sweep runs again for an event that arrived during it. Startup sweeps
  once, so a flow that a restart stopped continues.
- A link belongs to one routine and applies only to runs that started after it. An agent with several
  inputs waits for all of them and gets them in one message. An agent whose inputs all failed is
  skipped, so a failure never leaves a flow waiting.
- A handoff is a mailbox delivery from the routine (`RoutineScheduler.enqueueHandoff`). It names the
  same routine and run, but `reconcileDelivery` finds a run only by its own delivery, so the run status
  does not change. A `routine_report_failure` call in a handoff turn fails only that step, through its
  completed delivery's error, and the agents after it are skipped.

The agent tools `list_routine_flows`, `connect_routine_agents` and `disconnect_routine_agents` read and change flow links.

## Workflows

A workflow stores versioned graph definitions, triggers and execution state. A run uses its saved definition and records step results. A person can pause or revoke the trigger without removing earlier runs. New workflow connections use supported integrations. Historical graph nodes and previous output destinations remain readable. See [events](events.md) and [integrations](integrations.md).

- `src/backend/workflows/` owns the tables of migration 46: workflows, nodes, edges, versions,
  triggers, webhook triggers and receipts, runs, steps and output posts. The rows are written
  directly, not through `dispatch`, as for routine flows. `workflow-graph.ts` checks the graph rules
  (branch edges only from a condition, port types, limits). A graph can have loops. A save with an old revision
  answers the current graph as a conflict. The store keeps at most 50 versions: one when the newest
  is older than 5 minutes, one on a restore, and one when a run starts on a graph revision that has
  no version yet.
- `Workflows` (`workflows.ts`) is an Effect service on its own managed runtime. A run copies the
  graph. Each pass ends the steps that ended and starts each node whose inputs are in
  (`workflow-walk.ts`). Passes run one at a time; a pass runs after a turn or queue event, after
  each user action, and at startup. A node runs again when a node before it has a newer step, as
  after a retry. A retry uses the node's current settings, so a fix made after the failure applies;
  it uses the run's copy when the node is gone or is now another kind. An edge back to an earlier node (`workflowLoopEdges` in the contracts) is a loop:
  when its source is done and newer, the earlier node runs again with that answer as one more
  input. A loop has no pass limit. It ends when a condition takes the other branch, a step fails or
  is rejected, or the user stops the run.
- An agent step is a routine handoff (`AgentService.enqueueRoutineHandoff`, with the workflow as the
  routine) and ends when its delivery ends. Its tokens count under the agent. A model step and a
  condition run in a process without tools; a condition must answer yes or no, and only the edges of
  that branch stay active. That process (`warm-generations.ts`) stays for 5 idle minutes, so the
  next step does not start the provider again. Each step still starts a new ephemeral thread, so no
  step sees the text of another. The process stops when the provider's main client stops or
  changes, after a failed step, and at shutdown. These generations count under `WORKFLOWS_USAGE_ID`.
- An approval stays pending until the owner responds. A rejection stops the run. Output nodes can post to an internal channel or a configured external destination.
- `WorkflowTriggers` gives scheduled triggers to the routine timer as an extra due source. It skips an occurrence while the workflow has an open run. Missed occurrences become one run. A webhook trigger has its own route. GitHub deliveries for the same item wait until the earlier run ends.

- A restart keeps approvals and agent steps, because their state is in the database and the
  mailbox. The first pass fails a model step that was running, and ends a run that was stopping. An
  agent step fails with `agentMissing` when its agent is deleted. A post that did not start is sent; a
  post that was on its way fails as uncertain, and the user retries the step.

## Profiles and sections

Agents can read a profile's runtime, access, installed skills, routines and the names of its MCP servers. MCP commands, headers and environment values can hold secrets and stay out of the result. An agent may restrict an agent's access or Computer Use. The host applies those restrictions again at write time so a concurrent change cannot widen access. A new agent inherits the creator's access limits.

The section tools list, create, rename and delete sections, and assign agents to them. Removing an assignment ungroups the agent and retains its stored identity. Telegram agent creation persists a retry receipt for the originating operation.

Codex fixes dynamic tools at provider-session creation; resume does not update them. A local
`provider-toolsets` manifest records the tool fingerprint for each new Codex session. Sessions with
missing or outdated fingerprints are replaced before the next turn, using the existing history
handoff while retaining the public thread, agent identity, workspace, and stored conversation.
Unchanged fingerprints resume the existing session. Pending history handoffs are written before
the replacement is bound, reloaded after restart, and removed after a turn accepts the handoff.

The same handoff carries a chat to another provider after a provider switch. It holds the user and
assistant messages after the last context-reset marker, with attachment names only. The work log comes from provider captures. At the switch, before the old sessions are
retired, `ThreadLifecycle.readWorkSteps` reads each active session with the provider history read
through the client that holds it, with a 10-second limit. The switch then checks again that no turn started.
Only after the switch is stored, `saveWorkSteps` writes the rendered steps of the 60 newest turns to
`provider-work-steps/v2/<sha256(session id)>` (mode 0600), or `{}` for a session with none. The sessions
are retired before the write, so a turn that starts during it keeps its new session and reads the
provider instead. The file is
deleted and reconciled with the other session files, and a file that does not parse counts as no
capture. The handoff does not read a provider. A session without a capture, such as one that no
client held, gives no steps. `readCapturedSteps` (`src/backend/agent/handoff-tool-steps.ts`) renders
the work log: commands with exit code and output tail, changed file paths, tool
calls, searches and progress notes. The handoff adds the steps of each turn that matches a
transcript message. Each field is redacted before it is cut, and each turn has a
size limit. Reasoning, diffs, images and other provider-private state stay with the provider that
made them. A failed capture leaves that session's steps out. Codex returns tool steps from
its stored rollout. Claude returns only notes. An ACP agent keeps only the text and thinking of its
turns, so it also gives only notes, and only while its process holds the session.

A profile-creation marker is written before its workspace or agent row. Startup removes
uncommitted creations before mailbox initialization and queue draining, while a committed
retry receipt preserves the agent and its introduction. The existing sidebar reconciliation
removes assignments for recovered incomplete agents.

Reviewed instructions use the existing profile description. Profile saves coordinate
SQLite with the separately stored sidebar layout, rolling back section assignment
on failure. Updating an existing profile and its retry receipt shares a SQLite
transaction. Creation follows the existing workspace/initial-message flow with
cleanup on failure. Receipts make retries after a lost response return the saved
agent. This does not introduce a schema migration or alter released protocol codecs.

## Agent instruction file

An agent keeps its standing rules (persona, style, steps) in one file at the root of its workspace:
`AGENTS.md`, or `CLAUDE.md` when only that file exists. The profile description is a short summary
for teammates and the Team API; it keeps its meaning and its 2,000-character limit.

- `src/backend/agent/workspace-instructions.ts` finds, reads and saves the file. A link that goes
  outside the workspace is refused. A save writes the first file that exists, else it creates
  `AGENTS.md` with mode 0600. An existing file keeps its mode; a hard link to it is replaced by a
  new file. A save never deletes the file.

Changes made during a turn are compared to a baseline shared by the agent's threads. A detected change can record an `instructions-change` item with the previous and current text in `projection_thread_messages.message_json`. A turn reconciled on restart skips this change detection.

- The developer instructions name the file and tell the agent to keep its rules there.
  `workspaceInstructionFiles` in the provider descriptor lists the files that each CLI reads by
  itself from its working directory. `ThreadLifecycle` adds the text of the file, at most 32,000
  characters, only when the CLI does not read that file. Claude in workspace-only mode reads user
  settings only, so it gets the text.
- The text is redacted, and a `</agent_instructions>` tag in it is escaped.
- Codex keeps the instructions of a loaded session: the developer instructions, and the
  `AGENTS.md` that it read when the session started. The Codex tool fingerprint therefore includes
  the file name when it is not `AGENTS.md`, and the file text. A change to the file starts a new
  Codex session. Other providers read the file again when they start or resume a session.

## Local scripts API

`src/main/automation-server.ts` is a loopback HTTP listener through which a local script sends
messages, runs routines, and answers pending questions and approvals for an enabled agent. It also
reads delivery results, changes the agent's model and account, and starts a new chat. The listener runs only while at least one agent has `allowAutomation`, and binds
`127.0.0.1` on a free port. It writes the URL and a new bearer token to `<userData>/automation/`
(folder `0700`, files `0600`) and deletes them when it stops. It refuses any request with an
`Origin` header or a foreign `Host` before it checks the token, so a web page cannot reach it.

The grant lives in `agent_json`. Existing grants cover messages and prompt or approval responses as well as routine runs. A missing grant is off. A routine started by a script persists its payload with the run and recovers it after a crash. The developer instructions can name the token and endpoint files, but never include the token value.

Messages use `AgentService.sendMessage` and its persisted retry keys. The attention registry gives
each pending object an opaque local handle. Responses match that handle and agent together; an
expired handle cannot answer a later provider request. Pending details are not trimmed to the UI
snapshot budget. The HTTP boundary redacts outgoing values. Browser interaction requests and secret questions are notices only for local scripts. Messages and routine runs share the rate limit.

The packaged [script client](../../resources/cli/tommy-cli.mjs) uses this API. The operator's `tommy` command uses a separate local socket.

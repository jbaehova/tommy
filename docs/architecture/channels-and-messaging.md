# Channels and Telegram

## Shared channel chats

An internal channel belongs to the host. It has a purpose, member agents and a conversation history. A section groups agents in the directory. A channel gives them shared work and context. An external workflow connector posts to its configured service.

Each member's channel execution thread is separate from its main chat. The mailbox keeps the original sender and attached files. Task revisions stop an old assignment from completing a corrected request. Archiving a channel stops its work and keeps the records needed to restore it.

`ChannelStore` stores the canonical transcript, channel configuration, tasks, assignments, summaries,
execution threads, and human read positions in SQLite. Migration 18 adds these projections without
changing existing agent data. Channel commands use the orchestration log and command receipts.
Messages have stable IDs and per-channel sequences. A channel projection can be rebuilt from its events.
Archiving stops channel work and retains its records. Restore makes the chat available for new messages again. Neither action removes agents or linked conversations.

`ChannelService` selects the owners of a request. A selected recipient has priority, followed by the
task attached to a reply, a reply to a member message that has no task, a clear follow-up to the sole
open task or to the open root tasks that several members own for one request, and a channel with one
available member. These selections use no model. Other requests use
the lead's provider, model, and reasoning setting in a separate session with no work tools. The
request supplies the accepted result schema and the channel summary in place of the transcript.
Routing selects each member whose role or area the request touches, and only those (`agentIds`). A
request in the area of one member, or in the area of no member, goes to the one member best able to
answer it. A request for opinions or feedback on shared work goes to each member whose area gives a
different view, and a request to the whole group goes to all of them. Each selected member gets its own root task for the same request message, answers in its own reply, and
gets the request's attachments; its packet names the other members that answer, but does not carry
their replies to that request, so each member gives its own view. This stays true after a typed
"continue" makes the follow-up the request of a task: the replies count from the first request. After
the member wrote its own complete reply or result (not commentary), a follow-up gets the other replies, so it can ask about them. The packet cursor stops before the
first reply it leaves out, so a later turn of that session gets it. A member that the
model names but that cannot take work is left out. Invalid or stale routing cannot broadcast a
request. Routing can select an existing task, ask a question, or indicate that a message needs no answer.
An existing task that routing selects keeps its instruction, and the new message is its follow-up.
Each selected owner or existing task adds one channel message from the lead, so the selection is
visible and the user can correct it. Deterministic selection adds no message, and a lead that selects
only itself adds none: its reply shows who answers. A routing answer that does not decode pauses the
task with `channelRoutingUnreadable` and retains the task for reassignment. The log gets the answer length and its
field names only, not its text.

Channel work holds only the agent that does it. An agent runs one main-lane turn at a time: its chat,
a channel delivery or a messaging delivery. While the agent has an active assignment,
`ChannelService.mayDrain` holds its other main-lane requests. The work of other agents does not hold
it. The tasks of the agent run beside the channel turn within the agent task limit, and a channel
turn takes no task slot. When the provider of the agent runs one turn at a time (`concurrentTurns:
false`), its task turns count as busy. Only declared `browser` and `workspace:<path>` resources are
serialized: the same browser, or two workspaces where one path contains the other. An empty list,
`none`, and `host` (from an earlier version) reserve nothing. An assignment keeps the resources it
started with until it ends, and a task with an active assignment starts no second owner. An update
still waits for channel work on all of the host (`hasActiveWork`). These controls do not restrict
provider process privileges.

The channel copies the assistant rows of a member's execution thread. The first rows of a turn go
to the running assignment before it knows the turn id; a row of another turn does not. A new row
of an assignment that has ended is not copied: a turn sends its final rows before it completes, and
after a restart the provider history import can write an old turn again with new row ids. An empty
row is not copied until its first text arrives.

Task revisions prevent an old assignment from completing a corrected request. A retry retains the original files. Stopping a task pauses it and its descendants, interrupts active work and records `channelTaskStopped`. Reassignment waits for the previous assignment to finish stopping. Cancellation settles open tasks of the same root and keeps their messages. Startup checks accepted provider work before retry. An unknown outcome needs attention. Command, assignment and result IDs prevent duplicate internal dispatch. An interrupted external operation can still have taken effect.

### How a channel keeps context

`ChannelHistory.prepare` (`src/backend/channel-history.ts`) makes the packet of each turn.

| Step | Value | Where |
| --- | --- | --- |
| Packet budget | 120,000 characters (`CONTEXT_CHARACTERS`) | `channel-history.ts` |
| Transcript part | budget / 4 (`TRANSCRIPT_SHARE`), newest first | `newest()` |
| Summary in `prepare` | when the recent messages are more than the transcript part; it keeps the newest half of that part | `summarize` |
| Summary after a turn | at 0.75 of that threshold (`AHEAD_SHARE`), in the background | `ChannelService.#summarizeAhead` |
| Assignment again at the end | when 2,000 characters or less | `REPEATED_ASSIGNMENT_CHARACTERS` |
| Provider compaction | at 80% of the context window, or before a turn whose input would fill it over 80% | `ContextCompaction` |
| `channel_history` page | 24,000 characters (`HISTORY_PAGE_CHARACTERS`); a longer message is cut at 16,000 | `boundedHistoryPage` |
| Handoff of an agent in the packet | 24,000 characters (`HANDOFF_INSTRUCTION_CHARACTERS`): 18,000 first and 6,000 last | `cutInstruction` |
| Instruction of a task this task waits for | 500 characters (`DEPENDENCY_INSTRUCTION_CHARACTERS`) | `channel-history.ts` |
| Compaction stops | after 2 compactions that leave 80% or more; a `context_compaction_ineffective` notice | `ContextCompaction` |
| Compaction stops after failures | after 2 compactions in a row that fail or time out; a `context_compaction_stopped` notice. A completed compaction or a session under 80% starts the count again | `ContextCompaction` |
| Retry notice | at the 3rd provider retry; at 50% or more, a compaction before the next turn | `TurnLifecycle` |

- The packet starts with the current assignment. A short assignment comes again at the end, because
  a provider can cut a long message.
- The summary keeps the recent messages under the transcript part, so a message is in the summary
  or in the transcript. Only when the oldest recent message still streams does the summary wait,
  and the transcript then leaves out older messages with a line that tells how to read them.
- The task facts in the packet have no instruction or expected result: the assignment block gives
  them.
- The summary block is reference only. The request messages of the task are always in "Referenced
  messages", not only in the summary.
- A delta has no replies of the member that gets it: its session already has them. It has no
  fixed rules, and it has the channel facts only when they changed since the packet before it.
- A request that is the assignment is in the packet once: its transcript row refers to "Current
  assignment". A handoff of an agent over 24,000 characters is cut, with a line that gives the
  `channel_history` `messageId` and `offset` of the rest.
- `channel_history` gives a page of about 24,000 characters at most. A message over 16,000 characters
  is cut in the page and named in `cutMessages`; a read with its `messageId` and `offset` gives the
  next part.
- Before a turn, the drain gives `ContextCompaction.expectInput` the size of the message text (4
  characters a token). Attachments and images are not in this estimate. When the last usage and that
  text are over 80% of the window, the session compacts first.
- A channel with no lead summarizes with the model of the member that gets the packet.
- A change to `supersededAt` only does not reset the summary or the contexts. A text edit resets them
 .
- The summary uses the lead's provider. `backgroundModel` (`src/backend/agent/background-model.ts`)
  selects the provider's default model when its price is lower than the lead's model, as a memory
  review does. When the lead's provider or model is not available, the summary uses the model of
  another visible member.
- An isolated channel (`Channel.isolated`, off by default, in `channel_json`, so no migration) keeps
  what its members learn there. `TommyToolRouter` saves `tommy.remember` of a channel turn
  as a channel memory (`channel_remember`), and refuses a `memoryId`, so a channel cannot change an
  agent memory. Agent memories still reach the channel. The packet gives `isolated: true` in the
  channel facts with a rule line, and a line when a person turns it off. A save without the field
  keeps the stored value when the field is absent.
- After a turn, a channel starts one background summary. `prepare` waits for it only when its own
  budget needs a summary (`ChannelHistory.needsSummary`), so a turn does not summarize the same
  messages again. A deleted channel stops the summary. It does not start when it would take the
  last generation slot of `ProfileClients`: the next packet makes the summary. It uses the member's
  reasoning effort only on the member's own model.
- The log line "A channel packet was prepared." gives the size of each part (`packetParts`,
  `deltaParts`): assignment, memories, summary, referenced messages, transcript, and the count of
  kept and left-out messages. `otherCharacters` is the rest: the rules and the JSON facts. It never
  contains message text.

## Telegram: a turn in progress

The Telegram interface (`src/main/telegram-runtime.ts`) sends an answer when its turn ends. While
the turn runs, the chat shows two signs.

- **Typing.** From the start of the turn, the chat of the turn shows "typing", for 30 minutes at
  most.
- **Status message.** `TelegramStatus` (`src/main/telegram-status.ts`) sends one message when the
  turn runs longer than 30 seconds. It has a line that the agent works, with the minutes from the
  second minute, the last paragraph of the newest note of the turn (a commentary message or a
  reasoning summary, read with `TelegramAgentHost.turnNote`), and the newest tool step (the
  `turn-progress` event, in the owner's language). The message makes no notification
  (`disable_notification`). The status edits it in place, at most each 20 seconds and only when its
  text changed, and deletes it when the turn ends, so the chat keeps only answers.

Both go to the chat that `requestChat` gives for the turn, also for a turn that a teammate's message
started. A routine turn gets neither. The note and the step pass the same redaction as an answer.
The status message lives in memory: a server that stops deletes the messages of the running turns,
and a crash leaves them in the chat.

## Delivery and restart

The Telegram host listens for completed turns and reads the reply for the verified owner and chat. Queued deliveries store the turn address and chat generation. Rebinding or revoking the chat invalidates a pending delivery. The sender records progress after each part and uses the saved cursor on restart.

A visual reply can be a preview image and an HTML attachment. A failed render can fall back to the original file. Regular attachments and recorded Telegram voice messages stay in the message history. A missing file or a failed destination must never redirect media to another chat.

See the [Telegram host](../../src/main/telegram-agent-host.ts), [delivery queue](../../src/main/telegram-delivery.ts) and [Telegram host E2E](../../scripts/telegram-agent-host-e2e.ts).

---
name: tommy-t3
description: Start, resume, read and message T3 Code sessions on this server or on the user's Mac. Use when the user asks about T3 or T3 Code sessions or threads, or asks to hand work to one, on either computer.
---

# T3 Code sessions

T3 Code runs on this server and on the user's Mac. The `vps-t3` command controls the sessions of both. Use the Mac commands when the user says Mac, 맥, or a computer other than this server. If the request does not say which computer, ask.

## Commands for this server

- List projects: `vps-t3 projects`
- List sessions: `vps-t3 thread list --project <project id or path> --json`
- Start a session: `vps-t3 thread start --title "<title>" --json <project id or path> "<message>"`
- Continue a session: `vps-t3 thread send --json <thread id> "<message>"`
- Read a session: `vps-t3 thread show --messages 20 --json <thread id>`
- Stop a run: `vps-t3 thread stop <thread id>`
- Answer an approval: `vps-t3 thread answer <thread id> <request id> <accept|acceptForSession|decline|cancel>`

Add `--wait` to `thread start` or `thread send` on this server to wait for the reply. The exit code is 1 when the run failed, and 2 when the session waits for an answer.

## Commands for the Mac

- List projects: `vps-t3 mac projects`
- List sessions: `vps-t3 mac thread list [--project <project id>] [--title <text>] [--limit <n>]`
- Read a session: `vps-t3 mac thread show [--messages <n>] [--max-chars <n>] <thread id>`
- Start a session: `vps-t3 mac thread start --title "<title>" (--project <project id> | --scratch) -`
- Continue a session: `vps-t3 mac thread send <thread id> -`

Use `--scratch` only when the work has no project. There is no stop or approval command for the Mac. Tell the user to do these in T3 Code. There is no `--wait` for the Mac. Read the session later if the user wants the result.

## Messages

A long message goes on standard input, with `-` in the place of the message. For the Mac, always use a quoted heredoc, so that the shell changes nothing in the text:

```bash
vps-t3 mac thread send <thread id> - <<'T3_MESSAGE_END'
<message>
T3_MESSAGE_END
```

## A message to a session on the Mac

Write the message from what the user asked you to pass on. A session on the Mac cannot read this conversation, your files, or your memory, and it runs on another computer. Include everything it needs:

- The goal and what done looks like, and the user's instructions, with their exact words when these matter.
- The facts and decisions from this conversation that apply, and exact values such as names, numbers, URLs, and error text.
- The current state and the next action. Include the content of a file from this server when the session needs it, because it cannot read this server.

A new session knows nothing, so give it all of this. An existing session has its own context, so read it first when you do not know its state, and send only what is new. Do not add requests that the user did not make. Do not include a secret, such as a token or password. Say where it is stored instead.

## Rules

- `thread send` does not interrupt a session that runs. The message becomes its next turn. Do not repeat a send that failed until you read the session and see that the message did not arrive.
- Before you send to an existing session on the Mac, find it with `thread list`. If more than one session can match the request, or none matches, show the candidates and ask. Do not guess.
- Stop a run or approve a request only when the user asks for it. `thread show` gives the request id of a session that waits.
- A new session goes in a project. Ask the user which one when the request does not say.
- Tell the user the thread id of each session that you start.
- A Mac command fails when the Mac is asleep or off, or when T3 Code is closed there. Give the user the error and do not use a session on this server in its place unless the user asks.
- A success means that T3 Code accepted the message. It does not mean that the session finished the work.

# T3 Code and Tommy

[T3 Code](https://github.com/pingdotgg/t3code) runs coding sessions on a computer. Tommy and T3 Code
can send work to each other in two directions:

- **Tommy to T3 Code.** A Tommy agent starts, reads and messages T3 Code sessions on a linked
  computer. Set it up on the Tommy server with `sudo tommy t3 link`.
- **T3 Code to Tommy.** A T3 Code session (or another coding agent) asks a Tommy agent a question or
  gives it the session context. Set it up on that computer with `scripts/remote/install`.

Both are optional. Without them, Tommy works as before.

## Tommy to T3 Code

T3 Code answers MCP at `<address>/mcp`. `tommy t3 link` signs in there with a one-time pairing code,
and saves the token as the `Authorization` header of an MCP server row named `t3-<name>`. Every
agent of the server gets the tools that T3 Code gives an outside client from its next turn: for
example, list projects and sessions, start a session, send a message, and read a session.

### Requirements

- T3 Code runs on the other computer, and the Tommy server can reach its address. Use an `https`
  address, such as the one of T3 Connect or Tailscale Serve. Plain `http` is accepted only for
  T3 Code on the Tommy server itself (`http://127.0.0.1:<port>`).
- The `t3` command on that computer.

### Link

1. On the computer with T3 Code, make a pairing code:

   ```bash
   t3 pair --label Tommy
   ```

   It shows a pairing URL and a token. They stop working after 5 minutes, and after one use.

2. On the Tommy server, link it. Give the pairing URL, or the address and then the token when asked:

   ```bash
   sudo tommy t3 link --name mac --access approval-required 'https://t3.example.com/pair#token=<token>'
   sudo tommy t3 link --name mac https://t3.example.com
   ```

   `--name` is a short name of lowercase letters, digits and dashes. `--access` is the most that
   the agents can do there:

   | Access | Sessions that a Tommy agent starts or messages |
   | --- | --- |
   | `read-only` | Read sessions only. |
   | `approval-required` (default) | Ask for approval in T3 Code before edits and commands. |
   | `auto-accept-edits` | Edit files without approval. Other actions need approval. |
   | `auto` | The provider approves routine actions. Other actions need approval. |
   | `full-access` | Commands and edits need no approval. |

   An agent cannot approve a request on that computer. Approve it in T3 Code.

3. Check it:

   ```bash
   sudo tommy t3
   ```

   It shows each link, its access, when it ends, and the state of its MCP server row.

### Renew and remove

T3 Code gives the token 30 days and no refresh. Three days before a link ends, Tommy tells the owner
in the Telegram manager chat. To renew, make a new pairing code and run the same `tommy t3 link`
command again. Tommy replaces the token of the same MCP server row.

To remove a link:

```bash
sudo tommy t3 unlink mac
```

This removes the MCP server row. The session stays valid in T3 Code until it ends. Revoke it there
under Settings, Sharing & access, Authorized clients (Tommy shows there as `Tommy`).

### Security

- The token is in the MCP server row in the Tommy database, like other MCP keys. Tommy masks it in
  logs. The link file `tommy-t3-links-v1.json` in the data folder holds no secret.
- Every agent of the server gets the T3 Code tools. Choose the access for what any agent may do.
- An agent works with T3 Code only when the user's own message asks for it. A plan or a goal in
  the message, a routine run, a teammate message, or the agent's own idea is not such a request.
  The instructions of every agent say so. A Claude agent also refuses the T3 Code tools, and the
  `t3`, `vps-t3` and `tommy-t3` commands, in a turn that no user message started.
- An agent that reads a web page or a message can be told to misuse a tool. Use `full-access` only
  when you accept that risk for the other computer.

## T3 Code to Tommy

`scripts/remote/tommy-remote` runs the `tommy` command of the server over SSH: `agents`, `handoff`
and `ask`. The skills `tommy-ask` and `tommy-handoff` tell a coding agent how to use it.

### Requirements

- SSH from that computer to the Tommy server with a key, as a user that can run
  `sudo -n tommy` without a password. To allow only that command, add a sudoers rule on the server:

  ```text
  <user> ALL=(root) NOPASSWD: /usr/local/bin/tommy
  ```

- On the Tommy server itself (for example, T3 Code on the same server), only that sudo rule.

### Install

On the computer with T3 Code, from a clone of this repository:

```bash
scripts/remote/install --host tommy.example.com --user <ssh user> --identity ~/.ssh/<key> --source Mac
tommy-remote agents
```

On the Tommy server, give no `--host`. The command installs:

- `~/.local/bin/tommy-remote`.
- `~/.config/tommy-remote/connection` with the settings (mode `0600`).
- The skills in `~/.agents/skills` (Codex, T3 Code), with links in `~/.claude/skills` (Claude Code).

### Use

Ask the coding agent, for example "ask the Tommy agent Engineer what the last deploy changed" or
"hand off this session to Tommy". The skills run:

```bash
tommy-remote ask --agent Engineer "What did the last deploy change?"
tommy-remote send --agent Engineer --mode work < summary
```

`ask` waits for the answer (up to 600 seconds by default; `--timeout` up to 1800). `send` gives the
summary to the agent and returns a receipt. When the agent has a Telegram chat, the chat shows the
question or the handoff and the answer.

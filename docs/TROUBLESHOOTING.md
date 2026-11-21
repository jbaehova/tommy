# Troubleshooting Tommy

## Tommy says agent CLI setup is required

On the server, verify the CLI as the service user (`sudo -u tommy -H bash`):

```bash
codex --version
```

If the command is missing, install Codex using the official installer:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Then run `codex login` as the service user, sign in with ChatGPT, and restart Tommy. To use OpenAI
API credits instead of a ChatGPT plan, run `printenv OPENAI_API_KEY | codex login --with-api-key`.

You can use Claude instead. Verify and install Claude CLI:

```bash
claude --version
curl -fsSL https://claude.ai/install.sh | bash
claude auth login
```

If Codex is installed in a non-standard location, launch Tommy with `TOMMY_CODEX_PATH` set to the
absolute Codex executable path.

For a non-standard Claude location, set `TOMMY_CLAUDE_PATH` to the absolute Claude executable path.

If a Telegram agent reports that its engine sign-in expired, sign Claude in again on the server. A
server that runs all the time should use a token from `claude setup-token`; see
[Telegram interface](INSTALL.md#telegram-interface).

## Computer Use is unavailable

Computer Use needs the `agent-desktop` binary. The installed Linux release carries it in
`/opt/Tommy/app/resources/agent-desktop`. Reinstall a complete Tommy package and keep your Tommy data folder. The installed
application runs only the driver it was released with.

In a development checkout, run `bun run prepare:agent-desktop`, then start Tommy again. This command
writes the same pinned build the release ships. `TOMMY_AGENT_DESKTOP_PATH` selects a different
binary in a checkout; the installed application ignores it.

Tommy asks the driver once, at startup. Run the same check yourself on the computer that runs Tommy:

```bash
agent-desktop status
```

`permissions.accessibility.state` must be `granted`. After a fix, start Tommy again.

On Linux the driver reads apps through AT-SPI, so it needs the session bus of the desktop it drives,
the `at-spi2-core` package and a window manager. A Linux server install (`tommy-install`) adds
`at-spi2-core`, `libatk-adaptor` and `openbox`, and `tommy-server` starts `openbox` on the agent
display. `denied` with an empty `supported_surfaces` means the bus does not answer. An error that a
window type "could not be proven" means no window manager runs. An app appears only when its toolkit
registers on the bus: Qt apps need `QT_ACCESSIBILITY=1`, and Chromium browsers need
`--force-renderer-accessibility`.

## Computer Use is slow

The agent waits for the driver and then for its provider to choose the next step. In Telegram,
a long turn updates its status message with the latest progress.

A driver call usually takes a few seconds or less. To see the time of each call, start Tommy from
a terminal. Each driver call that takes 5 seconds or more shows in its output as `Computer Use
driver answered`, with the tool name and the milliseconds. A call that gets no answer before the
agent closes the connection shows as `Computer Use driver did not answer`. Set
`TOMMY_LOG_LEVEL=debug` to show every call. The log does not contain what the agent typed.

Most of the time in a slow step is the model. Its time depends on the model and on the reasoning
effort selected with `/effort`. A high effort can use tens of seconds before each action. For
mechanical GUI tasks, select a lower effort or a faster model. Name the application and the action
in your request, for example "Open https://example.com in the browser", so the agent does not look for
the target first.

A step also gets slower as the conversation gets longer. The model reads the full conversation
before each action, and each window read stays in it. When the conversation fills the model's
context, the provider compacts it: it writes a summary, which can take minutes, and the chat
shows no action in that time. A new conversation for a new GUI task does not have this cost, and the
agent keeps its workspace.

## A chat is missing after an update

Do not follow the reset steps below. Your messages are stored in one SQLite file, nothing copies it
before an upgrade, and moving that folder puts the only copy out of reach.

Restart the service with `sudo tommy restart` first. On launch Tommy gives a chat back to the agent it belongs to
when an agent and its chat lose track of each other, so a restart recovers most cases on its own.

If the chat is still missing, read the database in read-only mode as the service account. This reports chats that no
agent currently claims, and the number of messages waiting in each:

```sh
sudo -u tommy sqlite3 -readonly /var/lib/tommy/.config/Tommy/tommy.db \
  "SELECT t.thread_id, t.agent_id, (SELECT count(*) FROM projection_thread_messages m
     WHERE m.thread_id = t.thread_id) AS messages
   FROM projection_threads t
   LEFT JOIN projection_agents a ON a.agent_id = t.agent_id
   WHERE a.agent_id IS NULL;"
```

A row identifies a thread without a matching agent. The count shows how many messages are still on disk. Keep the folder in place and report the counts.

## Tommy will not start and names a stored agent profile

The message reads `Stored agent profile <id> has an unreadable "<field>" value`. Your data is intact:
Tommy stops before it writes anything, which is what keeps the profile as it is.

Do not follow the reset steps below, and do not move the folder. Install the current version first:
Tommy now repairs a stored profile field it cannot read and keeps the agent, its chat and its
workspace, while a release from before that repair refuses to start over the same profile.

If the current version still stops, read the profile it names in the Linux service database. Replace the placeholder with the reported ID.

```sh
sudo -u tommy sqlite3 -readonly /var/lib/tommy/.config/Tommy/tommy.db \
  "SELECT agent_json FROM projection_agents WHERE agent_id = '<id>';"
```

Report the field the message names, together with the details below. The output holds your own file
paths, so review it before you publish it.

## A company firewall or proxy blocks Tommy

Check inbound HTTPS to the public domain in the server configuration. Telegram must be able to reach the registered webhook. A phone that opens the Mini App must be able to reach the same domain with a valid certificate.

The server needs outbound HTTPS to Telegram and the enabled provider. Downloading a managed CLI can also require access to its release host. Each configured connector or MCP server needs its own endpoint. Use the service logs to identify which connection failed. Keep TLS verification enabled and install your organization's trusted CA through its supported procedure.

## Reset Tommy

Stop the service with `sudo systemctl stop tommy` before you move data. To reset the application
state and the shared browser profile while keeping agent workspaces, move this folder somewhere safe:

```text
/var/lib/tommy/.config/Tommy
```

To also reset agent workspaces, managed transfers, and downloads, move this folder as well:

```text
/var/lib/tommy/Tommy
```

Tommy creates fresh folders on the next start. Review and back up their contents first. Do not
remove `/var/lib/tommy/.codex` or `/var/lib/tommy/.claude` unless you intentionally want to manage
CLI login and history.

## Uninstall

Run `sudo systemctl disable --now tommy`, then remove `/opt/Tommy`, `/etc/systemd/system/tommy.service`,
`/etc/apparmor.d/tommy`, the nginx site and `/usr/local/bin/tommy`. To also remove the data, remove
`/var/lib/tommy` and `/etc/tommy` after the reset steps above. Agent CLIs and their data are
independent and are not removed with Tommy.

## Report a problem

Use the [bug report form](https://github.com/jbaehova/tommy/issues/new?template=bug_report.yml)
for reproducible bugs. Give the Tommy version (`sudo tommy status`), the operating system and
hardware, the provider and its CLI version, the steps, and the expected and actual results. Never
publish tokens, `~/.codex`, `~/.claude`, conversations, private files, Electron user data, or full
unreviewed diagnostics.

When Tommy stops by itself, look in `/var/lib/tommy/.config/Tommy/logs`:

- `main/main.log` has a `Quitting: <reason>.` line when Tommy quit by itself or was stopped.
- `trace.ndjson` has an `exit` line with the same reason, and a `crash` line for each helper process
  that stopped.

A dump in the `Crashpad` folder next to `logs` means a process crashed. Tell us that a dump exists,
but do not attach it publicly: it can hold secrets. When neither file has a reason and there is no
dump, something outside Tommy stopped it.

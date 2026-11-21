# Computer Use on the host

## Computer Use

Computer Use is `agent-desktop` (https://github.com/vercel-labs/agent-desktop), a third-party
Apache-2.0 binary. It reads apps through the operating system accessibility tree: AT-SPI on Linux and
the AX API on macOS. Tommy runs no process for it. `AgentDesktopRuntime`
(`src/main/agent-desktop-runtime.ts`) asks the driver once at startup, before the agent service is
made, and each provider spawns its own `agent-desktop mcp` when it starts a session.

`check()` runs `agent-desktop status` with the agent environment. The capability is `ready` only when
`permissions.accessibility.state` is `granted`: on Linux that means the AT-SPI bus of the session
answers, and on macOS that Tommy has the Accessibility grant. A driver that answers with anything
else is `setup-required`, and no driver or no answer is `unavailable`. The check runs once, so a fix
(a package installed, a grant given) applies at the next start of Tommy.

One MCP entry reaches every provider. While the capability is `ready`,
`AgentDesktopRuntime.mcpServerConfig()` returns the `agent_desktop` entry (id
`tommy-agent-desktop`), and `AgentService.enabledMcpServers()` appends it. Codex, Claude and ACP all
read that function. The name is not in `RESERVED_MCP_SERVER_NAMES`, which is a drop filter, and a
user may not save a server with it (`mcpConfigErrors`). Migration 51 moved saved servers with that
name, in any case, to `agent_desktop_saved` or the first free `agent_desktop_saved_<n>`. Migration 21
did the same for `computer_use`, the name of the earlier driver (cua-driver); that name is free again.
`workingDirectory` stays empty, because ACP has no field for one and drops an entry that has one.

The entry has to hold still, because Codex folds the MCP entries into its stored tool fingerprint and
replaces a session when it changes. The command is the packaged path, and the arguments are fixed.
`DISPLAY` is an explicit value, the agent display. The session bus address, the runtime directory and
the other variables the driver reads are passthrough names, read from Tommy's environment at each
spawn, so a session bus address that changes at each start does not replace every session.

On a display that no person uses (an agent display on a server), the entry is
`agent-desktop mcp --headed`. The driver may then take focus and send real pointer and key input,
and nobody is disturbed. Everywhere else the entry is `agent-desktop mcp`, which acts only through
accessibility calls and never moves the pointer or takes focus. Measured with agent-desktop 1.2.0
on the server (Xvfb, openbox, an Electron page):

| Action | Headless | `--headed` |
| --- | --- | --- |
| Click a native control (a menu button) | works | works (XTEST) |
| Click an element of web content | works | `TIMEOUT`: the hit test reports `sibling_overlap` and does not fall back |
| Type into a web field | `POLICY_DENIED` | works |
| `scroll-to` | works | works |
| Coordinate click (`mouse-click`) | `POLICY_DENIED` | works |

Neither mode does everything. Headed has a way for each action: when a click on web content times
out, the agent reads the element's bounds (`desktop_get`) and clicks its center with
`desktop_mouse_click`. So the server uses `--headed`.

The MCP server offers accessibility and input tools such as `desktop_snapshot` and `desktop_click`, and its instructions tell the agent to read `desktop_skills_get` first. The tools are named
after the CLI commands, so the driver's bundled skills apply as written.

The driver is packaged, not downloaded at run time. `native-runtime.lock.json` pins it under
`agentDesktop`: the release tag, the digest of each archive, and an allowlist of the files in it with
their digests. `scripts/agent-desktop-stage.mjs` is the `beforePack` hook of electron-builder. For each
target it downloads the archive (cached under `.tommy-build/agent-desktop-cache`), checks the digests,
and copies only the named files and the license to `.tommy-build/agent-desktop`, which
`extraResources` copies to `resources/agent-desktop`. An upstream layout change stops the build.

A packaged build reads only `resources/agent-desktop/agent-desktop`, because the release is pinned to
it and an environment variable must not decide which program drives the desktop. A checkout reads
`TOMMY_AGENT_DESKTOP_PATH`, else the build that `bun run prepare:agent-desktop` stages for this
computer.

On macOS the grant belongs to the responsible process. The provider CLI that spawns
`agent-desktop mcp` is a child of Tommy, so the grant is expected to be Tommy's. This was not tested
with a packaged build, and a development build asks as Electron. The driver ships
`agent-desktop-macos-helper` beside it.

### Agent display on a server

`tommy-server` starts two Xvfb displays, and names the agent display in `TOMMY_AGENT_DISPLAY`.
Electron keeps its own `DISPLAY`: the built-in browser draws its tabs in the Tommy window, and under
Xvfb a hidden view gives no capture and no clicks, so Tommy cannot only hide its window. On Linux,
`agent-display.ts` sets `DISPLAY` to the agent display in `agentEnvironment` for every agent process
and in the driver's entry, so a screenshot, an input event and a program that an agent starts all use
the agent display. Agents take screenshots of that display through the driver. The Telegram browser screenshot has its own tab and owner checks.

The driver needs two things on the server. `tommy-install` installs `at-spi2-core`, `libatk-adaptor`
and `openbox` when they are missing. `tommy-server` starts `openbox` on the agent display, because
without a window manager the driver cannot match a window to its app and `list-apps` and `snapshot`
fail. The session bus is the one `dbus-run-session` starts for the unit, and the AT-SPI bus starts on
it by D-Bus activation at the first `status`.

AT-SPI is per session bus, not per display, and Tommy and the agents share one session bus. On that
bus an app that registers is visible from either display: a probe window on the Tommy display that
registered was listed (as `background`) next to one on the agent display. What keeps Tommy off the
tree is that a bare server session has no settings daemon, so a Chromium, Electron, Qt or GTK 4 app
registers only when its environment asks. `agentDisplayEnvironment` gives every agent process,
and the driver's entry, `ACCESSIBILITY_ENABLED=1`, `QT_ACCESSIBILITY=1` and `GTK_A11Y=atspi` next to `DISPLAY`, so an
app that an agent or `desktop_launch` starts registers. Tommy never gets them; `tommy-server`
unsets them before it starts Tommy. Measured: with the variables only on the agent side,
`list-apps` showed the agent app and not the Tommy-side window, also after `IsEnabled` and
`ScreenReaderEnabled` of `org.a11y.Status` were set to true on the bus. A GTK 4 app such as zenity 4
did not register without `GTK_A11Y=atspi` on a bus with no other accessible app; once another app had
registered, one without the variable was listed too. Tommy draws no GTK 4 windows, so this does not
reach Tommy; a GTK 3 dialog registers on its own. Not measured: a Tommy restart while those bus properties are true.

`scripts/agent-desktop-smoke.ts` checks this on a Linux server without touching a running Tommy. It
starts two Xvfb displays and `openbox` in its own session bus, drives `agent-desktop mcp --headed`
as a provider does, and writes `.tommy-build/agent-desktop-smoke.json`. It checks the click (with
the bounds fallback), typing, a screenshot, and that a window on the other display stays off the
tree. Run it as the service user, with a runtime directory of that user:

```bash
XDG_RUNTIME_DIR=$(mktemp -d) dbus-run-session -- bun scripts/agent-desktop-smoke.ts \
  --driver <agent-desktop> --electron node_modules/electron/dist/electron
```

`tommy.service` holds the Xvfb displays and the window manager too, and a stop signals each process
of the unit at the same time. An Xvfb that stops first ends Tommy before it closes its database. So
the unit's `ExecStop` runs `tommy-server --stop`: it sends `SIGTERM` to Tommy only, whose PID the
script writes to `$XDG_RUNTIME_DIR/tommy.pid`, and waits for it.

# Computer Use and remote desktop

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

The MCP server offers 67 tools (`desktop_snapshot`, `desktop_click`, and so on) with about 41 KB of
schemas, and its instructions tell the agent to read `desktop_skills_get` first. The tools are named
after the CLI commands, so the driver's bundled skills apply as written.

The driver is packaged, not downloaded at run time. `native-runtime.lock.json` pins it under
`agentDesktop`: the release tag, the digest of each archive, and an allowlist of the files in it with
their digests. `scripts/agent-desktop-stage.mjs` is the `beforePack` hook of electron-builder. For each
target it downloads the archive (cached under `.tommy-build/agent-desktop-cache`), checks the digests,
and copies only the named files and the license to `.tommy-build/agent-desktop`, which
`extraResources` copies to `resources/agent-desktop`. An upstream layout change stops the build. A
target with no pinned build (Windows) gets an empty folder and reports no driver.

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
the agent display. `capture_screen` and `list_capture_sources` use Electron's `desktopCapturer`,
which sees only the Tommy display, so with an agent display they are not available, and agents take
screenshots with the driver.

The driver needs two things on the server. `tommy-install` installs `at-spi2-core`, `libatk-adaptor`
and `openbox` when they are missing. `tommy-server` starts `openbox` on the agent display, because
without a window manager the driver cannot match a window to its app and `list-apps` and `snapshot`
fail. The session bus is the one `dbus-run-session` starts for the unit, and the AT-SPI bus starts on
it by D-Bus activation at the first `status`.

AT-SPI is per session bus, not per display, and Tommy and the agents share one session bus. On that
bus an app that registers is visible from either display: a probe window on the Tommy display that
registered was listed (as `background`) next to one on the agent display. What keeps Tommy off the
tree is that a bare server session has no settings daemon, so a Chromium, Electron or Qt app
registers only when its environment asks. `agentDisplayEnvironment` gives every agent process,
and the driver's entry, `ACCESSIBILITY_ENABLED=1` and `QT_ACCESSIBILITY=1` next to `DISPLAY`, so an
app that an agent or `desktop_launch` starts registers. Tommy never gets them; `tommy-server`
unsets both before it starts Tommy. Measured: with the variables only on the agent side,
`list-apps` showed the agent app and not the Tommy-side window, also after `IsEnabled` and
`ScreenReaderEnabled` of `org.a11y.Status` were set to true on the bus. GTK apps register on their
own. Not measured: a Tommy restart while those bus properties are true.

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

## Remote desktop permission checks and live tests

`RemoteScreenGateway` owns setup checks and live-test session ownership. The optional
`remote-desktop-setup` Team API capability uses separate v4 adapter routes; released codecs remain unchanged.
Diagnostics contain host/account names and permission results and travel only to an authenticated member.
They do not include Sunshine credentials or screen content. The renderer opens macOS settings only through
fixed local IPC actions.

Sunshine checks its own macOS permissions and hosts the temporary native test panel. During a test, native
input is restricted to that panel and tagged for the test. The panel requires both the test tag and the
Sunshine process ID before recording a click or keyboard result. The gateway rejects additional sessions
and display switches during a test and closes the panel when its owning stream disconnects. It does not
interrupt another member's session to start a test.

Local tests use a temporary HTTP listener bound to `127.0.0.1`, without publishing the host or requiring an account. The same single-use viewer grant and cookie checks protect it. The gateway owns the listener and closes it with the test session; its lease expires after three minutes. Local test IPC can address only sessions created for this purpose.

A local video-only test can run without native diagnostics. Its viewer iframe is inert and excluded from keyboard focus; it does not start a native input test or report input success. Local loopback test cookies use HttpOnly, Secure and SameSite=None so the embedded viewer works across the app origin.

A paste in the viewer puts the member's text on the host's clipboard, and then presses the host's
paste keys. Moonlight sends Cmd+V or Ctrl+V as keys and cancels them, so the browser fires no paste
event and the host pastes its own clipboard. The gateway adds `tommy-paste.js` to Moonlight's
`stream.html`. The script keeps the member's paste key from Moonlight, reads the paste event, and
posts the text to `moonlight/tommy-clipboard`. Both routes are under `moonlight/` because the
released Team API adapters forward only that family of viewer routes. The same viewer cookie or
WebRTC session check protects them, and the clipboard route refuses a request from another site.
At the paste event, the script presses the host's paste modifier, Cmd for a macOS host or Ctrl for
other hosts, and releases the member's other held modifiers except Shift. A Win or Super key
released with no key between would open the host's Start menu or Activities. After the upload, the
script presses V. Text that the host
already has from an earlier paste is not sent again, so a copy made on the host stays on its
clipboard. A host with no clipboard writer serves neither route.

On Linux, the gateway accepts only an X11 session (`DISPLAY` set, no `WAYLAND_DISPLAY`, and
`XDG_SESSION_TYPE` not `wayland`). Sunshine then runs with X11 capture and software encoding, and
sends input through XTest, so a hosted server under Xvfb needs no uinput device and no extra
capability. On a server with an agent display, Sunshine runs on that display (see
[Agent display on a server](#agent-display-on-a-server)). Linux has no permission checks: an X11 session is ready.

### Codex tool approvals

Codex saves an “Always allow” tool decision only when the MCP server is in a file-backed
configuration layer. A thread configuration alone does not satisfy this check. Before starting or
resuming a thread with Computer Use, Tommy registers `agent_desktop` in the Codex user
configuration through `config/batchWrite`. The new entry contains only a placeholder command
(`tommy-mcp`) and `enabled = false`. The write uses the user layer's version, and an existing entry is left unchanged.
Tommy does not save the driver path, environment, or credentials in that entry. A disabled
`computer_use` placeholder from the earlier driver can stay in that file; nothing starts it.

The thread configuration enables the running driver and supplies its current command, arguments,
and environment. It also carries the saved per-tool settings, including `desktop_set_value.approval_mode`.
Saved tool settings are also in the session fingerprint. When an approval changes, the next turn
replaces a loaded provider session that holds the old policy.
An agent with Full access does not ask: Tommy accepts each Computer Use tool consent once and
saves nothing, as it does for other MCP tools. A Workspace only or Ask first agent shows the card,
and Codex keeps "Always allow" per tool and per provider account.
When Computer Use is off for the agent or the driver is unavailable, the thread keeps the saved
entry disabled. A registration failure stops the thread with steps to repair the configuration or
turn off Computer Use.

# Tommy

Tommy is a personal workspace for AI agents. One server runs the agents, and the Mac and Android
apps connect to it directly over WSS. There is no relay or account service in between. Each agent
keeps its own workspace, conversation and identity across provider switches and restarts.

> [!WARNING]
> Agents run with `danger-full-access`. They can read and modify files, run commands, use the
> network and control the embedded browser. Run only agents and tasks you trust.

## Run a server

The server is the Linux build of the desktop app, run as a systemd service on a virtual display.
Build it on the server from a checkout, then install it as root:

```bash
bun install --frozen-lockfile
bun run package:linux
sudo bash scripts/hosting/tommy-install dist/linux-unpacked
sudo tommy pair
```

`tommy-install` creates the `tommy` system user, installs the app in `/opt/Tommy`, keeps its data
in `/var/lib/tommy`, and starts `tommy.service`. Run it again to upgrade; the data stays.
`sudo tommy pair` shows a one-time code and a QR code for a new device. `tommy` with no arguments
lists the other commands (`status`, `devices`, `revoke-device`, `logs`, `restart`).

Devices reach the server over HTTPS. `scripts/hosting/nginx-tommy.conf` is the public entry: set
`server_name` to your host name, get a certificate for it, and install the file in
`/etc/nginx/sites-available`. It forwards only the pairing and connection paths to loopback; the
Team API stays on loopback with no public path.

## Apps

- **Mac:** `bun run dist:mac` builds the app. `bun run package` builds an unpacked app for a quick
  check.
- **Android:** `bun run mobile:android` builds and installs a development build on a connected
  device, and `bun run mobile:android:build:local` builds a release bundle. Two settings in the root
  `.env` are optional:
  - `TOMMY_ANDROID_KEYSTORE` names a signing key kept outside the repository. Without it, each
    `expo prebuild` makes a new key, and the phone refuses the next build as an update.
  - `FIREBASE_ANDROID_API_KEY`, `FIREBASE_ANDROID_APP_ID`, `FIREBASE_PROJECT_ID`,
    `FIREBASE_PROJECT_NUMBER` and `FIREBASE_STORAGE_BUCKET` come from your own Firebase project.
    Without them the app works but gets no notifications.

## Development

Development requires stable [Bun](https://bun.sh/) 1.4.2, Node.js 24 (the version in `.nvmrc`,
matching the Node that Electron bundles; run `nvm use`), and at least one supported agent CLI.

```bash
curl -fsSL https://bun.com/install | bash -s "bun-v1.4.2"
git clone https://github.com/jbaehova/tommy.git
cd tommy
bun install --frozen-lockfile
bun run dev
```

On macOS, a worktree's `node_modules` uses almost no new disk space. Bun clones packages from its
cache, and the root `postinstall` clones Electron from `~/Library/Caches/Tommy/electron-dist`.
`du` still shows the full size of each clone. Delete the directory to clear the cache; an entry that
nobody used for 30 days is removed by the next save.

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the Electron client with renderer HMR. Each worktree opens a profile of its own, keyed to its path; `--shared` opens the shared `Tommy Dev` profile instead. Ports come from the dev registry, so a sibling worktree never takes one this stack won. It refuses a second stack in the same worktree unless you pass `--force`. Before it starts, it runs `bun install --frozen-lockfile` only when `bun.lock`, a workspace `package.json` or a patch changed since the last successful run. |
| `bun run dev:status` | Show the dev stacks of this computer and their ports. |
| `bun run dev:stop` | Stop the processes that this worktree's stack started. Never stop a stack with `pkill -f electron` or `pkill -f bun`: on a machine running several worktrees those kill the other checkouts' work mid-write. |
| `bun run dev:forget` | Remove a stale entry from the dev registry. |
| `bun run dev:automation` | Drive a running dev app through CDP. Prints its usage with `--help`. |
| `bun run mobile` | Start the Expo development server for the Android app. |
| `bun run typecheck` | Type-check every project. |
| `bun run lint` | Run Biome on the whole repository. `bun run format` also writes the fixes. |
| `bun run check:ui` | Check the UI foundation rules. |
| `bun run i18n:check` | Check the interface text catalogs. |
| `bun run verify:preload` | Check the built preload bundle. |
| `bun run test:changed` | Run the Vitest files that changed since `origin/main`. Also `test:related`, `test:backend` and `test:desktop`. |
| `bun run package:linux` | Build the unpacked Linux app that `tommy-install` installs. `dist:linux` builds an AppImage. |
| `bun run prepare:agent-desktop` | Stage the pinned Computer Use driver for this computer, for a dev build. Packages stage their own. |

## Local skills

Ask an agent to create a skill from a reusable workflow. It prepares a folder with `SKILL.md` and
calls `create_skill`. The skill is saved in a shared local library and enabled for that agent. Other
agents can add it through **Settings → Skills → Local skills**.

Agents can use `list_local_skills`, `read_local_skill`, `revise_skill`, and `install_local_skill`.
Revisions require the version read by the agent and retain previous versions. Updating a library
skill does not update installed copies: use the Update chip or install an exact revision. Modified
installed files are protected.

Optional scripts, references, and assets follow the Codex skill folder structure. A PNG at
`assets/icon.png` supplies the local preview logo. The built-in `tommy-skill-creator` guide explains
the format and validation limits. Registration does not run scripts.

Skill authors can add optional `example-prompt` text to the YAML frontmatter in `SKILL.md`. The
skill preview shows it, and **Try skill** puts it in the selected agent's draft without sending it.

MCP servers are added in **Server settings → MCP**: a command (stdio) or a URL, with headers or a
browser sign-in.

## Architecture

```text
Electron main
├── provider CLIs (Codex, Claude, Grok, OpenCode and others) as child processes
├── SQLite command log and read projections
├── secure typed IPC handlers
├── direct connection server for paired devices
└── sandboxed WebContentsView browser host
    ↕ typed preload bridge
SolidJS renderer
```

- `src/main` owns the Electron lifecycle, window security, local protocol, and IPC registration.
- `src/backend` owns provider adapters, persistence, message scheduling, transfers, and the browser host.
- `src/preload` exposes only the typed `window.tommy` API.
- `src/renderer` contains the SolidJS interface.
- `apps/mobile` contains the Android app (Expo).
- `scripts/hosting` contains the Linux server install.
- `packages/contracts` contains process-boundary contracts, shared limits, and pure validation.
- `packages/i18n` contains the interface text in English and Korean. See [docs/i18n.md](docs/i18n.md).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for dependency direction, state ownership, and
rules for new modules.

## Chat attachments

Attach MP3 audio and MOV or MP4 video through the file picker or drag and drop. The limits are
100 MB per file, 250 MB per message, and 10 files per message. Tommy gives the agent the original
file; it does not play, decode, transcribe, or validate the recording. For other formats, export as
MP3, MOV, or MP4, or attach a text transcript.

ZIP archives use the same limits. Tommy does not extract or inspect an archive: the agent extracts
it with its own tools, and sends one back with `tommy.attach_files_to_response`.

SVG images use the same limits. The chat shows an SVG as an image, but the agent gets it as a file,
because providers take only raster images.

## Local data

- `~/Tommy/Agents/<agent-id>`: one working directory per agent.
- `~/Tommy/Shared`: files intentionally shared between agents.
- `~/Tommy/Shared/Transfers`: managed message snapshots and generated files. Each transfer has an
  `.tommy-transfer.json` manifest with ownership, recipients, size, and SHA-256 metadata.
- `~/Tommy/Downloads`: embedded-browser downloads.
- Electron `userData/tommy.db`: the canonical event log and projections for agents, conversations,
  provider session bindings, queues, reactions, and attachment indexes.
- `provider-runtimes` in the app data folder: the provider CLIs Tommy downloads and pins, one store
  for the whole computer.
- `~/.codex`, `~/.claude`, `~/.grok`, `~/.gemini`, `~/.cursor`, `~/.cline`, `~/.kimi`: login and
  session history, managed by each provider's own CLI.

Deleting an agent removes its workspace, owned generated attachments, and deliveries addressed only
to that agent. Tommy keeps one stable conversation when an agent changes provider. Native provider
session identifiers stay private and are used only to resume provider runtime state.

The renderer is never exposed as a public website. The embedded browser uses a separate sandboxed
Electron session and cannot access `window.tommy` or managed local attachments.

## License and attribution

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE), for noncommercial purposes only.
Commercial use needs a separate license from the copyright owner. Tommy is based on OpenBot; see
[NOTICE](NOTICE) for the origin of this software and for third-party notices.

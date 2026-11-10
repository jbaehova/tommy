# Install Tommy

This guide installs Tommy from start to end. A coding agent (Claude Code, Codex or another) can
follow it for you; a person can follow it too. The [README](../README.md#install) has the prompt to
give your agent.

Tommy has three parts:

| Part | What it is | Needed |
| --- | --- | --- |
| Server | The Linux service that runs the agents and keeps all data | Yes, one |
| Mac app | The desktop client | Optional |
| Android app | The phone client | Optional |

The apps connect directly to the server over HTTPS. There is no account and no relay.

## Rules for the agent

- Ask the user which parts to install, and on which computer each part goes. Do the steps of a
  part on that computer. If the server is another computer, connect to it over SSH only when the
  user gives you the host and user.
- Ask for every value that this guide marks as **ask**. Never invent a domain name, an email address
  or a host. Use the user's answers exactly.
- Show each command that uses `sudo` or changes the system before you run it, and say why. Stop and
  ask when a step fails twice; give the user the error text.
- Do not change files outside the paths that this guide names. Do not read or print keys, tokens or
  passwords.
- At the end, give the user the summary that [Finish](#finish) describes.

## 1. Server

### Requirements

- A Linux computer that stays on: Ubuntu 24.04 or Debian 12 (x64) is tested. 4 GB of memory is the
  minimum; 8 GB or more is better when several agents work at once. 20 GB of free disk.
- A domain name that points to the server's public IP address (an A or AAAA record), and TCP
  ports 80 and 443 open from the internet. **Ask** the user for the domain name, such as
  `tommy.example.com`, and for an email address for the certificate.
- A user with `sudo`.
- At least one agent subscription or API key: Claude, ChatGPT (Codex), Cursor or Pi. The user signs
  in from the app later.

Check the domain before you continue: `getent hosts <domain>` must print the server's public IP
address. If it does not, stop and ask the user to fix the DNS record.

### Build tools

```bash
sudo apt-get update
sudo apt-get install -y git curl unzip xz-utils ca-certificates build-essential
curl -fsSL https://bun.com/install | bash -s "bun-v1.4.2"
```

Tommy needs Node.js 24 too. Use the user's version manager if one is installed (`nvm install 24`,
`fnm install 24`, `mise use -g node@24`); otherwise install the official build:

```bash
curl -fsSL https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz -o /tmp/node.tar.xz
mkdir -p ~/.local/share/node && tar -xJf /tmp/node.tar.xz -C ~/.local/share/node --strip-components=1
mkdir -p ~/.local/bin && ln -sf ~/.local/share/node/bin/* ~/.local/bin/
```

Open a new shell (or add `~/.bun/bin` and `~/.local/bin` to `PATH`), then check: `bun --version`
prints `1.4.2` and `node --version` prints `v24.x`.

### Build

Build as the normal user, not as root:

```bash
git clone https://github.com/jbaehova/tommy.git ~/tommy
cd ~/tommy
bun install --frozen-lockfile
bun run package:linux
```

The build takes a few minutes and writes the app to `dist/linux-unpacked`.

### Install the service

Use the domain that the user gave:

```bash
sudo bash scripts/hosting/tommy-install dist/linux-unpacked https://<domain>
```

`tommy-install` installs the system packages that Tommy needs (a virtual display, a keyring and
the Electron libraries), creates the `tommy` system user, installs the app in `/opt/Tommy`, keeps
the data in `/var/lib/tommy`, and starts `tommy.service`. It installs Noto CJK fonts so browser
pages can show Chinese, Japanese and Korean text. Check it with `sudo tommy status`.

### 1Password (optional)

Put `OP_SERVICE_ACCOUNT_TOKEN` in `/var/lib/tommy/.config/tommy/agent.env` and restart
`tommy.service`. The browser fills the logins and the Credit Card items that this service account can
read, and agents can use the `op` command with it. An agent with a shell can read those items, so
share only the vaults that agents may read.

### HTTPS

Nginx holds the certificate and forwards only the device paths to Tommy. Get the certificate first,
then install the site:

```bash
sudo apt-get install -y nginx certbot
sudo certbot certonly --standalone -d <domain> -m <email> --agree-tos --no-eff-email \
  --pre-hook "systemctl stop nginx" --post-hook "systemctl start nginx"
sudo mkdir -p /var/www/tommy-acme
sed "s/tommy.example.com/<domain>/g" scripts/hosting/nginx-tommy.conf | sudo tee /etc/nginx/sites-available/tommy >/dev/null
sudo ln -sf /etc/nginx/sites-available/tommy /etc/nginx/sites-enabled/tommy
sudo nginx -t && sudo systemctl reload nginx
```

The hooks let certbot renew the certificate by itself. If `ufw` is active, open the ports:
`sudo ufw allow 80/tcp && sudo ufw allow 443/tcp`.

Check: `curl -sS -o /dev/null -w '%{http_code}\n' https://<domain>/` prints `404`. Tommy answers
only its own paths, so 404 is correct.

### Pair the first device

```bash
sudo tommy pair
```

It prints a one-time code and a QR code. Give the code to the user for the next part. A code works
once; run the command again for each new device.

### Update the server later

```bash
cd ~/tommy
git pull
bun install --frozen-lockfile
bun run package:linux
sudo bash scripts/hosting/tommy-install dist/linux-unpacked
```

The data and the address stay. Paired devices stay paired.

## 2. Mac app

Requirements: macOS 13 or later on Apple Silicon.

### From a release (preferred)

If <https://github.com/jbaehova/tommy/releases/latest> has a `.dmg` file, download it, open it and
drag Tommy to Applications. Release builds are signed and notarized, so they open without a
warning.

```bash
url=$(curl -fsSL https://api.github.com/repos/jbaehova/tommy/releases/latest \
  | grep -o '"browser_download_url": *"[^"]*arm64\.dmg"' | cut -d'"' -f4)
curl -fL "$url" -o /tmp/Tommy.dmg
hdiutil attach -nobrowse -quiet /tmp/Tommy.dmg -mountpoint /tmp/tommy-dmg
ditto /tmp/tommy-dmg/Tommy.app /Applications/Tommy.app
hdiutil detach -quiet /tmp/tommy-dmg
```

If `url` is empty, there is no release yet: build the app.

### Build it

Install the Xcode command line tools (`xcode-select --install`), Bun 1.4.2 and Node.js 24 as in
[Build tools](#build-tools) (on a Mac, Homebrew is fine: `brew install node@24`). Then:

```bash
git clone https://github.com/jbaehova/tommy.git ~/tommy
cd ~/tommy
bun install --frozen-lockfile
bun run package
ditto dist/mac-arm64/Tommy.app /Applications/Tommy.app
rm -rf dist/mac-arm64/Tommy.app
```

The last line removes the build copy, so macOS shows only one Tommy. A build on your own Mac opens
without a warning.

### Connect

Open Tommy. Enter the server address (the domain, such as `tommy.example.com`) and the code from
`sudo tommy pair`. Then open Settings › Providers and sign in to at least one agent provider.

## 3. Android app

Requirements: Android 7 or later on a 64-bit ARM phone (almost every phone since 2017).

Download the `.apk` file from <https://github.com/jbaehova/tommy/releases/latest> on the phone and
open it. Android asks to allow installs from the browser once. If there is no release yet, build
the APK (next section). Then open Tommy, scan the QR code from `sudo tommy pair` or type the address
and code.

The release APK has no push notifications, because notifications need the Firebase project of the
server owner. To get them, build the APK with your own Firebase values.

### Build it (optional)

Needs Bun, Node.js 24, JDK 17 and the Android SDK (`ANDROID_HOME`). Copy `.env.example` to `.env`
and fill `TOMMY_ANDROID_KEYSTORE` (keep the same key for every build, or the phone refuses updates)
and, for notifications, the `FIREBASE_*` values of your Firebase project. Then:

```bash
bun run mobile:android:apk
```

The APK is `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`. Install it with
`adb install -r <apk>` or copy it to the phone.

## Development UI checks

For CDP checks without opening windows or taking focus from another app, run
`TOMMY_DEV_BACKGROUND=1 bun run dev`, then use `bun run dev:automation` with that instance.
This setting applies only to development. Packaged apps ignore it.

## Finish

Tell the user:

- The server address, and that `sudo tommy status`, `sudo tommy logs` and `sudo tommy pair` manage
  it.
- Which apps are installed, and that each one is paired or what is left to do.
- That they must sign in to a provider in Settings › Providers before the first agent can work.
- That agents run with full access on the server: they can read and change files and run commands.
- How to update: the [server steps](#update-the-server-later), and a new release or build for the
  apps.

If something fails, read [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Optional host features

All settings below are empty by default. Set them in the Tommy host process. On a Linux service,
edit `/etc/tommy/server.env`, keep it owned by root with mode `0600`, and restart the service with
`sudo systemctl restart tommy`. Keep connector tokens out of the agent environment and git.
The installer preserves these settings when you run it again.

### Signed workflow webhooks and connectors

Set `TOMMY_WEBHOOK_PUBLIC_URL=https://tommy.example.com` to the HTTPS origin of the host. Use your
own address. The supplied Nginx file forwards `/hooks/` to the existing loopback listener. Update
an older Nginx installation with that location. Do not expose the Team API `/v1/` paths. Preserve
request bytes and signature headers. The host accepts no public webhook while the origin is empty.

Set `TOMMY_WORKFLOW_CONNECTORS_JSON` to one JSON object. Each section is optional:

```json
{
  "github": {
    "token": "example-github-token",
    "webhookSecret": "example-github-secret",
    "repositories": ["example/project"]
  },
  "slack": [{
    "id": "slack-example", "name": "Example workspace",
    "token": "example-slack-token", "signingSecret": "example-signing-secret",
    "workspaceId": "TEXAMPLE", "serviceUserId": "UEXAMPLE",
    "channels": [{"id": "CEXAMPLE", "name": "general"}]
  }],
  "telegram": [{
    "id": "telegram-example", "name": "Example chat",
    "token": "example-telegram-token", "webhookSecret": "example_telegram_secret",
    "serviceUserId": "12345", "username": "tommy_example", "chatId": "-1001234567890"
  }]
}
```

For systemd, put the JSON on one line with single quotes around the complete value. For example:

```ini
TOMMY_WORKFLOW_CONNECTORS_JSON='{"github":{"token":"example-github-token","webhookSecret":"example-github-secret","repositories":["example/project"]}}'
```

Actual tokens stay in `server.env`. The client app receives only connection names and permitted
destinations. The host removes this value from its process environment after reading it. An agent
with full shell access as the host user can still read that user's files and the service's initial
OS environment. The subprocess filter is not an isolation boundary against that full shell access.

- GitHub: configure a JSON repository webhook at `/hooks/github`, with the same secret. Subscribe
  to issues, issue comments, pull requests, reviews, review comments and check suites. Give the
  token only the repository permissions that the workflow needs. File output needs contents write.
  An optional `appSlug` enables App identity checks. Expiring App tokens need external renewal.
- Slack: use `/hooks/slack/<connection-id>` as the Events API URL. Subscribe to `app_mention`.
  Outbound messages need `chat:write`; reactions need `reactions:write`. Join the configured channels.
- Telegram: register `/hooks/telegram/<connection-id>` with `setWebhook`, the configured
  `secret_token`, and `allowed_updates=["message"]`. A connection permits one chat. A service account
  has one webhook URL, so use a separate service account for each configured chat. Tommy does not
  replace provider webhook settings automatically.

For a generic routine or workflow webhook, use the URL from its trigger. Keep the existing Tommy
signature, or configure its sender key and use Standard Webhooks headers. Rotation and revocation
invalidate the old key. The receiver checks signatures, timestamp bounds and durable delivery IDs.
No cloud relay is involved. A configured origin does not prove that external DNS and TLS work.

### Optional Linux secret storage fallback

The persistent OS keyring remains the default. If your installation must accept new secrets when
that keyring fails, set `TOMMY_SECRET_STORAGE_FALLBACK=key-file`. The host then protects new secrets
with a private AES key at `secret-storage.key` in its data directory. Keep that file private and
preserve it with the encrypted stores. Disabling the setting does not prevent reads of existing
file-encrypted secrets. It cannot decrypt secrets made with a lost OS keyring. An unreadable store
is kept unchanged until an explicit reset or replacement.

If the optional two-step file cannot be read, normal Vault items remain available. Tommy keeps
that file unchanged and refuses new setup-key writes. Restore the matching encrypted file and key
before changing those keys. Resetting the whole Vault still removes its items and needs an explicit
user action. A corrupt keyring ciphertext never changes the encryption backend for later writes.

### Realtime voice and other optional features

Realtime voice uses a signed-in Codex account with the required feature. Audio goes to the provider.
Availability, usage limits and additional costs depend on that account. Start a call explicitly;
Stop ends it and releases the microphone. Existing dictation and read-aloud settings stay separate.
Android needs a new CI-built APK for the WebRTC native module. No speech model download is required.

Pi can use the optional host web-search tool when Codex is already enabled and signed in.
The search uses that Codex account and its usage allowance. It does not change the agent provider,
thread or identity. Other providers keep their own search tools.

Skill learning starts with Ask first. It can be automatic or off. Saving creates an immutable local
skill revision. The skill detail view can restore an older revision as a new revision. A routine
runs in the main chat by default; its settings can select a separate thread. Each run still starts
a fresh provider session. A workflow can post a note to a Tommy channel without starting agent work.

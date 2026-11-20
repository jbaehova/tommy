# Install Tommy

This guide installs Tommy from start to end. A coding agent (Claude Code, Codex or another) can
follow it for you; a person can follow it too. The [README](../README.md#install) has the prompt to
give your agent.

Install one server, then connect Telegram. Telegram is the only interface: the manager bot is the
chat of your root agent, and every other agent gets a bot of its own. Telegram stores the messages
and media sent in its chats. The Telegram Mini App connects to the server over HTTPS.

## Rules for the agent

- Ask the user which computer is the server. If it is another computer, connect to it over SSH only
  when the user gives you the host and user.
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
- An account or API key for a supported provider. Sign the service user in to its CLI before you
  start work through Telegram (see [Telegram interface](#telegram-interface)).

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

For the Telegram development version, copy the current development checkout to the VPS and run
the install and build commands in that copy. The clone command below fetches the default branch.

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

On Ubuntu 26.04, `tommy-install` also adds one rule to `/etc/apparmor.d/local/bwrap-userns-restrict`:
`priority=1 allow pix /** -> &bwrap,`. The Ubuntu profile of `/usr/bin/bwrap` removes all
capabilities from the programs that `bwrap` starts, and the Claude sandbox ("Workspace only") needs
`CAP_SYS_ADMIN` there. With the rule, those programs keep the profile of `bwrap`, for all users of
the computer. To remove it, delete the `# Tommy:` line and the rule from that file, then run
`sudo apparmor_parser --replace /etc/apparmor.d/bwrap-userns-restrict`.

### 1Password (optional)

Put `OP_SERVICE_ACCOUNT_TOKEN` in `/var/lib/tommy/.config/tommy/agent.env` and restart
`tommy.service`. The browser fills the logins and the Credit Card items that this service account can
read, and agents can use the `op` command with it. An agent with a shell can read those items, so
share only the vaults that agents may read.

### HTTPS

Nginx holds the certificate and forwards the Telegram and workflow webhook paths to Tommy.
Get the certificate first, then install the site:

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

### Telegram interface

Use this setup for one trusted owner on one VPS. Each managed bot connects to one Tommy agent.
A fresh host selects Codex. On the VPS, install its CLI for the service account and sign in:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sudo -u tommy -H sh
sudo -u tommy -H /var/lib/tommy/.local/bin/codex --version
sudo -u tommy -H /var/lib/tommy/.local/bin/codex login --device-auth
sudo -u tommy -H /var/lib/tommy/.local/bin/codex login status
```

For Claude Code, install the CLI for the same service user with the
[official installer](https://code.claude.com/docs/en/setup) and configure the provider as described in
[Provider terms](provider-terms.md#risk-by-use). Set `TOMMY_CODEX_PATH` or `TOMMY_CLAUDE_PATH`
in `/etc/tommy/server.env` if the executable is in a custom location.

On a server, sign Claude in with a long-lived token. A normal `claude auth login` renews its
token every few hours. When the server is idle overnight and several agents start at once, a renewal
can fail and remove the sign-in. A token from `claude setup-token` is valid for one year and needs no
renewal:

```bash
sudo -u tommy -H /var/lib/tommy/.local/bin/claude setup-token
```

Open the link it prints, approve, and paste the code. Put the token it prints in
`/var/lib/tommy/.config/tommy/agent.env` as `CLAUDE_CODE_OAUTH_TOKEN=<token>`, then run
`sudo systemctl restart tommy`. Make a new token before the year ends.

1. Open the official `@BotFather` account in Telegram and create a new manager with `/newbot`.
   In its settings, enable **Bot Management Mode**. The manager needs no Main Mini App: each bot
   opens the Tommy Mini App from a button in its own chat.
2. Store the manager token from BotFather in a private file on the VPS. The file contains one
   line with the token. The following commands create a directory that only root and the service
   group can enter. Paste the token in the editor, then set the file mode and owner.

   ```bash
   sudo install -d -o root -g tommy -m 0710 /etc/tommy/telegram
   sudoedit /etc/tommy/telegram/manager-token
   sudo chmod 0600 /etc/tommy/telegram/manager-token
   sudo chown tommy:tommy /etc/tommy/telegram/manager-token
   ```

   Agents with full shell access run as the service user and can read this file.
3. Get your own numeric Telegram user ID. If you already know it, use it in the next step.
   For a new manager, run this command on the VPS before enabling its webhook.
   Open the link it prints in your own Telegram account and tap **Start**. If the chat shows only
   `/start`, copy the full command from the terminal into the manager chat. The request expires
   in 10 minutes. The terminal prints your numeric ID. The command requires Python 3.

   ```bash
   sudo -u tommy /opt/Tommy/hosted/tommy-telegram-owner-id /etc/tommy/telegram/manager-token
   ```

4. Set these values in `/etc/tommy/server.env` with `sudoedit`. Substitute your ID and HTTPS
   origin. The owner ID belongs to your personal Telegram account.

   ```text
   TOMMY_TELEGRAM_MANAGER_TOKEN_FILE=/etc/tommy/telegram/manager-token
   TOMMY_TELEGRAM_OWNER_ID=<your numeric user ID>
   TOMMY_TELEGRAM_PUBLIC_URL=https://<domain>
   TOMMY_TIMEZONE=<your time zone, such as Asia/Seoul>
   ```

   `TOMMY_TIMEZONE` is optional. Without it, times in chat use the time zone of your routines, or
   the server's own, which is often UTC.

5. For an existing install, update the nginx site from this checkout as described in [HTTPS](#https).
   Restart Tommy with `sudo systemctl restart tommy`. Open your manager in Telegram and send
   `/start` and choose your root agent. The root agent answers in the manager chat, like the main
   agent of the app. Send `/connect` to give each other agent its own bot and chat: tap an agent
   and create the new bot in Telegram with the suggested name. Use `/new` to create a new agent
   with its own bot. The manager then asks what the agent does: the answer becomes the agent's
   description and its first instruction. Send `/new <what the agent does>` to give the role at once,
   or `/skip` to give it later in the agent's chat. You can chat with a new bot at once.
6. Agents send work to each other inside Tommy, as in the app. Each agent bot's chat shows the
   messages that its agent sent to and received from other agents. Use `/agents` in the manager
   to find your bots. Use `/browser` in a bot's chat to see its agent's browser tabs.

In an agent's private chat, use `/engine codex` or `/engine claude` to switch engines.
Use `/name <display name>` to rename the agent. The Telegram username stays fixed.
Use `/disconnect @username` in the manager chat and confirm with the code it returns to unlink an agent.
Its workspace and conversation remain on the VPS. The Telegram account owner can use BotFather to delete the bot.
To delete an agent with its conversations and workspace, send `/delete` in its own chat. For an agent without a
bot, send `/delete <agent name>` in the manager chat and confirm with the code it returns. The root agent
cannot be deleted. Delete an agent before you disconnect its bot: an agent without a bot appears in `/connect` again.

When an agent asks for a website password or code, its bot's chat gets a message with an
**Open Tommy** button. The card opens inside that chat, and the secret goes directly to the VPS.
An agent that received the work from another agent asks in its own chat, or in the chat where the
owner started the work if it has no bot. The manager's view shows every request. Messages and
generated images sent in chat go to Telegram.
Agents send work to each other inside Tommy, never as Telegram messages between bots. Telegram
accepts only your own private messages; messages from other people and from bots never reach an
agent. If the host cannot confirm manager webhook health for 24 hours, an agent bot stops taking
work until you replace its token in BotFather from your owner account. Tommy then confirms the
bot again.

To turn off the Telegram interface, remove the three Telegram settings from
`/etc/tommy/server.env` and restart Tommy. The agent workspaces stay on the VPS.

Telegram describes [managed bot creation](https://core.telegram.org/api/bots/managed-bots).

### Update the server later

```bash
cd ~/tommy
git pull
bun install --frozen-lockfile
bun run package:linux
sudo bash scripts/hosting/tommy-install dist/linux-unpacked
```

The data and the settings stay.

## Finish

Tell the user:

- The server address, and that `sudo tommy status` and `sudo tommy logs` manage it.
- That the owner can talk to the root agent in the manager chat, and how `/connect` gives the other
  agents their own chats.
- Which provider the owner has configured for the first agent.
- That agents run with full access on the server: they can read and change files and run commands.
- How to update: the [server steps](#update-the-server-later).

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

### Other optional features

Pi can use the optional host web-search tool when Codex is already enabled and signed in.
The search uses that Codex account and its usage allowance. It does not change the agent provider,
thread or identity. Other providers keep their own search tools.

Skill learning starts with Ask first. It can be automatic or off. Saving creates an immutable local
skill revision. The skill detail view can restore an older revision as a new revision. A routine
runs in the main chat by default; its settings can select a separate thread. Each run still starts
a fresh provider session. A workflow can post a note to a Tommy channel without starting agent work.

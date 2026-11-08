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
| iPhone app | The phone client, built on a Mac | Optional |

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
the data in `/var/lib/tommy`, and starts `tommy.service`. Check it with `sudo tommy status`.

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

### Notifications on the server (optional)

The server sends Android notifications with the Firebase key of the same project. In the Firebase
console, open Project settings › Service accounts › Generate new private key, copy the file to the
server, and install it for the service:

```bash
sudo install -o tommy -g tommy -m 600 <downloaded-key>.json /var/lib/tommy/fcm-service-account.json
sudo systemctl restart tommy
```

## 4. iPhone app

There is no download: Apple installs an app only from the App Store, TestFlight, or a build signed
for the phone. Build it on a Mac and install it on the iPhone over a cable.

Requirements:

- A Mac with the current Xcode from the App Store, CocoaPods (`brew install cocoapods`), Bun 1.4.2
  and Node.js 24 as in [Build tools](#build-tools).
- An iPhone with iOS 16.4 or later.
- A paid Apple Developer Program membership. The app has a share extension, a notification
  extension and an App Group, which a free personal team cannot sign. In Xcode, open Settings ›
  Accounts and sign in with the Apple account of the membership.

**Ask** the user for the team ID of the membership (developer.apple.com › Account › Membership) and
for a bundle ID that is theirs, such as `com.example.tommy`. Apple gives each bundle ID to one team
only. Put both in `.env` in the repository (copy `.env.example` first):

```bash
TOMMY_IOS_BUNDLE_ID=com.example.tommy
TOMMY_APPLE_TEAM_ID=ABCDE12345
```

Connect the iPhone to the Mac, unlock it, and allow the Mac. Turn on Settings › Privacy & Security ›
Developer Mode on the iPhone if iOS asks for it. Then:

```bash
git clone https://github.com/jbaehova/tommy.git ~/tommy
cd ~/tommy
bun install --frozen-lockfile
bun run mobile:ios:prebuild
bun run mobile:ios -- --device --configuration Release
```

Choose the iPhone when Expo asks. Xcode registers the bundle IDs and the App Group for the team and
signs the build. The first time, iOS asks to trust the developer: Settings › General › VPN & Device
Management. Then open Tommy, scan the QR code from `sudo tommy pair` or type the address and code.

To update, run `git pull`, `bun install --frozen-lockfile` and the last two commands again. The
pairing stays.

### Notifications (optional)

The server sends iPhone notifications to Apple with an APNs key of the same team:

1. In the Apple Developer account, open Certificates, Identifiers & Profiles › Keys, add a key with
   Apple Push Notifications service (APNs), and download `AuthKey_<key ID>.p8`. Apple lets you
   download it once.
2. Copy the `.p8` file to the server, and write the key file there. Use the key ID, the team ID and
   the bundle ID of the app:

   ```bash
   node -e 'const [keyId, teamId, topic, file] = process.argv.slice(1);
     process.stdout.write(JSON.stringify({ keyId, teamId, topic, privateKey: require("fs").readFileSync(file, "utf8") }))' \
     <key ID> <team ID> <bundle ID> AuthKey_<key ID>.p8 | sudo install -o tommy -g tommy -m 600 /dev/stdin /var/lib/tommy/apns-key.json
   rm AuthKey_<key ID>.p8
   sudo systemctl restart tommy
   ```

3. In the app, open Settings › Notifications and allow notifications.

A build from Xcode gets development push tokens and a TestFlight or App Store build gets production
tokens. The app tells the server which one it has, so the same key works for both.

## Finish

Tell the user:

- The server address, and that `sudo tommy status`, `sudo tommy logs` and `sudo tommy pair` manage
  it.
- Which apps are installed, and that each one is paired or what is left to do.
- Whether the server has the notification keys of the phones (`fcm-service-account.json`,
  `apns-key.json`).
- That they must sign in to a provider in Settings › Providers before the first agent can work.
- That agents run with full access on the server: they can read and change files and run commands.
- How to update: the [server steps](#update-the-server-later), and a new release or build for the
  apps.

If something fails, read [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

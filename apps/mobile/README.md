# Tommy Mobile

The Android and iPhone app of Tommy, built with Expo SDK 58, Expo Router, TypeScript 7, Biome, and Bun. It connects to a paired Tommy server directly over WSS. The app uses Expo Continuous Native Generation, so the native `android/` and `ios/` directories are intentionally not committed.

## Requirements

- Node.js 24 or newer (the repository pins 24 in `.nvmrc`)
- Bun 1.4.2 (the version in the root `packageManager`)
- An Android device or emulator; Expo Go works for quick checks
- For iPhone: a Mac with Xcode and CocoaPods, and an iOS simulator or an iPhone


## Development

The repository uses Bun’s hoisted linker so native Expo modules resolve to one installation.
React Native Skia 2.14 needs no install step. Gradle reads its prebuilt libraries from
`react-native-skia-android`.

EAS profiles pin Bun 1.4.2 to match the root `packageManager`. Use the same Bun version
locally: dependency paths and package patch metadata affect the runtime fingerprint.
After switching from the isolated linker to the hoisted linker, move the old
`apps/mobile/node_modules` directory out of the app and run `bun install --frozen-lockfile`
from the repository root. A normal install can retain old workspace symlinks and cause
the local fingerprint to differ from the clean EAS installation.

Expo 58.0.17 is patched in `patches/expo@58.0.17.patch` so a DOM component ignores a props
message that it sends before Android mounts its web view, or after Android removes it. Android
rejects these calls, and the rejection shows as a console error. The DOM component asks for the
props again when it is ready.

expo-splash-screen 58.0.11 is patched in `patches/expo-splash-screen@58.0.11.patch` so Android 12
and 13 get no splash exit animation listener. With the listener, the platform hides the starting
window on the first draw, and the app crashes when that window is already gone. Gradle links the
prebuilt AAR of an Expo module and ignores a patch to its Kotlin source, so
`expo.autolinking.android.buildFromSource` in `package.json` builds `expo-splash-screen` from source.

@react-native-masked-view/masked-view 0.3.2 is patched in
`patches/@react-native-masked-view%2Fmasked-view@0.3.2.patch` to change only its TypeScript types. They
extend `NativeMethods`, which React Native 0.87 removed from its types, so `MaskedView` was not a
valid JSX component. Remove the patch when a release fixes the types.

react-native-screens 4.30.0 is patched in `patches/react-native-screens@4.30.0.patch` so the full
screen swipe back of a chat waits for a gesture handler pan in the top screen to fail. The swipe back
starts anywhere in the chat, and a swipe to the right on a message bubble still replies. Without
the patch, no rule sets which of the two recognizers gets the swipe. Remove the patch when a
release sets this failure requirement.
If a row or pinned avatar is tapped during the native return transition, the app retains that
tap until the list is focused and `transitionEnd` fires. It then invokes the original Link
handler once, without a fixed delay.
Focus is read from the route's live `isFocused()` state; nested navigators do not always emit
an initial `focus` event, so a first tap must not depend on receiving one.

Keyboard Controller 1.22.7 is the version that Expo SDK 58 pins for Expo Go. Custom development clients and
standalone apps must be rebuilt after adding this native dependency; a JavaScript reload alone
cannot add it to an existing binary. All channels use the fingerprint runtime policy, so these
updates cannot target older app-version `1.0.0` binaries without Keyboard Controller. Build and
distribute a binary with the new fingerprint before publishing compatible OTA updates.

Run commands from the repository root:

```bash
bun run mobile
bun run mobile:android
```

`bun mobile:android` applies the config plugins without clearing `android/`, then runs
`expo run:android`. Three local settings make a build in a new worktree faster:

- A release variant builds native code only for the ABIs of the connected devices and running
  emulators, not for all four. Pass `--all-arch` to build every ABI.
- The local `android/gradle.properties` gets `org.gradle.caching=true`. Worktrees share Gradle task
  outputs in `~/.gradle/caches/build-cache-1`. The app config, fingerprint and EAS builds stay the
  same.
- `CCACHE_BASEDIR` and `CCACHE_NOHASHDIR` let ccache share the C++ results of the app CMake project
  between worktrees. Install ccache with `brew install ccache`; React Native uses it when it is on
  `PATH`.

Chat links use a local link icon, with a smaller icon in thought-process text. Rendering links
or Markdown images does not contact their destinations; they open only on tap.

The Bloub loading overlay first renders a single idle pose. After commit, the animation provider
prepares one shared 30 fps sequence in idle batches of at most four frames. Hidden loaders and
reduced-motion mode do not start that work. Exit geometry is prepared the same way while holding
the current pose, then settles to idle before scaling down; unfinished preparation is cancelled
when no longer needed.

Working avatars also prepare their sequences in idle batches of at most four frames, sharing
both pending work and cached geometry across presentations. They hold the idle pose until ready;
leaving the screen or ending activity unsubscribes, cancelling preparation when no player needs it.
Returning to idle uses the same bounded scheduler and holds the displayed pose until ready;
resuming activity or unmounting cancels the pending return.

Streaming Markdown reveals words only for messages up to 2,000 characters. Longer responses
show incoming text directly, avoiding a full Markdown parse for every additional word reveal.

Structured question forms appear inline in mobile chat, including when reopening downloaded history.
They support option selection, multiple questions, skipping and cancellation. Custom answers are typed
in the main chat composer and sent to the current form question, rather than posted as chat messages. Responses
use the existing `/v1/prompts/respond` endpoint over the authenticated desktop connection; conversation
updates synchronize their resolution across devices. Offline forms are disabled, failed submissions
can be retried, and completed or expired forms cannot be submitted again. Private answers use a
secure input and are omitted from the local completion summary; unsent drafts stay in component memory.

When no agents have loaded and the selected server is connecting or offline, the agent list shows
`Waiting for connection`. The empty-server prompt appears only once the server is online; agents
already loaded remain visible during reconnection.

The phone keeps an encrypted copy of the agents, hidden agents, sections, latest chat pages and last
drawer values (`drawer-snapshot.ts`) of each server (`workspace-cache.ts`), and writes it when a
server load ends and when the app goes to the background. After a start, a server shows its copy at once, and its first connection attempt is
quiet for 5 seconds, as a return to the app is. The UI does not mark the copy: a server that takes
longer shows the usual reconnect status and faded avatars. Its own reads then replace the copy.
Sign-out, an expired session and the removal of a server delete it.

While a server is disconnected, its agent avatars and colored chat bubbles fade locally with the same
280 ms transition. Voice controls and suggested prompts are disabled until the server is online. The
chat input and attachments stay usable: a sent message goes to the phone's outbox and is drawn
lighter. One line under the last waiting message says `Sends when the server is online`, and touch
and hold on a waiting message opens the native context menu with Edit and Don't send. While the
history waits for the server, `Waiting for connection` shows under the reconnect status above the
composer; in the chat that status shows only the attempt and the countdown. The outbox is saved per account in the app's documents,
so it survives a restart. Each chat sends its messages one at a time and in order while its server is
online. An agent message carries a `clientMessageId` when the host advertises `message-client-id-v1`,
and a channel message uses the same id as its `operationId`, so a repeat after a lost reply stores
the message once. A message that the host refused shows `Not sent`, and its menu adds Retry; it holds
the later messages of its chat. A message that the host may have stored is not repeated when
the host cannot drop a repeat, or 12 hours after its first attempt; it shows `Not confirmed`. This
visual state is derived only in the mobile UI: it never changes the agent's synced avatar profile or
sends appearance updates to the server.

The app lock (Settings > App lock) uses a 4-digit PIN, the phone's biometrics with the phone
passcode as fallback (`expo-local-authentication`, strong biometrics only), or both. The
settings are in secure storage that a start in the background can read, so the app starts locked. The PIN is stored as a salted PBKDF2-SHA256 hash, and the failed attempts are stored
before each check, both in this-device-only secure storage. A 4-digit PIN cannot resist a
person who reads the Keystore; the Keystore and the attempt limit protect it. After 4 failures each
attempt waits longer, and the 10th failure signs out. Every change in App lock asks the owner to
unlock first, unless the owner unlocked in the last 5 minutes. The local `modules/app-lock` native module
measures the time away with a clock that counts during sleep and ignores changes of the phone's time.
It reports a phone lock from `ACTION_SCREEN_OFF`. Android counts the app as away only when no activity
of the app is visible, so permission and biometric dialogs do not lock it. On Android 13 and later the
recent apps show a blank card. The lock screen draws in a `Modal`, above sheets. Notification, quick action and
share navigation waits until the user unlocks. Expo Go does not have the module: it measures with the phone clock and cannot see a phone lock.

## iPhone

The iPhone app uses the same screens as the Android app. The design is the same; iOS adds its own
system parts: the native back swipe, Face ID or Touch ID for the app lock, Liquid Glass on iOS 26,
the iOS share sheet and date pickers, and the system haptics.

- `bun run mobile:ios:prebuild` makes `ios/` from `app.json`, `app.config.js` and the config plugins.
  Run it again after a change to them.
- `bun run mobile:ios` builds the app, installs it on a simulator and starts Metro. Add `--device` for
  a connected iPhone, and `--configuration Release` for a build that runs without Metro.
- A build for a phone needs `TOMMY_IOS_BUNDLE_ID` and `TOMMY_APPLE_TEAM_ID` in the root `.env`. See
  [docs/INSTALL.md](../../docs/INSTALL.md#4-iphone-app).
- `app.config.js` adds the share extension (`expo-sharing`) and the Notification Service Extension
  (`plugins/with-notification-service.js`). Both share the App Group `group.<bundle ID>` with the app:
  the app writes the notification keys and the agent pictures there.
- The native modules in `modules/` have a Swift part in `ios/` beside the Kotlin part. `modules/speech`
  fetches the sherpa-onnx xcframework at `pod install` and checks its SHA-256.
- CI builds the app for the simulator and runs `scripts/ios-simulator-smoke.ts`, which pairs it with a
  test host and takes screenshots (`.github/workflows/ios.yml`).

## Source structure

The mobile app uses a feature-first structure. Expo Router files stay deliberately thin: `src/app`
defines URLs, route groups, guards, and navigator options, while screen implementations live with
the feature that owns them.

```text
src/
  app/                  Expo Router routes and layouts only
    (app)/              routes available to an authenticated session
  features/
    auth/               QR and email sign-in, session storage, and session context
    agents/             agent list, agent actions, and pin transitions
    chat/               chat screen and its focused UI sections
    search/             search model, controls, results, and screen
    servers/            server drawer and joining a server
    settings/           account settings screen
    workspace/          server connection, live events, and workspace state
  shared/
    components/         UI used by more than one feature
    lib/                platform and infrastructure helpers
```

Keep code inside a feature until a second feature needs it. Move it to `shared` only when it has no
feature-specific behavior. Shared code must not import from features; direct feature-to-feature reuse
should stay explicit so it cannot turn into an accidental circular dependency.
Split screens into focused sections when they combine navigation, local state, and multiple distinct
UI regions; for example, chat owns separate header, message-list, and composer components.

## Design development

The mobile design system is documented in [`DESIGN.md`](./DESIGN.md). Read it before implementing or reviewing UI.

In short, use HeroUI Native for application content and reusable product components. Use native Expo Router and `@expo/ui` surfaces for navigation, headers, tabs, toolbars, search, menus, and route-level sheets so the platform owns its chrome.

## Verification

Chat follows the [v0 chat interaction model](https://vercel.com/blog/how-we-built-the-v0-ios-app).
`use-chat-motion.ts` owns measurements, native blank-space insets, initial positioning, and send
animation sequencing. Message groups keep stable keys. Responses fill the blank space without
autoscrolling; the down-arrow returns to the latest content. Keyboard Controller absorbs keyboard
and composer growth into the blank space before shifting content at the end of the chat.

Streaming Markdown uses a bounded reveal pool (four active nodes, batches every 32 ms). It renders
the complete received text without a second typewriter queue. Reduced motion skips movement.
The floating composer uses the existing Expo glass components with an opaque accessibility fallback.
Mobile file attachments are currently disabled by `CHAT_ATTACHMENTS_ENABLED` in
`use-chat-attachments.ts`. The plus button shows a native Coming soon dialog; large pasted text
stays in the input. When enabled, the native menu on the plus button opens Files. The plus button and input share one row; there is
no separate paste button. The native multiline input grows to five lines, then scrolls internally;
its height limit follows the system font scale. Large text pasted into the input becomes a text attachment.
Photos, videos and other files pasted into the input become attachments through the local
`modules/composer-paste` native module; Expo Go does not have it and pastes text only. Mobile uploads
use the released file-transfer protocol and are limited to 10 MB per file. Sending dismisses the
keyboard. The gesture area covers the chat and uses the measured composer height for dismissal.
The installed Keyboard Controller content-inset hit-test workaround enables scrolling in blank space.

Device verification must cover: first send with the keyboard open/closed; subsequent sends; short
and long responses; initial history position; scrolling up while streaming; down-arrow; multiline
composer growth at the end and in history; interactive keyboard dismissal and swipe-to-focus;
background/foreground; reduced motion/transparency; text/image/file paste; upload failure and retry.
Code blocks show the fence language and a Copy action. They use the same syntax tokenizer as
desktop, render native text, and retain plain text for unknown languages. Highlighting does not
change source whitespace. Copy writes only the source to the system clipboard.
The local model and protocol tests do not establish native animation quality.

```bash
bun run mobile:lint
bun run mobile:typecheck
bun run mobile:doctor
```

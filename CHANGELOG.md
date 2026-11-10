# Changelog

## [0.60.1]

### Upgrade notes

- **Android: install this release's APK to use GPT live voice.** The new native WebRTC module
  needs an updated app. A JavaScript-only update cannot add it. Mobile builds target Android.
- **Claude: enable Fast again only after you confirm its cost.** When upgrading from 0.59.0 or
  earlier, Tommy turns off an inherited Fast flag once. Agents and conversations stay in place.
- **Linux key-file fallback: keep `secret-storage.key` with the Tommy data directory.** This
  optional mode writes secrets that older builds cannot read. Losing the key makes those secrets
  unreadable. Keep the default keyring mode unless the installation needs the fallback.
- **For webhook and connector features, configure the host first.** Set the optional values in
  `docs/INSTALL.md` and `.env.example`. Empty values leave these features off.

### Changes

- Fix the Android release build by using the installed package's canonical deletion icon path.
  The icon and its behavior stay the same.
- Include all workspace, agent and mobile improvements from 0.60.0.

## [0.60.0]

### Upgrade notes

- **Android: install this release's APK to use GPT live voice.** The new native WebRTC module
  needs an updated app. A JavaScript-only update cannot add it. Mobile builds target Android.
- **Claude: enable Fast again only after you confirm its cost.** This upgrade turns off an
  inherited Fast flag once. Agents, conversations and saved work stay in place.
- **Linux key-file fallback: keep `secret-storage.key` with the Tommy data directory.** This
  optional mode writes secrets that older builds cannot read. Losing the key makes those secrets
  unreadable. Keep the default keyring mode unless the installation needs the fallback.
- **For webhook and connector features, configure the host first.** Set the optional values in
  `docs/INSTALL.md` and `.env.example`. Empty values leave these features off.

### Changes

- Keep queued work and provider context stable through interruptions, compaction and restarts.
- Add separate routine threads, workflow tools, signed webhooks and native host connectors.
- Add reviewed skill learning with immutable revisions, explicit Save and revision restore.
- Add the Library, managed batch downloads, message deletion and history cleanup.
- Add optional live voice, account model catalogs, speed controls and Vault authenticator codes.
- Improve browser profiles, proxy handling, login safety, Android drafts and conversation controls.
- Keep direct WSS, host-owned data and released Team protocols. Add data-preserving migrations
  through schema 58.
- Preserve the Mac connection and latest-page fixes, Android dictation without a downloaded reply
  voice, and the selected splash appearance.

### Development

- Add a background mode for UI checks without taking focus from another app.
- Start a fresh development profile without calling the removed demonstration seed command.

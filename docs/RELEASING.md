# Releasing

Releases come from CI only. A tag `v<version>` runs [release.yml](../.github/workflows/release.yml).
It keeps only what users cannot easily build themselves:

| File | Built on | Ready after | Notes |
| --- | --- | --- | --- |
| `Tommy-<version>-arm64.dmg`, `.zip`, `latest-mac.yml` | `macos-15` | about 9 minutes | Developer ID signed, hardened runtime, notarized and stapled |
| `Tommy-<version>-android-arm64.apk` | `ubuntu-latest` | about 25 minutes | Signed with the release key; no Firebase, so no push notifications |

The release is published when the Mac app is ready; most of those 9 minutes are Apple's notary
service. The APK joins the same release when its build is done. The server has no release file: it
is built from source by [docs/INSTALL.md](INSTALL.md). GitHub shows the SHA-256 of each file.

The standard GitHub-hosted runners are free for a public repository, macOS included.

The README leads with the agent install ([docs/INSTALL.md](INSTALL.md)). A release is the second
way to get the apps, so keep the file names that `docs/INSTALL.md` downloads.

## Secrets

Set these in the repository settings (Settings › Secrets and variables › Actions). Never commit
them, and never print them in a workflow.

| Secret | Value |
| --- | --- |
| `MAC_CERTIFICATE_P12` | Base64 of a `.p12` that holds a "Developer ID Application" certificate and its private key |
| `MAC_CERTIFICATE_PASSWORD` | The password of that `.p12` |
| `APPLE_API_KEY_P8` | The text of an App Store Connect API key (`AuthKey_<id>.p8`), role Developer |
| `APPLE_API_KEY_ID` | The key ID of that API key |
| `APPLE_API_ISSUER` | The issuer ID shown on the App Store Connect API keys page |
| `ANDROID_KEYSTORE` | Base64 of the Android signing keystore (alias `androiddebugkey`, password `android`) |

Keep the same Android keystore for every release: Android refuses an update that another key signed.

## Make a release

1. Run the [release-upgrade-safety](../.agents/skills/release-upgrade-safety/SKILL.md) audit on the
   change set since the last tag.
2. Add `## [<version>]` to `CHANGELOG.md`. Put required upgrade actions in bold. CI publishes
   that section as the release notes and stops if it is missing.
3. Set the new version in `package.json` (`version`) and commit it to `main`.
4. Optional: run the workflow by hand (Actions › Release › Run workflow) on `main`. It builds, signs
   and notarizes everything and keeps the files as workflow artifacts, without a release.
5. Tag the commit and push the tag:

   ```bash
   git tag v<version>
   git push origin v<version>
   ```

The `Version` job stops the run when the tag differs from `package.json` or the tagged commit is not
on `main`. The Android version code is `major * 1000000 + minor * 1000 + patch`.

## When a build fails

- Mac signing: `codesign` or `spctl` fails in "Check the signature and the notarization". Check that
  the certificate is a Developer ID Application certificate and has not expired.
- Notarization: the log of "Build, sign and notarize" shows the notary service answer. An invalid
  API key or issuer stops it at once.
- Run the failed job again only for a network or runner fault (`gh run rerun <id> --failed`).

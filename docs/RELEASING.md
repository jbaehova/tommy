# Releasing

Releases come from CI only. A tag `v<version>` runs [release.yml](../.github/workflows/release.yml).
It builds the unpacked Linux server and publishes it as a GitHub release:

| File | Built on | Notes |
| --- | --- | --- |
| `Tommy-<version>-linux-x64.tar.gz` | `ubuntu-latest` | The unpacked server that `tommy-install` installs |
| `Tommy-<version>-linux-arm64.tar.gz` | `ubuntu-24.04-arm` | The same, for arm64 servers |

The README leads with the agent install ([docs/INSTALL.md](INSTALL.md)), which builds the server from
source. A release is the second way. GitHub shows the SHA-256 of each file. The release needs no
secrets.

## Make a release

1. Run the [release-upgrade-safety](../.agents/skills/release-upgrade-safety/SKILL.md) audit on the
   change set since the last tag.
2. Add `## [<version>]` to `CHANGELOG.md`. Put required upgrade actions in bold. CI publishes
   that section as the release notes and stops if it is missing.
3. Set the new version in `package.json` (`version`) and commit it to `main`.
4. Optional: run the workflow by hand (Actions › Release › Run workflow) on `main`. It builds
   everything and keeps the files as workflow artifacts, without a release.
5. Tag the commit and push the tag:

   ```bash
   git tag v<version>
   git push origin v<version>
   ```

The `Version` job stops the run when the tag differs from `package.json` or the tagged commit is not
on `main`.

## When a build fails

- Run the failed job again only for a network or runner fault (`gh run rerun <id> --failed`).

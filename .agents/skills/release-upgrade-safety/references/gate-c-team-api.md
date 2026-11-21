# Released Team contracts

Compare the candidate to the release tag for each supported historical protocol. Include helpers in
mixed modules that an adapter calls. A change to a decoder can change the wire while its entry point
stays byte-identical.

```sh
git diff --name-status --find-renames <tag> HEAD -- packages/contracts
git ls-tree -r --name-only <tag> packages/contracts/src/team-protocol
git ls-tree -r --name-only HEAD packages/contracts/src/team-protocol
```

Trace historical producers and consumers from those revisions. For each changed encoder,
projection, parser or status mapping, compare representative old inputs and outputs on both
revisions. Include unsupported capabilities, unknown optional fields, invalid required fields,
bounds, and user-visible errors. Replay release fixtures when available. For an active peer
transport also exercise older client to newer host, newer client to older host, matching peers
and peers with no shared protocol. Report which versions and directions actually ran.

Keep each released wire meaning. Use a new capability or version for a changed behavior.
Check that removing an old desktop source export cannot remove a codec dependency.

# Stored files and credentials

Compare the names, contents and readers of persisted files at the release tag and the candidate.
Start from service construction and the changed features. Find additional version guards with
`git grep -iEn 'version.*(literal|===|!==)' <tag> HEAD -- src/main src/backend`.
Follow imports into private packages and check keyring services and filesystem directory names.
Search both revisions so a deleted reader remains visible.

For each change:

- Read the old record with the new code in an isolated directory. Preserve unknown values that a
  previous release could store. A decoding error must leave the only copy intact.
- Check where a previous build looks after a downgrade. If it rewrites an incompatible value to
  defaults, use a supported versioned format or separate paths. Retain the earlier file where its
  reader still needs it.
- Stop partway through a write or transfer. Retry the operation and reopen the same profile.
  Check duplicate deliveries, ownership, partially committed files and receipts.
- Reopen encrypted state using the installed service user and keyring. Keep a failed decryption
  separate from an empty store. Check reset, revoke, account rotation and reconnect where relevant.
- Keep legacy application preferences and old user artifacts in place when retiring their readers.
  An upgrade must not sweep user files because a UI no longer uses them.

For Telegram, check connection generations, delivery cursors and pending queue state. Revoke or
rebind a connection during a pending delivery. Verify that the next recipient cannot receive the
previous chat's private data.

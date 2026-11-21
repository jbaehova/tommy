# Reverse actions and release notes

For each state the release adds or changes, exercise its reverse action. Examples include resume,
unmute, reconnect and cancellation of a pending sign-in. Repeat after a restart where the state is
durable. Check what happens to pending work when an agent is hidden or a connection is revoked.

Put required upgrade actions in bold in the version section of `CHANGELOG.md`. State who must act,
which command or setting they need and what data the upgrade preserves.

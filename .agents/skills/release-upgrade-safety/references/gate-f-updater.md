# Linux release and installation

Audit the release workflow, Electron package settings, the installer and the service scripts. CI
builds an unpacked application for x64 and arm64 and publishes their archives on a version tag.
A manual workflow run builds artifacts. See [Releasing](../../../../docs/RELEASING.md).

Check both packages for the server executable, sandbox helper, separate database host, driver for
the architecture, operator CLI, hosting scripts and license files. Preserve the app ID, service user,
keyring identity, Electron fuses and configured data paths. Compare the target versions and hashes
of all retained provider and driver files in `native-runtime.lock.json`. Verify existing releases
can still read the revocations at `provider-runtime-blocklist.json`.

When installation, storage or service startup changed, upgrade a disposable Linux installation
from the released archive. Stop it, install the candidate and restart it. Reopen its existing
database and keyring. Check attachment ownership, agent sessions, pending Telegram work and service
shutdown. Verify that the installed Chromium sandbox and AppArmor profile are active. Record any
untested architecture or missing live credential.

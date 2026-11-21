# Skills and MCP tools

## Skill folders and MCP configuration

A skill directory contains `SKILL.md` with a name and description in its YAML frontmatter. Managed skills ship under [resources/managed-skills](../../resources/managed-skills). The installer places each managed skill in the agent workspace where supported providers can find it. Keep installation receipts and file hashes when enabling or disabling a skill.

The `tommy-data` skill uses the shared agent database. All agents can read and change rows. Only the owning agent can remove its table through the agent tools. Keep credentials in the server's secret store.

MCP servers use a command with arguments or an HTTP endpoint. The host prepares managed tool runtimes before it starts a command. An HTTP server can require [MCP sign-in](integrations.md#mcp-sign-in).

## Local skill library

The [library](../../src/main/local-skill-library.ts) stores immutable revisions under `local-skills/<id>/<revision>/bundle.zip` in application data. A staging directory becomes a revision only after the archive has been written. A revision change checks the expected version.

A new library revision and an installed copy have separate lifetimes. The installer validates the bundle, writes the provider directories and records the installed hashes. Restoring a learned skill creates a revision and installs it. Disabling learning cancels work that is still in progress.

See the [skill learning service](../../src/main/skill-learning-service.ts) and [skill learning E2E](../../scripts/skill-learning-e2e.ts).

A pack is one bundle that holds skills of its own in `skills/<slug>-<name>/SKILL.md`. The installer writes each one as the sibling folder `<slug>-<name>` in both provider directories, so a provider finds it and `$<slug>-<name>` lists it, and keeps them all under the pack's one lock entry: install, update, disable, enable and removal act on every folder together, with one download and one install receipt.

The backend local skill tools identify the agent from the calling provider session. Per-agent install operations serialize changes to its files, installed hashes and disabled copies. A new library revision does not implicitly update an installed copy.

Skill learning is a host preference with Ask first as its default. It can be automatic or off.
A background writer has no tools and accepts only a general reusable procedure. Before publishing,
it rejects secrets and installation-specific identifiers. Saving names a stored suggestion message;
the caller cannot supply generated skill contents or a filesystem path through that endpoint. Manual
skill tools keep their existing human-request gates.

Each learned publication keeps an operation receipt beside its immutable bundle. A duplicate save,
including a retry after restart, reuses that receipt and cannot overwrite a later installed
revision. Updates require the expected revision. Restore copies an older bundle into a new revision.
Off cancels pending publication; a revision that already committed stays intact. Review cursors are
host-local disposable state, scoped by agent and thread. Removing one scope preserves other cursors.

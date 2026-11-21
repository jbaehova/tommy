# Tommy architecture

Tommy runs as a systemd service on Linux. Telegram is the owner's chat interface. The same server runs the agents, stores their work and hosts the Mini App. Its other entry points are the operator socket, the local scripts API and configured incoming webhooks.

| Topic | Where to start |
| --- | --- |
| [Structure and state](architecture/structure.md) | Which process owns the data and credentials |
| [Server lifecycle and storage](architecture/servers.md) | Startup, SQLite, attachments and restart |
| [Agents and routines](architecture/agents.md) | Workspaces, threads, scheduling and recovery |
| [Channels and Telegram](architecture/channels-and-messaging.md) | Internal collaboration and delivery to an owner |
| [Providers](architecture/providers.md) | Sessions, tool discovery and managed executables |
| [Browser](architecture/browser.md) | Browser tools, screenshots and private input |
| [Computer Use](architecture/computer-use.md) | Driver and separate agent display |
| [Webhooks](architecture/events.md) | Signatures, duplicate requests and revocation |
| [External integrations](architecture/integrations.md) | MCP sign-in and workflow connectors |
| [Skills](architecture/skills-and-plugins.md) | Managed skills, local revisions and installation |
| [Change rules](architecture/change-rules.md) | Trust boundaries, compatibility and focused checks |

For operations, use the [installation guide](INSTALL.md). For setup and available commands, use the [development guide](DEVELOPMENT.md).

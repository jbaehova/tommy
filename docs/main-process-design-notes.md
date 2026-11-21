# Main-process design notes

## Privileged services

The Electron main process owns browser windows, the system keyring and the HTTP listeners. Web content runs in a sandbox with context isolation. The agent browser has no application preload. Window navigation, permissions and access to local attachments must remain checked at the host boundary.

The Telegram Mini App is an HTTPS page. The server authenticates its launch data and uses the current chat binding before serving a private request. Keep unrelated endpoints and the operator socket outside the reverse proxy. See [security-sensitive changes](../CONTRIBUTING.md#security-sensitive-changes).

## Construction and shutdown

The application entry point sets up the Electron process before it constructs services. [Application services](../src/main/application-services.ts) registers each service with its teardown order when it starts. If initialization fails or the process receives a stop request during startup, the registry can close resources already acquired.

A callback that runs after initialization must read the current state of the service or window it uses. The database must remain available while services finish work that writes a receipt. Finish the browser and provider shutdown before the service exits.

Construction order makes dependencies explicit. A new service can depend on an already constructed instance. A callback registered before construction must obtain the service when the callback runs. Capturing an early null value can pass a type check and still lose the service for the lifetime of the process. Teardown ordinals keep the intended shutdown order beside startup. Closing in reverse construction order could stop the agent service before its provider runtime finishes.

## MCP sign-in redirect address

The MCP authorization request and the token exchange must agree on the redirect URI. Local authorization can use the loopback listener. An owner who starts authorization in Telegram uses the exact HTTPS callback of the configured server. Keep the per-request state, code verifier and token exchange on the host. The callback must not print its query.

A saved dynamic client registration may name a different redirect URI. For interactive sign-in the authority can register again with the current URI. A token refresh uses the existing client registration and does not require a redirect. The exchange of a grant already in hand must use the client ID to which that grant was issued.

See [MCP accounts and callbacks](architecture/integrations.md) and the [installation guide](INSTALL.md).

## Released protocols

Released clients can depend on decoders accepting an old shape or rejecting malformed metadata. Preserve those rules in the [Team protocol modules](../packages/contracts/src/team-protocol). Current Telegram commands and callbacks authenticate the caller at their own boundaries.

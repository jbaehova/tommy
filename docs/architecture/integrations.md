# External integrations

## MCP sign-in

An MCP server uses a local command or an HTTP URL. The host owns the configuration. Some HTTP servers require an OAuth grant. When an agent needs one, the originating Telegram chat shows a **Connect** button. The Mini App verifies the owner's Telegram launch data for that chat before it opens the provider's authorization page.

Register the HTTPS callback `/tommy/telegram/app/mcp/callback` on the configured public origin when the provider requires a fixed redirect URI. The host matches the returned state to the outstanding request and completes the exchange with PKCE. The owner sees the result in the original chat. A request can expire, be refused or lose its chat binding. A completed sign-in can refresh the tool list. A previous external action must not run again as a side effect of sign-in.

A sign-in started locally can still use the [loopback listener](../../src/main/mcp-oauth-redirect-server.ts). The Telegram flow uses the public callback because a browser on the owner's phone cannot reach the server's loopback address.

## Accounts and tokens

The [OAuth authority](../../src/backend/mcp-oauth-provider.ts) reads the stored grant, refreshes it and handles revocation. Two connections can use the same upstream URL. A saved account fragment distinguishes their local records. The host strips it from requests to the provider.

The provider process gets a local MCP proxy route for the account. The [proxy](../../src/backend/mcp-oauth-proxy.ts) adds authorization on the server. The encrypted [grant store](../../src/main/mcp-oauth-store.ts) is separate from the SQLite conversation database. Keep tokens, callback queries and authorization codes out of logs and chats.

### How an MCP sign-in renews and ends

`McpOAuth` ([`mcp-oauth-provider.ts`](../../src/backend/mcp-oauth-provider.ts)) renews a token
before a thread start or a test, with no browser. The renewal calls `refreshAuthorization` of the
SDK, not `auth()`, so it never registers a new client. The answer of the token endpoint sets what
stays:

| Answer | Tokens | Client registration | Sign-in app, discovery | Row |
| --- | --- | --- | --- | --- |
| New token set | Replaced | Kept | Kept | Signed in |
| `invalid_grant` | Dropped | Kept | Kept | Sign-in needed (`lostAt`) |
| `invalid_client`, `unauthorized_client` | Dropped | Dropped | Kept | Sign-in needed (`lostAt`) |
| No network, a server error, a timeout | Kept | Kept | Kept | No change |

Sign-out and removal delete the local tokens first. Then Tommy sends one best-effort RFC 7009
request per token, refresh token first, to the `revocation_endpoint` of the authorization server.
The request goes through `secureOAuthFetch`, with the client authentication of the registration and
a 5-second limit. A failure is logged with the origin and the status only, and is not shown.

`secureOAuthFetch` limits each OAuth request: the body is at most 1 MiB, and the answer must come in
20 seconds. The outer deadlines stay. A request to the MCP URL itself is MCP traffic, because the
probe uses the same fetch for the transport, so it has no size or time limit. When the host of the
MCP URL resolves only to public addresses, each OAuth host (metadata, authorization server, token,
registration and revocation endpoints) must also resolve only to public addresses, or the request
fails with `error.backend.mcpOAuthPrivateEndpoint` before it connects. A failed lookup also stops
the request. A LAN or localhost MCP URL has no such check. The check does not pin the address, so
DNS can change between the check and the connection; this residual risk is accepted.

### Separate accounts for the same service

Each HTTP connection has its own row and may carry a local `#account-<id>` fragment. A row created before account fragments keeps its existing grant. Discovery, token refresh, registration and revocation all use the address with the fragment removed.

### How an agent reaches a signed-in MCP server

An agent never gets an OAuth token. `McpGateway.endpoint` gives a provider a route of
`McpOAuthProxy` ([`mcp-oauth-proxy.ts`](../../src/backend/mcp-oauth-proxy.ts)) for each http row
that has a sign-in on this computer, or a sign-in that the server ended, and no manually supplied `Authorization` header.

| Part | Rule |
| --- | --- |
| Address | `http://127.0.0.1:<port>/mcp/<route>/<agent>`. The route is a digest of the row id and its URL, so a changed URL is a new route. The agent segment is a digest of the agent id (`mcpOAuthProxyAgentKey`). `/mcp/<route>` with no agent segment stays valid: Codex sessions from before the segment hold it. |
| Bearer | An HMAC of the route and the agent segment with the proxy secret. A bearer opens one route for one agent only. It is compared with `timingSafeEqual` and registered for redaction. |
| Identity | The `clientInfo` of each `initialize` becomes `{ name: "tommy", title: "<agent name> (Tommy)", version, websiteUrl }`; the name is read at each `initialize`, so a rename shows in the next session. With no known agent the title is `Tommy`. `User-Agent` is `Tommy/<version>` unless the row sets one. A body that is not JSON, is a batch, or is larger than 64 KiB goes through unchanged. |
| Refused with 403 | A `Host` that is not `127.0.0.1:<port>` or `localhost:<port>`, an unknown path, a wrong bearer. |
| Upstream | The row's URL and its headers, with the current token. The provider's `Authorization` and cookies are not sent. Only same-origin 307 and 308 redirects are followed, at most 3. |
| Server answers 401 | One `McpOAuth.refreshAccessToken`, then one retry with the new token. |
| No sign-in | Each request gets JSON-RPC error `-32001`, notifications get 202, GET and DELETE get 405. The proxy never answers 401, so the provider does not start its own sign-in. |
| Server not reached | 502 with JSON-RPC error `-32603`. |

Each request reads its target from the enabled rows and the stored sign-in. Removing, turning off,
editing or signing out of a row refuses its route at once; there is no list of routes to keep
current. A proxy that cannot start drops the row from the hand-off with
`error.backend.mcpOAuthProxyUnavailable`. The raw token is never the fallback.

The port and the secret are kept encrypted in `tommy-mcp-oauth-proxy-v1.json`. Codex keeps the
MCP configuration of a resumed thread, so the same address must work after a restart. When the
saved port is in use, the proxy takes a new port and a new secret, so the old bearers stop working.
The Codex tool manifest records the proxy address and the proxied rows; a change replaces the Codex
session at its next turn. A computer with no proxied row keeps its manifest.

## Workflow connectors

The Linux operator configures GitHub, Slack and Telegram under `TOMMY_WORKFLOW_CONNECTORS_JSON`. Inbound requests arrive at the signed routes on the public listener. Connector credentials and allowed destinations are installation settings. Internal Tommy channels use a different workflow output.

See [connector setup](../INSTALL.md#signed-workflow-webhooks-and-connectors) and [webhook processing](events.md). A stored graph can contain a retired Discord node. Keep its definition and run history readable when editing other nodes.

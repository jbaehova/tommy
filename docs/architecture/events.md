# Webhook routines and workflows

A configured server accepts direct HTTPS requests for routines and workflows. Nginx forwards the allowed paths to the loopback HTTP listener. Each receiver authenticates its own requests. Set the public origin and sender credentials as described in the [installation guide](../INSTALL.md#signed-workflow-webhooks-and-connectors).

## Route lifecycle

A routine webhook belongs to an agent or a channel. A workflow can own a webhook trigger as well. The host keeps the route ID, encrypted signing secret and delivery receipts in SQLite. Changing a routine's trigger can retain the routine ID and its run history.

The [route store](../../src/backend/webhook-route-store.ts) keeps receipts and pending revocations. Pause, delete and revoke stop future work according to the stored route state. Rotation replaces the signing key. Restart reconstructs routes from host state. A route must still be active when the host dispatches the request.

## Inbound request

The receiver bounds the body and checks the signature over its original bytes. Tommy signatures cover `timestamp.deliveryId.body`. Standard Webhooks signatures cover `id.timestamp.body`. Both formats require a timestamp within five minutes. The size limit on the incoming body is 64 KiB. A provider-specific receiver, such as GitHub, uses that provider's verification rules.

The host checks the route and the delivery ID before it starts work. A retry of an accepted ID must not create a second run. A routine can filter the event type and match scalar values with JSON Pointer. Treat inbound payloads as data.

See [signature verification](../../src/main/webhook-security.ts), [trigger validation](../../src/backend/webhook-trigger.ts) and the [direct webhook E2E](../../scripts/direct-webhooks-e2e.ts).

### Delivery outcomes

| HTTP status | Host outcome |
| --- | --- |
| 200 | The host has already recorded the delivery ID. |
| 202 | The run started or the route ignored the event under its filter or active state. |
| 400 | The body cannot be decoded as a supported event. |
| 401 | The timestamp or signature is invalid. |
| 404 | The host has no active route for the supplied ID. |
| 413 | The body or expanded run instruction exceeds its limit. |
| 503 | The host cannot accept work or cannot decrypt the signing secret. |

The receipt and the run commit in one transaction. The unique key `(owner_kind, routine_id,
delivery_id)` makes a repeated delivery a no-op. Ignored requests also write a receipt, so their IDs
are also deduplicated. Receipts older than 7 days do not count as duplicates, and they are pruned when
a new receipt is written. The
event is kept only in the run instruction, between `--- external event input ---` markers, so a
restart that resumes the run still has it. Runs use the existing agent and channel queues, provider
limits, and approval controls. While a restart waits for idle agents (`holdRoutines`), the host
answers 503 and writes no receipt, so the sender retries after the restart.

### Workflow webhook triggers

`rotateWorkflowSecret` creates the route ID and secret together when needed. Removing the trigger or deleting its workflow records its route revocation with the change. A verified request for a workflow goes to `Workflows.receiveWebhook`. The host keeps the receipt without the body for seven days. An open run causes a new delivery to be recorded as ignored with the reason `busy`. The accepted event becomes the trigger's output, marked as external data.

### Workflow GitHub triggers

The configured GitHub App sends signed events to the direct host route. When a delivery passes verification, the workflow applies the repository, event and item filters.

`Workflows.receiveGitHub` records each delivery in `workflow_github_deliveries`, without the body,
the newest 50 per trigger (`WORKFLOW_GITHUB_DELIVERY_LIMIT`). A delivery ID that is there already
records nothing. A delivery is `started`, `waiting` (its item has an open run), or `skipped` with a
reason:

- `filter`: the event or a filter of the trigger does not match.
- `self`: the event is the echo of a change that a run of this workflow made, by the GitHub object
  ID in `workflow_github_actions`.
- `chain`: The GitHub App caused 3 runs on the item in 10 minutes.
- `refused`: the run could not start.

`workflow_github_runs` links a run to its item. When a run ends, the oldest waiting delivery of its
item starts. The event, marked as data, is the trigger's output.

// Optional write-only sender key configuration. Existing generated-key routes stay unchanged.
// Owner/admin only; neither route returns the secret. A key is 16 to 512 decoded bytes.
import { adminRoute, empty, fields, identifier, type OptionalRouteCodec, oneOf, string, variant } from "./admin-wire";
export const WEBHOOK_SENDER_SECRET_CAPABILITY = "webhook-sender-secret-v1";
export const WEBHOOK_SENDER_SECRET_ROUTES = {
  routine: "/v1/admin/webhooks/routine-sender-secret",
  workflow: "/v1/admin/webhooks/workflow-sender-secret",
} as const;
const owner = variant({
  agent: fields({ kind: oneOf("agent"), id: identifier }),
  channel: fields({ kind: oneOf("channel"), id: identifier }),
});
export const WEBHOOK_SENDER_SECRET_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [WEBHOOK_SENDER_SECRET_ROUTES.routine, adminRoute(fields({ owner, id: identifier, secret: string(1_024) }), empty)],
  [
    WEBHOOK_SENDER_SECRET_ROUTES.workflow,
    adminRoute(fields({ workflowId: identifier, nodeId: identifier, secret: string(1_024) }), empty),
  ],
]);

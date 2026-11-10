// @vitest-environment node
import { WEBHOOK_DELIVERY_BODY_BYTES_LIMIT } from "@tommy/contracts/signal-protocol/messages";
import { describe, expect, it } from "vitest";
import {
  isStandardWebhookSecret,
  signStandardWebhookBody,
  signWebhookBody,
  verifyStandardWebhookSignature,
  verifyWebhookSignature,
} from "./webhook-security";

const key = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const input = {
  timestamp: "1800000000",
  deliveryId: "msg_12345",
  body: Buffer.from('{"type":"invoice.paid","data":{"number":123}}'),
  nowMs: 1_800_000_000_000,
};

describe("Standard Webhooks trust boundary", () => {
  it("authenticates raw bytes and supports multiple versioned rotation signatures", () => {
    const valid = signStandardWebhookBody(key, input.timestamp, input.deliveryId, input.body);
    const other = signStandardWebhookBody(
      `whsec_${Buffer.alloc(32, 8).toString("base64")}`,
      input.timestamp,
      input.deliveryId,
      input.body,
    );
    expect(() => verifyStandardWebhookSignature(key, input, `${other} v2,unsupported ${valid}`)).not.toThrow();
    expect(() => verifyStandardWebhookSignature(key, { ...input, body: Buffer.from("{}") }, valid)).toThrow();
    expect(() => verifyStandardWebhookSignature(key, { ...input, deliveryId: "msg_12346" }, valid)).toThrow();
    expect(() => verifyStandardWebhookSignature(key, { ...input, timestamp: "1800000001" }, valid)).toThrow();
  });

  it("refuses stale or future requests and malformed bounded inputs", () => {
    const signature = signStandardWebhookBody(key, input.timestamp, input.deliveryId, input.body);
    for (const nowMs of [input.nowMs - 300_001, input.nowMs + 300_001])
      expect(() => verifyStandardWebhookSignature(key, { ...input, nowMs }, signature)).toThrow();
    expect(() => verifyStandardWebhookSignature(key, { ...input, timestamp: "1e9" }, signature)).toThrow();
    expect(() => verifyStandardWebhookSignature(key, { ...input, deliveryId: "bad\r\nid" }, signature)).toThrow();
    expect(() =>
      verifyStandardWebhookSignature(
        key,
        { ...input, body: new Uint8Array(WEBHOOK_DELIVERY_BODY_BYTES_LIMIT + 1) },
        signature,
      ),
    ).toThrow();
    expect(() => verifyStandardWebhookSignature(key, input, "v1,abc")).toThrow();
    expect(() => verifyStandardWebhookSignature(key, input, "x".repeat(4_097))).toThrow();
  });

  it("keeps the released Tommy signing format distinct", () => {
    const legacy = signWebhookBody(key, input.timestamp, input.deliveryId, input.body);
    const standard = signStandardWebhookBody(key, input.timestamp, input.deliveryId, input.body);
    expect(() => verifyWebhookSignature(key, input, legacy)).not.toThrow();
    expect(() => verifyStandardWebhookSignature(key, input, legacy)).toThrow();
    expect(() => verifyWebhookSignature(key, input, standard)).toThrow();
    expect(isStandardWebhookSecret(key)).toBe(true);
    expect(isStandardWebhookSecret("not-a-secret")).toBe(false);
    expect(isStandardWebhookSecret(`whsec_${"x".repeat(3_000)}`)).toBe(false);
  });
});

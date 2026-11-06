import type { QueueDelivery } from "@tommy/contracts/ipc";

/** Queue order: position, then the time the message was queued. */
export function queueOrder(left: QueueDelivery, right: QueueDelivery): number {
  const leftPosition = left.position ?? Number.MAX_SAFE_INTEGER;
  const rightPosition = right.position ?? Number.MAX_SAFE_INTEGER;
  return leftPosition - rightPosition || left.createdAt.localeCompare(right.createdAt);
}

/**
 * The first message in queue order that a Steer button can send: queued, and held by no editor.
 * The steer chord of the composer sends this one.
 */
export function firstSteerableDelivery(
  deliveries: readonly QueueDelivery[],
  editingDeliveryId: string | null | undefined,
): QueueDelivery | undefined {
  return deliveries
    .filter((delivery) => delivery.status === "queued" && delivery.id !== editingDeliveryId && !delivery.editing)
    .sort(queueOrder)[0];
}

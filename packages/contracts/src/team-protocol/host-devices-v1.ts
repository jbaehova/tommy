// Frozen optional host-devices-v1 wire contract.
//
// What it grants, recorded here because freezing it makes it permanent: the owner of a server, from
// a device that is already paired, can list the paired devices, make a pairing code for a new device,
// and remove another device. `current` marks the device that asks, and a device cannot remove itself.
// A code works once for five minutes and replaces the earlier code, as a code of the terminal does.
// A member cannot use these routes; `requireOwner` on the host is the only gate. Widening any of it
// needs a second capability string.
import {
  adminRoute,
  boolean,
  count,
  empty,
  fields,
  identifier,
  list,
  type OptionalRouteCodec,
  string,
} from "./admin-wire";

export const HOST_DEVICES_CAPABILITY = "host-devices-v1";

export const HOST_DEVICES_ROUTES = {
  list: "/v1/admin/host/devices",
  pair: "/v1/admin/host/devices/pair",
  revoke: "/v1/admin/host/devices/revoke",
} as const;

const device = fields({ id: identifier, name: string(128), pairedAt: string(64), current: boolean });
const snapshot = fields({ devices: list(device, 1024) });
const pairing = fields({ link: string(4096), code: string(32), expiresAt: count });

export const HOST_DEVICES_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [HOST_DEVICES_ROUTES.list, adminRoute(empty, snapshot)],
  [HOST_DEVICES_ROUTES.pair, adminRoute(empty, pairing)],
  [HOST_DEVICES_ROUTES.revoke, adminRoute(fields({ deviceId: identifier }), snapshot)],
]);

/**
 * The paired devices of a server (`host-devices-v1`), as the desktop main process, the preload and
 * the renderer read them. On the wire the route codec has already checked the fields; this gives
 * them their IPC types and fails closed on anything else.
 */

import { isDynamicRecord, isNumber, isString } from "./runtime-values";

export interface HostDevice {
  id: string;
  name: string;
  /** An ISO date. */
  pairedAt: string;
  /** True for the device that asked. It cannot remove itself. */
  current: boolean;
}

export interface HostDevices {
  devices: HostDevice[];
}

/** The QR code holds `link`, which holds the address and the code. The code stays out of every log. */
export interface HostDevicePairing {
  link: string;
  code: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export function decodeHostDevices(value: unknown): HostDevices {
  if (!isDynamicRecord(value) || !Array.isArray(value.devices)) throw new Error("Invalid device list.");
  return {
    devices: value.devices.map((device: unknown) => {
      if (
        !isDynamicRecord(device) ||
        !isString(device.id) ||
        !isString(device.name) ||
        !isString(device.pairedAt) ||
        typeof device.current !== "boolean"
      ) {
        throw new Error("Invalid device list.");
      }
      return { id: device.id, name: device.name, pairedAt: device.pairedAt, current: device.current };
    }),
  };
}

export function decodeHostDevicePairing(value: unknown): HostDevicePairing {
  if (!isDynamicRecord(value) || !isString(value.link) || !isString(value.code) || !isNumber(value.expiresAt)) {
    throw new Error("Invalid device pairing.");
  }
  return { link: value.link, code: value.code, expiresAt: value.expiresAt };
}

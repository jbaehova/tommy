import type { HostDevice, HostDevicePairing, ServerSummary } from "@tommy/contracts/ipc";
import { createEffect, createSignal, createStore } from "solid-js";
import { serverCanAdminister } from "../servers/server-capabilities";

/** While a QR code shows, the list is read this often, so that the page sees the new device. */
const READ_INTERVAL_SECONDS = 3;

interface SettingsDevicesState {
  devices: HostDevice[] | null;
  /** The QR code on screen. It leaves memory when the tab closes, the code expires, or the device pairs. */
  pairing: HostDevicePairing | null;
  remainingSeconds: number;
  expired: boolean;
  pairedName: string | null;
  busy: boolean;
}

/** The devices of the one server, and the QR code that adds a device. The host checks the owner again. */
export function createSettingsDevicesStore(options: {
  visible: () => boolean;
  server: () => ServerSummary | undefined;
}) {
  const [state, setState] = createStore<SettingsDevicesState>({
    devices: null,
    pairing: null,
    remainingSeconds: 0,
    expired: false,
    pairedName: null,
    busy: false,
  });
  const [error, setError] = createSignal<unknown>(null);
  /** The devices when the code was made. A device that is not in this list spent the code. */
  let knownDeviceIds: ReadonlySet<string> = new Set();

  const available = () => serverCanAdminister(options.server(), "host-devices-v1");

  function applyDevices(devices: HostDevice[]): void {
    const paired = state.pairing ? devices.find((device) => !knownDeviceIds.has(device.id)) : undefined;
    setState((draft) => {
      draft.devices = devices;
      if (paired) {
        draft.pairing = null;
        draft.pairedName = paired.name;
      }
    });
  }

  async function read(serverId: string): Promise<void> {
    setError(null);
    try {
      applyDevices((await window.tommy.hostAdmin.listDevices(serverId)).devices);
    } catch (failure) {
      setError(failure);
    }
  }

  /** Runs one user action at a time. */
  async function run(action: (serverId: string) => Promise<void>): Promise<void> {
    const serverId = options.server()?.id;
    if (!serverId || state.busy) return;
    setState((draft) => {
      draft.busy = true;
    });
    setError(null);
    try {
      await action(serverId);
    } catch (failure) {
      setError(failure);
    } finally {
      setState((draft) => {
        draft.busy = false;
      });
    }
  }

  const showCode = () =>
    run(async (serverId) => {
      const { devices } = await window.tommy.hostAdmin.listDevices(serverId);
      knownDeviceIds = new Set(devices.map((device) => device.id));
      const pairing = await window.tommy.hostAdmin.createDevicePairing(serverId);
      setState((draft) => {
        draft.devices = devices;
        draft.pairing = pairing;
        draft.remainingSeconds = secondsUntil(pairing.expiresAt);
        draft.expired = false;
        draft.pairedName = null;
      });
    });

  function hideCode(): void {
    setState((draft) => {
      draft.pairing = null;
      draft.expired = false;
      draft.pairedName = null;
    });
  }

  const revoke = (deviceId: string) =>
    run(async (serverId) => {
      const { devices } = await window.tommy.hostAdmin.revokeDevice(deviceId, serverId);
      setState((draft) => {
        draft.devices = devices;
      });
    });

  createEffect(
    () => (options.visible() && available() ? options.server()?.id : undefined),
    (serverId) => {
      if (serverId) void read(serverId);
      else hideCode();
    },
  );

  createEffect(
    () => state.pairing?.expiresAt,
    (expiresAt) => {
      if (expiresAt === undefined) return;
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        const remainingSeconds = secondsUntil(expiresAt);
        setState((draft) => {
          draft.remainingSeconds = remainingSeconds;
          if (remainingSeconds === 0) {
            draft.pairing = null;
            draft.expired = true;
          }
        });
        const serverId = options.server()?.id;
        if (serverId && remainingSeconds > 0 && ticks % READ_INTERVAL_SECONDS === 0) {
          // A failed read waits for the next one: the network can drop while the code is on screen.
          window.tommy.hostAdmin.listDevices(serverId).then(({ devices }) => applyDevices(devices), noop);
        }
      }, 1_000);
      return () => clearInterval(timer);
    },
  );

  return { state, error, available, showCode, hideCode, revoke };
}

function secondsUntil(time: number): number {
  return Math.max(0, Math.ceil((time - Date.now()) / 1_000));
}

function noop(): void {}

export type SettingsDevicesStore = ReturnType<typeof createSettingsDevicesStore>;

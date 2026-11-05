import { createDirectPairingLink, directSessionId } from "@tommy/contracts/direct-connection";
import { HOST_DEVICES_CAPABILITY, HOST_DEVICES_ROUTES } from "@tommy/contracts/team-protocol/host-devices-v1";
import { sourceText } from "@tommy/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { TeamApiAdmin } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireOwner, stringField } from "./request-helpers";

/**
 * The owner connects another device from a paired device, and manages the paired devices. Frozen by
 * `host-devices-v1`. The answer of the pair route holds a code: nothing here writes it to a log.
 */
export async function routeHostDevices(
  context: TeamApiRequestContext,
  admin: TeamApiAdmin | undefined,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, sessionId, json } = context;
  if (
    method !== "POST" ||
    (url.pathname !== HOST_DEVICES_ROUTES.list &&
      url.pathname !== HOST_DEVICES_ROUTES.pair &&
      url.pathname !== HOST_DEVICES_ROUTES.revoke)
  )
    return "unmatched";
  const devices = admin?.devices;
  if (!devices || !capabilities.has(HOST_DEVICES_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.hostDevicesUnsupported"));
  requireOwner(member);
  const body = await readJson(request);
  const snapshot = () => ({
    devices: devices.list().map(({ id, name, pairedAt }) => ({
      id,
      name,
      pairedAt,
      current: directSessionId(id) === sessionId,
    })),
  });
  if (url.pathname === HOST_DEVICES_ROUTES.list) return json(200, snapshot());
  if (url.pathname === HOST_DEVICES_ROUTES.pair) {
    const pairing = devices.createPairingCode();
    if (!pairing?.publicUrl) throw new HttpError(409, sourceText("error.team.hostDevicesAddressMissing"));
    return json(200, {
      link: createDirectPairingLink({ url: pairing.publicUrl, code: pairing.code }),
      code: pairing.code,
      expiresAt: pairing.expiresAt,
    });
  }
  const deviceId = stringField(body, "deviceId");
  if (!devices.list().some((device) => device.id === deviceId))
    throw new HttpError(404, sourceText("error.team.hostDeviceNotFound"));
  // A device that removes itself loses this server at once. The server menu forgets a server on purpose.
  if (directSessionId(deviceId) === sessionId) throw new HttpError(409, sourceText("error.team.hostDeviceIsCurrent"));
  await runCauseEffect(devices.revoke(deviceId));
  return json(200, snapshot());
}

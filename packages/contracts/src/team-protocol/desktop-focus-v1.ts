// Frozen optional desktop-focus-v1 wire contract.
//
// What it grants, recorded here because freezing it makes it permanent: a signed-in member's desktop
// app tells the host whether one of its windows has focus. The host keeps that member's phones quiet
// while a window has focus, because the window shows the event. Only this one fact goes to the host,
// and a report ends when its time runs out, so a Mac that sleeps or quits does not keep a phone quiet.
// Widening any of it needs a second capability string.
import { adminRoute, boolean, empty, fields, type OptionalRouteCodec } from "./admin-wire";

export const DESKTOP_FOCUS_CAPABILITY = "desktop-focus-v1";

export const DESKTOP_FOCUS_ROUTES = { report: "/v1/client/desktop-focus" } as const;

/** While a window has focus, the desktop app reports it again after this time. */
export const DESKTOP_FOCUS_INTERVAL_MS = 20_000;
/** The host counts a focus report for this long: two lost reports do not make a phone ring. */
export const DESKTOP_FOCUS_LIFETIME_MS = 50_000;

export const DESKTOP_FOCUS_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [DESKTOP_FOCUS_ROUTES.report, adminRoute(fields({ focused: boolean }), empty)],
]);

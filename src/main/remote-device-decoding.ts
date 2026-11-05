// The devices a host exposes: its embedded browser, and its remote desktop.
// See `remote-host-decoding.ts` for why the `FromHost` suffix exists and must not be merged away.

import type { BrowserControlState, BrowserDisplayState, BrowserPreview, BrowserTab } from "@tommy/contracts/ipc";
import { isBoolean, isDynamicRecord, isNumber, isString } from "@tommy/contracts/runtime-values";

export function decodeBrowserTabs(value: unknown): BrowserTab[] {
  if (!Array.isArray(value) || !value.every(isBrowserTabValue)) {
    throw new Error("Invalid remote browser tabs.");
  }
  return value;
}

export function decodeBrowserTab(value: unknown): BrowserTab {
  if (!isBrowserTabValue(value)) throw new Error("Invalid remote browser tab.");
  return value;
}

export function decodeBrowserDisplayState(value: unknown): BrowserDisplayState {
  if (!isDynamicRecord(value) || (value.activeTabId !== null && !isString(value.activeTabId))) {
    throw new Error("Invalid remote browser display state.");
  }
  return { tabs: decodeBrowserTabs(value.tabs), activeTabId: value.activeTabId };
}

export function decodeBrowserPreviewFromHost(value: unknown): BrowserPreview {
  if (!isBrowserPreviewValue(value)) throw new Error("Invalid remote browser preview.");
  return value;
}

function isBrowserPreviewValue(value: unknown): value is BrowserPreview {
  return (
    isDynamicRecord(value) &&
    isString(value.dataUrl) &&
    value.dataUrl.length <= 2_000_000 &&
    /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.dataUrl) &&
    isNumber(value.width) &&
    Number.isSafeInteger(value.width) &&
    value.width > 0 &&
    value.width <= 960 &&
    isNumber(value.height) &&
    Number.isSafeInteger(value.height) &&
    value.height > 0 &&
    value.height <= 600
  );
}

function isBrowserTabValue(value: unknown): value is BrowserTab {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.title) &&
    isString(value.url) &&
    isBoolean(value.loading) &&
    (value.ownerThreadId === null || isString(value.ownerThreadId)) &&
    (value.ownerAgentId === null || isString(value.ownerAgentId))
  );
}

export function decodeBrowserControlState(value: unknown): BrowserControlState {
  if (!isBrowserControlStateValue(value)) {
    throw new Error("Invalid remote browser control state.");
  }
  return value;
}

function isBrowserControlStateValue(value: unknown): value is BrowserControlState {
  return isDynamicRecord(value) && Array.isArray(value.sessions);
}

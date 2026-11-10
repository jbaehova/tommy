import { defineMessages } from "../../message";

export const messages = defineMessages("menu", {
  // The native application menu. Electron localizes its own `role:` entries from the operating
  // system, so only the custom items are here. A role's label does not follow the app language, so
  // the chat's right-click edit menu takes its labels from here.
  "menu.stopAllAgents": "Stop all agents",
  "menu.preferences": "Settings…",
  "menu.actualSize": "Actual Size",
  "menu.zoomIn": "Zoom In",
  "menu.zoomOut": "Zoom Out",
  "menu.copyLink": "Copy Link",
  "menu.quit": "Quit Tommy",
  "menu.quitConfirmTitle": "Quit Tommy?",
  "menu.quitConfirmBody": "Agents and routines stop until you open Tommy again.",
  "menu.quitConfirm": "Quit",
  "menu.quitHint": "Hold ⌘Q or press it twice to quit",
  "menu.trayOpen": "Open Tommy",
  "menu.trayQuit": "Quit Tommy",
  "menu.trayTooltip": "Tommy",
  "menu.undo": "Undo",
  "menu.redo": "Redo",
  "menu.cut": "Cut",
  "menu.copy": "Copy",
  "menu.paste": "Paste",
  "menu.pasteAndMatchStyle": "Paste and Match Style",
  "menu.delete": "Delete",
  "menu.selectAll": "Select All",
  "menu.copyImage": "Copy Image",
});

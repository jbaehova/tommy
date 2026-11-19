import { defineMessages } from "../../message";

/**
 * Short words with no context of their own: a button or a menu item that means the same thing on
 * every screen. A word whose translation can change with the screen gets a key in that screen's
 * area instead, even when the English is the same.
 */
export const messages = defineMessages("common", {
  "common.cancel": "Cancel",
});

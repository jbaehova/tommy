import { Platform, StyleSheet, type TextStyle } from "react-native";
import { APP_FONT } from "@/shared/lib/app-font";

export type ChatTextType = "body" | "body-sm" | "h4" | "h5";

/**
 * The text of chat messages, as plain native styles. A long reply draws hundreds of text views, so
 * they take these styles and no class names. Every way of drawing a message uses this one table.
 */
export const CHAT_TEXT_STYLES = StyleSheet.create({
  body: { fontFamily: APP_FONT, fontWeight: "400", fontSize: 15, lineHeight: 21 },
  "body-sm": { fontFamily: APP_FONT, fontWeight: "400", fontSize: 13, lineHeight: 18 },
  h4: { fontFamily: APP_FONT, fontWeight: "600", fontSize: 18, lineHeight: 24, letterSpacing: -0.2 },
  h5: { fontFamily: APP_FONT, fontWeight: "600", fontSize: 16, lineHeight: 22, letterSpacing: -0.1 },
}) satisfies Record<ChatTextType, TextStyle>;

/** The iOS Dynamic Type style of each heading. */
export const CHAT_HEADING_RAMP = { h4: "title3", h5: "headline" } as const;

const CODE_FONT = Platform.OS === "ios" ? "Menlo" : "monospace";

/**
 * Inline code. Its chip adds one point above and below, so a chip is as tall as the line of the
 * text around it and does not push the line apart.
 */
export const CHAT_CODE_STYLES = StyleSheet.create({
  body: { fontFamily: CODE_FONT, fontSize: 13, lineHeight: 19 },
  small: { fontFamily: CODE_FONT, fontSize: 12, lineHeight: 16 },
});

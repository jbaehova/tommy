import type { ComponentProps } from "react";
import { Text, type TextStyle } from "react-native";
import { APP_FONT } from "@/shared/lib/app-font";

/** The type steps of the app, from the Mac scale. The tight line heights are part of the look. */
const VARIANTS = {
  display: { fontSize: 24, lineHeight: 30, fontWeight: "700", letterSpacing: -0.45 },
  title: { fontSize: 20, lineHeight: 26, fontWeight: "600", letterSpacing: -0.3 },
  headline: { fontSize: 16, lineHeight: 21, fontWeight: "600", letterSpacing: -0.15 },
  body: { fontSize: 15, lineHeight: 21, fontWeight: "400", letterSpacing: -0.1 },
  label: { fontSize: 14, lineHeight: 19, fontWeight: "500", letterSpacing: -0.08 },
  sub: { fontSize: 13, lineHeight: 18, fontWeight: "400", letterSpacing: -0.04 },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: "400" },
  micro: { fontSize: 11, lineHeight: 14, fontWeight: "500", letterSpacing: 0.1 },
} as const satisfies Record<string, TextStyle>;

const TONES = {
  primary: "text-foreground",
  secondary: "text-text-secondary",
  muted: "text-muted",
  dim: "text-text-dim",
  accent: "text-accent-text",
  danger: "text-danger-text",
} as const;

export type TxtVariant = keyof typeof VARIANTS;
export type TxtTone = keyof typeof TONES;

/** The text of the app. */
export function Txt({
  variant = "body",
  tone = "primary",
  className,
  style,
  ...props
}: ComponentProps<typeof Text> & { variant?: TxtVariant; tone?: TxtTone }) {
  return (
    <Text
      {...props}
      className={className ? `${TONES[tone]} ${className}` : TONES[tone]}
      style={[{ fontFamily: APP_FONT, includeFontPadding: false }, VARIANTS[variant], style]}
    />
  );
}

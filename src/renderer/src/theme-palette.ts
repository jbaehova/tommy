import type { AppThemePalette } from "@tommy/contracts/app-appearance";

/** `color-mix` of one palette color into transparency, as the base palettes use translucent ink. */
function clear(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

function mix(color: string, other: string, percent: number): string {
  return `color-mix(in srgb, ${color}, ${other} ${percent}%)`;
}

/**
 * The tokens that a palette sets, over the light or dark palette that its scheme names. A palette
 * gives twelve colors; the other tokens of each family come from them, as the base palettes make
 * their hover, soft and strong steps from one color. Tokens not listed here keep the base value:
 * illustrations, provider logos, charts and the file colors stay as they are in each scheme.
 *
 * Cards, sheets and controls are a step above the canvas: lighter than it in both base palettes. A
 * dark palette gives that step as `surface`. A light theme has no color lighter than its background
 * (Catppuccin Latte's `surface` is darker), so a light palette makes the step from its canvas and
 * white, as the base light palette is white over a grey canvas, and uses `surface` for the tab bar.
 */
function paletteTokens({ scheme, colors }: AppThemePalette): Record<string, string> {
  const raised = scheme === "light" ? mix(colors.canvas, "#ffffff", 70) : colors.surface;
  const tabsBar = scheme === "light" ? mix(colors.canvas, colors.surface, 30) : colors.surface;
  return {
    "--tommy-bg-canvas": colors.canvas,
    "--tommy-bg-canvas-clear": clear(colors.canvas, 0),
    "--tommy-bg-frame": colors.frame,
    "--tommy-bg-sidebar": colors.sidebar,
    "--tommy-bg-native-sidebar": colors.sidebar,
    "--tommy-bg-sheet": raised,
    "--tommy-bg-sheet-inset": colors.frame,
    "--tommy-bg-grouped": raised,
    "--tommy-bg-surface": raised,
    "--tommy-bg-surface-raised": mix(raised, colors.text, 3),
    "--tommy-bg-control": raised,
    "--tommy-bg-control-hover": mix(raised, colors.text, 4),
    "--tommy-bg-control-active": mix(raised, colors.text, 8),
    "--tommy-tabs-bar-bg": tabsBar,
    "--tommy-tabs-pill-bg": scheme === "light" ? raised : mix(colors.surface, colors.text, 8),
    "--tommy-marketplace-detail-bg": colors.frame,
    "--tommy-bg-overlay": clear(colors.canvas, 92),
    "--tommy-bg-glass": clear(raised, 76),
    "--tommy-scroll-edge-overlay": clear(colors.canvas, 72),

    "--tommy-border": clear(colors.border, 35),
    "--tommy-border-strong": clear(colors.border, 50),
    "--tommy-border-grouped": colors.border,
    "--tommy-dialog-ring": clear(colors.border, 70),
    "--tommy-image-outline": clear(colors.border, 60),
    "--tommy-hover": clear(colors.text, 5),

    "--tommy-text-primary": colors.text,
    "--tommy-text-secondary": mix(colors.text, colors.textMuted, 25),
    "--tommy-text-muted": colors.textMuted,
    "--tommy-text-dim": mix(colors.textMuted, colors.canvas, 30),
    "--tommy-text-placeholder": colors.textMuted,
    "--tommy-text-readable": colors.textMuted,
    "--tommy-text-grouped-secondary": colors.textMuted,
    "--tommy-settings-text-muted": colors.textMuted,

    // The inverted element (the default button, a checked switch, the user's bubble) is the text
    // color on the canvas, as it is in both base palettes.
    "--tommy-surface-light": colors.text,
    "--tommy-text-on-light": colors.canvas,
    "--tommy-text-muted-on-light": clear(colors.canvas, 64),
    "--tommy-text-dim-on-light": clear(colors.canvas, 40),
    "--tommy-border-on-light": clear(colors.canvas, 16),

    "--tommy-accent": colors.accent,
    "--tommy-accent-hover": mix(colors.accent, colors.text, 15),
    "--tommy-accent-text": colors.accent,
    "--tommy-accent-soft": clear(colors.accent, 16),
    "--tommy-accent-strong": clear(colors.accent, 34),
    "--tommy-text-on-accent": colors.accentForeground,

    "--tommy-success": colors.success,
    "--tommy-success-text": colors.success,
    "--tommy-success-soft": clear(colors.success, 14),
    "--tommy-success-wash": clear(colors.success, 6),
    "--tommy-warning": colors.warning,
    "--tommy-warning-text": colors.warning,
    "--tommy-warning-soft": clear(colors.warning, 14),
    "--tommy-danger": colors.danger,
    "--tommy-danger-hover": mix(colors.danger, colors.text, 15),
    "--tommy-danger-text": colors.danger,
    "--tommy-danger-soft": clear(colors.danger, 14),
    "--tommy-danger-soft-hover": clear(colors.danger, 22),
    "--tommy-danger-focus": clear(colors.danger, 36),
    "--tommy-danger-border": clear(colors.danger, 45),
  };
}

let applied: string[] = [];

/**
 * Sets the palette tokens on the root element, or removes them for null. Inline properties on the
 * root win over `tokens.css` and `tokens-light.css`, so the base palette shows again once they go.
 * The preload let only hex colors through, so each value is a color or a `color-mix` of colors.
 */
export function applyThemePalette(palette: AppThemePalette | null): void {
  const style = document.documentElement.style;
  for (const name of applied) style.removeProperty(name);
  applied = [];
  if (palette === null) return;
  for (const [name, value] of Object.entries(paletteTokens(palette))) {
    style.setProperty(name, value);
    applied.push(name);
  }
}

import { join } from "node:path";
import type { AppVariant } from "@tommy/contracts/ipc";

const APP_VARIANTS = ["production", "dev", "preview"] as const satisfies readonly AppVariant[];

export function readAppVariant(value: string | undefined, isPackaged: boolean): AppVariant {
  if (isAppVariant(value)) return value;
  return isPackaged ? "production" : "dev";
}

function appIconFileName(variant: AppVariant, platform: NodeJS.Platform): string {
  return platform === "darwin" ? `icon-${variant}-macos-safe-area.png` : `icon-${variant}.png`;
}

export function resolveAppIconPath(options: {
  variant: AppVariant;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  resourcesPath: string;
  sourceRoot: string;
}): string {
  return options.isPackaged
    ? join(options.resourcesPath, "icons", appIconFileName(options.variant, options.platform))
    : join(options.sourceRoot, "build", appIconFileName(options.variant, options.platform));
}

/**
 * The macOS menu bar icon. The `Template` suffix makes macOS draw it in the color of the menu bar,
 * and Electron loads the `@2x` file next to it.
 */
export function resolveMenuBarIconPath(options: {
  isPackaged: boolean;
  resourcesPath: string;
  sourceRoot: string;
}): string {
  return options.isPackaged
    ? join(options.resourcesPath, "icons", "tray", "trayTemplate.png")
    : join(options.sourceRoot, "build", "macos", "tray", "trayTemplate.png");
}

function isAppVariant(value: string | undefined): value is AppVariant {
  return APP_VARIANTS.some((variant) => variant === value);
}

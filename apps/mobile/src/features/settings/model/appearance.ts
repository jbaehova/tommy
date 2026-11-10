import { type NativeModule, requireOptionalNativeModule } from "expo";
import * as SecureStore from "expo-secure-store";
import { Uniwind } from "uniwind";
import { create } from "zustand";

export type Appearance = "system" | "light" | "dark";

declare class AppearanceModule extends NativeModule {
  setNightMode(mode: Appearance): void;
}

/** `modules/appearance`. The system draws the splash screen in the chosen look. A build without it shows the phone's. */
const native = requireOptionalNativeModule<AppearanceModule>("TommyAppearance");

function applyAppearance(value: Appearance): void {
  Uniwind.setTheme(value);
  try {
    native?.setNightMode(value);
  } catch {
    // Only the splash screen keeps the phone's look.
  }
}

const key = "tommy.mobile.appearance.v1";
export const useAppearance = create<{ value: Appearance; ready: boolean; saving: boolean }>(() => ({
  value: "system",
  ready: false,
  saving: false,
}));

export async function loadAppearance(): Promise<void> {
  try {
    const stored = await SecureStore.getItemAsync(key);
    const value = stored === "light" || stored === "dark" ? stored : "system";
    applyAppearance(value);
    useAppearance.setState({ value });
  } finally {
    useAppearance.setState({ ready: true });
  }
}

export async function saveAppearance(value: Appearance): Promise<void> {
  if (!useAppearance.getState().ready || useAppearance.getState().saving) return;
  useAppearance.setState({ saving: true });
  try {
    await SecureStore.setItemAsync(key, value);
    applyAppearance(value);
    useAppearance.setState({ value });
  } finally {
    useAppearance.setState({ saving: false });
  }
}

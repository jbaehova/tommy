import { useSafeAreaInsets } from "react-native-safe-area-context";

/** The height of the native bar under the status bar: the 64 dp Material top app bar. */
export const NATIVE_BAR_HEIGHT = 64;

/** The size of the glass bar buttons that the app draws itself. */
export const BAR_BUTTON_SIZE = 48;

/**
 * The top of a drawn bar button under the status bar that lines up with the native bar buttons of the
 * screen beside it, as in the two columns of a wide window.
 */
export const NATIVE_BAR_BUTTON_TOP = (NATIVE_BAR_HEIGHT - BAR_BUTTON_SIZE) / 2;

/** Where the top bar starts. */
export function useBarTop(): number {
  return useSafeAreaInsets().top;
}

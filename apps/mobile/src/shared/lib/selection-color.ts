import type { ColorValue } from "react-native";

/**
 * Android paints `selectionColor` as an opaque highlight behind the text, so a text-colored
 * selection hides the text. On Android, tint only the cursor and handles and keep the system
 * highlight; iOS already draws the selection translucent.
 */
export function selectionColorProps(color: ColorValue | undefined) {
  return { cursorColor: color, selectionHandleColor: color };
}

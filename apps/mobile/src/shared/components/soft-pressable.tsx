import type { ComponentProps } from "react";
import { Pressable } from "react-native";
import Animated from "react-native-reanimated";
import { useSoftPress } from "@/shared/lib/use-soft-press";

/** A pressable whose content gives way under the finger and springs back. */
export function SoftPressable({
  scale = 0.92,
  children,
  onPressIn,
  onPressOut,
  ...props
}: Omit<ComponentProps<typeof Pressable>, "children"> & { scale?: number; children: React.ReactNode }) {
  const press = useSoftPress(scale);
  return (
    <Pressable
      {...props}
      onPressIn={(event) => {
        press.onPressIn();
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        press.onPressOut();
        onPressOut?.(event);
      }}
    >
      <Animated.View style={press.style}>{children}</Animated.View>
    </Pressable>
  );
}

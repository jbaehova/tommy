import type { ComponentProps, ReactNode } from "react";
import { Pressable, type StyleProp, type ViewStyle } from "react-native";
import Animated from "react-native-reanimated";
import { haptics } from "@/shared/lib/haptics";
import { useSoftPress } from "@/shared/lib/use-soft-press";

/**
 * The one way to make something pressable. It gives way under the finger at once and springs back,
 * with an optional tint behind the content. `className` and `style` lay out the content.
 */
export function Press({
  scale = 0.97,
  tint = false,
  tintClassName = "bg-control-active/70",
  haptic = true,
  className,
  style,
  hitClassName,
  children,
  onPress,
  onPressIn,
  onPressOut,
  ...props
}: Omit<ComponentProps<typeof Pressable>, "children" | "style" | "className"> & {
  scale?: number;
  tint?: boolean;
  tintClassName?: string;
  haptic?: boolean;
  className?: string;
  style?: StyleProp<ViewStyle>;
  hitClassName?: string;
  children: ReactNode;
}) {
  const press = useSoftPress(scale);
  return (
    <Pressable
      {...props}
      className={hitClassName}
      onPress={
        onPress
          ? (event) => {
              if (haptic) void haptics.impact("soft");
              onPress(event);
            }
          : undefined
      }
      onPressIn={(event) => {
        press.onPressIn();
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        press.onPressOut();
        onPressOut?.(event);
      }}
    >
      <Animated.View className={tint ? `overflow-hidden ${className ?? ""}` : className} style={[style, press.style]}>
        {tint ? (
          <Animated.View
            pointerEvents="none"
            className={`absolute inset-0 ${tintClassName}`}
            style={press.highlightStyle}
          />
        ) : null}
        {children}
      </Animated.View>
    </Pressable>
  );
}

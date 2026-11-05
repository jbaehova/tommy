import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { haptics } from "@/shared/lib/haptics";
import { Txt } from "@/shared/ui/text";

const INSET = 3;
const SLIDE = { damping: 17, stiffness: 260, mass: 0.7 };

/** A full-width choice of one option, with a pill that slides to the choice. */
export function UsageSegments<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const [width, setWidth] = useState(0);
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const place = useSharedValue(index);
  useEffect(() => {
    place.set(withSpring(index, SLIDE));
  }, [index, place]);
  const segment = width > 0 ? (width - INSET * 2) / options.length : 0;
  const pillStyle = useAnimatedStyle(() => ({ transform: [{ translateX: place.get() * segment }] }));
  return (
    <View
      accessibilityRole="tablist"
      className="h-9 flex-row rounded-[11px] bg-control"
      style={{ padding: INSET }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {segment > 0 ? (
        <Animated.View
          pointerEvents="none"
          className="absolute rounded-[8px] bg-foreground/10"
          style={[{ left: INSET, top: INSET, bottom: INSET, width: segment }, pillStyle]}
        />
      ) : null}
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            className="flex-1 items-center justify-center px-1"
            onPress={() => {
              if (active) return;
              void haptics.selection();
              onChange(option.value);
            }}
          >
            <Txt variant="label" tone={active ? "primary" : "muted"} numberOfLines={1} style={{ fontSize: 13 }}>
              {option.label}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

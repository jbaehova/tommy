import { useEffect } from "react";
import { Pressable } from "react-native";
import Animated, {
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useCSSVariable } from "uniwind";
import { haptics } from "@/shared/lib/haptics";

const TRACK_WIDTH = 42;
const TRACK_HEIGHT = 25;
const INSET = 2.5;
const THUMB = TRACK_HEIGHT - INSET * 2;
/** How much wider the thumb gets under the finger. It stretches toward its next place. */
const STRETCH = 5;
/** The thumb passes its place a little and settles. */
const MOVE = { damping: 14, stiffness: 260, mass: 0.6 };

export function Switch({
  value,
  disabled = false,
  label,
  onValueChange,
}: {
  value: boolean;
  disabled?: boolean;
  label?: string;
  onValueChange?: (value: boolean) => void;
}) {
  const [on, off] = useCSSVariable(["--tommy-accent", "--tommy-bg-control-active"]);
  const place = useSharedValue(value ? 1 : 0);
  const pressed = useSharedValue(0);
  useEffect(() => {
    place.set(withSpring(value ? 1 : 0, MOVE));
  }, [place, value]);
  const onColor = String(on);
  const offColor = String(off);
  const trackStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(Math.min(1, Math.max(0, place.get())), [0, 1], [offColor, onColor]),
  }));
  const thumbStyle = useAnimatedStyle(() => {
    const width = THUMB + STRETCH * pressed.get();
    return {
      width,
      transform: [{ translateX: interpolate(place.get(), [0, 1], [0, TRACK_WIDTH - INSET * 2 - width]) }],
    };
  });
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      hitSlop={10}
      style={{ opacity: disabled ? 0.4 : 1 }}
      onPressIn={() => pressed.set(withTiming(1, { duration: 90 }))}
      onPressOut={() => pressed.set(withSpring(0, MOVE))}
      onPress={() => {
        void haptics.selection();
        onValueChange?.(!value);
      }}
    >
      <Animated.View
        style={[
          { width: TRACK_WIDTH, height: TRACK_HEIGHT, borderRadius: TRACK_HEIGHT / 2, padding: INSET },
          trackStyle,
        ]}
      >
        <Animated.View
          style={[
            {
              height: THUMB,
              borderRadius: THUMB / 2,
              backgroundColor: "#ffffff",
              boxShadow: "0 1px 3px rgba(0, 0, 0, 0.3)",
            },
            thumbStyle,
          ]}
        />
      </Animated.View>
    </Pressable>
  );
}

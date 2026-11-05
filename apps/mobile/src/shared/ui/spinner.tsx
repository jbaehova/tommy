import { useThemeColor } from "heroui-native/hooks";
import { useEffect } from "react";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";

const TURN = { duration: 850, easing: Easing.linear };

/** A thin ring with one open side that turns. */
export function Spinner({ size = 22, stroke = 2 }: { size?: number; stroke?: number }) {
  const muted = String(useThemeColor("muted"));
  const turn = useSharedValue(0);
  useEffect(() => {
    turn.set(withRepeat(withTiming(360, TURN), -1, false));
  }, [turn]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get()}deg` }] }));
  const radius = (size - stroke) / 2;
  const length = 2 * Math.PI * radius;
  return (
    <Animated.View style={[{ width: size, height: size }, style]}>
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={muted}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${length * 0.7} ${length * 0.3}`}
        />
      </Svg>
    </Animated.View>
  );
}

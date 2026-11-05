import { useCallback } from "react";
import { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useReducedMotion } from "./motion";

const PRESS_IN = { duration: 70 };
const PRESS_OUT = { duration: 320, dampingRatio: 0.72 };

/**
 * The response of a control to a touch: it gives way at once and springs back on release. `style`
 * goes on the view that moves, and `highlightStyle` on a tinted view under the content.
 */
export function useSoftPress(scale = 0.985) {
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);
  const onPressIn = useCallback(() => progress.set(withTiming(1, PRESS_IN)), [progress]);
  const onPressOut = useCallback(() => progress.set(withSpring(0, PRESS_OUT)), [progress]);
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: reduced ? 1 : 1 - (1 - scale) * progress.get() }],
  }));
  const highlightStyle = useAnimatedStyle(() => ({ opacity: Math.max(0, Math.min(1, progress.get())) }));
  return { onPressIn, onPressOut, style, highlightStyle };
}

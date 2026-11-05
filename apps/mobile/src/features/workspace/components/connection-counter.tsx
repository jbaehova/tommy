import { Typography } from "heroui-native";
import { useLayoutEffect, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useReducedMotion } from "@/shared/lib/motion";

const COUNTER_TIMING = {
  duration: 260,
  easing: Easing.bezier(0.77, 0, 0.175, 1),
  reduceMotion: ReduceMotion.System,
};
const BLUR_PADDING = 3;

function CounterText({ value }: { value: string }) {
  return (
    <Typography.Paragraph
      type="body-xs"
      className="text-text-secondary"
      maxFontSizeMultiplier={1.2}
      style={{ fontVariant: ["tabular-nums"] }}
    >
      {value}
    </Typography.Paragraph>
  );
}

// Android draws ForeignObject without its filter, and the new text can mount a frame before a shared
// progress reset. Each Android layer keeps one value and its own progress, and RenderEffect blurs it.
const ANDROID_BLUR = Number(Platform.Version) >= 31;

function AndroidCounterLayer({
  value,
  visible,
  animateIn,
  size,
}: {
  value: string;
  visible: boolean;
  animateIn: boolean;
  size: { width: number; height: number };
}) {
  const progress = useSharedValue(animateIn ? 0 : 1);

  useLayoutEffect(() => {
    progress.set(withTiming(visible ? 1 : 0, COUNTER_TIMING));
  }, [visible, progress]);

  const sharpStyle = useAnimatedStyle(() => {
    const visibility = progress.get();
    return { opacity: ANDROID_BLUR ? visibility * visibility : visibility };
  });
  const blurredStyle = useAnimatedStyle(() => {
    const visibility = progress.get();
    return { opacity: 2 * visibility * (1 - visibility) };
  });

  return (
    <>
      <Animated.View style={[StyleSheet.absoluteFill, sharpStyle]}>
        <CounterText value={value} />
      </Animated.View>
      {ANDROID_BLUR ? (
        <Animated.View
          style={[
            {
              position: "absolute",
              left: -BLUR_PADDING,
              top: -BLUR_PADDING,
              width: size.width + BLUR_PADDING * 2,
              height: size.height + BLUR_PADDING * 2,
            },
            blurredStyle,
          ]}
        >
          <View style={{ padding: BLUR_PADDING, filter: [{ blur: 0.8 }] }}>
            <CounterText value={value} />
          </View>
        </Animated.View>
      ) : null}
    </>
  );
}

type AndroidCounterValue = { id: number; value: string };

function AndroidCounter({ value }: { value: string }) {
  const [frame, setFrame] = useState<{ previous: AndroidCounterValue | null; current: AndroidCounterValue }>({
    previous: null,
    current: { id: 0, value },
  });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const reduceMotion = useReducedMotion();

  if (frame.current.value !== value) {
    setFrame({ previous: frame.current, current: { id: frame.current.id + 1, value } });
  }

  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View
        style={{ opacity: reduceMotion || size.width === 0 ? 1 : 0 }}
        onLayout={({ nativeEvent: { layout } }) => {
          setSize((current) =>
            current.width === layout.width && current.height === layout.height
              ? current
              : { width: layout.width, height: layout.height },
          );
        }}
      >
        <CounterText value={value} />
      </View>
      {!reduceMotion && size.width > 0
        ? [frame.previous, frame.current].map((layer) =>
            layer ? (
              <AndroidCounterLayer
                key={layer.id}
                value={layer.value}
                visible={layer === frame.current}
                animateIn={layer.id > 0}
                size={size}
              />
            ) : null,
          )
        : null}
    </View>
  );
}

export const AnimatedCounter = AndroidCounter;

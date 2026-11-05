import { usePathname } from "expo-router";
import type { PropsWithChildren, ReactNode } from "react";
import { View } from "react-native";
import Animated, { type SharedValue, useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { isDockPath, useDockInset } from "@/shared/ui/dock";
import { Txt } from "@/shared/ui/text";
import { TOP_BAR_HEIGHT } from "@/shared/ui/top-bar";

export interface LargeTitleScroll {
  onScroll: ReturnType<typeof useAnimatedScrollHandler>;
  /** How far the content moved up from its rest position. */
  scrolled: SharedValue<number>;
  titleHeight: SharedValue<number>;
  headerHeight: number;
  barTop: number;
  /** Whether the screen uses the bar of the stack, not a bar that it draws itself. */
  nativeBar: boolean;
  ownsInset: boolean;
}

/** The scroll state of a page whose title stays in its bar. */
export function useLargeTitleScroll(customBar?: { headerHeight: number }): LargeTitleScroll {
  const insets = useSafeAreaInsets();
  const scrolled = useSharedValue(0);
  const titleHeight = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrolled.set(event.contentOffset.y);
  });
  return {
    onScroll,
    scrolled,
    titleHeight,
    headerHeight: customBar?.headerHeight ?? insets.top + TOP_BAR_HEIGHT,
    barTop: insets.top,
    nativeBar: customBar === undefined,
    ownsInset: true,
  };
}

/** The first item of the scroll content. The title is in the bar, so this holds only what goes above the list. */
export function LargeTitle({
  above,
}: {
  scroll?: LargeTitleScroll;
  title?: string;
  caption?: string;
  /** Room above the content, such as for a header block. */
  above?: ReactNode;
  accessibilityLabel?: string;
  onPress?: () => void;
}) {
  return <View className="pt-1">{above}</View>;
}

/** The solid bar behind the buttons of a page, with the title of the page. */
export function LargeTitleBar({
  scroll,
  title,
  hidden = false,
  surface = "canvas",
  children,
}: PropsWithChildren<{
  scroll: LargeTitleScroll;
  title: string;
  /** Hides the title, for example while the bar shows the connection state in its place. */
  hidden?: boolean;
  insetLeft?: number;
  insetRight?: number;
  surface?: "canvas" | "sheet";
}>) {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  return (
    <>
      <View
        pointerEvents="none"
        className={surface === "sheet" ? "bg-sheet" : "bg-background"}
        style={{ position: "absolute", top: 0, left: 0, right: 0, height: scroll.headerHeight }}
      />
      {children}
      {title && !hidden ? (
        <View
          pointerEvents="none"
          className="justify-center"
          style={{
            position: "absolute",
            top: insets.top,
            height: TOP_BAR_HEIGHT,
            left: isDockPath(pathname) ? 16 : 62,
            right: 72,
          }}
        >
          <Txt variant="title" numberOfLines={1} accessibilityRole="header">
            {title}
          </Txt>
        </View>
      ) : null}
    </>
  );
}

/** A full page of grouped content under its bar, such as Routines and Usage. */
export function LargeTitleScrollView({
  title,
  contentContainerClassName,
  children,
}: PropsWithChildren<{ title: string; caption?: string; contentContainerClassName?: string }>) {
  const scroll = useLargeTitleScroll();
  const dockInset = useDockInset();
  const pathname = usePathname();
  return (
    <View className="flex-1 bg-sheet">
      <Animated.ScrollView
        className="flex-1"
        alwaysBounceVertical={false}
        contentContainerStyle={{
          paddingTop: scroll.headerHeight,
          paddingBottom: isDockPath(pathname) ? dockInset : 24,
        }}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        onScroll={scroll.onScroll}
      >
        <View className={contentContainerClassName}>{children}</View>
      </Animated.ScrollView>
      <LargeTitleBar scroll={scroll} title={title} surface="sheet" />
    </View>
  );
}

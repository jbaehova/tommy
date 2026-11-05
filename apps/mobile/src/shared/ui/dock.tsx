import { type Href, router, usePathname, useSegments } from "expo-router";
import { useThemeColor } from "heroui-native/hooks";
import type { LucideIcon } from "lucide-react-native";
import Bot from "lucide-react-native/icons/bot";
import CalendarClock from "lucide-react-native/icons/calendar-clock";
import ChartColumn from "lucide-react-native/icons/chart-column";
import ListChecks from "lucide-react-native/icons/list-checks";
import Settings from "lucide-react-native/icons/settings";
import { useEffect } from "react";
import { Pressable, View } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
import { create } from "zustand";
import { useMobileWorkspaceSelector } from "@/features/workspace/context/workspace-store";
import { haptics } from "@/shared/lib/haptics";
import { useReducedMotion } from "@/shared/lib/motion";
import { useText } from "@/shared/lib/text";

const ITEM_WIDTH = 58;
const ITEM_HEIGHT = 44;
const PADDING = 5;
const DOCK_HEIGHT = ITEM_HEIGHT + PADDING * 2;
/** The pill slides past its place a little and settles. This is most of the feel of the dock. */
const SLIDE = { damping: 16, stiffness: 240, mass: 0.75 };
const POP = { damping: 9, stiffness: 320, mass: 0.5 };

/** The search covers home and takes the bottom of the screen, so the dock leaves while it is open. */
export const useDockHidden = create<{ hidden: boolean }>(() => ({ hidden: false }));

/** The room that a list keeps under its last row, so the dock does not cover it. */
export function useDockInset(): number {
  const insets = useSafeAreaInsets();
  return DOCK_HEIGHT + Math.max(insets.bottom, 10) + 18;
}

const ITEMS = [
  { key: "agents", icon: Bot, path: "/connected", label: "mobile.shared.dock.agents" },
  { key: "threads", icon: ListChecks, path: "/server-tasks", label: "mobile.app.route.threads" },
  { key: "routines", icon: CalendarClock, path: "/server-routines", label: "mobile.server.drawer.routines" },
  { key: "usage", icon: ChartColumn, path: "/server-usage", label: "mobile.server.drawer.usage" },
  { key: "settings", icon: Settings, path: "/settings", label: "mobile.app.route.settings" },
] as const;

function dockHref(key: (typeof ITEMS)[number]["key"], serverId: string): Href {
  if (key === "threads") return { pathname: "/server-tasks", params: { serverId } };
  if (key === "routines") return { pathname: "/server-routines", params: { serverId } };
  if (key === "usage") return { pathname: "/server-usage", params: { serverId } };
  if (key === "settings") return "/settings";
  return "/connected";
}

const DOCK_PATHS: readonly string[] = ["/", ...ITEMS.map((item) => item.path)];

/** The dock pages have no back button: the dock is how the person moves between them. */
export function isDockPath(pathname: string): boolean {
  return DOCK_PATHS.includes(pathname);
}

function DockItem({
  icon: Icon,
  label,
  active,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const reduced = useReducedMotion();
  const [foreground, muted] = useThemeColor(["foreground", "muted"]);
  const press = useSharedValue(1);
  const pop = useSharedValue(1);
  useEffect(() => {
    if (active && !reduced) pop.set(withSequence(withTiming(1.14, { duration: 90 }), withSpring(1, POP)));
  }, [active, pop, reduced]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: press.get() * pop.get() }] }));
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      hitSlop={4}
      onPress={onPress}
      onPressIn={() => press.set(withTiming(0.84, { duration: 70 }))}
      onPressOut={() => press.set(withSpring(1, POP))}
      style={{ width: ITEM_WIDTH, height: ITEM_HEIGHT }}
      className="items-center justify-center"
    >
      <Animated.View style={style}>
        <Icon color={String(active ? foreground : muted)} size={21} strokeWidth={active ? 2.1 : 1.8} />
      </Animated.View>
    </Pressable>
  );
}

/** The bottom of the app: the icons of the rail of the Mac app, in a floating pill. */
export function Dock() {
  const { t } = useText();
  const pathname = usePathname();
  const segments = useSegments();
  const insets = useSafeAreaInsets();
  const hidden = useDockHidden((state) => state.hidden);
  const serverId = useMobileWorkspaceSelector((current) => current.activeServer.id);
  const glass = String(useCSSVariable("--tommy-bg-surface-raised"));
  const edge = String(useCSSVariable("--tommy-border-chrome-glass"));
  const { height: keyboard } = useReanimatedKeyboardAnimation();
  const index = ITEMS.findIndex((item) => item.path === (pathname === "/" ? "/connected" : pathname));
  const shown = index >= 0 && !hidden && segments.length > 0;
  const visible = useDerivedValue(() => withSpring(shown ? 1 : 0, { damping: 20, stiffness: 260, mass: 0.7 }));
  const place = useSharedValue(Math.max(index, 0));
  useEffect(() => {
    if (index >= 0) place.set(withSpring(index, SLIDE));
  }, [index, place]);
  const pillStyle = useAnimatedStyle(() => ({ transform: [{ translateX: place.get() * ITEM_WIDTH }] }));
  const dockStyle = useAnimatedStyle(() => {
    const away = 1 - visible.get();
    return {
      opacity: Math.max(0, 1 - away * 1.6) * (keyboard.get() < -40 ? 0 : 1),
      transform: [{ translateY: away * 26 }, { scale: 1 - away * 0.06 }],
    };
  });
  const go = (key: (typeof ITEMS)[number]["key"]) => {
    if (index >= 0 && ITEMS[index]?.key === key) return;
    void haptics.selection();
    if (key === "agents") {
      router.dismissTo("/connected");
      return;
    }
    const href = dockHref(key, serverId);
    if (index === 0) router.push(href);
    else router.replace(href);
  };
  return (
    <Animated.View
      pointerEvents={shown ? "box-none" : "none"}
      className="absolute left-0 right-0 items-center"
      style={[{ bottom: Math.max(insets.bottom, 10) + 4 }, dockStyle]}
    >
      <View
        accessibilityRole="tablist"
        className="flex-row rounded-full"
        style={{
          padding: PADDING,
          backgroundColor: glass,
          borderColor: edge,
          borderWidth: 1,
          boxShadow: "0 10px 30px rgba(0, 0, 0, 0.35)",
        }}
      >
        <Animated.View
          pointerEvents="none"
          className="absolute rounded-full bg-foreground/10"
          style={[{ left: PADDING, top: PADDING, width: ITEM_WIDTH, height: ITEM_HEIGHT }, pillStyle]}
        />
        {ITEMS.map((item) => (
          <DockItem
            key={item.key}
            icon={item.icon}
            label={t(item.label)}
            active={ITEMS[index]?.key === item.key}
            onPress={() => go(item.key)}
          />
        ))}
      </View>
    </Animated.View>
  );
}

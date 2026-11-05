import { usePathname } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { StyleSheet } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { Spinner } from "@/shared/ui/spinner";
import { Txt } from "@/shared/ui/text";

interface AppLoadingOverlayContextValue {
  setLoadingLabel: (label: string | null) => void;
  isLoaderPresent: boolean;
}

const AppLoadingOverlayContext = createContext<AppLoadingOverlayContextValue | null>(null);

/**
 * A small indicator in the middle of the screen while the app has nothing to show yet. It does not
 * cover the app. It comes in after a moment, so a fast load shows no indicator at all.
 */
export function AppLoadingOverlayProvider({ children }: PropsWithChildren) {
  const [label, setLabel] = useState<string | null>(null);
  const setLoadingLabel = useCallback((next: string | null) => setLabel(next), []);
  const value = useMemo(() => ({ setLoadingLabel, isLoaderPresent: label !== null }), [label, setLoadingLabel]);
  return (
    <AppLoadingOverlayContext.Provider value={value}>
      {children}
      {label !== null ? (
        <Animated.View
          pointerEvents="none"
          entering={FadeIn.duration(220).delay(180)}
          exiting={FadeOut.duration(140)}
          className="items-center justify-center gap-3"
          style={StyleSheet.absoluteFill}
        >
          <Spinner />
          <Txt variant="caption" tone="muted">
            {label}
          </Txt>
        </Animated.View>
      ) : null}
    </AppLoadingOverlayContext.Provider>
  );
}

// Hold the app loading label for one screen, while that screen is the route on top. A screen stays
// mounted under a pushed chat, so ownership needs the route as well as focus.
export function useScreenLoadingLabel(route: string, label: string | null) {
  const { setLoadingLabel } = useAppLoadingOverlay();
  const isFocused = useIsFocused();
  const pathname = usePathname();
  const ownsOverlay = isFocused && pathname === route;

  useLayoutEffect(() => {
    if (!ownsOverlay) return;
    setLoadingLabel(label);
    return () => setLoadingLabel(null);
  }, [label, ownsOverlay, setLoadingLabel]);
}

export function useAppLoadingOverlay() {
  const value = useContext(AppLoadingOverlayContext);
  if (!value) throw new Error("useAppLoadingOverlay requires AppLoadingOverlayProvider.");
  return value;
}

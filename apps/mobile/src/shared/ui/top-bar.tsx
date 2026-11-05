import { usePathname } from "expo-router";
import type { NativeStackHeaderProps } from "expo-router/native-stack";
import ChevronLeft from "lucide-react-native/icons/chevron-left";
import { createElement } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useText } from "@/shared/lib/text";
import { isDockPath } from "./dock";
import { IconButton } from "./icon-button";
import { Txt } from "./text";

export const TOP_BAR_HEIGHT = 52;

/** The bar at the top of every page: the round back button, the title in the middle, the actions. */
function TopBar({ options, navigation, route }: NativeStackHeaderProps) {
  const { t } = useText();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const canGoBack = navigation.canGoBack() && !isDockPath(pathname);
  const title = typeof options.headerTitle === "string" ? options.headerTitle : (options.title ?? "");
  const left = options.headerLeft?.({ canGoBack });
  const right = options.headerRight?.({ canGoBack });
  return (
    <View
      key={route.key}
      className={`flex-row items-center px-3 ${options.headerTransparent ? "" : "bg-background"}`}
      style={[
        { paddingTop: insets.top, height: insets.top + TOP_BAR_HEIGHT },
        // The bar has the color of its page.
        options.headerTransparent
          ? undefined
          : { backgroundColor: StyleSheet.flatten(options.contentStyle)?.backgroundColor },
      ]}
    >
      <View className="min-w-11 shrink flex-row items-center">
        {left ??
          (canGoBack && options.headerBackVisible !== false ? (
            <IconButton icon={ChevronLeft} label={t("common.back")} onPress={() => navigation.goBack()} />
          ) : null)}
      </View>
      <View className="min-w-0 flex-1 items-center">
        <Txt variant="headline" numberOfLines={1}>
          {title}
        </Txt>
      </View>
      <View className="min-w-11 shrink-0 flex-row items-center justify-end">{right}</View>
    </View>
  );
}

/** Puts the bar on the pages of a stack. */
export const appHeaderOptions = {
  header: (props: NativeStackHeaderProps) => createElement(TopBar, props),
} as const;

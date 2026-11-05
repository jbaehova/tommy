import { ListGroup } from "heroui-native";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import { Children, type PropsWithChildren, type ReactNode, useState } from "react";
import { type LayoutChangeEvent, useWindowDimensions, View } from "react-native";
import Animated from "react-native-reanimated";
import { useCSSVariable } from "uniwind";
import { SheetScrollView } from "@/shared/components/sheet-scroll-view";
import { haptics } from "@/shared/lib/haptics";
import { useSoftPress } from "@/shared/lib/use-soft-press";
import { Txt } from "@/shared/ui/text";

export function SettingsContent({ children }: PropsWithChildren) {
  return (
    <SheetScrollView
      scrollEdgeEffect={false}
      contentContainerClassName="gap-5 px-4 pb-safe-offset-5 pt-2"
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </SheetScrollView>
  );
}

export function SettingsSection({
  title,
  footer,
  children,
}: PropsWithChildren<{ title?: string; footer?: ReactNode }>) {
  return (
    <View className="gap-1.5">
      {title ? (
        <Txt variant="caption" tone="muted" className="px-1">
          {title}
        </Txt>
      ) : null}
      <ListGroup variant="secondary" className="overflow-hidden rounded-[14px] bg-grouped p-0 shadow-none">
        {Children.map(Children.toArray(children), (child) => (child ? <View>{child}</View> : null))}
      </ListGroup>
      {footer ? (
        <Txt variant="caption" tone="muted" className="px-1">
          {footer}
        </Txt>
      ) : null}
    </View>
  );
}

export function SettingsNote({ children }: PropsWithChildren) {
  return (
    <View className="px-1 pb-2">
      <Txt variant="caption" tone="muted">
        {children}
      </Txt>
    </View>
  );
}

/**
 * From the iOS "xxxLarge" text size (1.35) and its Android equivalent, a value beside its title can
 * squeeze the title to one letter a line. As in the iOS Settings app, such a row puts the value
 * under the title. Smaller text sizes keep the one-line row.
 */
const STACKED_FONT_SCALE = 1.3;
/** A trailing value wider than this part of the row goes under the title. An icon never does. */
const STACKED_VALUE_SHARE = 0.4;
/** `px-4` on both sides of a row. */
const ROW_PADDING_X = 28;

export function SettingsRow({
  children,
  supportingText,
  onPress,
  trailing,
  disabled = false,
  leading,
  disclosure = true,
  accessibilityLabel,
  checked,
  expanded,
}: PropsWithChildren<{
  supportingText?: string;
  onPress?: () => void;
  trailing?: ReactNode;
  disabled?: boolean;
  leading?: ReactNode;
  disclosure?: boolean;
  /** For an action row whose visible text needs its context, such as the item it acts on. */
  accessibilityLabel?: string;
  /** Makes the row one choice of a list. True when it is the selected choice. */
  checked?: boolean;
  /** For a row that shows or hides the rows below it. */
  expanded?: boolean;
}>) {
  const muted = String(useCSSVariable("--tommy-text-grouped-secondary"));
  const press = useSoftPress();
  const { fontScale } = useWindowDimensions();
  const measures = Boolean(trailing) && fontScale >= STACKED_FONT_SCALE;
  const [rowWidth, setRowWidth] = useState(0);
  const [trailingWidth, setTrailingWidth] = useState(0);
  const stacked = measures && rowWidth > 0 && trailingWidth > (rowWidth - ROW_PADDING_X) * STACKED_VALUE_SHARE;
  const onRowLayout = measures
    ? (event: LayoutChangeEvent) => setRowWidth(Math.round(event.nativeEvent.layout.width))
    : undefined;
  const measuredTrailing = (
    <View
      className={stacked ? "max-w-full self-start overflow-hidden" : "min-w-0 shrink"}
      onLayout={(event) => setTrailingWidth(Math.round(event.nativeEvent.layout.width))}
    >
      {trailing}
    </View>
  );
  const title = (
    <>
      {children}
      {supportingText ? (
        <Txt variant="caption" tone="muted">
          {supportingText}
        </Txt>
      ) : null}
    </>
  );
  const content = (
    <>
      {leading}
      <View className="min-w-0 flex-1 gap-0.5">
        {title}
        {stacked ? measuredTrailing : null}
      </View>
      {stacked
        ? null
        : measures
          ? measuredTrailing
          : trailing || (onPress && disclosure ? <ChevronRight size={15} color={muted} strokeWidth={2.5} /> : null)}
    </>
  );
  return onPress ? (
    <ListGroup.Item
      accessibilityRole={checked === undefined ? "button" : "radio"}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, checked, expanded }}
      disabled={disabled}
      onPress={() => {
        void haptics.impact("soft");
        onPress();
      }}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      className="min-h-[46px] flex-row items-center gap-3 overflow-hidden px-3.5 py-2"
      style={{ opacity: disabled ? 0.45 : 1 }}
      onLayout={onRowLayout}
    >
      <Animated.View
        pointerEvents="none"
        className="absolute inset-0 bg-control-active/60"
        style={press.highlightStyle}
      />
      {content}
    </ListGroup.Item>
  ) : (
    <View className="min-h-[46px] flex-row items-center gap-3 px-3.5 py-2" onLayout={onRowLayout}>
      {content}
    </View>
  );
}

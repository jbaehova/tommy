import { useThemeColor } from "heroui-native/hooks";
import type { LucideIcon } from "lucide-react-native";
import type { ComponentProps } from "react";
import { Press } from "./press";

/** A round button with one icon: the back button, and the actions of a bar. */
export function IconButton({
  icon: Icon,
  label,
  plain = false,
  size = 38,
  ...props
}: Omit<ComponentProps<typeof Press>, "children" | "accessibilityLabel"> & {
  icon: LucideIcon;
  label: string;
  /** No circle behind the icon. */
  plain?: boolean;
  size?: number;
}) {
  const foreground = String(useThemeColor("foreground"));
  return (
    <Press
      {...props}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      scale={0.88}
      className={plain ? "items-center justify-center" : "items-center justify-center rounded-full bg-control"}
      style={{ width: size, height: size }}
    >
      <Icon color={foreground} size={Math.round(size * 0.47)} strokeWidth={2} />
    </Press>
  );
}

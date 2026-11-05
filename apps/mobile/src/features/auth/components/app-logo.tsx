import { APP_LOGO_CORNER, APP_LOGO_GUN_PATH, APP_LOGO_SIZE } from "@tommy/brand/app-logo-shape";
import Svg, { Path, Rect } from "react-native-svg";
import { useCSSVariable } from "uniwind";

export interface AppLogoProps {
  size?: number;
}

export function AppLogo({ size = APP_LOGO_SIZE }: AppLogoProps) {
  const tile = String(useCSSVariable("--tommy-logo-production"));
  const mark = String(useCSSVariable("--tommy-logo-production-mark"));

  return (
    <Svg
      accessibilityElementsHidden
      height={size}
      importantForAccessibility="no-hide-descendants"
      viewBox={`0 0 ${APP_LOGO_SIZE} ${APP_LOGO_SIZE}`}
      width={size}
    >
      <Rect fill={tile} height={APP_LOGO_SIZE} rx={APP_LOGO_CORNER} ry={APP_LOGO_CORNER} width={APP_LOGO_SIZE} />
      <Path d={APP_LOGO_GUN_PATH} fill={mark} />
    </Svg>
  );
}

import { Show } from "solid-js";
import { APP_LOGO_CORNER, APP_LOGO_GUN_BOX, APP_LOGO_GUN_PATH, APP_LOGO_SIZE } from "./app-logo-shape";

export type AppLogoVariant = "production" | "dev" | "preview";

export interface AppLogoProps {
  variant: AppLogoVariant;
  /** Only the gun, with no square and no margin: for a surface that is black by itself. */
  bare?: boolean;
  class?: string;
}

export function AppLogo(props: AppLogoProps) {
  return (
    <svg
      class={["app-logo", props.class].filter(Boolean).join(" ")}
      data-variant={props.variant}
      viewBox={props.bare ? APP_LOGO_GUN_BOX : `0 0 ${APP_LOGO_SIZE} ${APP_LOGO_SIZE}`}
      aria-hidden="true"
    >
      <Show when={!props.bare}>
        <rect
          class="app-logo-background"
          width={APP_LOGO_SIZE}
          height={APP_LOGO_SIZE}
          rx={APP_LOGO_CORNER}
          ry={APP_LOGO_CORNER}
        />
      </Show>
      <path class="app-logo-mark" d={APP_LOGO_GUN_PATH} />
    </svg>
  );
}

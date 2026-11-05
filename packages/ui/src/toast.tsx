import type { ComponentProps, JSX } from "@solidjs/web";
import { errorReference } from "@tommy/user-errors";
import { createSignal, onSettled } from "solid-js";
import { Toaster as Sonner, type ExternalToast as SonnerExternalToast, toast as sonnerToast } from "solid-sonner";
import { documentColorScheme } from "./document-color-scheme";
import { ErrorReference } from "./error-reference";
import { CircleCheck, Info, LoaderCircle, OctagonX, TriangleAlert } from "./icons";
import { currentText } from "./text";
import { cx } from "./utils";

export type ToasterProps = ComponentProps<typeof Sonner>;
export type ExternalToast = SonnerExternalToast & {
  /**
   * The failure the toast reports. The toast shows its code under the description, so a user can
   * copy it. Without a `description`, the toast shows `errorMessage(error, fallback)`.
   */
  error?: unknown;
  /** The translated sentence for an `error` with no readable message of its own. */
  fallback?: string;
};
function outcomeToast(kind: "error" | "warning") {
  return (message: Parameters<typeof sonnerToast>[0], options?: ExternalToast) => {
    const { error, fallback, ...data } = options ?? {};
    if (error !== undefined) data.description = withReference(error, data.description, fallback);
    return sonnerToast[kind](message, data);
  };
}
function withReference(
  error: unknown,
  description: SonnerExternalToast["description"],
  fallback: string | undefined,
): SonnerExternalToast["description"] {
  const reference = errorReference(error);
  const text = description ?? (fallback === undefined ? undefined : currentText().errorMessage(error, fallback));
  if (!reference) return text;
  return () => (
    <>
      {typeof text === "function" ? text() : text}
      <ErrorReference reference={reference} />
    </>
  );
}

export const toast = Object.assign((...args: Parameters<typeof sonnerToast>) => sonnerToast(...args), sonnerToast, {
  error: outcomeToast("error"),
  warning: outcomeToast("warning"),
});

/** Toast lifetime; exported so manual timers settle on the same count. */
export const TOAST_DURATION = 6_000;

const [hasVisibleToasts, setHasVisibleToasts] = createSignal(false);

export function Toaster(props: ToasterProps): JSX.Element {
  // The desktop app mounts the Toaster outside its text provider, so it follows the active locale.
  const { t } = currentText();
  let layer: HTMLDivElement | undefined;
  onSettled(() => {
    if (!layer) return;
    const updateVisibility = () => {
      setHasVisibleToasts(Boolean(layer?.querySelector("[data-sonner-toast]")));
      // solid-sonner renders the close button, so mark it here for the close cue.
      for (const button of layer?.querySelectorAll("[data-close-button]:not([data-cuelume-close])") ?? []) {
        button.setAttribute("data-cuelume-close", "");
        button.setAttribute("data-cuelume-emphasis", "subtle");
      }
    };
    // Track mounted toasts so native content stays behind their exit animation too.
    const observer = new MutationObserver(updateVisibility);
    observer.observe(layer, { childList: true, subtree: true });
    updateVisibility();
    return () => {
      observer.disconnect();
      setHasVisibleToasts(false);
    };
  });
  return (
    <div ref={layer} data-kb-top-layer="" class="ui-toast-layer">
      <Sonner
        {...props}
        class={cx("ui-toaster", (props.closeButton ?? true) && "ui-toaster-closeable", props.class)}
        theme={props.theme ?? documentColorScheme()}
        position={props.position ?? "top-right"}
        // A toast past the visible count stays hidden even when hover expands the stack, so an update
        // offer would wait behind another. Six providers can offer an update at once.
        visibleToasts={props.visibleToasts ?? 6}
        duration={props.duration ?? TOAST_DURATION}
        gap={props.gap ?? 8}
        richColors={props.richColors ?? false}
        closeButton={props.closeButton ?? true}
        pauseWhenPageIsHidden={props.pauseWhenPageIsHidden ?? true}
        containerAriaLabel={props.containerAriaLabel ?? t("notification.toast.region")}
        toastOptions={{ closeButtonAriaLabel: t("notification.toast.close"), ...props.toastOptions }}
        icons={{
          success: <CircleCheck class="ui-toast-icon" aria-hidden="true" />,
          info: <Info class="ui-toast-icon" aria-hidden="true" />,
          warning: <TriangleAlert class="ui-toast-icon" aria-hidden="true" />,
          error: <OctagonX class="ui-toast-icon" aria-hidden="true" />,
          loading: <LoaderCircle class="ui-toast-icon ui-toast-loading-icon" aria-hidden="true" />,
          ...props.icons,
        }}
      />
    </div>
  );
}

export type { ToastT } from "solid-sonner";
export { hasVisibleToasts };

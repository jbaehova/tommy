import { lazy } from "solid-js";

/**
 * The views that are their own bundle chunk, wrapped once each.
 *
 * `lazy()` returns a component that owns the load state of its chunk, so
 * wrapping the same import twice makes two components that load the same module
 * independently - two `Loading` fallbacks, two `preload()` handles that do not
 * know about each other. Two of these are read from more than one place after
 * the view split (`InitialSetup` by the access gate and the overlays,
 * ), so the wrappers live here and each chunk has exactly one.
 */
export const AgentUsagePanel = lazy(() =>
  import("./features/usage/AgentUsagePanel").then((module) => ({ default: module.AgentUsagePanel })),
);
export const DevicePairing = lazy(() =>
  import("@tommy/ui/features/account/DevicePairing").then((module) => ({ default: module.DevicePairing })),
);
export const GlobalSearch = lazy(() =>
  import("@tommy/ui/components/GlobalSearch").then((module) => ({ default: module.GlobalSearch })),
);
export const LanguageStep = lazy(() =>
  import("./features/onboarding/LanguageStep").then((module) => ({ default: module.LanguageStep })),
);
export const ServerSettingsModal = lazy(() =>
  import("./features/servers/ServerSettingsModal").then((module) => ({ default: module.ServerSettingsModal })),
);
export const SettingsModal = lazy(() =>
  import("./features/settings/SettingsModal").then((module) => ({ default: module.SettingsModal })),
);
export const WorkflowsPage = lazy(() =>
  import("./features/workflows/WorkflowsPage").then((module) => ({ default: module.WorkflowsPage })),
);

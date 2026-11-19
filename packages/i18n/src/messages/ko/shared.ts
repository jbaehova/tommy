import { messages as common } from "./common";
import { messages as format } from "./format";

/** Keys every surface uses. */
export const shared = {
  ...common,
  ...format,
} as const;

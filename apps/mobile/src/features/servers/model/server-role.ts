import type { TeamRole } from "@tommy/contracts/ipc";
import type { MobileTextKey } from "@tommy/i18n/mobile";

/** The role as a label on its own, such as a picker item. */
export const SERVER_ROLE_LABEL_KEYS = {
  owner: "mobile.server.role.ownerLabel",
  admin: "mobile.server.role.adminLabel",
  member: "mobile.server.role.memberLabel",
} as const satisfies Record<TeamRole, MobileTextKey>;

import { redirectIncomingLink } from "@/features/links/model/incoming-links";
import { isIncomingShareLink } from "@/features/share/model/share-link";

export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  if (isIncomingShareLink(path)) return "/incoming-share";
  return redirectIncomingLink(path);
}

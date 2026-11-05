import { useText } from "@tommy/ui/text";
import { actionToast } from "../../action-toast";
import { useServerSelection } from "./server-selection";

/** Opens a server, and says so when that fails. */
export function useServerActions() {
  const { t, errorMessage } = useText();
  const { selectServer } = useServerSelection();
  function select(serverId: string): void {
    void selectServer(serverId).catch((error: unknown) => {
      actionToast.error(t("server.select.failedTitle"), {
        ...{ description: errorMessage(error, t("server.select.failedDescription")) },
      });
    });
  }
  return { select };
}

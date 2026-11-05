// The cloud account: email sign-in, profile, and the mobile devices connected to it.

import { Effect } from "effect";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { DirectPairedServer } from "../direct-paired-server";
import type { LocalAccount } from "../local-account";
import type { RemoteServerManager } from "../remote-server-manager";
import { RemoteWorkflowError } from "../remote-service-effects";
import { parsePairDevice } from "./app-inputs";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

export interface AccountIpcDependencies {
  centralAuth: LocalAccount;
  pairedServer: DirectPairedServer | null;
  remoteServers: Pick<RemoteServerManager, "syncRemoteHosts" | "select">;
}

export function accountIpcHandlers({
  centralAuth,
  pairedServer,
  remoteServers,
}: AccountIpcDependencies): Pick<IpcGroupHandlers, "auth"> {
  return {
    auth: {
      getState: handler(() => centralAuth.getState()),
      retry: handler(() => centralAuth.refresh()),
      pairDevice: payloadHandler(parsePairDevice, (input) =>
        runCauseEffect(
          Effect.gen(function* () {
            if (!pairedServer) return yield* new RemoteWorkflowError({ cause: new Error("This app cannot pair.") });
            const { hostId } = yield* pairedServer.pair(input);
            const state = centralAuth.refresh();
            // The new server is the server of this computer, so the window opens on it.
            yield* remoteServers.syncRemoteHosts();
            yield* remoteServers.select(hostId);
            return state;
          }),
        ),
      ),
      logout: handler(async () => {
        if (pairedServer) await runCauseEffect(pairedServer.forget());
        return centralAuth.refresh();
      }),
    },
  };
}

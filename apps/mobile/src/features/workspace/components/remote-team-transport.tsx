import type { AgentEvent, TeamRealtimeEvent } from "@tommy/contracts/ipc";
import { TEAM_API_ROUTES } from "@tommy/contracts/team-api-routes";
import {
  INSTANCE_TRANSFER_REMOTE_BYTES,
  INSTANCE_TRANSFER_ROUTES,
} from "@tommy/contracts/team-protocol/instance-transfer-v1";
import { isQueueEditRoute, QueueEditRejectedError } from "@tommy/contracts/team-protocol/queue-edit-v1";
import type { TeamProtocolV2Json } from "@tommy/contracts/team-protocol/v2";
import { sourceText } from "@tommy/i18n/source";
import {
  createRemoteTeamPeer,
  type RemoteFileUpload,
  type RemoteTeamCommand,
  type RemoteTeamCommandResult,
  type RemoteTeamConnectionUpdate,
  type RemoteTeamDiagnostic,
  type RemoteTeamPeerActions,
  type RemoteUploadProgress,
} from "@tommy/team-client/remote-peer";
import { referenceFrom } from "@tommy/user-errors";
import * as Crypto from "expo-crypto";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { mobileDevice } from "@/features/auth/api/mobile-auth";
import { useMobileSession } from "@/features/auth/context/mobile-session-context";
import {
  type BrowserViewBridgeEvent,
  type BrowserViewBridgeOpen,
  createBrowserViewBridge,
  type RemoteBrowserViewSession,
} from "@/features/browser/model/browser-view-bridge";
import { supportLog, supportLogUrl } from "@/features/support/model/support-log";
import { InactiveRequestError } from "@/features/workspace/model/pending-approvals";
import { referencedError } from "@/features/workspace/model/referenced-error";
import {
  BACKGROUND_READS_IN_FLIGHT,
  createRequestLimiter,
  isBackgroundRead,
} from "@/features/workspace/model/request-lanes";
import { currentText } from "@/shared/lib/text";

export interface RemoteTeamTransportRef {
  connect(hostId: string, hostPublicKey: string): Promise<void>;
  disconnect(): Promise<void>;
  request<T>(
    method: string,
    path: string,
    decode: (value: unknown) => T,
    body?: TeamProtocolV2Json,
    upload?: RemoteFileUpload,
    /** Hears the fraction of the uploaded file sent so far, from 0 to 1. */
    onUploadProgress?: (fraction: number) => void,
  ): Promise<T>;
  /** Null while the connection has no live view. Events of a closed view are dropped. */
  openBrowserView(
    options: Omit<BrowserViewBridgeOpen, "viewId">,
    listener: (event: BrowserViewBridgeEvent) => void,
  ): RemoteBrowserViewSession | null;
}

interface RemoteTeamTransportProps {
  active: boolean;
  onConnectionUpdate: (update: RemoteTeamConnectionUpdate) => void;
  /** The phone got a network again. */
  onNetworkRestored?: () => void;
  onTeamEvent: (hostId: string, event: AgentEvent | TeamRealtimeEvent) => void;
}

type RemoteTeamCommandInput =
  | { type: "connect"; hostId: string; hostPublicKey: string }
  | { type: "disconnect" }
  | { type: "request"; method: string; path: string; body: TeamProtocolV2Json; upload?: RemoteFileUpload };

/** The peer of this phone. It runs in the app, on one WebSocket to the host. */
export const RemoteTeamTransport = memo(
  forwardRef<RemoteTeamTransportRef, RemoteTeamTransportProps>(function RemoteTeamTransport(props, ref) {
    const { session } = useMobileSession();
    // Upload progress arrives by command ID, while the command is still pending.
    const uploadListeners = useRef(new Map<string, (fraction: number) => void>());
    const latest = useRef({ props, session });
    latest.current = { props, session };
    const viewsRef = useRef<ReturnType<typeof createBrowserViewBridge> | null>(null);
    const viewListeners = useRef(new Map<string, (event: BrowserViewBridgeEvent) => void>());
    const actions = useRef<RemoteTeamPeerActions>({
      getDevice: async () => {
        const current = latest.current.session;
        if (!current) throw new Error(sourceText("error.remote.serverNotFound"));
        return mobileDevice(current);
      },
      onUploadProgress: async ({ commandId, sent, total }: RemoteUploadProgress) =>
        uploadListeners.current.get(commandId)?.(total > 0 ? sent / total : 1),
      onHostStreamData: (data: string | ArrayBuffer) => viewsRef.current?.receive(data),
      onConnectionUpdate: async (update: RemoteTeamConnectionUpdate) => {
        if (update.state !== "online") viewsRef.current?.disconnect(update.message ?? null);
        await latest.current.props.onConnectionUpdate(update);
      },
      onDiagnostic: async ({ hostId, step, detail }: RemoteTeamDiagnostic) =>
        supportLog.add(
          step === "failed" ? "warn" : "info",
          "connection",
          `${hostId} peer ${step}${detail ? `: ${detail}` : ""}`,
        ),
      onNetworkRestored: async () => latest.current.props.onNetworkRestored?.(),
      onTeamEvent: async (hostId: string, event: AgentEvent | TeamRealtimeEvent) =>
        latest.current.props.onTeamEvent(hostId, event),
    });
    const peerRef = useRef<ReturnType<typeof createRemoteTeamPeer> | null>(null);
    peerRef.current ??= createRemoteTeamPeer(actions);
    const peer = peerRef.current;
    viewsRef.current ??= createBrowserViewBridge(
      (data) => peer.sendHostStreamData(data),
      async (method, path, body) => {
        const result = await peer.execute({ id: Crypto.randomUUID(), type: "request", method, path, body: body ?? {} });
        if (!result.ok || (result.status !== undefined && result.status >= 400))
          throw new Error(result.error ?? sourceText("error.remote.serverRequestFailed"));
        return result.body;
      },
      (event) => {
        const listener = viewListeners.current.get(event.viewId);
        if (event.type === "ended") viewListeners.current.delete(event.viewId);
        listener?.(event);
      },
    );
    const views = viewsRef.current;
    useEffect(() => peer.setActive(props.active), [peer, props.active]);
    useEffect(
      () => () => {
        void peer.dispose();
        peerRef.current = null;
      },
      [peer],
    );
    // The server of this transport, for support log lines. Requests do not name it.
    const hostIdRef = useRef<string | null>(null);
    const backgroundReads = useRef<ReturnType<typeof createRequestLimiter> | null>(null);
    backgroundReads.current ??= createRequestLimiter(BACKGROUND_READS_IN_FLIGHT);
    const backgroundLane = backgroundReads.current;

    const enqueue = useCallback(
      (
        next: RemoteTeamCommandInput,
        onUploadProgress?: (fraction: number) => void,
      ): Promise<RemoteTeamCommandResult> => {
        const id = Crypto.randomUUID();
        const command: RemoteTeamCommand =
          next.type === "connect"
            ? { id, type: "connect", hostId: next.hostId, hostPublicKey: next.hostPublicKey }
            : next.type === "request"
              ? {
                  id,
                  type: "request",
                  method: next.method,
                  path: next.path,
                  body: next.body,
                  upload: next.upload,
                  // The transfer file is the one answer larger than an attachment.
                  ...(next.path === INSTANCE_TRANSFER_ROUTES.export
                    ? { largeDownload: { maxBytes: INSTANCE_TRANSFER_REMOTE_BYTES, mimeType: "application/zip" } }
                    : {}),
                }
              : { id, type: "disconnect" };
        if (!onUploadProgress) return peer.execute(command);
        uploadListeners.current.set(id, onUploadProgress);
        return peer.execute(command).finally(() => uploadListeners.current.delete(id));
      },
      [peer],
    );

    useImperativeHandle(
      ref,
      () => ({
        connect: async (hostId, hostPublicKey) => {
          hostIdRef.current = hostId;
          const result = await enqueue({ type: "connect", hostId, hostPublicKey });
          if (!result.ok)
            throw referencedError(
              result.error ?? currentText().t("mobile.workspace.error.connectFailed"),
              result.reference,
            );
        },
        disconnect: async () => {
          const result = await enqueue({ type: "disconnect" });
          if (!result.ok)
            throw referencedError(
              result.error ?? currentText().t("mobile.workspace.error.disconnectFailed"),
              result.reference,
            );
        },
        request: async <T,>(
          method: string,
          path: string,
          decode: (value: unknown) => T,
          body: TeamProtocolV2Json = {},
          upload?: RemoteFileUpload,
          onUploadProgress?: (fraction: number) => void,
        ): Promise<T> => {
          const started = Date.now();
          const send = () => enqueue({ type: "request", method, path, body, upload }, onUploadProgress);
          const result = await (isBackgroundRead(method, path) ? backgroundLane(send) : send());
          // Method, path, status and time only. Never the body or the upload.
          const request = `${hostIdRef.current ?? "unknown server"} ${method} ${supportLogUrl(path)}`;
          const time = `(${Date.now() - started} ms)`;
          if (!result.ok)
            supportLog.add("warn", "connection", `${request} -> failed: ${result.error ?? "no error"} ${time}`);
          else
            supportLog.add(
              result.status !== undefined && result.status >= 400 ? "warn" : "info",
              "connection",
              `${request} -> ${result.status ?? "no status"} ${time}`,
            );
          if (!result.ok)
            throw referencedError(result.error ?? sourceText("error.remote.serverRequestFailed"), result.reference);
          if (result.status === 409 && isQueueEditRoute(method, path))
            throw new QueueEditRejectedError(currentText().t("mobile.workspace.error.queueEditRejected"));
          // The host answers 409 when a form or an approval no longer waits: answered elsewhere, or ended.
          if (result.status === 409 && method === "POST" && path === TEAM_API_ROUTES.respond.approval)
            throw new InactiveRequestError(currentText().t("mobile.workspace.error.approvalInactive"));
          if (result.status === 409 && method === "POST" && path === TEAM_API_ROUTES.respond.prompt)
            throw new InactiveRequestError(currentText().t("mobile.workspace.error.formUnavailable"));
          if (result.status !== undefined && result.status >= 400)
            throw referencedError(sourceText("error.remote.serverRequestFailed"), referenceFrom("http", result.status));
          return decode(result.body);
        },
        openBrowserView: (options, listener) => {
          const viewId = Crypto.randomUUID();
          viewListeners.current.set(viewId, listener);
          views.command({ type: "open", viewId, ...options });
          return {
            input: (inputs) => {
              if (inputs.length > 0) views.command({ type: "input", viewId, inputs });
            },
            frameDone: (sequence, drawn) => views.command({ type: "frame-done", viewId, sequence, drawn }),
            close: () => {
              if (!viewListeners.current.delete(viewId)) return;
              views.command({ type: "close", viewId });
            },
          };
        },
      }),
      [enqueue, backgroundLane, views],
    );

    return null;
  }),
);

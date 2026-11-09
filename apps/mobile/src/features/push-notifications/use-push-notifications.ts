import {
  ANDROID_PUSH_NOTIFICATIONS_ROUTES,
  type AndroidPushNotificationRegistration,
} from "@tommy/contracts/team-protocol/push-notifications-android-v1";
import type { TeamProtocolV2Json } from "@tommy/contracts/team-protocol/v2";
import { encodeNotificationBytes } from "@tommy/team-client/notification-seal";
import { pushNotificationKeys } from "@tommy/team-client/push-notification-seal";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadNotificationSecret, notificationHostKey } from "@/features/push-notifications/notification-keys";
import {
  effectiveServerNotificationSetting,
  useSyncedNotificationLevels,
} from "@/features/settings/model/notification-levels";
import {
  loadPushNotificationPreference,
  mutedUntil,
  registeredSound,
  setNotificationPermission,
  usePushNotificationPreference,
} from "@/features/settings/model/push-notifications";
import type { MobileServer } from "@/features/workspace/model/workspace-types";
import { currentLocale } from "@/shared/lib/text";
import { pushNotificationsNative as native } from "./push-notifications-native";

interface PushNotificationsInput {
  servers: readonly Pick<MobileServer, "id" | "name" | "state">[];
  /**
   * Whether `servers` came from the account service. Before that, and when it failed, the list is
   * empty, and the key file keeps the keys of the last list.
   */
  serversReady: boolean;
  /** While the app is on screen, the hosts send nothing: the app shows the event itself. */
  foreground: boolean;
  post(serverId: string, path: string, body: TeamProtocolV2Json): Promise<unknown>;
  supportsPush(serverId: string): boolean;
  /** The current session, read when this hook unmounts: only a change of session removes the phone. */
  currentWorkspaceKey(): string | null;
}

/** A request that failed is sent again after this time, or at the next change or connection. */
const RETRY_MS = 30_000;
/** An Android phone registers through `push-notifications-android-v1`. */
const ROUTES = ANDROID_PUSH_NOTIFICATIONS_ROUTES;

/**
 * Gives each connected server that supports the notifications of this platform the push token of the
 * app, the events that the user chose, and whether the app is on screen. The server level is the
 * level that the user chose for all of their devices, or this phone's level when they chose none. A host keeps the registration also when it restarts, so the phone tells each
 * host again after each connection, and removes it when the user turns both off for that host or
 * signs out.
 */
export function usePushNotifications({
  servers,
  serversReady,
  foreground,
  post,
  supportsPush,
  currentWorkspaceKey,
}: PushNotificationsInput): void {
  const preference = usePushNotificationPreference();
  // The level that the user chose for all of their devices replaces the level of this phone. The host
  // applies it too, and the levels of the agents, so a change registers again only when it turns the
  // server on or off here, or changes the level of the registration.
  const synced = useSyncedNotificationLevels((state) => state.servers);
  const [token, setToken] = useState<string | null>(null);
  const [secret, setSecret] = useState<Uint8Array | null>(null);
  /** What the phone last told each host, so an unchanged state is not sent again. */
  const registered = useRef(new Map<string, { key: string; removed: boolean }>());
  const postRef = useRef(post);
  postRef.current = post;
  const currentWorkspaceKeyRef = useRef(currentWorkspaceKey);
  currentWorkspaceKeyRef.current = currentWorkspaceKey;
  const queues = useRef(new Map<string, Promise<void>>());
  /**
   * A removal cannot reach a host before the registration that it removes. Each server has its own
   * queue, so a host that does not answer does not hold the others.
   */
  const enqueue = useCallback((serverId: string, run: () => Promise<void>) => {
    queues.current.set(
      serverId,
      (queues.current.get(serverId) ?? Promise.resolve()).then(run).catch(() => undefined),
    );
  }, []);
  const [attempt, setAttempt] = useState(0);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enabled = preference.ready && preference.enabled;

  useEffect(() => {
    if (!native) return;
    let current = true;
    void loadNotificationSecret().then(
      (loaded) => {
        if (current) setSecret(loaded);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (native && foreground) void loadPushNotificationPreference().catch(() => undefined);
  }, [foreground]);

  // The phone asks once. The answer can change in the phone settings while the app is away, so it is read again.
  // Apple or Google can fail to give the token, as without network at the first launch. Without it no
  // host gets the phone, so the read runs again while the app is on screen.
  useEffect(() => {
    // A local name, so that the check above also holds in the function below.
    const push = native;
    if (!push || !enabled || !foreground) return;
    let current = true;
    let again: ReturnType<typeof setTimeout> | null = null;
    const readToken = async () => {
      try {
        const device = await push.deviceToken();
        if (current) setToken(device);
      } catch {
        if (current) again = setTimeout(() => void readToken(), RETRY_MS);
      }
    };
    void (async () => {
      const permission = await push.permission();
      if (!current) return;
      setNotificationPermission(permission);
      if (permission === "granted") await readToken();
    })().catch(() => undefined);
    return () => {
      current = false;
      if (again) clearTimeout(again);
    };
  }, [enabled, foreground]);

  useEffect(() => native?.onDeviceToken(setToken), []);

  // The file is written again only when a server or its name changes. A list that did not load would
  // remove the keys, and each notification would then show the app name only.
  useEffect(() => {
    if (!native || !secret || !serversReady) return;
    try {
      native.writeKeys(
        servers.map(({ id, name }) => {
          const keys = pushNotificationKeys(notificationHostKey(secret, id));
          // `NotificationService.swift` and `SealedNotification.kt` read these field names.
          return {
            serverId: id,
            name,
            seal: encodeNotificationBytes(keys.seal),
            tag: encodeNotificationBytes(keys.tag),
          };
        }),
      );
    } catch {
      // Without the file the extension shows the app name only.
    }
  }, [secret, servers, serversReady]);

  useEffect(() => {
    if (!native || !preference.ready || !secret) return;
    // Wait for iOS and the token, so a phone that has notifications does not remove them at launch.
    if (preference.enabled && preference.permission === null) return;
    const deliverable = preference.enabled && preference.permission === "granted";
    if (deliverable && !token) return;
    const now = Date.now();
    for (const server of servers) {
      // A host forgets nothing when the phone goes offline, but the phone tells it again on reconnect.
      if (server.state !== "online") {
        registered.current.delete(server.id);
        continue;
      }
      if (!supportsPush(server.id)) continue;
      const setting = effectiveServerNotificationSetting(preference, synced[server.id], server.id);
      const muted = mutedUntil(setting, now);
      let registration: AndroidPushNotificationRegistration | null = null;
      if (deliverable && setting.level !== "nothing" && muted !== Number.POSITIVE_INFINITY) {
        const common = {
          serverId: server.id,
          secret: encodeNotificationBytes(notificationHostKey(secret, server.id)),
          locale: currentLocale(),
          away: !foreground,
          level: setting.level,
          mutedUntil: muted === null ? null : Math.ceil(muted / 1_000),
          preview: preference.preview,
          sound: registeredSound(preference),
        };
        registration = token ? { ...common, token } : null;
      }
      // A retry after a failed request sends the state again.
      const key = `${attempt}:${JSON.stringify(registration)}`;
      if (registered.current.get(server.id)?.key === key) continue;
      registered.current.set(server.id, { key, removed: registration === null });
      const serverId = server.id;
      enqueue(serverId, async () => {
        try {
          await postRef.current(
            serverId,
            registration ? ROUTES.register : ROUTES.remove,
            registration ? { ...registration } : {},
          );
        } catch {
          if (registered.current.get(serverId)?.key !== key) return;
          registered.current.delete(serverId);
          retry.current ??= setTimeout(() => {
            retry.current = null;
            setAttempt((count) => count + 1);
          }, RETRY_MS);
        }
      });
    }
  }, [servers, foreground, token, secret, preference, synced, supportsPush, enqueue, attempt]);

  useEffect(() => {
    const sent = registered.current;
    const workspaceAtMount = currentWorkspaceKeyRef.current();
    return () => {
      if (retry.current) clearTimeout(retry.current);
      retry.current = null;
      // Android closes the app window with the back gesture, and that also unmounts this tree. The
      // session stays, so the phone must keep its registration and its keys: without the keys, each
      // notification shows the app name only.
      if (currentWorkspaceKeyRef.current() === workspaceAtMount) return;
      // Sign-out removes the workspace. Its hosts must not notify about it, and the extension must not
      // open a notification of it. The requests go at once: the server connections close after this
      // cleanup. A host that does not get one learns it from the account service, which refuses the
      // ended session.
      for (const [serverId, { removed }] of sent) {
        if (!removed) void postRef.current(serverId, ROUTES.remove, {}).catch(() => undefined);
      }
      sent.clear();
      try {
        native?.removeKeys();
      } catch {
        // The keys open nothing after sign-out: the phone secret changes.
      }
    };
  }, []);
}

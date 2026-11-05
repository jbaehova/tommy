import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  logoutMobileSession,
  type MobileSession,
  MobileSessionExpiredError,
  readMobileSession,
} from "@/features/auth/api/mobile-auth";
import { deleteAgentAvatars } from "@/features/workspace/model/agent-avatar-cache";
import type { QueryScope } from "@/features/workspace/model/query-keys";
import { deleteWorkspaceCaches } from "@/features/workspace/model/workspace-cache";
import { untilForeground } from "@/shared/lib/until-foreground";

interface MobileSessionContextValue {
  loading: boolean;
  session: MobileSession | null;
  sessionScope: number;
  handleSessionError: (error: unknown, initiatingSession: MobileSession) => void;
  connect: (session: MobileSession) => void;
  signOut: () => Promise<void>;
  /**
   * The current session as `sessionWorkspaceKey` names it. An effect cleanup reads it to tell a sign-out
   * from Android closing the app window: the window also unmounts the tree, and the session then stays.
   */
  currentWorkspaceKey: () => string | null;
}

/** The workspace of a session: another server or account is another workspace. */
export function sessionWorkspaceKey(session: Pick<MobileSession, "apiUrl" | "user">): string {
  return `${session.apiUrl}:${session.user.id}`;
}

const MobileSessionContext = createContext<MobileSessionContextValue | null>(null);

export function MobileSessionProvider({ children }: PropsWithChildren) {
  const [sessionState, setSessionState] = useState<MobileSession | null | undefined>(undefined);
  const sessionRef = useRef<MobileSession | null>(null);
  const sessionScope = useRef(0);

  const setCurrentSession = useCallback((session: MobileSession | null) => {
    if (sessionRef.current?.sessionToken !== session?.sessionToken) sessionScope.current += 1;
    // A removed pairing deletes the phone's copy.
    if (sessionRef.current && !session) void deleteWorkspaceCaches();
    sessionRef.current = session;
    setSessionState(session);
  }, []);

  const handleSessionError = useCallback(
    (error: unknown, initiatingSession: MobileSession) => {
      if (
        error instanceof MobileSessionExpiredError &&
        sessionRef.current?.sessionToken === initiatingSession.sessionToken
      )
        setCurrentSession(null);
    },
    [setCurrentSession],
  );

  useEffect(() => {
    let active = true;
    const scope = sessionScope.current;
    const read = () =>
      readMobileSession().then((stored) => {
        if (active && scope === sessionScope.current) setCurrentSession(stored);
      });
    // A start in the background can find the keychain closed. The app reads again when the user
    // opens it, so it does not show pairing for a device that it still has.
    void read()
      .catch(() => untilForeground().then(read))
      .catch(() => {
        if (active && scope === sessionScope.current) setCurrentSession(null);
      });
    return () => {
      active = false;
    };
  }, [setCurrentSession]);

  const signOut = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    await logoutMobileSession(current);
    deleteAgentAvatars();
    if (sessionRef.current?.sessionToken === current.sessionToken) setCurrentSession(null);
  }, [setCurrentSession]);

  const value = useMemo<MobileSessionContextValue>(
    () => ({
      loading: sessionState === undefined,
      session: sessionState ?? null,
      sessionScope: sessionScope.current,
      handleSessionError,
      connect: setCurrentSession,
      signOut,
      currentWorkspaceKey: () => (sessionRef.current ? sessionWorkspaceKey(sessionRef.current) : null),
    }),
    [sessionState, setCurrentSession, signOut, handleSessionError],
  );

  return <MobileSessionContext.Provider value={value}>{children}</MobileSessionContext.Provider>;
}

export function useMobileSession(): MobileSessionContextValue {
  const value = useContext(MobileSessionContext);
  if (!value) throw new Error("useMobileSession must be used within MobileSessionProvider.");
  return value;
}

/** The account part of the query keys (`queryKeys`). */
export function useQueryScope(): QueryScope {
  const { session, sessionScope } = useMobileSession();
  return [session?.apiUrl, session?.user.id, sessionScope];
}

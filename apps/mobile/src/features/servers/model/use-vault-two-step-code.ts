import type { VaultTwoStepCodes } from "@tommy/contracts/ipc";
import { useCallback, useEffect, useRef, useState } from "react";

interface CodeSample {
  value: string;
  expiresAt: number;
}

interface CodeView {
  identity: string;
  sample: CodeSample | null;
  pending: boolean;
  failed: boolean;
}

/** Codes stay in this mounted view, never in a query cache or the workspace cache. */
export function useVaultTwoStepCode({
  identity,
  itemId,
  active,
  load,
}: {
  identity: string;
  itemId: string;
  active: boolean;
  load(): Promise<VaultTwoStepCodes>;
}) {
  const scope = JSON.stringify([identity, itemId]);
  const [view, setView] = useState<CodeView>({ identity: scope, sample: null, pending: false, failed: false });
  const [clock, setClock] = useState(() => performance.now());
  const generation = useRef(0);
  const loader = useRef(load);
  loader.current = load;
  const retry = useRef<(() => void) | null>(null);
  const current = useRef({ active, identity: scope, view });
  current.current = { active, identity: scope, view };

  useEffect(() => {
    const epoch = ++generation.current;
    let alive = true;
    let waiting = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let tickTimer: ReturnType<typeof setInterval> | undefined;
    const valid = () => alive && generation.current === epoch;
    setView({ identity: scope, sample: null, pending: active, failed: false });
    if (!active)
      return () => {
        alive = false;
      };

    const read = async () => {
      if (!valid() || waiting) return;
      waiting = true;
      clearTimeout(refreshTimer);
      clearInterval(tickTimer);
      setView({ identity: scope, sample: null, pending: true, failed: false });
      const started = performance.now();
      try {
        const result = await loader.current();
        if (!valid()) return;
        const received = performance.now();
        const code = result.codes.find((entry) => entry.id === itemId);
        // Count the whole request against validity. Network delay cannot extend the host's expiry.
        const remainingMs = code ? code.remainingMs - (received - started) : 0;
        if (!code || remainingMs <= 500) {
          setView({ identity: scope, sample: null, pending: false, failed: true });
          return;
        }
        const sample = { value: code.code, expiresAt: received + remainingMs };
        setView({ identity: scope, sample, pending: false, failed: false });
        setClock(received);
        tickTimer = setInterval(() => setClock(performance.now()), 250);
        refreshTimer = setTimeout(() => void read(), remainingMs + 1);
      } catch {
        if (valid()) setView({ identity: scope, sample: null, pending: false, failed: true });
      } finally {
        waiting = false;
      }
    };
    retry.current = () => void read();
    void read();
    return () => {
      alive = false;
      retry.current = null;
      clearInterval(tickTimer);
      clearTimeout(refreshTimer);
    };
  }, [active, scope, itemId]);

  const visible = active && view.identity === scope;
  const sample = visible ? view.sample : null;
  const remainingMs = sample ? Math.max(0, sample.expiresAt - Math.max(clock, performance.now())) : 0;
  return {
    code: remainingMs > 0 ? (sample?.value ?? null) : null,
    remainingMs,
    pending: visible && view.pending,
    failed: visible && view.failed,
    retry: useCallback(() => retry.current?.(), []),
    /** A press can arrive between timer ticks. Check the monotonic deadline again before copying. */
    currentCode: useCallback(() => {
      const latest = current.current;
      const sample = latest.view.sample;
      return latest.active &&
        latest.view.identity === latest.identity &&
        sample &&
        sample.expiresAt - performance.now() > 1_000
        ? sample.value
        : null;
    }, []),
  };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CorrectionSession } from "@kbo/contracts";

import { deleteCorrectionSession } from "../api/correction-client";

const rememberedSessionKey = "kbo-correction-unsaved-session";
export function rememberedCorrectionSessionId(): string | null {
  try {
    return sessionStorage.getItem(rememberedSessionKey);
  } catch {
    return null;
  }
}
function rememberSession(session: CorrectionSession | null): void {
  try {
    if (session?.dirty) sessionStorage.setItem(rememberedSessionKey, session.sessionId);
    else sessionStorage.removeItem(rememberedSessionKey);
  } catch {
    /* Storage may be disabled; the server still owns the draft. */
  }
}

export function useOwnedSession() {
  const client = useQueryClient();
  const [session, updateSession] = useState<CorrectionSession | null>(null);
  const current = useRef<CorrectionSession | null>(null);
  const mounted = useRef(true);
  const releases = useRef(new WeakMap<CorrectionSession, Promise<void>>());
  const release = useCallback(
    async (value: CorrectionSession) => {
      const pending = releases.current.get(value);
      if (pending !== undefined) return pending;
      const result = deleteCorrectionSession(value.sessionId, value.sessionVersion)
        .then(() => {
          client.removeQueries({ queryKey: ["correction", value.sessionId] });
        })
        .catch((error: unknown) => {
          releases.current.delete(value);
          throw error;
        });
      releases.current.set(value, result);
      return result;
    },
    [client],
  );
  const retire = useCallback(
    (value: CorrectionSession) => {
      // A stale version must remain on the server. Abandoned clean sessions also expire there.
      void release(value).catch(() => undefined);
    },
    [release],
  );

  const setSession = useCallback(
    (next: CorrectionSession | null) => {
      const previous = current.current;
      current.current = next;
      rememberSession(next);
      if (previous !== null && previous.sessionId !== next?.sessionId) retire(previous);
      if (mounted.current) updateSession(next);
      else if (next !== null && !next.dirty) retire(next);
    },
    [retire],
  );

  useEffect(() => {
    mounted.current = true;
    const leave = () => {
      const value = current.current;
      if (value !== null && !value.dirty) retire(value);
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (current.current?.dirty) event.preventDefault();
    };
    globalThis.addEventListener("pagehide", leave);
    globalThis.addEventListener("beforeunload", beforeUnload);
    return () => {
      mounted.current = false;
      globalThis.removeEventListener("pagehide", leave);
      globalThis.removeEventListener("beforeunload", beforeUnload);
      leave();
    };
  }, [retire]);
  return { session, setSession, release };
}

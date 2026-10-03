// Blind review state. Hidden fields are off by default; revealing is per idea and lives for the
// browser session. Every annotation records whether its idea(s) were revealed at the time.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

interface RevealState {
  revealed: Set<string>;
  isRevealed: (ideaId: string | null | undefined) => boolean;
  toggle: (ideaId: string) => void;
  /** Blind for a target that touches several ideas: blind only if none is revealed. */
  blindFor: (ideaIds: (string | null | undefined)[]) => boolean;
}

const Ctx = createContext<RevealState | null>(null);
const KEY = "idea-factory-revealed";

function load(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function RevealProvider({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState<Set<string>>(load);
  const toggle = useCallback((id: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        sessionStorage.setItem(KEY, JSON.stringify([...next]));
      } catch {
        /* session storage unavailable: state is in memory only */
      }
      return next;
    });
  }, []);
  const value = useMemo<RevealState>(
    () => ({
      revealed,
      isRevealed: (id) => !!id && revealed.has(id),
      toggle,
      blindFor: (ids) => !ids.some((id) => !!id && revealed.has(id)),
    }),
    [revealed, toggle],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useReveal(): RevealState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useReveal outside RevealProvider");
  return v;
}

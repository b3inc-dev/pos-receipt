import { createContext, useContext, useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useLocation } from "react-router";

type Draft = { baseline: string; value: unknown };
const DraftContext = createContext<Map<string, Draft> | null>(null);

export function SettingsDrafts({ children }: { children: ReactNode }) {
  const [drafts] = useState(() => new Map<string, Draft>());
  return <DraftContext.Provider value={drafts}>{children}</DraftContext.Provider>;
}

/** Tab navigation remounts route components. Only retain edits for the same shop and server baseline. */
export function useSettingsDraft<T>(field: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const drafts = useContext(DraftContext);
  const key = useLocation().pathname + "/" + field;
  if (!drafts) throw new Error("SettingsDrafts is required");
  const baseline = JSON.stringify(initial);
  const [, refresh] = useState(0);
  const draft = drafts.get(key);
  useEffect(() => {
    const current = drafts.get(key);
    if (current && current.baseline !== baseline) drafts.delete(key);
  }, [drafts, key, baseline]);

  const setDraft: Dispatch<SetStateAction<T>> = (update) => {
    const current = drafts.get(key);
    const previous = current?.baseline === baseline ? current.value as T : initial;
    const next = typeof update === "function" ? (update as (previous: T) => T)(previous) : update;
    if (JSON.stringify(next) === baseline) drafts.delete(key);
    else drafts.set(key, { baseline, value: next });
    refresh(count => count + 1);
  };
  return [draft?.baseline === baseline ? draft.value as T : initial, setDraft];
}

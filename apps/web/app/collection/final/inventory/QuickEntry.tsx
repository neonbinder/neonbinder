import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useAuth } from "@clerk/clerk-react";
import { boxesOf, useContainers, useDemoExtension } from "../data/store";
import type { Container, ContainerId } from "../data/types";
import { useReplaceParams } from "../mode";
import {
  createCommitQueue,
  readStoredTargetBox,
  resolveTargetBox,
  TARGET_BOX_PARAM,
  targetBoxStorageKey,
  writeStoredTargetBox,
  type CommitQueue,
} from "./targetBox";

/**
 * NEO-364 — what the inventory's Checklists share: the target box (the
 * "Adding to" picker, every quantity field, "Add a range to …") and the one
 * commit queue every field's blur writes through (D10), so rapid tabbing
 * never blocks the keyboard and the writes land in the order they were made.
 *
 * Mounted only on the inventory side; the collection's Checklists never
 * reach it.
 */
export interface QuickEntry {
  /** The box the fields count and fill; `undefined` while the shelf loads. */
  box: Container | undefined;
  /** What the picker offers: Unsorted first, then the collector's boxes. */
  boxes: Container[];
  /** Picks another box: replaces `box=` on the URL and keeps it on this device. */
  setBox: (id: ContainerId) => void;
  queue: CommitQueue;
}

const QuickEntryContext = createContext<QuickEntry | null>(null);

export function useQuickEntry(): QuickEntry {
  const entry = useContext(QuickEntryContext);
  if (!entry) throw new Error("useQuickEntry: outside QuickEntryProvider (the inventory's Checklists)");
  return entry;
}

export function QuickEntryProvider({ children }: { children: ReactNode }) {
  const containers = useContainers();
  const demo = useDemoExtension();
  const { userId } = useAuth();
  const [params] = useSearchParams();
  const replaceParams = useReplaceParams();
  const key = targetBoxStorageKey(userId, !!demo);
  // The kept pick is read once per key; a pick here updates it in step.
  const [stored, setStored] = useState<{ key: string | null; id: string | null }>(() => ({
    key,
    id: readStoredTargetBox(key),
  }));
  const storedId = stored.key === key ? stored.id : readStoredTargetBox(key);
  const urlId = params.get(TARGET_BOX_PARAM);
  const box = resolveTargetBox(containers, urlId, storedId);
  const boxes = useMemo(() => boxesOf(containers), [containers]);

  const setBox = useCallback(
    (id: ContainerId) => {
      writeStoredTargetBox(key, id);
      setStored({ key, id });
      replaceParams((p) => p.set(TARGET_BOX_PARAM, id));
    },
    [key, replaceParams],
  );

  // One queue for the page's lifetime.
  const [queue] = useState<CommitQueue>(createCommitQueue);

  const value = useMemo<QuickEntry>(() => ({ box, boxes, setBox, queue }), [box, boxes, setBox, queue]);
  return <QuickEntryContext.Provider value={value}>{children}</QuickEntryContext.Provider>;
}

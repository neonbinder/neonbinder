/**
 * NEO-370 — which for-sale copy is "oldest", the one order shared by the
 * listing push (the SKU names the oldest copy's box) and the sale path (a
 * sale lowers the oldest matching copy first).
 *
 * Pure and env-free. A copy's age is its `acquiredOn` day when it has one
 * (`YYYY-MM-DD`, the day the collector got it), else the UTC day it was
 * created in NB (`_creationTime`). Two copies of the same age day are a TIE:
 * the sale path breaks it toward the SKU's box (the box the listing named),
 * then by exact creation time, then by copy id, so the order is total and the
 * same on every run.
 */

/** The fields of a copy the order reads. */
export interface AgedCopy {
  copyId: string;
  homeId: string;
  /** `YYYY-MM-DD`; anything else is ignored and the creation day is used. */
  acquiredOn?: string;
  /** The copy's `_creationTime`, ms since the epoch. */
  creationTime: number;
}

const DAY_MS = 86_400_000;

/** The copy's age as a UTC day number (smaller is older). */
export function copyAgeDay(copy: Pick<AgedCopy, "acquiredOn" | "creationTime">): number {
  const acquired = acquiredDay(copy.acquiredOn);
  return acquired ?? Math.floor(copy.creationTime / DAY_MS);
}

function acquiredDay(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  // Reject 2026-02-31 and friends rather than let Date roll them over.
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    return null;
  }
  return Math.floor(ms / DAY_MS);
}

/**
 * Oldest first. `preferHomeId`, when given, wins a tie on the age day; with
 * none the order is age day, creation time, copy id.
 */
export function compareCopiesOldestFirst(
  a: AgedCopy,
  b: AgedCopy,
  preferHomeId?: string | null,
): number {
  const dayDiff = copyAgeDay(a) - copyAgeDay(b);
  if (dayDiff !== 0) return dayDiff;
  if (preferHomeId) {
    const aPref = a.homeId === preferHomeId;
    const bPref = b.homeId === preferHomeId;
    if (aPref !== bPref) return aPref ? -1 : 1;
  }
  if (a.creationTime !== b.creationTime) return a.creationTime - b.creationTime;
  return a.copyId < b.copyId ? -1 : a.copyId > b.copyId ? 1 : 0;
}

/** The oldest copy of a non-empty list (no tie preference), or null. */
export function oldestCopy<T extends AgedCopy>(copies: readonly T[]): T | null {
  let best: T | null = null;
  for (const c of copies) {
    if (best === null || compareCopiesOldestFirst(c, best) < 0) best = c;
  }
  return best;
}

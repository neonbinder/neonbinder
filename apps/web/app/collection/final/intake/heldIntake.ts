import { useSyncExternalStore } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { classifyIntake } from "@/lib/placeholders/intake-kind";

/**
 * NEO-452 — the photos a collector dropped on Add cards before the run was set
 * up. They wait here, in the browser, until the run has a home, a set and (for
 * a box that lists) a price, then go up on their own. Nothing exists on the
 * server until then, so a reload has no run or upload to clean up.
 *
 * Module state, not component state, for the same reason as `doneRuns`: a Back
 * answered "Stay" (`useLeaveGuard`) can remount the page, and a trip to
 * Checklists to set a common price unmounts this tab outright. Component state
 * would quietly lose the photos both times. It also means a send that is under
 * way survives a remount, so `sending` lives here too: a second copy of the
 * screen must not send the same files again.
 *
 * Going elsewhere in the app keeps the photos with no nagging, so the only
 * guard is `beforeunload`: a reload or a closed tab loses them, after the
 * browser's own prompt. The guard is armed from here rather than from the tab,
 * because it has to hold while the tab is unmounted too.
 *
 * Keyed by signed-in user and side. The setup (home, set, defaults) is kept only
 * while files are held, so an old Min price can't leak into a later run. A sign-out
 * or a change of user drops everything held for anyone else (`keepHeldFor`).
 */

export type Condition = "Mint" | "Near Mint" | "Excellent" | "Very Good" | "Good" | "Poor";
export type Grader = "PSA" | "BGS" | "SGC" | "CGC" | "TAG";

/** The run's batch defaults, as the server keeps them. */
export interface RunDefaults {
  condition?: Condition;
  grading?: { grader: Grader; grade: string; cert?: string };
  costCents?: number;
  acquiredOn?: string;
  location?: string;
  notes?: string;
  /** NEO-378's floor for every card in the run; blank sells at the common price. */
  minPriceCents?: number;
}

export interface VariantPick {
  variantId: Id<"selectorOptions">;
  title: string;
}

export interface HeldSetup {
  homeId: string;
  variant: VariantPick | null;
  defaults: RunDefaults;
}

export interface HeldIntake {
  files: readonly File[];
  /** What the screen had set up; null whenever no files are held. */
  setup: HeldSetup | null;
  /** A send is under way (it may have been started by a copy of the screen that has since unmounted). */
  sending: boolean;
  /**
   * The setup a send last failed on. It isn't sent again until this changes, a
   * new drop lands or Try again is pressed, so a failure can't loop.
   */
  failedConfig: string | null;
  /**
   * What the screen's status line says. Here so a send finishing after a remount
   * can still say it. The screen clears it on leaving, and when the run changes.
   */
  note: string;
  /**
   * NEO-529 — these are photos a session closed on before they got in. They go
   * up only after the collector presses New run (`releaseForNewRun`), never into
   * a new session by themselves, so a remount with no run open can't send them.
   * Absent on any other pile, which goes up as soon as the screen is ready.
   */
  waitForNewRun?: true;
}

const NOTHING: HeldIntake = { files: [], setup: null, sending: false, failedConfig: null, note: "" };

const store = new Map<string, HeldIntake>();

/** `entry` with `waitForNewRun` set or gone; never present as false. */
function withWait(entry: HeldIntake, wait: boolean): HeldIntake {
  const next = { ...entry };
  delete next.waitForNewRun;
  return wait ? { ...next, waitForNewRun: true } : next;
}
const listeners = new Set<() => void>();
/** The key prefix of whoever is signed in, once `keepHeldFor` has said. */
let ownerPrefix: string | null = null;

const askBeforeUnload = (event: BeforeUnloadEvent) => {
  event.preventDefault();
  // Older browsers need a returnValue to show the prompt.
  event.returnValue = "";
};
let guarding = false;

function syncUnloadGuard(): void {
  const holding = [...store.values()].some((entry) => entry.files.length > 0);
  if (holding === guarding) return;
  guarding = holding;
  if (holding) window.addEventListener("beforeunload", askBeforeUnload);
  else window.removeEventListener("beforeunload", askBeforeUnload);
}

function write(key: string, change: (current: HeldIntake) => HeldIntake): void {
  // A send that outlived its collector's session finishing up: it has nowhere to say so.
  if (ownerPrefix !== null && !key.startsWith(ownerPrefix)) return;
  const next = change(store.get(key) ?? NOTHING);
  if (next.files.length === 0 && !next.sending && next.note === "") store.delete(key);
  else store.set(key, next);
  syncUnloadGuard();
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const keyPrefix = (userId: string | null | undefined) => `${userId ?? "signed-out"}:`;

/** The store's key: a collector's photos, on one side of the app. */
export function heldIntakeKey(userId: string | null | undefined, side: string): string {
  return `${keyPrefix(userId)}${side}`;
}

/**
 * The signed-in user changed: forget what was held for anyone else. Run from above
 * the signed-in layout (`HeldIntakeOwner`), because the tab is unmounted by then.
 * Without it, one collector's photos and setup would wait in memory for the next
 * person on this browser, and keep the unload prompt armed for them.
 */
export function keepHeldFor(userId: string | null | undefined): void {
  ownerPrefix = keyPrefix(userId);
  const prefix = ownerPrefix;
  const others = [...store.keys()].filter((key) => !key.startsWith(prefix));
  if (others.length === 0) return;
  others.forEach((key) => store.delete(key));
  syncUnloadGuard();
  listeners.forEach((listener) => listener());
}

export function readHeld(key: string): HeldIntake {
  return store.get(key) ?? NOTHING;
}

export function useHeldIntake(key: string): HeldIntake {
  return useSyncExternalStore(subscribe, () => readHeld(key));
}

/**
 * Add a drop to the pile, as an open run takes a second drop. When the combined
 * pile is one nothing can send (`classifyIntake`: a zip with photos, two zips),
 * the first pile stays and this answers the pile that was refused, for the zone
 * to explain. Otherwise null.
 */
export function holdFiles(key: string, chosen: readonly File[], setup: HeldSetup): File[] | null {
  const pile = [...readHeld(key).files, ...chosen];
  if (classifyIntake(pile).kind === "invalid") return pile;
  write(key, (current) => ({ ...current, files: pile, setup, failedConfig: null, note: "" }));
  return null;
}

/** Keep the setup current while files are held; with none held there is nothing to keep it for. */
export function updateHeldSetup(key: string, setup: HeldSetup): void {
  if (readHeld(key).files.length === 0) return;
  write(key, (current) => ({ ...current, setup }));
}

/** Forget the held files (the tray's Remove photos, or a shelf that loaded empty). */
export function removeHeld(key: string): void {
  write(key, (current) => withWait({ ...current, files: [], setup: null, failedConfig: null, note: "" }, false));
}

/** Claim the pile for a send. Null when there is nothing to send or a send already has it. */
export function beginSend(key: string): readonly File[] | null {
  const current = readHeld(key);
  if (current.sending || current.files.length === 0) return null;
  write(key, (entry) => ({ ...entry, sending: true, failedConfig: null }));
  return current.files;
}

/**
 * The send is over. `failedConfig` null: those files are up, and leave the pile.
 * Otherwise they stay in the tray, and won't go again until the setup moves off
 * this value or the collector asks.
 *
 * `waitForNewRun`: the files left behind are ones a closed session refused, so
 * they wait for New run (NEO-529). A pile already waiting keeps waiting.
 */
export function finishSend(
  key: string,
  sent: readonly File[],
  failedConfig: string | null,
  waitForNewRun = false,
): void {
  write(key, (current) => {
    if (failedConfig !== null) return { ...current, sending: false, failedConfig };
    const files = current.files.filter((file) => !sent.includes(file));
    return withWait(
      { ...current, sending: false, files, setup: files.length > 0 ? current.setup : null, failedConfig: null },
      files.length > 0 && (waitForNewRun || current.waitForNewRun === true),
    );
  });
}

/** New run: photos a closed session left behind may go up into the next one. */
export function releaseForNewRun(key: string): void {
  if (!readHeld(key).waitForNewRun) return;
  write(key, (current) => withWait(current, false));
}

/** Try again: clear the failure so the pile goes up next time the screen is ready. */
export function retryHeld(key: string): void {
  write(key, (current) => ({ ...current, failedConfig: null }));
}

export function sayHeld(key: string, note: string): void {
  if (readHeld(key).note === note) return;
  write(key, (current) => ({ ...current, note }));
}

/** Empty the store. For tests: it is module state and would leak between them. */
export function clearAllHeld(): void {
  store.clear();
  ownerPrefix = null;
  syncUnloadGuard();
  listeners.forEach((listener) => listener());
}

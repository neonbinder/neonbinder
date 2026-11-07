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
 * while files are held, so an old Min price can't leak into a later run.
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
  /** What the screen's status line says. Here so a send finishing after a remount can still say it. */
  note: string;
}

const NOTHING: HeldIntake = { files: [], setup: null, sending: false, failedConfig: null, note: "" };

const store = new Map<string, HeldIntake>();
const listeners = new Set<() => void>();

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

/** The store's key: a collector's photos, on one side of the app. */
export function heldIntakeKey(userId: string | null | undefined, side: string): string {
  return `${userId ?? "signed-out"}:${side}`;
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
  write(key, (current) => ({ ...current, files: [], setup: null, failedConfig: null, note: "" }));
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
 */
export function finishSend(key: string, sent: readonly File[], failedConfig: string | null): void {
  write(key, (current) => {
    if (failedConfig !== null) return { ...current, sending: false, failedConfig };
    const files = current.files.filter((file) => !sent.includes(file));
    return { ...current, sending: false, files, setup: files.length > 0 ? current.setup : null, failedConfig: null };
  });
}

/** Try again: clear the failure so the pile goes up next time the screen is ready. */
export function retryHeld(key: string): void {
  write(key, (current) => ({ ...current, failedConfig: null }));
}

export function sayHeld(key: string, note: string): void {
  write(key, (current) => ({ ...current, note }));
}

/** Empty the store. For tests: it is module state and would leak between them. */
export function clearAllHeld(): void {
  store.clear();
  syncUnloadGuard();
  listeners.forEach((listener) => listener());
}

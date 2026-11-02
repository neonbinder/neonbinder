import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { PlatformSyncStatus, SetProblems, SyncProblem, SyncStatus } from "./types";

/**
 * NEO-370 — the Sync status reads (`listingSync.syncStatus`, and the admin's
 * `adminSyncStatus` per collector) as the view model draws them. Pure and
 * Convex-free at run time, so the inventory tab and the admin screen share
 * one mapping and the unit tests pin it without a deployment.
 *
 * Optional fields stay absent when the server leaves them out; a held-back
 * total smaller than the problems shown is raised to the shown count, so the
 * screen never says "2 held back" over a list of 3.
 */

export type RawSyncStatus = FunctionReturnType<typeof api.listingSync.syncStatus>;
type RawPlatform = RawSyncStatus["platforms"][number];
type RawProblem = RawPlatform["sets"][number]["problems"][number];
export type RawSetProblems = FunctionReturnType<typeof api.listingSync.syncSetProblems>;

function toProblem(raw: RawProblem): SyncProblem {
  return {
    reason: raw.reason,
    ...(raw.cardNo !== undefined ? { cardNo: raw.cardNo } : {}),
    ...(raw.cardLabel !== undefined ? { cardLabel: raw.cardLabel } : {}),
    ...(raw.detail !== undefined ? { detail: raw.detail } : {}),
  };
}

function toPlatform(raw: RawPlatform): PlatformSyncStatus {
  return {
    platform: raw.platform,
    connected: raw.connected,
    listing: raw.listing,
    needsReauth: raw.needsReauth,
    paused: raw.paused,
    sellerConflict: raw.sellerConflict,
    running: raw.running
      ? {
          startedAt: raw.running.startedAt,
          ...(raw.running.setLabel !== undefined ? { setLabel: raw.running.setLabel } : {}),
          ...(raw.running.variantId !== undefined ? { variantId: raw.running.variantId } : {}),
        }
      : null,
    ...(raw.scheduledAt !== undefined ? { scheduledAt: raw.scheduledAt } : {}),
    ...(raw.lastDrainAt !== undefined ? { lastDrainAt: raw.lastDrainAt } : {}),
    queued: {
      cards: raw.queued.cards.map((c) => ({
        cardId: c.cardId,
        ...(c.cardNo !== undefined ? { cardNo: c.cardNo } : {}),
        ...(c.cardLabel !== undefined ? { cardLabel: c.cardLabel } : {}),
        variantId: c.variantId,
        setLabel: c.setLabel,
        changedAt: c.changedAt,
      })),
      more: raw.queued.more,
    },
    sets: raw.sets.map((s) => ({
      variantId: s.variantId,
      setLabel: s.setLabel,
      status: s.status,
      ...(s.lastRunAt !== undefined ? { lastRunAt: s.lastRunAt } : {}),
      ...(s.lastSuccessAt !== undefined ? { lastSuccessAt: s.lastSuccessAt } : {}),
      ...(s.lastError !== undefined ? { lastError: s.lastError } : {}),
      ...(s.counts ? { counts: s.counts } : {}),
      problems: s.problems.map(toProblem),
      problemsTotal: Math.max(s.problemsTotal, s.problems.length),
    })),
  };
}

export function toSyncStatus(raw: RawSyncStatus): SyncStatus {
  return { platforms: raw.platforms.map(toPlatform) };
}

export function toSetProblems(raw: RawSetProblems): SetProblems {
  return {
    problems: raw.problems.map(toProblem),
    problemsTotal: Math.max(raw.problemsTotal, raw.problems.length),
  };
}

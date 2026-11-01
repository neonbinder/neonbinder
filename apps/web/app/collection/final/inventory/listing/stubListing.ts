import type { ListingExtension } from "../../data/store";
import type { ListingPlatformSettings, SyncStatus } from "../../data/types";

/**
 * NEO-370 — a listing extension for component tests: everything answers
 * "nothing yet" unless the test passes its own. Test-only (nothing in the app
 * imports it); it holds no test runner calls, so spies stay in the test.
 */

/** Connected and listing, nothing wrong. */
export const LISTING: ListingPlatformSettings = {
  connected: true,
  listing: true,
  listingSince: new Date(2026, 9, 30).getTime(),
  needsReauth: false,
  paused: false,
  sellerConflict: false,
};

/** Connected, not started. */
export const NOT_STARTED: ListingPlatformSettings = {
  connected: true,
  listing: false,
  needsReauth: false,
  paused: false,
  sellerConflict: false,
};

export const EMPTY_SYNC_STATUS: SyncStatus = { platforms: [] };

export function stubListing(over: Partial<ListingExtension> = {}): ListingExtension {
  return {
    useSettings: () => ({ bsc: LISTING }),
    syncVariant: async () => ({ queued: true }),
    setContainerListed: async () => {},
    useSyncStatus: () => EMPTY_SYNC_STATUS,
    loadSetProblems: async () => ({ problems: [], problemsTotal: 0 }),
    useSales: () => ({ sales: [], canLoadMore: false, loadingMore: false, loadMore: () => {} }),
    ...over,
  };
}

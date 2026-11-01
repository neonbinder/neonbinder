import { useCallback, useId, useMemo, useRef } from "react";
import { useConvex, useQuery } from "convex/react";
import { useSearchParams } from "react-router";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { SkeletonBars } from "@/app/collection/final/catalog/Skeleton";
import { toSetProblems, toSyncStatus } from "@/app/collection/final/data/syncStatus";
import type { ListingPlatform, VariantId } from "@/app/collection/final/data/types";
import SyncStatusView from "@/app/collection/final/inventory/listing/SyncStatusView";
import NeonButton from "@/components/modules/NeonButton";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";

/**
 * /admin/sync-status — NEO-370 Rev 4. The collector's Sync status screen
 * (`SyncStatusView`), for every collector who lists anywhere, or one picked
 * from "Collector". READ-ONLY: no Sync here, and no link to anyone's
 * Profile. The functions behind it are requireAdmin server-side.
 *
 * The pick lives in the URL (`?owner=`), so a refresh or a pasted link
 * reopens the same collector. Picking under "Collector" is a filter, so it
 * replaces the entry; "See everything for <name>" from the everyone view is
 * a drill-down, so it pushes one and Back returns to everyone.
 *
 * The everyone view gets short per-collector lists from the server (a few
 * queued cards and sets each); one collector's view gets the full ones.
 *
 * The h1 lives in the section layout, so this heads its content with an h2.
 */

/** The "Collector" select's value for everyone. */
const EVERYONE = "";

export default function AdminSyncStatusPage() {
  useDocumentTitle("Sync Status · Admin");
  const [params, setParams] = useSearchParams();
  const owner = params.get("owner") ?? EVERYONE;
  const owners = useQuery(api.listingSync.adminSyncOwners, {});
  const result = useQuery(api.listingSync.adminSyncStatus, owner ? { ownerId: owner } : {});
  const convex = useConvex();
  const selectId = useId();
  const selectRef = useRef<HTMLSelectElement>(null);

  const pick = (next: string, replace = true) => {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next) p.set("owner", next);
        else p.delete("owner");
        return p;
      },
      { replace },
    );
  };

  /** Drill from everyone into one collector, and land on the filter that now names them. */
  const seeAll = (ownerId: string) => {
    pick(ownerId, false);
    requestAnimationFrame(() => selectRef.current?.focus());
  };

  const shown = useMemo(
    () => result?.owners.map((o) => ({ ownerId: o.ownerId, label: o.label, status: toSyncStatus(o.status) })),
    [result],
  );

  const loaderFor = useCallback(
    (ownerId: string) => async (variantId: VariantId, platform: ListingPlatform) =>
      toSetProblems(
        await convex.query(api.listingSync.adminSyncSetProblems, {
          ownerId,
          variantId: variantId as Id<"selectorOptions">,
          platform,
        }),
      ),
    [convex],
  );

  // A picked collector who has dropped off the list still shows as picked.
  const knownOwner = !owner || owners === undefined || owners.some((o) => o.ownerId === owner);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 text-2xl font-semibold">Sync Status</h2>
        <p className="text-sm text-ink-3">
          What every collector&apos;s listing is doing: syncs running now, cards queued for the next one, and each
          set&apos;s last result. Look, don&apos;t touch: nothing here syncs.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label htmlFor={selectId} className="block">
          <span className="mb-1 block text-sm font-medium text-ink-2">Collector</span>
          <select
            id={selectId}
            ref={selectRef}
            value={owner}
            onChange={(e) => pick(e.target.value)}
            className="min-h-11 rounded-md border border-field-rule bg-field px-3 text-base text-ink focus-outline sm:min-h-10"
          >
            <option value={EVERYONE}>Everyone who lists</option>
            {!knownOwner && <option value={owner}>This collector</option>}
            {(owners ?? []).map((o) => (
              <option key={o.ownerId} value={o.ownerId}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {owners === undefined && <p className="pb-2 text-sm text-ink-3">Rounding up collectors…</p>}
      </div>

      {shown === undefined ? (
        <div aria-busy="true">
          <SkeletonBars rows={6} />
        </div>
      ) : shown.length === 0 ? (
        <p className="rounded-md border border-dashed border-rule-strong px-3 py-2 text-sm text-ink-3">
          {owner ? "Nothing synced for this collector yet." : "Nobody lists anywhere yet. Quiet on the wire."}
        </p>
      ) : (
        <div className="space-y-8">
          {!owner && (
            <p className="text-sm text-ink-3">
              Each collector&apos;s lists are cut short here. See everything for one with the button beside their name.
            </p>
          )}
          {shown.map((o) => (
            <section key={o.ownerId} aria-label={`Sync status for ${o.label}`} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="min-w-0 break-words text-xl font-semibold">{o.label}</h3>
                {!owner && (
                  <NeonButton
                    type="button"
                    size="1"
                    variant="secondary"
                    outline
                    onClick={() => seeAll(o.ownerId)}
                    className="shrink-0 max-sm:min-h-11"
                  >
                    {`See everything for ${o.label}`}
                  </NeonButton>
                )}
              </div>
              <SyncStatusView status={o.status} loadProblems={loaderFor(o.ownerId)} readOnly level={4} />
            </section>
          ))}
          {result?.more && (
            <p className="text-sm text-ink-3">
              Showing the first {shown.length} collectors. Pick one under Collector to see anyone else.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

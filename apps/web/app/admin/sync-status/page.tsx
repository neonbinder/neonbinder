import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import { Link, useSearchParams } from "react-router";
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
 * (`SyncStatusView`), for every collector who has connected a marketplace
 * (a listing state on any platform), or one picked from "Collector". READ-ONLY: no Sync here, and no link to anyone's
 * Profile. The functions behind it are requireAdmin server-side.
 *
 * The pick lives in the URL (`?owner=`), so a refresh or a pasted link
 * reopens the same collector. Picking under "Collector" is a filter, so it
 * replaces the entry; "See everything for <name>" from the everyone view is
 * a drill-down link, so it pushes one and Back returns to everyone.
 *
 * The everyone view gets short per-collector lists from the server (a few
 * queued cards and sets each); one collector's view gets the full ones. The
 * everyone read spans up to 25 collectors, so it is read once on demand
 * (on arriving, and on "Refresh"), never subscribed: a subscription re-runs
 * on every collector's writes (CLAUDE.md, NEO-392). One collector's view is
 * small and stays live.
 *
 * A collector with no public profile name comes back `named: false` with a
 * plain "Collector without a name (…xxxxxx)" label. The page asks Clerk for
 * those names once per id (`adminUsers.adminResolveOwnerLabels`) and shows one
 * wherever the collector is named: the picker, their section and its link.
 * The action answers an id with itself when Clerk has nothing (or fails), so
 * an answer equal to the id is no name, and the raw id is never shown.
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
  const one = useQuery(api.listingSync.adminSyncStatus, owner ? { ownerId: owner } : "skip");
  const convex = useConvex();
  const selectId = useId();
  const sectionId = useId();
  const selectRef = useRef<HTMLSelectElement>(null);

  // Everyone: read once on demand, on arriving (first load, or Back from one
  // collector) and on each Refresh (`tick`). `asked` counts reads, so a slow
  // answer never overwrites a newer one.
  type Everyone = { result: NonNullable<typeof one>; at: number };
  const [everyone, setEveryone] = useState<Everyone | undefined>(undefined);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const asked = useRef(0);
  useEffect(() => {
    if (owner) return;
    const mine = ++asked.current;
    convex
      .query(api.listingSync.adminSyncStatus, {})
      .then(
        (read) => {
          if (mine !== asked.current) return;
          setEveryone({ result: read, at: Date.now() });
          setReadError(null);
        },
        (error: unknown) => {
          if (mine !== asked.current) return;
          setReadError(error instanceof Error ? error.message : "the server didn't answer");
        },
      )
      .finally(() => {
        if (mine === asked.current) setReading(false);
      });
  }, [owner, convex, tick]);
  const refresh = () => {
    if (reading) return;
    setReading(true);
    setTick((n) => n + 1);
  };
  const result = owner ? one : everyone?.result;

  // Clerk's names for the unnamed collectors on screen, by id. `namesAsked`
  // holds every id already sent, so a re-render or Refresh never asks again;
  // a failed call forgets its ids so a later read can retry them.
  const [clerkNames, setClerkNames] = useState<Record<string, string>>({});
  const namesAsked = useRef(new Set<string>());
  const unnamedKey = useMemo(() => {
    const ids = new Set<string>();
    for (const o of [...(owners ?? []), ...(result?.owners ?? [])]) if (!o.named) ids.add(o.ownerId);
    return [...ids].sort().join("\n");
  }, [owners, result]);
  useEffect(() => {
    const ids = unnamedKey ? unnamedKey.split("\n").filter((id) => !namesAsked.current.has(id)) : [];
    if (ids.length === 0) return;
    ids.forEach((id) => namesAsked.current.add(id));
    convex.action(api.adminUsers.adminResolveOwnerLabels, { userIds: ids }).then(
      (labels) => {
        const found: Record<string, string> = {};
        for (const id of ids) {
          const name = labels[id]?.trim();
          if (name && name !== id) found[id] = name;
        }
        if (Object.keys(found).length > 0) setClerkNames((prev) => ({ ...prev, ...found }));
      },
      () => ids.forEach((id) => namesAsked.current.delete(id)),
    );
  }, [unnamedKey, convex]);
  const nameOf = useCallback(
    (o: { ownerId: string; label: string; named: boolean }) => (!o.named && clerkNames[o.ownerId]) || o.label,
    [clerkNames],
  );

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

  /** After the drill-down link: land on the filter that now names the collector. */
  const focusFilter = () => requestAnimationFrame(() => selectRef.current?.focus());

  const shown = useMemo(
    () => result?.owners.map((o) => ({ ownerId: o.ownerId, label: nameOf(o), status: toSyncStatus(o.status) })),
    [result, nameOf],
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
          What syncing is doing for every collector who has connected a marketplace: syncs running now, cards
          queued for the next one, and each set&apos;s last result. Look, don&apos;t touch: nothing here syncs.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        {/* min-w-0 + max-w-full: a long collector name never pushes the select past a phone's edge. */}
        <label htmlFor={selectId} className="block min-w-0 max-w-full">
          <span className="mb-1 block text-sm font-medium text-ink-2">Collector</span>
          <select
            id={selectId}
            ref={selectRef}
            value={owner}
            onChange={(e) => pick(e.target.value)}
            className="min-h-11 w-full max-w-full rounded-md border border-field-rule bg-field px-3 text-base text-ink focus-outline sm:min-h-10"
          >
            <option value={EVERYONE}>Everyone who has connected a marketplace</option>
            {!knownOwner && <option value={owner}>This collector</option>}
            {(owners ?? []).map((o) => (
              <option key={o.ownerId} value={o.ownerId}>
                {nameOf(o)}
              </option>
            ))}
          </select>
        </label>
        {owners === undefined && <p className="pb-2 text-sm text-ink-3">Rounding up collectors…</p>}
        {!owner && (
          <NeonButton
            type="button"
            variant="secondary"
            outline
            onClick={refresh}
            aria-disabled={reading || undefined}
            aria-busy={reading || undefined}
            className="min-h-11 sm:min-h-10"
          >
            Refresh
          </NeonButton>
        )}
        {/* Always mounted, so the read time and a failed read are announced. */}
        <p
          key={readError ? "error" : "ok"}
          role={readError ? "alert" : "status"}
          aria-live={readError ? undefined : "polite"}
          aria-atomic="true"
          className={`pb-2 text-sm ${readError ? "text-notice-warn-ink" : "text-ink-3"}`}
        >
          {owner
            ? ""
            : readError
              ? `Couldn't read everyone's sync status: ${readError}. Press Refresh to try again.`
              : everyone
                ? `As of ${new Date(everyone.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
                : ""}
        </p>
      </div>

      {shown === undefined ? (
        // A first read that failed says so above; no skeleton waits on it.
        readError && !owner ? null : (
          <div aria-busy="true">
            <SkeletonBars rows={6} />
          </div>
        )
      ) : shown.length === 0 ? (
        <p className="rounded-md border border-dashed border-rule-strong px-3 py-2 text-sm text-ink-3">
          {owner ? "Nothing synced for this collector yet." : "Nobody has connected a marketplace yet."}
        </p>
      ) : (
        <div className="space-y-8">
          {!owner && (
            <p className="text-sm text-ink-3">
              Each collector&apos;s lists are cut short here. See everything for one with the button beside their name.
            </p>
          )}
          {shown.map((o) => (
            <section key={o.ownerId} aria-labelledby={`${sectionId}-${o.ownerId}`} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 id={`${sectionId}-${o.ownerId}`} className="min-w-0 break-words text-xl font-semibold">
                  {o.label}
                </h3>
                {!owner && (
                  // A drill-down: a link that pushes history, so Back returns to everyone.
                  // On a phone a long name wraps inside the button rather than running off the edge.
                  <NeonButton
                    asChild
                    size="1"
                    variant="secondary"
                    outline
                    className="max-w-full shrink-0 max-sm:h-auto max-sm:min-h-11 max-sm:whitespace-normal max-sm:py-2 max-sm:text-center max-sm:wrap-anywhere"
                  >
                    <Link to={`?owner=${encodeURIComponent(o.ownerId)}`} onClick={focusFilter}>
                      {`See everything for ${o.label}`}
                    </Link>
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

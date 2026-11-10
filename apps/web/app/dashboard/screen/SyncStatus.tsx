import { ArrowPathIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { Link, useLocation } from "react-router";
import { MARKETPLACES, type SyncProblemSet, type SyncStatusData } from "../fake-data";
import { CardTitle, count, MarketBadge, sideHref, Thumb } from "./bits";

/**
 * NEO-464 review round 4 — the sync status, at the top of the dashboard
 * (Jason, 2026-11-10: "any sync errors that have not self corrected, ie only
 * show errors that have not had a successful sync of that card/set later.
 * Also show pending syncs there if there are any pending").
 *
 * Read from NB's own records of its syncs (`dashboard.syncAlerts`): the cards
 * waiting for the next sync, per marketplace, and each set whose LATEST sync
 * failed or held cards back. A set a later clean sync put right is not here.
 * Each card it names opens on Inventory, where the fix is; the link at the
 * foot opens Inventory's Sync status tab. Nothing waiting and nothing wrong:
 * no section (the caller passes null).
 */
export default function SyncStatus({ status }: { status: SyncStatusData }) {
  const { pathname } = useLocation();
  const trouble = status.problems.length > 0;
  return (
    <section
      aria-labelledby="cb-sync-heading"
      className={`min-w-0 rounded-2xl border bg-raised p-4 sm:p-5 ${trouble ? "border-notice-danger-rule" : "border-rule"}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="cb-sync-heading" className="text-lg font-bold text-ink">
          Sync status
        </h2>
        <Link
          to={sideHref(pathname, "inventory", { tab: "sync" })}
          className="rounded-sm text-sm font-semibold text-neon-blue-text underline-offset-2 hover:underline focus-outline"
        >
          Open Sync status
        </Link>
      </div>

      {status.pending.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {status.pending.map((p) => (
            <li key={p.marketplace} className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
              <ArrowPathIcon aria-hidden="true" className="size-4 shrink-0 text-neon-blue-text" />
              <MarketBadge marketplace={p.marketplace} />
              <span>{p.more ? `${p.cards}+ cards` : count(p.cards, "card")} waiting for the next sync.</span>
            </li>
          ))}
        </ul>
      )}

      {trouble && (
        <ul className="mt-4 flex flex-col gap-4">
          {status.problems.map((set) => (
            <li key={set.id}>
              <ProblemSet set={set} pathname={pathname} />
            </li>
          ))}
        </ul>
      )}
      {status.more && <p className="mt-3 text-sm text-ink-3">More sets need a look on Sync status.</p>}
    </section>
  );
}

function ProblemSet({ set, pathname }: { set: SyncProblemSet; pathname: string }) {
  const market = MARKETPLACES[set.marketplace].name;
  const headingId = `${set.id}-heading`;
  const unnamed = set.heldBack - set.cards.length;
  return (
    <article aria-labelledby={headingId} className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <MarketBadge marketplace={set.marketplace} />
        <h3 id={headingId} className="text-sm font-bold text-ink">
          {set.setLabel}
          <span className="sr-only"> on {market}</span>
        </h3>
      </div>
      {set.failure && (
        <p className="mt-2 flex items-start gap-2 rounded-md border border-notice-danger-rule bg-notice-danger-bg px-2 py-1.5 text-sm text-notice-danger-ink">
          <ExclamationTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{set.failure}</span>
        </p>
      )}
      {set.heldBack > 0 && (
        <>
          <p className="mt-2 text-xs text-ink-3">
            {count(set.heldBack, "card")} held back from {market}:
          </p>
          <ul className="mt-1.5 grid gap-2 sm:grid-cols-2">
            {set.cards.map(({ card, reason }) => (
              <li key={card.id}>
                <Link
                  to={sideHref(pathname, "inventory", { tab: "cards", detail: card.id })}
                  className="flex min-w-0 items-start gap-2.5 rounded-md p-1 hover:bg-hover-raised focus-outline"
                >
                  <Thumb card={card} className="w-9" />
                  <span className="min-w-0 flex-1 text-xs leading-snug">
                    <CardTitle card={card} className="font-semibold text-ink" />
                    <span className="mt-0.5 block text-ink-2">{reason}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {unnamed > 0 && <p className="mt-1.5 text-xs text-ink-3">and {count(unnamed, "more card")}</p>}
        </>
      )}
    </article>
  );
}

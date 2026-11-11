import { ArrowPathIcon, ChevronDownIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { Link, useLocation } from "react-router";
import type { SyncProblemSet, SyncStatusData } from "../fake-data";
import { MARKETPLACES } from "../dash-labels";
import { CardTitle, count, MarketBadge, sideHref, Thumb } from "./bits";
import { heldOf, PanelLink } from "./panelLink";
import { useOpen } from "./useOpen";

/**
 * NEO-464 review round 4 — the sync status, at the top of the dashboard
 * (Jason, 2026-11-10: "any sync errors that have not self corrected, ie only
 * show errors that have not had a successful sync of that card/set later.
 * Also show pending syncs there if there are any pending").
 *
 * Read from NB's own records of its syncs (`dashboard.syncAlerts`): each set
 * whose LATEST sync failed or held cards back, then the cards waiting for the
 * next sync, per marketplace. A set a later clean sync put right is not here.
 *
 * Held-back cards lead (Jason, 2026-11-11: "very important, probably more
 * important than other things within sync... each one should open the card
 * panel where they could fix it"): the sets holding cards back come first,
 * and within a set its cards come before the failure sentence. Each card,
 * with its reason, opens its card panel over the dashboard (`./panelLink`),
 * as stock for sale, where its price, photo or copy is fixed. The first `HELD_PREVIEW` show; "Show all N" opens
 * every card the read named (an in-view tweak, `useOpen`); cards past what
 * the read names open on Sync status. The link at the top opens Inventory's
 * Sync status tab. Nothing waiting and nothing wrong: no section (the caller
 * passes null).
 */

/** Held-back cards a set shows before "Show all". */
export const HELD_PREVIEW = 6;

/**
 * The frame says how bad it is: a set whose last sync failed is the danger
 * rule; only cards held back (each one a fix the collector can make) is the
 * warning rule; only cards waiting for the next sync is the plain rule.
 */
export function syncFrame(status: SyncStatusData): "danger" | "warn" | "plain" {
  if (status.problems.some((p) => p.failure)) return "danger";
  if (status.problems.length > 0) return "warn";
  return "plain";
}

const FRAME_RULE = {
  danger: "border-notice-danger-rule",
  warn: "border-notice-warn-rule",
  plain: "border-rule",
} as const;

/** A link on its own line: a 44px target on a phone, its text height beside the heading on wider screens. */
const SYNC_LINK =
  "inline-flex min-h-11 items-center rounded-sm text-sm font-semibold text-neon-blue-text underline-offset-2 hover:underline focus-outline sm:min-h-0";

export default function SyncStatus({ status }: { status: SyncStatusData }) {
  const { pathname } = useLocation();
  const trouble = status.problems.length > 0;
  return (
    <section
      aria-labelledby="cb-sync-heading"
      className={`shadow-offset min-w-0 rounded-2xl border bg-raised p-4 sm:p-5 ${FRAME_RULE[syncFrame(status)]}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="cb-sync-heading" tabIndex={-1} className="rounded-sm text-lg font-bold text-ink focus-outline">
          Sync status
        </h2>
        <Link to={sideHref(pathname, "inventory", { tab: "sync" })} className={SYNC_LINK}>
          Open Sync status
        </Link>
      </div>

      {trouble && (
        <ul className="mt-4 flex flex-col gap-5">
          {status.problems.map((set) => (
            <li key={set.id}>
              <ProblemSet set={set} pathname={pathname} />
            </li>
          ))}
        </ul>
      )}
      {status.more && <p className="mt-3 text-sm text-ink-3">More sets need a look on Sync status.</p>}

      {status.pending.length > 0 && (
        <ul className={`flex flex-col gap-2 ${trouble ? "mt-4 border-t border-rule pt-3" : "mt-3"}`}>
          {status.pending.map((p) => (
            <li key={p.marketplace} className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
              <ArrowPathIcon aria-hidden="true" className="size-4 shrink-0 text-neon-blue-text" />
              <MarketBadge marketplace={p.marketplace} />
              <span>{p.more ? `${p.cards}+ cards` : count(p.cards, "card")} waiting for the next sync.</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProblemSet({ set, pathname }: { set: SyncProblemSet; pathname: string }) {
  const market = MARKETPLACES[set.marketplace].name;
  const headingId = `${set.id}-heading`;
  const [all, toggle] = useOpen(set.id);
  const shown = all ? set.cards : set.cards.slice(0, HELD_PREVIEW);
  const folded = set.cards.length - HELD_PREVIEW;
  const unnamed = set.heldBack - set.cards.length;
  // ↑ ↓ in a held-back card's panel walk the set's held-back cards, the folded ones too, each with its reason.
  const heldIds = set.cards.map((c) => c.card.id);
  const heldList = new Map(
    set.cards.flatMap((c) => {
      const held = heldOf(set.marketplace, c.code);
      return held ? [[c.card.id, held] as const] : [];
    }),
  );
  return (
    <article aria-labelledby={headingId} className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <MarketBadge marketplace={set.marketplace} />
        <h3 id={headingId} tabIndex={-1} className="rounded-sm text-sm font-bold text-ink focus-outline">
          {set.setLabel}
          <span className="sr-only"> on {market}</span>
        </h3>
      </div>
      {set.heldBack > 0 && (
        <>
          <p className="mt-2 text-sm font-semibold text-ink">
            {count(set.heldBack, "card")} held back from {market}.{" "}
            {set.heldBack === 1
              ? "Fix it on the card and it goes up next sync:"
              : "Fix each one on its card and it goes up next sync:"}
          </p>
          {shown.length > 0 && (
            <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {shown.map(({ card, reason, code }) => (
                <li key={card.id} className="min-w-0">
                  <PanelLink
                    cardId={card.id}
                    side="inventory"
                    list={heldIds}
                    held={heldOf(set.marketplace, code)}
                    heldList={heldList}
                    // The warn tint stays under the pointer: the rule darkens and the title underlines.
                    className="group flex h-full min-w-0 items-start gap-2.5 rounded-md border border-notice-warn-rule bg-notice-warn-bg p-2 hover:border-notice-warn-ink focus-outline"
                  >
                    <Thumb card={card} className="w-10" />
                    <span className="min-w-0 flex-1 text-xs leading-snug">
                      <CardTitle
                        card={card}
                        className="font-semibold text-ink underline-offset-2 group-hover:underline"
                      />
                      <span className="mt-1 block text-notice-warn-ink">{reason}</span>
                    </span>
                  </PanelLink>
                </li>
              ))}
            </ul>
          )}
          {(folded > 0 || unnamed > 0) && (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
              {folded > 0 && (
                <button
                  type="button"
                  aria-expanded={all}
                  onClick={toggle}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-control px-3 text-sm text-ink-2 hover:border-neon-blue hover:text-ink focus-outline sm:min-h-9"
                >
                  <ChevronDownIcon
                    aria-hidden="true"
                    className={`size-4 transition-transform motion-reduce:transition-none ${all ? "rotate-180" : ""}`}
                  />
                  {/* The words on it lead its name (WCAG 2.5.3): the count it adds is seen, the set it is in is read, last. */}
                  {all ? "Show fewer" : `Show all ${set.cards.length}`}
                  {!all && (
                    <span aria-hidden="true" className="text-ink-3">
                      {" "}
                      (+{folded})
                    </span>
                  )}
                  <span className="sr-only">
                    {" "}
                    held back in {set.setLabel} on {market}
                  </span>
                </button>
              )}
              {unnamed > 0 && (
                <Link
                  to={sideHref(pathname, "inventory", { tab: "sync" })}
                  aria-label={`${count(unnamed, "more card")} on Sync status, held back in ${set.setLabel} on ${market}`}
                  className={SYNC_LINK}
                >
                  {count(unnamed, "more card")} on Sync status
                </Link>
              )}
            </div>
          )}
        </>
      )}
      {set.failure && (
        <p className="mt-2 flex items-start gap-2 rounded-md border border-notice-danger-rule bg-notice-danger-bg px-2 py-1.5 text-sm text-notice-danger-ink">
          <ExclamationTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{set.failure}</span>
        </p>
      )}
    </article>
  );
}

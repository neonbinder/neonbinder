import { useState } from "react";
import { Link } from "react-router";
import NeonButton from "@/components/modules/NeonButton";
import { SYNC_REPORT_GROUP_COUNT_CAP } from "@/lib/collection/sync-report";
import { MARKETPLACES } from "../dash-labels";
import { MarketBadge, RAIL_PANEL, RailHeading } from "./bits";
import {
  ADMIN_REQUESTS_HREF,
  adminAskHref,
  ASK_KIND_LABEL,
  MY_REQUESTS_HREF,
  useCrew,
  WAITING_SHOWN,
  type CrewAsk,
} from "./crew";

/**
 * NEO-536 — right under Sync status: what is open with the crew. Stats and
 * actions only (Jason, 2026-11-13: the dashboard shows "only helpful stats
 * and actions the user must take"; nothing closed, no explaining).
 *
 * - "With our crew": the collector's open card requests, set requests and
 *   sync reports, one line each. A report can be withdrawn here. Past the
 *   few named, "N more" opens My requests.
 * - "From collectors" (an admin only): every collector's open asks, oldest
 *   first, each a link into its review on Card Requests.
 *
 * An admin with asks of their own sees both, side by side from `lg`. Nothing
 * open on either side, or no crew at all (the demo): nothing drawn.
 */
export default function CrewDesk() {
  const crew = useCrew();
  const desk = crew?.desk;
  if (!desk) return null;
  const mine = desk.mine.length > 0;
  const waiting = (desk.waiting?.length ?? 0) > 0;
  if (!mine && !waiting) return null;
  return (
    <div className={mine && waiting ? "grid gap-6 lg:grid-cols-2 lg:items-start" : "max-w-2xl"}>
      {mine && <WithOurCrew asks={desk.mine} more={desk.mineMore} />}
      {waiting && <FromCollectors asks={desk.waiting!} more={desk.waitingMore} />}
    </div>
  );
}

const ROW = "flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 py-1.5";
const MORE_LINK =
  "mt-2 inline-flex min-h-11 items-center rounded-sm text-sm font-semibold text-neon-blue-text underline-offset-2 hover:underline focus-outline sm:min-h-9";

/** "Sync report", then the marketplace pill for a report. */
function AskTags({ ask }: { ask: CrewAsk }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-2">
      <span className="text-xs text-ink-3">{ASK_KIND_LABEL[ask.kind]}</span>
      {ask.platform && <MarketBadge marketplace={ask.platform} />}
    </span>
  );
}

/**
 * After a withdraw the row is gone (and with the last one, the panel): focus
 * goes to the panel's heading, or to Sync status's above it, never the page.
 */
function focusAfterWithdraw(): void {
  (document.getElementById(MINE_HEADING) ?? document.getElementById("cb-sync-heading"))?.focus();
}

const MINE_HEADING = "cb-crew-mine-heading";

function WithOurCrew({ asks, more }: { asks: CrewAsk[]; more: number }) {
  const total = asks.length + more;
  return (
    <section aria-labelledby={MINE_HEADING} className={`${RAIL_PANEL} min-w-0`}>
      <RailHeading id={MINE_HEADING} note={`${total} open`}>
        With our crew
      </RailHeading>
      <ul className="divide-y divide-rule">
        {asks.map((ask) => (
          <MyAsk key={ask.id} ask={ask} />
        ))}
      </ul>
      {more > 0 && (
        <Link to={MY_REQUESTS_HREF} className={MORE_LINK}>
          {more} more in My requests
        </Link>
      )}
    </section>
  );
}

function MyAsk({ ask }: { ask: CrewAsk }) {
  const crew = useCrew();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const market = ask.platform ? MARKETPLACES[ask.platform].name : null;
  async function withdraw() {
    if (!crew || busy) return;
    setBusy(true);
    setError(null);
    const why = await crew.withdraw(ask.id);
    if (why) {
      setError(why);
      setBusy(false);
    } else {
      // The read has dropped the row by now (a mutation resolves after its reads re-run).
      focusAfterWithdraw();
    }
  }
  return (
    <li className={ROW}>
      <span className="min-w-0 flex-1 text-sm font-semibold text-ink [overflow-wrap:anywhere]">{ask.label}</span>
      <AskTags ask={ask} />
      {ask.kind === "report" && (
        <NeonButton
          variant="negative"
          outline
          size="1"
          className="max-sm:min-h-11"
          aria-disabled={busy || undefined}
          onClick={() => void withdraw()}
        >
          Withdraw
          <span className="sr-only">
            {" "}
            report for {ask.label}
            {market ? ` on ${market}` : ""}
          </span>
        </NeonButton>
      )}
      {error && (
        <p role="alert" className="w-full text-sm text-neon-pink-text">
          {error}
        </p>
      )}
    </li>
  );
}

/** "+3 reported"; at the count's cap, "20+ reported". */
export function alsoReportedLabel(n: number): string {
  return n >= SYNC_REPORT_GROUP_COUNT_CAP ? `${SYNC_REPORT_GROUP_COUNT_CAP}+ reported` : `+${n} reported`;
}

function FromCollectors({ asks, more }: { asks: CrewAsk[]; more: boolean }) {
  const shown = asks.slice(0, WAITING_SHOWN);
  const past = asks.length - shown.length;
  const note = more ? `${asks.length}+ waiting` : `${asks.length} waiting`;
  return (
    <section aria-labelledby="cb-crew-waiting-heading" className={`${RAIL_PANEL} min-w-0`}>
      <RailHeading id="cb-crew-waiting-heading" note={note}>
        From collectors
      </RailHeading>
      <ul className="divide-y divide-rule">
        {shown.map((ask) => (
          <li key={ask.id}>
            <Link
              to={adminAskHref(ask)}
              className={`${ROW} group -mx-2 rounded-md px-2 hover:bg-list-hover-raised focus-outline`}
            >
              <span className="min-w-0 flex-1 text-sm font-semibold text-ink underline-offset-2 [overflow-wrap:anywhere] group-hover:underline">
                {ask.label}
              </span>
              <AskTags ask={ask} />
              {(ask.alsoReportedBy ?? 0) > 0 && (
                <span className="shrink-0 rounded-full border border-notice-warn-rule bg-notice-warn-bg px-2 py-0.5 text-xs font-bold tabular-nums text-notice-warn-ink">
                  {alsoReportedLabel(ask.alsoReportedBy!)}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
      {(past > 0 || more) && (
        <Link to={ADMIN_REQUESTS_HREF} className={MORE_LINK}>
          {more ? `${past}+` : past} more on Card Requests
        </Link>
      )}
    </section>
  );
}

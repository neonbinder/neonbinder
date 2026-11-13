import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import NeonButton from "@/components/modules/NeonButton";
import { alsoReportedLine, alsoReportedSpoken } from "@/app/admin/card-requests/syncReportCopy";
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
 * open on either side: no panels, only the (empty) line that says what a
 * withdraw did, mounted from the start so it is announced. No crew at all
 * (the demo): nothing drawn.
 */
export default function CrewDesk() {
  const crew = useCrew();
  const desk = crew?.desk;
  const [withdrew, setWithdrew] = useState<string | null>(null);
  // The withdrawn report's id until the read has dropped its row; then the
  // keyboard moves (`focusAfterWithdraw`).
  const landing = useRef<string | null>(null);
  useEffect(() => {
    const gone = landing.current;
    if (!gone || !desk || desk.mine.some((a) => a.id === gone)) return;
    landing.current = null;
    focusAfterWithdraw();
  }, [desk, withdrew]);
  if (!crew) return null;
  const mine = (desk?.mine.length ?? 0) > 0;
  const waiting = (desk?.waiting?.length ?? 0) > 0;
  const panels = !!desk && (mine || waiting);
  // The page spaces its sections with margins (`space-y-*`, zero specificity):
  // with nothing to draw this one takes no room, its own gap included.
  return (
    <div className={panels || withdrew ? "min-w-0" : "mb-0 min-w-0"}>
      {panels && (
        <div className={mine && waiting ? "grid gap-6 lg:grid-cols-2 lg:items-start" : "max-w-2xl"}>
          {mine && (
            <WithOurCrew
              asks={desk!.mine}
              more={desk!.mineMore}
              onWithdrawn={(ask, words) => {
                landing.current = ask.id;
                setWithdrew(`Withdrew the report on ${words}.`);
              }}
            />
          )}
          {waiting && <FromCollectors asks={desk!.waiting!} more={desk!.waitingMore} />}
        </div>
      )}
      <p role="status" className={withdrew ? `${panels ? "mt-3 " : ""}text-sm font-semibold text-neon-green-text` : ""}>
        {withdrew}
      </p>
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
 * goes to the panel's heading, else Sync status's above it, else the
 * dashboard's h1 (made focusable, never a tab stop), never the page.
 */
function focusAfterWithdraw(): void {
  const heading = document.getElementById(MINE_HEADING) ?? document.getElementById("cb-sync-heading");
  if (heading) {
    heading.focus();
    return;
  }
  const h1 = document.querySelector<HTMLElement>("h1");
  if (!h1) return;
  if (!h1.hasAttribute("tabindex")) h1.tabIndex = -1;
  h1.focus();
}

const MINE_HEADING = "cb-crew-mine-heading";

/** Said once a report is withdrawn: its set, and its marketplace when it has one. */
type OnWithdrawn = (ask: CrewAsk, words: string) => void;

function WithOurCrew({ asks, more, onWithdrawn }: { asks: CrewAsk[]; more: number; onWithdrawn: OnWithdrawn }) {
  const total = asks.length + more;
  return (
    <section aria-labelledby={MINE_HEADING} className={`${RAIL_PANEL} min-w-0`}>
      <RailHeading id={MINE_HEADING} note={`${total} open`}>
        With our crew
      </RailHeading>
      <ul className="divide-y divide-rule">
        {asks.map((ask) => (
          <MyAsk key={ask.id} ask={ask} onWithdrawn={onWithdrawn} />
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

function MyAsk({ ask, onWithdrawn }: { ask: CrewAsk; onWithdrawn: OnWithdrawn }) {
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
      // The section says so, and moves the keyboard once the row is gone.
      onWithdrawn(ask, market ? `${ask.label} (${market})` : ask.label);
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
      {/* Mounted from the start, so a refusal is announced; empty, it takes no room in the row. */}
      <p role="alert" className="w-full text-sm text-neon-pink-text empty:-mt-1">
        {error}
      </p>
    </li>
  );
}

/** When an ask was made, for a reader telling two of the same name apart. */
function askedWhen(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
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
                <>
                  <span
                    aria-hidden="true"
                    className="shrink-0 rounded-full border border-notice-warn-rule bg-notice-warn-bg px-2 py-0.5 text-xs font-bold tabular-nums text-notice-warn-ink"
                  >
                    {alsoReportedLine(ask.alsoReportedBy!)}
                  </span>
                  <span className="sr-only"> {alsoReportedSpoken(ask.alsoReportedBy!)}</span>
                </>
              )}
              <span className="sr-only"> asked {askedWhen(ask.at)}</span>
            </Link>
          </li>
        ))}
      </ul>
      {(past > 0 || more) && (
        <Link to={ADMIN_REQUESTS_HREF} className={MORE_LINK}>
          {past > 0 ? `${more ? `${past}+` : past} more on Card Requests` : "More on Card Requests"}
        </Link>
      )}
    </section>
  );
}

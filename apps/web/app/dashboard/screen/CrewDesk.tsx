import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import NeonButton from "@/components/modules/NeonButton";
import AlsoReportedTag from "@/app/admin/card-requests/AlsoReportedTag";
import { syncReportWhen } from "@/app/admin/card-requests/syncReportCopy";
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

/** How long "Withdrew the report on …" stays up. */
export const WITHDREW_SHOWN_MS = 5000;

/**
 * NEO-536 — right under Sync status: what is open with the crew. Stats and
 * actions only (Jason, 2026-11-13: the dashboard shows "only helpful stats
 * and actions the user must take"; nothing closed, no explaining).
 *
 * - "With our crew": the collector's open card requests, set requests and
 *   sync reports, one line each. A card or set request opens My requests; a
 *   report can be withdrawn here. Past the few named, "N more" opens My
 *   requests.
 * - "From collectors" (an admin only): every collector's open asks, oldest
 *   first, each a link into its review on Card Requests.
 *
 * An admin with asks of their own sees both, side by side from `lg`. Nothing
 * open on either side: no panels, only the (empty) line that says what a
 * withdraw did, mounted from the start so it is announced. That line clears
 * itself after `WITHDREW_SHOWN_MS`, or as the next withdraw starts, so it
 * never reads as news it no longer is. No crew at all (the demo): nothing
 * drawn.
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
  useEffect(() => {
    if (!withdrew) return;
    const timer = setTimeout(() => setWithdrew(null), WITHDREW_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [withdrew]);
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
              onWithdrawing={() => setWithdrew(null)}
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
/** A whole row that opens somewhere: the row's layout, lit under the pointer. */
const ROW_LINK = `${ROW} group -mx-2 rounded-md px-2 hover:bg-list-hover-raised focus-outline`;
/** The label inside a `ROW_LINK`: it underlines with the row. */
const ROW_LINK_LABEL =
  "min-w-0 flex-1 text-sm font-semibold text-ink underline-offset-2 [overflow-wrap:anywhere] group-hover:underline";
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

interface WithdrawEvents {
  /** A withdraw has started: the last one's line clears. */
  onWithdrawing: () => void;
  onWithdrawn: OnWithdrawn;
}

function WithOurCrew({ asks, more, ...events }: { asks: CrewAsk[]; more: number } & WithdrawEvents) {
  const total = asks.length + more;
  return (
    <section aria-labelledby={MINE_HEADING} className={`${RAIL_PANEL} min-w-0`}>
      <RailHeading id={MINE_HEADING} note={`${total} open`}>
        With our crew
      </RailHeading>
      <ul className="divide-y divide-rule">
        {asks.map((ask) => (
          <MyAsk key={ask.id} ask={ask} {...events} />
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

/**
 * One of the collector's open asks. A card or set request is a link into My
 * requests, where it can be followed or withdrawn; its name says which ask
 * it is, its kind and when it was asked, so two of one name read apart. A
 * sync report is withdrawn right here.
 */
function MyAsk({ ask, ...events }: { ask: CrewAsk } & WithdrawEvents) {
  if (ask.kind !== "report") {
    return (
      <li>
        <Link to={MY_REQUESTS_HREF} className={ROW_LINK}>
          <span className={ROW_LINK_LABEL}>{ask.label}</span>
          <AskTags ask={ask} />
          <span className="sr-only">, in My requests, asked {syncReportWhen(ask.at)}</span>
        </Link>
      </li>
    );
  }
  return <MyReport ask={ask} {...events} />;
}

function MyReport({ ask, onWithdrawing, onWithdrawn }: { ask: CrewAsk } & WithdrawEvents) {
  const crew = useCrew();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const market = ask.platform ? MARKETPLACES[ask.platform].name : null;
  async function withdraw() {
    if (!crew || busy) return;
    setBusy(true);
    setError(null);
    onWithdrawing();
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
      {/* The words on it lead its name (WCAG 2.5.3), busy too: "Withdrawing… report for …". */}
      <NeonButton
        variant="negative"
        outline
        size="1"
        className="max-sm:min-h-11"
        aria-disabled={busy || undefined}
        onClick={() => void withdraw()}
      >
        {busy ? "Withdrawing…" : "Withdraw"}
        <span className="sr-only">
          {" "}
          report for {ask.label}
          {market ? ` on ${market}` : ""}
        </span>
      </NeonButton>
      {/* Mounted from the start, so a refusal is announced; empty, it takes no room in the row. */}
      <p role="alert" className="w-full text-sm text-neon-pink-text empty:-mt-1">
        {error}
      </p>
    </li>
  );
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
            <Link to={adminAskHref(ask)} className={ROW_LINK}>
              <span className={ROW_LINK_LABEL}>{ask.label}</span>
              <AskTags ask={ask} />
              <AlsoReportedTag n={ask.alsoReportedBy ?? 0} />
              <span className="sr-only"> asked {syncReportWhen(ask.at)}</span>
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

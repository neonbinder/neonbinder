import { Link } from "react-router";
import { EmptySleeve } from "@/app/collection/prototypes/_shared/CardFace";
import type { IntakeInProgress, IntakeUpload } from "../fake-data";
import { CardLine, count, RAIL_PANEL, RailHeading } from "./bits";

/**
 * NEO-464 combined dashboard — In the Hopper: scans still in intake. Shown to
 * everyone who has scans (collector or dealer, sales or none), at the top of
 * the page beside the to-do, because nothing gets filed until these clear
 * (Jason, review item 1). First the scans waiting on a yes, each named by its
 * best guess's full title; then the scans processing, with each run as a link
 * to the Add cards tab that finishes it: Collection for a run into a binder,
 * Inventory for one into a box (Jason, 2026-11-10).
 */

/** The screen a run is finished on, as the shell's tab names it. */
const SIDE_SCREEN: Record<IntakeUpload["side"], string> = { collection: "Collection", inventory: "Inventory" };
/**
 * Empty sleeves drawn for the scans processing: one per scan up to this many,
 * then "+N more", so the pile is as deep as the count says and still fits the
 * rail at phone width.
 */
const SLEEVES_SHOWN = 6;
export default function Hopper({ intake, wanted }: { intake: IntakeInProgress; wanted: Set<string> }) {
  if (intake.total === 0) return null;
  const guesses = intake.preview.flatMap((s) => (s.guess ? [{ id: s.id, card: s.guess }] : []));
  const sleeves = Math.min(intake.waiting, SLEEVES_SHOWN);
  const moreScans = intake.waiting - sleeves;

  return (
    <section aria-labelledby="cb-hopper-heading" className={RAIL_PANEL}>
      <RailHeading id="cb-hopper-heading" note={`${count(intake.total, "scan")} in intake`}>
        In the Hopper
      </RailHeading>

      {intake.needsYou > 0 && (
        <div>
          <h3 className="text-sm font-bold text-ink">
            {count(intake.needsYou, "scan")} {intake.needsYou === 1 ? "needs" : "need"} your yes
          </h3>
          <p className="text-xs text-ink-2">We think we know these. Check the match and they go in a binder.</p>
          <ul aria-label="Best guesses waiting on your yes" className="mt-2.5 flex flex-col gap-2.5">
            {guesses.map((g) => (
              <li key={g.id}>
                <CardLine card={g.card} wanted={wanted.has(g.card.id)} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {intake.waiting > 0 && (
        <div className={intake.needsYou > 0 ? "mt-4 border-t border-rule pt-3" : undefined}>
          <h3 className="text-sm font-bold text-ink">{count(intake.waiting, "scan")} processing</h3>
          {/* The pile, one empty sleeve per scan: a picture of the heading, so it is hidden from a reader. */}
          <div aria-hidden="true" className="mt-2 flex items-center gap-1.5">
            {Array.from({ length: sleeves }, (_, i) => (
              <div key={i} className="w-8">
                <EmptySleeve size="fill" label="Scan processing" ghost="?" />
              </div>
            ))}
            {moreScans > 0 && <span className="ml-1 text-xs font-semibold tabular-nums text-ink-2">+{moreScans} more</span>}
          </div>
        </div>
      )}

      {/* Every run, whatever its scans are waiting on: the yeses and the processing are both finished there. */}
      {intake.uploads.length > 0 && (
        <ul aria-label="Scan runs" className="mt-3 space-y-1 border-t border-rule pt-2">
          {intake.uploads.map((u) => (
            <li key={u.id}>
              <RunLink upload={u} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One run: its binder or box (the link), how far along it is, when it last
 * moved, and a bar. The link is named by what it shows, line by line ("Main 0
 * of 1 scan done Finish on Collection Last scan 3:42 PM"), so two runs into
 * Main read apart by their progress and their time. A sorted run says so
 * instead of asking to be finished.
 */
function RunLink({ upload: u }: { upload: IntakeUpload }) {
  const screen = SIDE_SCREEN[u.side];
  // A run stays a week after its last scan is sorted (intakeRunShows): it has nothing left to finish.
  const finished = u.scans > 0 && u.done >= u.scans;
  return (
    <Link
      to={u.href}
      className="group -mx-1.5 block rounded-md px-1.5 py-1.5 text-xs focus-outline hover:bg-hover-raised max-sm:min-h-11"
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate font-semibold text-neon-blue-text group-hover:underline">{u.name}</span>
        <span className="shrink-0 tabular-nums text-ink-3">
          {u.done} of {count(u.scans, "scan")} done
        </span>
      </span>
      <span className="mt-0.5 flex flex-wrap items-baseline justify-between gap-x-2 text-ink-3">
        <span>{finished ? `All sorted. Open on ${screen}` : `Finish on ${screen}`}</span>
        <span className="tabular-nums">{u.lastScan}</span>
      </span>
      <span aria-hidden="true" className="mt-1 block h-1 overflow-hidden rounded-full bg-chip">
        <span className="block h-full rounded-full bg-neon-blue" style={{ width: `${u.scans > 0 ? (u.done / u.scans) * 100 : 0}%` }} />
      </span>
    </Link>
  );
}

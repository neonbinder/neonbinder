import { Fragment } from "react";
import { Link } from "react-router";
import NeonButton from "@/components/modules/NeonButton";
import type { IntakeInProgress, IntakeUpload } from "../fake-data";
import { count, RAIL_PANEL, RailHeading, Thumb, WANT_RING, WantFlag } from "./bits";
import { PanelLink } from "./panelLink";

/**
 * NEO-464 combined dashboard — In the Hopper. The dashboard holds only stats
 * worth a look and the things to do (Jason, 2026-11-13, NEO-539), so the
 * hopper is a run to finish per row (rules between them, no card in the
 * card), and one line of what got sorted:
 *
 *   7 scans need your yes · 1 to identify
 *   Unsorted → Inventory               ▯▯▯
 *   5 need your yes · 1 to identify          one row per run with a scan
 *   [Finish this run]                        still open, newest first
 *   ─────────────────────────────────────
 *   6 runs sorted this week · 42 all-time
 *
 * Each block's button opens the run on the Add cards tab that finishes it:
 * Collection for a run into a binder, Inventory for one into a box (Jason,
 * 2026-11-10). A sorted run is only a count here, never a row.
 */

/** The screen a run is finished on, as the shell's tab names it. */
const SIDE_SCREEN: Record<IntakeUpload["side"], string> = { collection: "Collection", inventory: "Inventory" };

/** A hand of up to three cards, fanned out from the middle: the tilts for a hand of one, two or three. */
const FAN_TILT = [["rotate-0"], ["-rotate-6", "rotate-6"], ["-rotate-6", "rotate-0", "rotate-6"]] as const;
const FAN_MAX = FAN_TILT.length;

/** Whether the hopper has anything to show: a scan to finish, or a run sorted this week. */
export function hopperShows(intake: IntakeInProgress): boolean {
  return intake.total > 0 || intake.sortedThisWeek > 0;
}

/** "5 need your yes", "1 to identify": the parts left, a zero part left out. With `noun`, the first number takes it: "7 scans need your yes". */
export function intakeCountParts(n: Pick<IntakeInProgress, "needsYou" | "unidentified">, noun?: string): string[] {
  const first = (k: number) => (noun ? count(k, noun) : String(k));
  const parts: string[] = [];
  if (n.needsYou > 0) parts.push(`${first(n.needsYou)} ${n.needsYou === 1 ? "needs" : "need"} your yes`);
  if (n.unidentified > 0) parts.push(`${parts.length > 0 ? n.unidentified : first(n.unidentified)} to identify`);
  return parts;
}

/**
 * "6 runs sorted this week", "42 all-time". A zero part is left out, and so
 * is an all-time count that says no more than the week does. A floor reads
 * "20+". Nothing to say: empty.
 */
export function sortedParts(intake: Pick<IntakeInProgress, "sortedThisWeek" | "sortedAllTime" | "sortedAllTimeMore">): string[] {
  const { sortedThisWeek: week, sortedAllTime: all, sortedAllTimeMore: more } = intake;
  const allText = `${all}${more ? "+" : ""}`;
  const showAll = all > 0 && (more || all > week);
  if (week > 0) return showAll ? [`${count(week, "run")} sorted this week`, `${allText} all-time`] : [`${count(week, "run")} sorted this week`];
  if (showAll) return [`${allText} ${all === 1 && !more ? "run" : "runs"} sorted all-time`];
  return [];
}

/**
 * Parts of one line, a dot between them on screen and a comma for a reader
 * (the dot is hidden, so the line is not read as "yes dot 18").
 */
function Parts({ parts }: { parts: readonly string[] }) {
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <>
              <span aria-hidden="true"> · </span>
              <span className="sr-only">, </span>
            </>
          )}
          {part}
        </Fragment>
      ))}
    </>
  );
}

/**
 * What tells apart open runs into homes of one name on one screen: when each
 * last moved, and where two moved at the same minute too, its place among
 * them ("Last scan 3:42 PM, run 2 of 2"). A run whose name is its own: null.
 */
export function runTells(uploads: readonly IntakeUpload[]): Map<string, string | null> {
  const groups = new Map<string, IntakeUpload[]>();
  for (const u of uploads) {
    const key = `${u.side}:${u.name}`;
    groups.set(key, [...(groups.get(key) ?? []), u]);
  }
  const tells = new Map<string, string | null>();
  for (const group of groups.values()) {
    group.forEach((u, i) => {
      if (group.length === 1) tells.set(u.id, null);
      else if (group.filter((o) => o.lastScan === u.lastScan).length === 1) tells.set(u.id, u.lastScan);
      else tells.set(u.id, `${u.lastScan}, run ${i + 1} of ${group.length}`);
    });
  }
  return tells;
}

export default function Hopper({ intake, wanted }: { intake: IntakeInProgress; wanted: Set<string> }) {
  if (!hopperShows(intake)) return null;
  const sorted = sortedParts(intake);
  const tells = runTells(intake.uploads);

  return (
    <section aria-labelledby="cb-hopper-heading" className={RAIL_PANEL}>
      <RailHeading id="cb-hopper-heading">In the Hopper</RailHeading>

      {intake.total > 0 && (
        <p className="text-sm font-bold text-ink">
          <Parts parts={intakeCountParts(intake, "scan")} />
        </p>
      )}

      {/* The runs and the stat line are parted by rules, not cards in the card. `rule-strong`: in dark,
          `rule` is the panel's own tone and the rule would vanish. */}
      {intake.uploads.length > 0 && (
        <ul aria-label="Runs to finish" className="mt-1 divide-y divide-rule-strong">
          {intake.uploads.map((u) => (
            <li key={u.id} className="py-3">
              <RunBlock upload={u} tell={tells.get(u.id) ?? null} wanted={wanted} />
            </li>
          ))}
        </ul>
      )}

      {sorted.length > 0 && (
        <p className={`text-xs text-ink-3 ${intake.uploads.length > 0 ? "border-t border-rule-strong pt-2.5" : ""}`}>
          <Parts parts={sorted} />
        </p>
      )}
    </section>
  );
}

/**
 * One run still open: its binder or box and the screen it is finished on,
 * what is left in it, a few of its best guesses, and the way in. Each guess
 * opens its card panel, as every card on the dashboard does, named by its
 * title, on the run's side: a box run's as stock for sale (its add form
 * offers boxes), a binder run's as a pull. The button reads "Finish this
 * run"; a reader also hears which run (and, for runs into homes of one name,
 * its `tell`), so every block's button and guess list has its own name.
 */
function RunBlock({ upload: u, tell, wanted }: { upload: IntakeUpload; tell: string | null; wanted: Set<string> }) {
  const screen = SIDE_SCREEN[u.side];
  const which = `${u.name} on ${screen}${tell ? `, ${tell.charAt(0).toLowerCase()}${tell.slice(1)}` : ""}`;
  const fan = u.guesses.slice(0, FAN_MAX);
  const fanIds = fan.map((c) => c.id);
  const wants = fan.some((c) => wanted.has(c.id));
  return (
    <div>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-base font-bold leading-snug text-ink">
            {u.name}{" "}
            <span className="whitespace-nowrap text-sm font-semibold text-ink-3">
              <span aria-hidden="true">→</span>
              <span className="sr-only">on</span> {screen}
            </span>
          </h3>
          {tell && <p className="text-xs tabular-nums text-ink-3">{tell}</p>}
          <p className="mt-1 text-sm tabular-nums text-ink-2">
            <Parts parts={intakeCountParts(u)} />
          </p>
          {wants && <WantFlag className="mt-1" />}
        </div>
        {fan.length > 0 && (
          <ul aria-label={`Best guesses for ${which}`} className="flex shrink-0 pt-0.5 pr-1">
            {fan.map((card, i) => (
              <li key={`${card.id}-${i}`} className={`-ml-2 first:ml-0 ${FAN_TILT[fan.length - 1][i]}`}>
                {/* p-2 -m-2: a bigger tap target, drawn the same size, so the fan keeps its shape. */}
                <PanelLink cardId={card.id} side={u.side} list={fanIds} className="-m-2 block rounded-md p-2 focus-outline">
                  <div className={wanted.has(card.id) ? WANT_RING : undefined}>
                    <Thumb card={card} className="w-8" />
                  </div>
                  <span className="sr-only">
                    {card.title}
                    {wanted.has(card.id) ? ", on your Want List" : ""}
                  </span>
                </PanelLink>
              </li>
            ))}
          </ul>
        )}
      </div>
      <NeonButton asChild className="mt-3 max-sm:min-h-11">
        <Link to={u.href}>
          Finish this run
          <span className="sr-only"> into {which}</span>
        </Link>
      </NeonButton>
    </div>
  );
}

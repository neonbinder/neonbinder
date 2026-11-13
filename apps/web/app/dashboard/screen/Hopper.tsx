import { Link } from "react-router";
import NeonButton from "@/components/modules/NeonButton";
import type { IntakeInProgress, IntakeUpload } from "../fake-data";
import { count, RAIL_PANEL, RailHeading, Thumb, WANT_RING, WantFlag } from "./bits";
import { PanelLink } from "./panelLink";

/**
 * NEO-464 combined dashboard — In the Hopper. The dashboard holds only stats
 * worth a look and the things to do (Jason, 2026-11-13, NEO-539), so the
 * hopper is a run to finish per block, and one line of what got sorted:
 *
 *   7 scans need your yes · 1 to identify
 *   ┌ Unsorted → Inventory ─────────────┐
 *   │ 5 need your yes · 1 to identify   │  one block per run with a scan
 *   │ [Finish this run]          ▯▯▯    │  still open, newest first
 *   └───────────────────────────────────┘
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

/** "5 need your yes · 1 to identify", a zero part left out. With `noun`, the first number takes it: "7 scans need your yes". */
export function intakeCounts(n: Pick<IntakeInProgress, "needsYou" | "unidentified">, noun?: string): string {
  const first = (k: number) => (noun ? count(k, noun) : String(k));
  const parts: string[] = [];
  if (n.needsYou > 0) parts.push(`${first(n.needsYou)} ${n.needsYou === 1 ? "needs" : "need"} your yes`);
  if (n.unidentified > 0) parts.push(`${parts.length > 0 ? n.unidentified : first(n.unidentified)} to identify`);
  return parts.join(" · ");
}

/**
 * "6 runs sorted this week · 42 all-time". A zero part is left out, and so is
 * an all-time count that says no more than the week does. A floor reads "20+".
 */
export function sortedLine(intake: Pick<IntakeInProgress, "sortedThisWeek" | "sortedAllTime" | "sortedAllTimeMore">): string | null {
  const { sortedThisWeek: week, sortedAllTime: all, sortedAllTimeMore: more } = intake;
  const allText = `${all}${more ? "+" : ""}`;
  const showAll = all > 0 && (more || all > week);
  if (week > 0) return showAll ? `${count(week, "run")} sorted this week · ${allText} all-time` : `${count(week, "run")} sorted this week`;
  if (showAll) return `${allText} ${all === 1 && !more ? "run" : "runs"} sorted all-time`;
  return null;
}

export default function Hopper({ intake, wanted }: { intake: IntakeInProgress; wanted: Set<string> }) {
  if (!hopperShows(intake)) return null;
  const sorted = sortedLine(intake);
  // Two open runs into homes of one name read apart by when each last moved.
  const names = new Map<string, number>();
  for (const u of intake.uploads) names.set(`${u.side}:${u.name}`, (names.get(`${u.side}:${u.name}`) ?? 0) + 1);

  return (
    <section aria-labelledby="cb-hopper-heading" className={RAIL_PANEL}>
      <RailHeading id="cb-hopper-heading">In the Hopper</RailHeading>

      {intake.total > 0 && <p className="text-sm font-bold text-ink">{intakeCounts(intake, "scan")}</p>}

      {intake.uploads.length > 0 && (
        <ul aria-label="Runs to finish" className="mt-3 flex flex-col gap-2.5">
          {intake.uploads.map((u) => (
            <li key={u.id}>
              <RunBlock upload={u} twin={(names.get(`${u.side}:${u.name}`) ?? 0) > 1} wanted={wanted} />
            </li>
          ))}
        </ul>
      )}

      {sorted && <p className={`text-xs text-ink-3 ${intake.uploads.length > 0 ? "mt-3 border-t border-rule pt-2.5" : ""}`}>{sorted}</p>}
    </section>
  );
}

/**
 * One run still open: its binder or box and the screen it is finished on,
 * what is left in it, a few of its best guesses, and the way in. Each guess
 * opens its card panel, as every card on the dashboard does, named by its
 * title. The button reads "Finish this run"; a reader also hears which run,
 * so every block's button has its own name.
 */
function RunBlock({ upload: u, twin, wanted }: { upload: IntakeUpload; twin: boolean; wanted: Set<string> }) {
  const screen = SIDE_SCREEN[u.side];
  const when = twin ? `, ${u.lastScan.charAt(0).toLowerCase()}${u.lastScan.slice(1)}` : "";
  const fan = u.guesses.slice(0, FAN_MAX);
  const fanIds = fan.map((c) => c.id);
  const wants = fan.some((c) => wanted.has(c.id));
  return (
    <div className="rounded-xl border border-rule bg-raised-deep p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-base font-bold leading-snug text-ink">
            {u.name}{" "}
            <span className="whitespace-nowrap text-sm font-semibold text-ink-3">
              <span aria-hidden="true">→</span>
              <span className="sr-only">on</span> {screen}
            </span>
          </h3>
          {twin && <p className="text-xs tabular-nums text-ink-3">{u.lastScan}</p>}
          <p className="mt-1 text-sm tabular-nums text-ink-2">{intakeCounts(u)}</p>
          {wants && <WantFlag className="mt-1" />}
        </div>
        {fan.length > 0 && (
          <ul aria-label="Best guesses waiting on your yes" className="flex shrink-0 pt-0.5 pr-1">
            {fan.map((card, i) => (
              <li key={`${card.id}-${i}`} className={`-ml-2 first:ml-0 ${FAN_TILT[fan.length - 1][i]}`}>
                <PanelLink
                  cardId={card.id}
                  side="collection"
                  list={fanIds}
                  className={`block rounded-[6%] focus-outline ${wanted.has(card.id) ? WANT_RING : ""}`}
                >
                  <Thumb card={card} className="w-8" />
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
          <span className="sr-only">
            {" "}
            into {u.name} on {screen}
            {when}
          </span>
        </Link>
      </NeonButton>
    </div>
  );
}

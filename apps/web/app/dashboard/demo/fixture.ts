import { useMemo } from "react";
import { dashCard, getDashboard, type DashboardData, type DashCard } from "../fake-data";

/**
 * The demo's fake dashboard: the fake collector's data (`../fake-data`) plus
 * one demo-only extra, so the Want List highlight has something to show: a
 * scan in the hopper whose best guess is a Want List card (Deion Sanders,
 * 1996 Playoff Contenders #13), waiting on a yes. It came in with "Show
 * pickups", so that upload counts one more scan.
 *
 * The card is one the demo's catalog holds and the collector does not own
 * yet, so its panel agrees: on the Want List, no copy. No pull matches the
 * Want List here, since a pull the panel showed as owned and still wanted
 * would be a story the demo store does not tell. The real screen gets its
 * matches from the account's data, so this file goes with the fake data.
 */

/** A card of the Want List, by player and card number: exactly one, or none (a number is never a key alone). */
function findWant(data: DashboardData, player: string, cardNumber: string): DashCard | null {
  const hits = data.wantList.filter((w) => w.player === player && w.cardNumber === cardNumber);
  return hits.length === 1 ? dashCard(hits[0].id) : null;
}

function withWantMatches(data: DashboardData): DashboardData {
  const scan = findWant(data, "Deion Sanders", "13");
  if (scan === null) return data;
  const intake = {
    ...data.intake,
    total: data.intake.total + 1,
    needsYou: data.intake.needsYou + 1,
    uploads: data.intake.uploads.map((u) => (u.id === "upload-show" ? { ...u, scans: u.scans + 1 } : u)),
    preview: [{ id: "scan-want", guess: scan }, ...data.intake.preview],
  };
  return { ...data, intake };
}

/** The demo dashboard: every section the demo collector's data fills. */
export function useDemoDashboard(): DashboardData {
  return useMemo(() => withWantMatches(getDashboard()), []);
}

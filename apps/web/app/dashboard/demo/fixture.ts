import { useMemo } from "react";
import { dashCard, getDashboard, type AddedCard, type DashboardData, type DashCard } from "../fake-data";

/**
 * The demo's fake dashboard: the fake collector's data (`../fake-data`) plus
 * two demo-only extras, so the Want List highlight has something to show.
 * The shared fake data has no pull and no scan that is on the Want List:
 *
 * - a scan in the hopper whose best guess is a Want List card (Deion Sanders,
 *   1996 Playoff Contenders #13), waiting on a yes; it came in with
 *   "Show pickups", so that upload counts one more scan;
 * - a Want List card in today's pulls (Mike Trout, 2024 Topps Chrome #12),
 *   filed in Main.
 *
 * Both are cards the demo's catalog holds. The real screen gets its matches
 * from the account's data, so this file goes with the fake data.
 */

/** A card of the Want List, by player and card number: exactly one, or none (a number is never a key alone). */
function findWant(data: DashboardData, player: string, cardNumber: string): DashCard | null {
  const hits = data.wantList.filter((w) => w.player === player && w.cardNumber === cardNumber);
  return hits.length === 1 ? dashCard(hits[0].id) : null;
}

function withWantMatches(data: DashboardData): DashboardData {
  const scan = findWant(data, "Deion Sanders", "13");
  const pull = findWant(data, "Mike Trout", "12");

  const intake =
    scan === null
      ? data.intake
      : {
          ...data.intake,
          total: data.intake.total + 1,
          needsYou: data.intake.needsYou + 1,
          uploads: data.intake.uploads.map((u) => (u.id === "upload-show" ? { ...u, scans: u.scans + 1 } : u)),
          preview: [{ id: "scan-want", guess: scan }, ...data.intake.preview],
        };

  const additions =
    pull === null
      ? data.additions
      : data.additions.map((b, i) => {
          if (i !== 0) return b;
          const added: AddedCard = { ...pull, binderName: "Main" };
          return {
            ...b,
            cards: [added, ...b.cards],
            binders: b.binders.map((x) => (x.name === "Main" ? { ...x, count: x.count + 1 } : x)),
          };
        });

  return { ...data, intake, additions };
}

/** The demo dashboard: every section filled. */
export function useDemoDashboard(): DashboardData {
  return useMemo(() => withWantMatches(getDashboard()), []);
}

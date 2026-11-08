import { useMemo } from "react";
import { dashCard, type AddedCard, type DashboardData, type DashCard } from "../_shared/data";
import { useDashboard } from "../_shared/persona";

/**
 * NEO-464 combined dashboard — the shared fixture plus two demo-only extras,
 * so the Want List highlight (Jason, review item 5) has something to show.
 * The shared fixture has no pull and no scan that is on the Want List, and
 * the other five prototypes read it, so the extras live here, not there:
 *
 * - a scan in the hopper whose best guess is a Want List card (Deion Sanders,
 *   1996 Playoff Contenders #13), waiting on a yes; it came in with
 *   "Show pickups", so that upload counts one more scan;
 * - a Want List card in today's pulls (Mike Trout, 2024 Topps Chrome #12),
 *   filed in Main.
 *
 * Both are cards the demo's catalog holds; nothing else changes.
 */

/** Cards of the Want List, by demo card id, for the highlight. */
export function wantIds(data: DashboardData): Set<string> {
  return new Set(data.wantList.map((w) => w.id));
}

function findWant(data: DashboardData, player: string, cardNumber: string): DashCard | null {
  const hits = data.wantList.filter((w) => w.player === player && w.cardNumber === cardNumber);
  // Exactly one, or none: a card number is never a key on its own.
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

/** The dashboard for the persona in the URL, with the demo's Want List matches. */
export function useCombinedDashboard(): DashboardData {
  const base = useDashboard();
  return useMemo(() => withWantMatches(base), [base]);
}

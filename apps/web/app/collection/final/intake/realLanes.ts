import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { IntakeReason } from "@/convex/lib/intakeMatch";

/**
 * NEO-382 — the signed-in intake screen's lanes, worked out from the three
 * live reads it subscribes to: the placeholder job's images and pairs, and the
 * run's matches. Pure, so the stage rules are tested without Convex.
 *
 * Every photo is in exactly one lane, left to right as the pipeline works:
 *
 *   Reading:  uploaded, not cropped and read yet;
 *   Pairing:  read (or failed) and not in a pair: the loose pile;
 *   Matching: in a pair the matcher has not answered yet;
 *   Needs you: matched (or not), waiting for the collector;
 *   Saved:    saved by the collector. A pair set aside sits apart.
 */

export type IntakeImage = FunctionReturnType<typeof api.placeholderPipeline.listPlaceholderImages>[number];
export type IntakePair = FunctionReturnType<typeof api.placeholderPipeline.listPlaceholderPairs>[number];
export type IntakeMatchRow = FunctionReturnType<typeof api.intakeRuns.listIntakeMatches>[number];
export type CardSummary = IntakeMatchRow["candidates"][number];

/** What was read off a pair: the number and the names, either side. */
export interface PairRead {
  number: string | null;
  players: string[];
}

export interface Lanes {
  reading: IntakeImage[];
  loose: IntakeImage[];
  matching: IntakePair[];
  review: IntakeMatchRow[];
  saved: IntakeMatchRow[];
  setAside: IntakeMatchRow[];
}

export const EMPTY_LANES: Lanes = { reading: [], loose: [], matching: [], review: [], saved: [], setAside: [] };

const pairKey = (frontIndex: number, backIndex: number) => `${frontIndex}-${backIndex}`;

export function laneOf(images: IntakeImage[], pairs: IntakePair[], matches: IntakeMatchRow[]): Lanes {
  const paired = new Set<number>();
  for (const p of pairs) {
    paired.add(p.frontIndex);
    paired.add(p.backIndex);
  }
  const answered = new Set(matches.map((m) => pairKey(m.frontIndex, m.backIndex)));
  const byIndex = (a: IntakeImage, b: IntakeImage) => a.entryIndex - b.entryIndex;
  return {
    reading: images.filter((i) => i.status !== "done" && i.status !== "failed").sort(byIndex),
    loose: images
      .filter((i) => (i.status === "done" || i.status === "failed") && !paired.has(i.entryIndex))
      .sort(byIndex),
    matching: pairs
      .filter((p) => !answered.has(pairKey(p.frontIndex, p.backIndex)))
      .sort((a, b) => a.frontIndex - b.frontIndex),
    review: matches.filter((m) => m.savedAt === undefined && !m.setAside),
    saved: matches.filter((m) => m.savedAt !== undefined).sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0)),
    setAside: matches.filter((m) => m.savedAt === undefined && m.setAside),
  };
}

/** What preprocess read off a pair's two photos, front first. */
export function readOf(images: Map<number, IntakeImage>, frontIndex: number, backIndex: number): PairRead {
  const front = images.get(frontIndex);
  const back = images.get(backIndex);
  const players = [...(front?.players ?? []), ...(back?.players ?? [])].filter(
    (p, i, all) => all.indexOf(p) === i,
  );
  return { number: back?.cardNumber ?? front?.cardNumber ?? null, players };
}

/** "#47 Le'Veon Bell", with the variation when it has one. */
export function cardLabel(card: CardSummary | null | undefined): string {
  if (!card) return "No card picked";
  return `#${card.cardNumber} ${card.cardName}${card.variation ? ` (${card.variation})` : ""}`;
}

/** Why the matcher decided what it did, in a collector's words. */
export function reasonText(row: Pick<IntakeMatchRow, "reason" | "candidates">, read: PairRead): string {
  const number = read.number ? `#${read.number}` : "no number";
  const reasons: Record<IntakeReason, string> = {
    numberAndPlayer: "The number and the player both match.",
    numberOnly: "Matched on the number. No player was read, so check the name.",
    playerUnconfirmed: `The number matches, but the name read (${read.players.join(", ") || "none"}) is on no card in this set.`,
    numberPlayerConflict: `The number reads ${number}, but the name reads ${read.players.join(", ")}. One of them is misread: check which card this is.`,
    numberSharedPlayerPicked: `More than one card is ${number}. The player picked this one.`,
    numberShared: `More than one card is ${number}. Pick the right one.`,
    numberFuzzy: `The number only matched after reading look-alike characters (O as 0, I as 1). Check it.`,
    playerOnly: `No card in this set is ${number}. Matched on the player.`,
    playerShared: `No card in this set is ${number}, and the player is on more than one card. Pick one.`,
    noMatch: "Nothing in this set matches what was read.",
    nothingRead: "Couldn't read a number or a player off this card.",
    noVariant: "Pick the set above and this card is matched in it.",
    byUser: "You picked this card.",
  };
  return reasons[row.reason];
}

/** The line's count once saved: what is already here, plus this scan. */
export function proposedCount(row: Pick<IntakeMatchRow, "haveHere">): number {
  return row.haveHere + 1;
}

/**
 * NEO-350 / NEO-358 / NEO-359 — how a line item (one Copy: a stack of
 * identical cards, or a one of a kind slab) reads on a row and in a
 * control's name.
 *
 * A copy has one home (a binder, or a box: for sale). The visible summary
 * names it; a control's name leaves it out unless two of a card's lines would
 * otherwise read the same, so "Have #4 Reggie White, Raw" stays the name of a
 * one-line card wherever it lives.
 */

import type { Copy } from "./data/types";

/** A home as far as a line item names it: a container off the shelf. */
export interface NamedBinder {
  id: string;
  name: string;
  system?: string;
}

/** A line item as these read it: a `Copy`, or details on their way in (the add form's). */
export type LineCopy = Pick<Copy, "quantity" | "graded" | "condition" | "serialNumber"> &
  Partial<Pick<Copy, "homeId" | "homeName" | "homeKind" | "upForTrade">>;

/** "PSA 10", "Raw, Mint", "Raw": the grade or the condition. */
export function gradeText(copy: Pick<Copy, "graded" | "condition">): string {
  if (copy.graded) return `${copy.graded.grader} ${copy.graded.grade || "?"}`.trim();
  return copy.condition ? `Raw, ${copy.condition}` : "Raw";
}

/** "Raw, Mint ×5" or "PSA 10 · 23/50": what the line is, without where it lives. */
export function lineWhat(copy: LineCopy): string {
  const parts = [`${gradeText(copy)}${copy.quantity > 1 ? ` ×${copy.quantity}` : ""}`];
  if (copy.serialNumber) parts.push(copy.serialNumber);
  return parts.join(" · ");
}

/**
 * Where a line item lives: the name the store hands with it, else the home
 * looked up on the shelf (`homes`), else "" (not known yet).
 */
export function binderText(copy: LineCopy, homes?: readonly NamedBinder[]): string {
  if (copy.homeName) return copy.homeName;
  if (copy.homeId && homes) return homes.find((h) => h.id === copy.homeId)?.name ?? "";
  return "";
}

/** "Raw, Mint ×5 · Main" or "PSA 10 · 23/50 · Show box". */
export function lineSummary(copy: LineCopy, homes?: readonly NamedBinder[]): string {
  const where = binderText(copy, homes);
  return where ? `${lineWhat(copy)} · ${where}` : lineWhat(copy);
}

/**
 * One name per line item of a card, distinct from its siblings so every
 * control on the row reads differently: what the line is; then, only where
 * two lines would read the same, where it lives; then, if they still match,
 * its place in the list.
 */
export function lineNames(copies: readonly LineCopy[], homes?: readonly NamedBinder[]): string[] {
  const unique = (names: string[], i: number) => names.indexOf(names[i]) === names.lastIndexOf(names[i]);
  const what = copies.map((c) => lineWhat(c).replace(/ · /g, ", "));
  const placed = what.map((name, i) => {
    if (unique(what, i)) return name;
    const where = binderText(copies[i], homes);
    return where ? `${name}, in ${where}` : name;
  });
  return placed.map((name, i) => (unique(placed, i) ? name : `${name}, line ${i + 1}`));
}

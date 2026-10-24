/**
 * NEO-350 / NEO-358 — how a line item (one Copy: a stack of identical cards,
 * or a one of a kind slab) reads on a row and in a control's name.
 */

import type { Copy } from "./data/types";

/** A binder as far as a line item names it (the demo's filing). */
export interface NamedBinder {
  id: string;
  name: string;
  system?: string;
}

/**
 * A line item as these read it: the view model's `Copy`, or the demo
 * reducer's own copy (My Binders still hands those in), which carries its
 * binders as `binderIds`.
 */
export type LineCopy = Pick<Copy, "quantity" | "graded" | "condition" | "serialNumber"> &
  Partial<Pick<Copy, "homeName" | "demo">> & { binderIds?: string[] };

/** "PSA 10", "Raw, Mint", "Raw": the grade or the condition. */
export function gradeText(copy: Pick<Copy, "graded" | "condition">): string {
  if (copy.graded) return `${copy.graded.grader} ${copy.graded.grade || "?"}`.trim();
  return copy.condition ? `Raw, ${copy.condition}` : "Raw";
}

/**
 * Where a line item lives. In the demo, its binders: Up for Trade has its own
 * toggle on the row, so it is left out unless it is the only binder. In the
 * real collection, its one home when the store names it.
 */
export function binderText(copy: LineCopy, binders?: readonly NamedBinder[]): string {
  const ids = copy.demo?.binderIds ?? copy.binderIds;
  if (ids && binders) {
    const named = ids.map((id) => binders.find((b) => b.id === id)).filter((b): b is NamedBinder => !!b);
    const shown = named.filter((b) => b.system !== "trade");
    return (shown.length > 0 ? shown : named).map((b) => b.name).join(", ");
  }
  return copy.homeName ?? "";
}

/** "Raw, Mint ×5 · Main" or "PSA 10 · 23/50 · Slab case". */
export function lineSummary(copy: LineCopy, binders?: readonly NamedBinder[]): string {
  const parts = [`${gradeText(copy)}${copy.quantity > 1 ? ` ×${copy.quantity}` : ""}`];
  if (copy.serialNumber) parts.push(copy.serialNumber);
  const where = binderText(copy, binders);
  if (where) parts.push(where);
  return parts.join(" · ");
}

/**
 * One name per line item of a card, distinct from its siblings so every
 * control on the row reads differently: the summary, with the line's place
 * added only when two lines would otherwise read the same.
 */
export function lineNames(copies: readonly LineCopy[], binders?: readonly NamedBinder[]): string[] {
  const base = copies.map((c) => lineSummary(c, binders).replace(/ · /g, ", "));
  return base.map((name, i) => (base.indexOf(name) === base.lastIndexOf(name) ? name : `${name}, line ${i + 1}`));
}

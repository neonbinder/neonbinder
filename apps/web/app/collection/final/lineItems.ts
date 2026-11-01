/**
 * NEO-350 — how a line item (one Copy: a stack of identical cards, or a one
 * of a kind slab) reads on a row and in a control's name.
 */

import type { Copy } from "../prototypes/_shared/data";
import type { CollectionBinder } from "./store";

/** "PSA 10", "Raw, Mint", "Raw": the grade or the condition. */
export function gradeText(copy: Copy): string {
  if (copy.graded) return `${copy.graded.grader} ${copy.graded.grade || "?"}`.trim();
  return copy.condition ? `Raw, ${copy.condition}` : "Raw";
}

/**
 * The binders a line item shows. Up for Trade has its own toggle on the row,
 * so it is left out unless it is the only binder.
 */
export function binderText(copy: Copy, binders: CollectionBinder[]): string {
  const named = copy.binderIds
    .map((id) => binders.find((b) => b.id === id))
    .filter((b): b is CollectionBinder => !!b);
  const shown = named.filter((b) => b.system !== "trade");
  return (shown.length > 0 ? shown : named).map((b) => b.name).join(", ");
}

/** "Raw, Mint ×5 · Main" or "PSA 10 · 23/50 · Slab case". */
export function lineSummary(copy: Copy, binders: CollectionBinder[]): string {
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
export function lineNames(copies: Copy[], binders: CollectionBinder[]): string[] {
  const base = copies.map((c) => lineSummary(c, binders).replace(/ · /g, ", "));
  return base.map((name, i) =>
    base.indexOf(name) === base.lastIndexOf(name) ? name : `${name}, line ${i + 1}`,
  );
}

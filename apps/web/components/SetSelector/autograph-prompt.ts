import {
  AUTOGRAPH_FORMATS,
  carriesAutographToken,
  isAutographFormat,
  type AutographFormat,
} from "../../convex/features/deriveCardFeatures";

/**
 * NEO-345 — the checklist header's "how are these autographs signed?" prompt,
 * as pure rules and words in one React-free module.
 *
 * The prompt (`AutographFormatPrompt` in `AutographFormatStep.tsx`) shows on
 * a stored leaf (Base, insert or parallel) that has no
 * `features.autographFormat` while at least one of its cards carries the "AU"
 * attribute and is still marked `autographed` "None". The set-build tool
 * (`tools/setbuild/lib/attention.ts`) lists the same leaves with the same
 * count and the same line, so the rule and the words live here and both
 * sides import them, as `attention-rules.ts` does for the walker. One copy,
 * nothing to drift.
 *
 * Keep it pure: no React, no `convex/react`, no `@/` paths (the set-build
 * tool's tsconfig has no `@/` alias).
 */

export { AUTOGRAPH_FORMATS, type AutographFormat };

/**
 * The two answers' display names, keyed by the stored value — the wizard's
 * tiles, the checklist prompt's buttons and Set details' select all say
 * these words (NEO-345 a11y: one name per answer everywhere).
 */
export const AUTOGRAPH_CHOICE_LABEL: Readonly<Record<AutographFormat, string>> = {
  "On Card": "On card",
  "Sticker/Label": "Sticker",
};

/** A stored value read back as one of the two answers (anything else is none). */
export function asAutographFormat(value: string | undefined | null): AutographFormat | undefined {
  return isAutographFormat(value) ? value : undefined;
}

/** Does this attribute list carry the autograph token? Case-folded, trimmed. */
export function carriesAutograph(attributes: readonly string[] | undefined): boolean {
  return carriesAutographToken(attributes);
}

/** The checklist header's one line, for a stored leaf. */
export function autographPromptLine(count: number): string {
  return count === 1
    ? "1 autographed card — on card or sticker?"
    : `${count} autographed cards — on card or sticker?`;
}

/** What the header line says once the answer is saved. */
export function autographPromptSaved(value: AutographFormat): string {
  return `Autographs saved as ${AUTOGRAPH_CHOICE_LABEL[value].toLowerCase()}.`;
}

/**
 * Said after the saved line when the answer also reached the row's parallels
 * (Jason, 2026-10-18: an insert's or the Base's answer lands on each of its
 * parallels with no format of its own). `count` is how many the server says
 * it reached; nothing is said for none.
 */
export function autographPromptParallels(count: number): string {
  return count === 1 ? "Its parallel takes the same answer." : `Its ${count} parallels take the same answer.`;
}

/** What the prompt reads off a stored card (a `getCardChecklist` row fits). */
export interface AutographPromptCard {
  attributes?: readonly string[];
  features?: { readonly autographed?: string };
}

/** One stored card the prompt counts: it carries "AU" and is still marked not autographed (absent is "None"). */
export function isUnformattedAutograph(attributes: readonly string[] | undefined, autographed: string | undefined): boolean {
  return carriesAutograph(attributes) && (autographed ?? "None") === "None";
}

/** Stored cards carrying "AU" still marked not autographed. */
export function countUnformattedAutographs(cards: readonly AutographPromptCard[]): number {
  return cards.filter((card) => isUnformattedAutograph(card.attributes, card.features?.autographed)).length;
}

/**
 * Does the header ask? Only while the leaf has no format, and only when an
 * autographed card is still marked "None". The host adds its own session
 * conditions (the leaf row has loaded, no sync preview is open).
 */
export function autographPromptAsks(leafFormat: string | undefined | null, unformattedCount: number): boolean {
  return asAutographFormat(leafFormat) === undefined && unformattedCount > 0;
}

/**
 * How many cards the header prompt asks about: the unformatted autographs
 * while it asks, 0 (no prompt) otherwise. What the set-build tool lists.
 */
export function autographPromptCount(
  leafFormat: string | undefined | null,
  cards: readonly AutographPromptCard[],
): number {
  const count = countUnformattedAutographs(cards);
  return autographPromptAsks(leafFormat, count) ? count : 0;
}

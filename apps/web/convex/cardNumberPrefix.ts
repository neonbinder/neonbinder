/**
 * NEO-291 — the ONE rule for `selectorOptions.metadata.cardNumberPrefix`.
 *
 * The prefix is the few characters a marketplace puts in front of a card
 * number ("DK-" for Diamond Kings, "SP-", "T-"); the checklist sync strips it
 * with `startsWith` so NB's card number is the bare number. Two doors write
 * it — the attributes panel's `setSelectorOptionCardNumberPrefix` and the
 * reconciliation modal via `storeReconciledOptions` — and the security audit
 * on this ticket found them applying two rules (one validated, one merely
 * trimmed). This module is the rule; both doors call it.
 *
 * Pure and dependency-light on purpose (a `ConvexError` import only) so the
 * unit tests can hit it directly and neither Convex file grows a copy.
 */

import { ConvexError } from "convex/values";

/**
 * Ceiling on a prefix. Nothing legitimate approaches it; a longer string is
 * a paste of the wrong field.
 */
export const MAX_CARD_NUMBER_PREFIX_LENGTH = 32;

/**
 * Trim `raw` and return the prefix to store, or `undefined` when the operator
 * cleared it — `""` is never stored (the NEO-217 spelling `features` uses).
 *
 * Throws a STRING `ConvexError` — the shape `userFacingMessage` shows
 * verbatim — for a prefix carrying a line break, a control character or an
 * invisible character (the same classes `checkSelectorValue` refuses in a
 * row name, for the same reason: a prefix nothing renders never matches a
 * marketplace card number and cannot be seen to be wrong), or one over the
 * ceiling.
 */
export function normalizeCardNumberPrefix(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
    throw new ConvexError(
      "A card prefix cannot contain line breaks or control characters.",
    );
  }
  if (/[​-‍⁠﻿]/.test(trimmed)) {
    throw new ConvexError(
      "A card prefix cannot contain zero-width or invisible characters.",
    );
  }
  if (trimmed.length > MAX_CARD_NUMBER_PREFIX_LENGTH) {
    throw new ConvexError(
      `A card prefix is at most ${MAX_CARD_NUMBER_PREFIX_LENGTH} characters.`,
    );
  }
  return trimmed;
}

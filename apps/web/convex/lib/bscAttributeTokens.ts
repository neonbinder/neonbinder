/**
 * NEO-345 — BSC attribute tokens, read into NB's own attribute vocabulary.
 *
 * BSC tags a card with short tokens in `playerAttribute` ("AU, SN25",
 * "RC, SP", "AU, MEM, SN49, EXCH"). They used to be stored raw, so a numbered
 * card carried "SN25" instead of NB's `NUM` + `printRun: 25`, and a
 * memorabilia card carried "MEM" without ever becoming a relic. This module is
 * the one reading of those tokens, shared by every BSC parse site (the bulk
 * catalogue, the per-card `card-listing` lookup) and by the stored-row fill
 * (`cardChecklist.applyBscAttributeFill`).
 *
 * It lives in `convex/lib/` rather than in `adapters/buysportscards.ts`
 * because that adapter is a `"use node"` file, which a default-runtime
 * mutation cannot import. The adapter re-exports it.
 *
 * WHAT IT NEVER DOES: decide an autograph's FORMAT. `AU` says only "this card
 * is signed"; whether on card or on a sticker is NB data the operator supplies
 * per synced leaf (`autographFormat`), because no marketplace tells us.
 */

/**
 * The tokens this module knows. `SN<n>` and `1/1` are matched by pattern;
 * this set is the rest. Used to recognise a BSC "team" value that is really
 * the attribute label ("AU  SN1"), so it is never offered as a team.
 *
 * `FY` (First Year) and `EXCH` (Exchange Card) were seen live on the
 * card-listing endpoint; they are kept raw like every token without an NB
 * meaning, and listed here only so a label made of them is recognised.
 */
const KNOWN_BSC_ATTRIBUTE_TOKENS = new Set([
  "AU",
  "RC",
  "SP",
  "SSP",
  "RELIC",
  "MEM",
  "JSY",
  "JERSEY",
  "PATCH",
  "VAR",
  "UER",
  "IA",
  "BP",
  "ASR",
  "FBC",
  "MGR",
  "HC",
  "PC",
  "FY",
  "EXCH",
  // NB's own canonical tokens, so an already-normalised list reads as one.
  "NUM",
]);

/** Tokens that become NB's `RELIC` (and `isRelic`). Mirrors SportLots. */
const RELIC_TOKENS = new Set(["RELIC", "MEM", "JSY", "JERSEY", "PATCH"]);

/** Tokens kept under their canonical upper-case spelling. */
const CANONICAL_TOKENS = new Set(["AU", "RC", "SP", "SSP", "VAR", "UER", "NUM"]);

/** A print run is a positive whole number no larger than this. */
export const MAX_BSC_PRINT_RUN = 1_000_000;

/**
 * Bounds on an UNTRUSTED token list before it is read or stored. A token
 * longer than this is not an attribute anybody wrote; a list longer than this
 * is not one card's tags. Over either bound the token (or the whole list) is
 * dropped, never truncated.
 */
export const MAX_BSC_ATTRIBUTE_TOKEN_LENGTH = 32;
export const MAX_BSC_ATTRIBUTE_TOKENS = 24;

const SN_PATTERN = /^SN\s*(\d{1,7})$/i;
const ONE_OF_ONE_PATTERN = /^1\s*\/\s*1$/;

/** `n` when `token` is a print-run token (`SN<n>` or `1/1`), else undefined. */
export function printRunFromToken(token: string): number | undefined {
  const trimmed = token.trim();
  if (ONE_OF_ONE_PATTERN.test(trimmed)) return 1;
  const m = trimmed.match(SN_PATTERN);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > MAX_BSC_PRINT_RUN) return undefined;
  return n;
}

/**
 * Trim, drop blanks and over-long tokens, and refuse an over-long list.
 * Returns `refused: true` when the list was dropped whole.
 */
export function boundBscAttributeTokens(tokens: ReadonlyArray<unknown>): {
  tokens: string[];
  refused: boolean;
} {
  if (tokens.length > MAX_BSC_ATTRIBUTE_TOKENS) {
    return { tokens: [], refused: true };
  }
  const out: string[] = [];
  for (const raw of tokens) {
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    if (!t || t.length > MAX_BSC_ATTRIBUTE_TOKEN_LENGTH) continue;
    out.push(t);
  }
  return { tokens: out, refused: false };
}

export type NormalizedBscAttributes = {
  attributes: string[];
  printRun?: number;
};

/**
 * `normalizeBscAttributeTokens` plus the raw tokens that carried the print
 * run, so a caller that finds a DIFFERENT print run already on a row can keep
 * BSC's own token beside `NUM` for the operator to see.
 */
export function normalizeBscAttributeTokensDetailed(
  tokens: ReadonlyArray<string>,
): NormalizedBscAttributes & { printRunTokens: string[] } {
  const attributes: string[] = [];
  const seen = new Set<string>();
  const push = (token: string) => {
    const key = token.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    attributes.push(token);
  };

  const printRunTokens: string[] = [];
  const printRuns = new Set<number>();
  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;
    const upper = token.toUpperCase();
    const n = printRunFromToken(token);
    if (n !== undefined) {
      printRuns.add(n);
      printRunTokens.push(token);
      continue;
    }
    if (RELIC_TOKENS.has(upper)) {
      push("RELIC");
      continue;
    }
    if (CANONICAL_TOKENS.has(upper)) {
      push(upper);
      continue;
    }
    // IA, BP, ASR, FBC, MGR, HC, PC, FY, EXCH and anything unknown: kept as
    // BSC wrote it, never dropped.
    push(token);
  }

  if (printRuns.size === 1) {
    push("NUM");
    return {
      attributes,
      printRun: [...printRuns][0],
      printRunTokens,
    };
  }
  if (printRuns.size > 1) {
    // BSC named two different print runs for one card. NUM is still true
    // (it IS numbered), but which run is unknowable here: no print run is
    // set, and BSC's tokens are kept beside NUM for the operator.
    push("NUM");
    for (const t of printRunTokens) push(t);
    return { attributes, printRunTokens };
  }
  return { attributes, printRunTokens };
}

/**
 * Read BSC attribute tokens into NB's attribute vocabulary. Pure; case-folded.
 *
 * - `SN<n>` (1..1,000,000) and `1/1` -> `NUM` (replacing the raw token),
 *   `printRun = n`.
 * - `AU` -> `AU`. The FORMAT never comes from here (see the module note).
 * - `RC` -> `RC` (the row's `isRookie`); `SP`/`SSP` kept (shortPrint is
 *   derived from them downstream).
 * - `RELIC`/`MEM`/`JSY`/`JERSEY`/`PATCH` -> `RELIC` (the row's `isRelic`).
 * - `VAR`, `UER` kept; every other token (IA, BP, ASR, FBC, MGR, HC, PC,
 *   unknown) kept raw, never dropped.
 *
 * Idempotent: a normalised list normalises to itself (with no print run,
 * since `NUM` carries none).
 */
export function normalizeBscAttributeTokens(
  tokens: ReadonlyArray<string>,
): NormalizedBscAttributes {
  const { attributes, printRun } = normalizeBscAttributeTokensDetailed(tokens);
  return printRun === undefined ? { attributes } : { attributes, printRun };
}

/** Split a label or attribute string into its tokens (whitespace or comma). */
function labelTokens(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Is BSC's `teamName` really the card's attribute LABEL rather than a team?
 *
 * Seen live: a card whose `playerAttribute` is empty and whose `teamName` is
 * "AU  SN1" (two spaces). True when the value's tokens are exactly the
 * payload's own attribute tokens, or when every token in it is an attribute
 * token this module knows. A real team name ("Seattle Mariners") fails both.
 */
export function isBscAttributeLabel(
  teamName: string,
  payloadTokens: ReadonlyArray<string>,
): boolean {
  const parts = labelTokens(teamName);
  if (parts.length === 0) return false;
  const upper = parts.map((p) => p.toUpperCase());
  const payload = payloadTokens
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  if (payload.length > 0) {
    const a = [...new Set(upper)].sort();
    const b = [...new Set(payload)].sort();
    if (a.length === b.length && a.every((t, i) => t === b[i])) return true;
  }
  return parts.every(
    (p) =>
      KNOWN_BSC_ATTRIBUTE_TOKENS.has(p.toUpperCase()) ||
      printRunFromToken(p) !== undefined,
  );
}

/** The label's tokens, for a card whose attributes arrived only as a label. */
export function bscAttributeLabelTokens(teamName: string): string[] {
  return labelTokens(teamName);
}

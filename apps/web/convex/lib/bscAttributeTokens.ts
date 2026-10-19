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
  // A serial number with no print run ("AU, SN" on a dual autograph's
  // productName). Not a print run, so normalising keeps it raw, as it always
  // has; listed so a label or a productName run made of it is recognised.
  "SN",
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

/**
 * A `productName` longer than this is not one card's title; it is not read.
 * Dropped, never truncated, like every other bound in this module.
 */
export const MAX_BSC_PRODUCT_NAME_LENGTH = 512;

const ZERO_WIDTH = /[​-‍﻿]/g;

/**
 * The comma-joined run of upper-case words at the end of the text before
 * `#<cardNo>`. The first word follows whitespace (it is attached to the last
 * player name by a space); the rest follow commas. Case-sensitive on purpose:
 * BSC writes its tokens upper case, and a mixed-case word ("Au", "Sn",
 * "Harper") can never start or join the run.
 */
const PRODUCT_NAME_TOKEN_RUN = /(?:^|\s)([A-Z0-9/]+(?:\s*,\s*[A-Z0-9/]+)*)\s*$/;

/** A word this module knows as an attribute token, exactly as BSC writes it. */
function isProductNameToken(word: string): boolean {
  if (word === "NUM") return false;
  return (
    KNOWN_BSC_ATTRIBUTE_TOKENS.has(word) || printRunFromToken(word) !== undefined
  );
}

/**
 * NEO-339 (Jason: "yes read AU from product name") — the attribute tokens in
 * BSC's per-card `productName`, for a card whose `playerAttribute` is empty.
 *
 * Seen live on dual-autograph inserts (2024 Topps Chrome Black "Pitch Black
 * Pairings Dual Autographs", 2025 Bowman Draft "Prospect Dual Autographs"):
 * `playerAttribute` is "" while `productName` reads
 * "Gerrit Cole / Andy Pettitte AU, SN #PBDA-CP" or "... AU, SN99 #...". The
 * tokens are the comma-separated run between the player names and the
 * `#<cardNo>` suffix.
 *
 * Strict, because the rest of the string is player names:
 * - no `#<cardNo>` suffix (a `#` after whitespace, with text after it) means
 *   no run, so nothing is read;
 * - only the trailing run of words this module knows, written upper case
 *   (`AU`, `SN`, `SN99`, `1/1`, `RC`, ...), is taken; the walk stops at the
 *   first word it does not know, so a name never becomes a token;
 * - something must precede the run (the names), or nothing is read;
 * - `NUM` is NB's own word, never BSC's, and is not read from here.
 *
 * Returns the raw tokens, like `parsePlayerAttributeTokens`; the caller bounds
 * and normalises them the same way (`SN99` -> `NUM` + print run 99; a bare
 * `SN`, which names no print run, stays `SN`). Pure; per-card data read once,
 * when the card is created from marketplace data. Set and insert names are
 * never passed here.
 */
export function bscAttributeTokensFromProductName(productName: unknown): string[] {
  if (typeof productName !== "string") return [];
  const value = productName.replace(ZERO_WIDTH, "").trim();
  if (!value || value.length > MAX_BSC_PRODUCT_NAME_LENGTH) return [];

  const hash = value.lastIndexOf("#");
  if (hash <= 0 || !/\s/.test(value[hash - 1])) return [];
  if (!value.slice(hash + 1).trim()) return [];
  const head = value.slice(0, hash).trimEnd();

  const match = head.match(PRODUCT_NAME_TOKEN_RUN);
  if (!match || match.index === undefined) return [];
  const words = match[1].split(",").map((w) => w.trim());

  // The trailing run of known tokens, read right to left: "WITT, AU" keeps
  // "AU" and stops at the name.
  let firstToken = words.length;
  while (firstToken > 0 && isProductNameToken(words[firstToken - 1])) {
    firstToken--;
  }
  if (firstToken === words.length) return [];

  // The names must come first: a run with nothing before it is not the
  // "<players> <tokens> #<cardNo>" shape.
  const before =
    head.slice(0, match.index).trim() +
    (firstToken > 0 ? words.slice(0, firstToken).join(",") : "");
  if (!before.trim()) return [];

  return Array.from(new Set(words.slice(firstToken)));
}

/** The attribute fields a checklist candidate (or stored card) carries. */
export type BscAttributeFields = {
  attributes?: string[];
  printRun?: number;
  isRookie?: boolean;
  isRelic?: boolean;
};

function hasAttributeToken(list: ReadonlyArray<string>, token: string): boolean {
  const key = token.toUpperCase();
  return list.some((t) => t.trim().toUpperCase() === key);
}

/**
 * NEO-339 — BSC's per-card tokens (the card-listing lookup) filled onto a
 * checklist CANDIDATE, by the rule `cardChecklist.applyBscAttributeFill`
 * applies to a stored card. Pure, so the staging mutation
 * (`checklistCandidates.resolveCandidateTeams`) and the read-only preview
 * (`selectorOptions.previewCardChecklist`) run the one function, and a draft
 * stays byte-identical to the stage.
 *
 * FILL-EMPTY, NEVER OVERWRITE, exactly the attribute half of that fill:
 * - `attributes`: the union of what the card holds (first, in its order) and
 *   BSC's tokens, bounded and normalised here. A raw `SN<n>`/`1/1` becomes
 *   `NUM`; one is kept beside `NUM` only while it disagrees with the card's
 *   print run. Nothing the card holds is removed.
 * - `printRun`: set only when the card has none; a different one is left,
 *   reported as `printRunDisagreement`, with BSC's raw token kept.
 * - `isRookie` / `isRelic`: set true from `RC` / `RELIC`; never set false.
 *
 * `changed` is false, and `fields` equals `current`, when BSC adds nothing:
 * the usual case, where the catalogue already carried the same tokens.
 *
 * DRIFT: `applyBscAttributeFill` still holds its own copy of this rule;
 * `convex/bscProductNameTokens.test.ts` pins the two equal on the same inputs.
 */
export function fillBscAttributeFields(
  current: BscAttributeFields,
  opts: { tokens: ReadonlyArray<string>; printRun?: number },
): { fields: BscAttributeFields; changed: boolean; printRunDisagreement: boolean } {
  const incoming = normalizeBscAttributeTokensDetailed(
    boundBscAttributeTokens(opts.tokens).tokens,
  );
  const callerPrintRun =
    opts.printRun !== undefined &&
    Number.isInteger(opts.printRun) &&
    opts.printRun >= 1 &&
    opts.printRun <= MAX_BSC_PRINT_RUN
      ? opts.printRun
      : undefined;
  const incomingPrintRun = callerPrintRun ?? incoming.printRun;

  const stored = current.attributes ?? [];
  const storedRuns = new Set<number>();
  for (const t of stored) {
    const n = printRunFromToken(t);
    if (n !== undefined) storedRuns.add(n);
  }
  const storedRun = storedRuns.size === 1 ? [...storedRuns][0] : undefined;

  // ── print run ──────────────────────────────────────────────────────────
  const offeredRun = incomingPrintRun ?? storedRun;
  let printRun = current.printRun;
  let printRunDisagreement = false;
  if (offeredRun !== undefined) {
    if (printRun === undefined) printRun = offeredRun;
    else if (printRun !== offeredRun) printRunDisagreement = true;
  }
  if (printRun !== undefined) {
    for (const n of storedRuns) if (n !== printRun) printRunDisagreement = true;
  }

  // ── attributes ─────────────────────────────────────────────────────────
  const keepRawRun = (t: string): boolean => {
    const n = printRunFromToken(t);
    return n !== undefined && (printRun === undefined || n !== printRun);
  };
  const merged: string[] = [];
  const add = (t: string) => {
    const trimmed = t.trim();
    if (trimmed && !hasAttributeToken(merged, trimmed)) merged.push(trimmed);
  };
  let numbered = false;
  for (const t of [...stored, ...incoming.attributes]) {
    if (printRunFromToken(t) !== undefined) {
      numbered = true;
      if (keepRawRun(t)) add(t);
      continue;
    }
    add(t);
  }
  if (incoming.printRun !== undefined || incoming.printRunTokens.length > 0) {
    numbered = true;
    for (const t of incoming.printRunTokens) if (keepRawRun(t)) add(t);
  }
  if (callerPrintRun !== undefined) {
    numbered = true;
    if (printRun !== undefined && callerPrintRun !== printRun) {
      add(`SN${callerPrintRun}`);
    }
  }
  if (numbered) add("NUM");

  // ── typed flags ────────────────────────────────────────────────────────
  const isRookie =
    current.isRookie === true || hasAttributeToken(merged, "RC")
      ? true
      : current.isRookie;
  const isRelic =
    current.isRelic === true || hasAttributeToken(merged, "RELIC")
      ? true
      : current.isRelic;

  const attributesChanged =
    merged.length !== stored.length || merged.some((t, i) => t !== stored[i]);
  const fields: BscAttributeFields = {
    ...(attributesChanged
      ? { attributes: merged }
      : current.attributes !== undefined
        ? { attributes: current.attributes }
        : {}),
    ...(printRun !== undefined ? { printRun } : {}),
    ...(isRookie !== undefined ? { isRookie } : {}),
    ...(isRelic !== undefined ? { isRelic } : {}),
  };
  const changed =
    attributesChanged ||
    printRun !== current.printRun ||
    isRookie !== current.isRookie ||
    isRelic !== current.isRelic;
  return { fields, changed, printRunDisagreement };
}

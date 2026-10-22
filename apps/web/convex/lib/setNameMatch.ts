/**
 * The name comparison the Reconcile matcher (`computeMatches` in
 * convex/setReconciliation.ts) pairs BSC and SportLots sets by, and the
 * set-build draft ranks a likely pair by (tools/setbuild/runner/draft.ts), so
 * the dialog and the tool read names one way.
 *
 * A name is a matching AID here, never a key: whatever it pairs is either
 * shown to the operator (the dialog's Ready sets) or confirmed by the two
 * sides' cards before the draft keeps it (`pairCardEvidence`), and a tie is
 * never given to either candidate.
 *
 * **Pure by contract.** No `_generated/server` import, no Convex types, no
 * I/O: the set-build tool imports it directly.
 */

// Common marketplace abbreviations / aliases. Keys and values must be lowercase.
// Applied token-by-token after basic normalization so "Autos" → "autographs" etc.
const TOKEN_SYNONYMS: Record<string, string> = {
  auto: "autograph",
  autos: "autograph",
  rc: "rookie",
  rcs: "rookie",
  sp: "shortprint",
  sps: "shortprint",
  ssp: "supershortprint",
  ssps: "supershortprint",
  // Plural-normalize common suffix words so "autograph" / "autographs" collapse too
  autographs: "autograph",
  rookies: "rookie",
  inserts: "insert",
  parallels: "parallel",
  shortprints: "shortprint",
  supershortprints: "supershortprint",
  refractors: "refractor",
  prizms: "prizm",
  prisms: "prism",
  variations: "variation",
  variants: "variant",
  patches: "patch",
  relics: "relic",
  jerseys: "jersey",
  signatures: "signature",
};

// Words that take a simple "+s" plural. When a token ends in 's' and the
// trimmed singular is in this set, the singular form is used for matching.
// Lightweight, extensible alternative to listing each plural pair in
// TOKEN_SYNONYMS — add new singulars here as marketplaces surface them.
const PLURALIZABLE_WORDS: Set<string> = new Set(["prizm"]);

function singularize(tok: string): string {
  if (tok.length > 1 && tok.endsWith("s")) {
    const singular = tok.slice(0, -1);
    if (PLURALIZABLE_WORDS.has(singular)) return singular;
  }
  return tok;
}

/**
 * Lowercased, accents folded ("Exposé" is "expose": one marketplace writes
 * the accent and the other does not), punctuation dropped, whitespace
 * collapsed, then each token through the synonyms.
 */
export function normalizeForMatch(s: string): string {
  const base = s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");
  if (!base) return base;
  return base
    .split(" ")
    .map((tok) => TOKEN_SYNONYMS[tok] ?? singularize(tok))
    .join(" ");
}

function tokensOf(s: string): Set<string> {
  return new Set(normalizeForMatch(s).split(" ").filter(Boolean));
}

// Returns true when one normalized token-set is a subset of the other.
// Used as a guard on fuzzy matches so a single differing meaningful token
// (e.g. "red" vs "chrome") blocks the pair, while genuine super/subset
// relationships ("Topps Chrome Update" vs "Chrome Update") still match.
export function isTokenSubsetOrSuperset(a: string, b: string): boolean {
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (ta.size === 0 || tb.size === 0) return false;
  const [smaller, larger] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const tok of smaller) {
    if (!larger.has(tok)) return false;
  }
  return true;
}

export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp[m][n];
}

// Strips a leading SL Base prefix from an SL value (case-insensitive,
// optional trailing whitespace) so matching can compare the variant tail
// against the BSC name. Returns the original string when the prefix
// doesn't lead — never lossy.
export function stripSlBasePrefix(value: string, prefix: string): string {
  if (!prefix) return value;
  const v = value.trim();
  const p = prefix.trim();
  if (v.toLowerCase().startsWith(p.toLowerCase())) {
    return v.slice(p.length).trim();
  }
  return v;
}

/**
 * A name's normalized form with a LEADING manufacturer word (or words, "Upper
 * Deck") taken off, so a name that carries the brand and one that does not
 * compare equal: BSC "Topps Chrome Authentics Relics" and SportLots "Chrome
 * Authentics Relics" (SportLots' labels drop the brand, adapters/sportlots.ts)
 * both read "chrome authentics relic". Whole tokens only ("Toppstown" keeps
 * its name), and a name that IS the manufacturer is kept whole. Without a
 * manufacturer, the plain normalized name.
 */
export function brandFoldedKey(value: string, manufacturer: string | undefined): string {
  const norm = normalizeForMatch(value);
  const brand = manufacturer ? normalizeForMatch(manufacturer).split(" ").filter(Boolean) : [];
  if (brand.length === 0) return norm;
  const toks = norm.split(" ").filter(Boolean);
  if (toks.length <= brand.length) return norm;
  for (let i = 0; i < brand.length; i++) {
    if (toks[i] !== brand[i]) return norm;
  }
  return toks.slice(brand.length).join(" ");
}

const ratioScore = (a: string, b: string): number => {
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 0 : 1 - levenshteinDistance(a, b) / maxLen;
};
const bagOf = (key: string): string => key.split(" ").filter(Boolean).sort().join(" ");

/**
 * How alike a BSC set name and a SportLots set name read, 0 to 1: the best of
 * comparing them whole, with SportLots' Base label taken off the SportLots
 * name (each of `slPrefixes`, as the matcher strips `baseSlPrefix`), and with
 * a leading manufacturer word taken off either side (`brandFoldedKey`). Two
 * names with the same words in another order score 0.95. A ranking for a
 * person to read, never a pairing. Pure.
 */
export function nameAffinity(
  bscName: string,
  slName: string,
  ctx: { manufacturer?: string; slPrefixes?: readonly string[] } = {},
): number {
  const slForms = new Set([slName, ...(ctx.slPrefixes ?? []).map((p) => stripSlBasePrefix(slName, p))]);
  const keysOf = (name: string) => new Set([normalizeForMatch(name), brandFoldedKey(name, ctx.manufacturer)]);
  const bscKeys = keysOf(bscName);
  let best = 0;
  for (const form of slForms) {
    for (const s of keysOf(form)) {
      for (const b of bscKeys) {
        if (!s || !b) continue;
        let score = ratioScore(b, s);
        if (score < 0.95 && bagOf(b) === bagOf(s)) score = 0.95;
        if (score > best) best = score;
      }
    }
  }
  return best;
}

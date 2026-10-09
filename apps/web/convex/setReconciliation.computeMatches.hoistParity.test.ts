/**
 * NEO-325 — the matcher's per-pass key arrays were HOISTED out of the loops
 * (computed once, counted in a map, spliced alongside the items). That is
 * meant to change nothing but the cost. This file pins it: the three passes
 * below are a FROZEN COPY of the pre-hoist implementation (it recounted every
 * remaining key on every iteration), and `computeMatches` must give the same
 * pairs, in the same order, with the same confidences and leftovers, on a long
 * list that mixes every case the guards care about: unique exact, reordered,
 * synonym and fuzzy pairs, twins on either side, an unrelated tail, a blocked
 * id, and a Base prefix to strip.
 *
 * The frozen copy is test code: do not "tidy" it to match the new one.
 */

import { describe, expect, test } from "vitest";
import { computeMatches } from "./setReconciliation";

type PlatformItem = { value: string; platformValue: string };
type MatchedPair = {
  displayName: string;
  bsc: PlatformItem;
  sl: PlatformItem;
  confidence: number;
};

// ===== MATCHING HELPERS =====

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

function normalizeForMatch(s: string): string {
  const base = s
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

// Returns true when one normalized token-set is a subset of the other.
// Used as a guard on fuzzy matches so a single differing meaningful token
// (e.g. "red" vs "chrome") blocks the pair, while genuine super/subset
// relationships ("Topps Chrome Update" vs "Chrome Update") still match.
function tokensOf(s: string): Set<string> {
  return new Set(normalizeForMatch(s).split(" ").filter(Boolean));
}

function isTokenSubsetOrSuperset(a: string, b: string): boolean {
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (ta.size === 0 || tb.size === 0) return false;
  const [smaller, larger] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const tok of smaller) {
    if (!larger.has(tok)) return false;
  }
  return true;
}

function levenshteinDistance(a: string, b: string): number {
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
function stripSlBasePrefix(value: string, prefix: string): string {
  if (!prefix) return value;
  const v = value.trim();
  const p = prefix.trim();
  if (v.toLowerCase().startsWith(p.toLowerCase())) {
    return v.slice(p.length).trim();
  }
  return v;
}

function referenceMatches(
  bscItems: PlatformItem[],
  slItems: PlatformItem[],
  slStripPrefix?: string,
  blocked?: { bsc?: ReadonlySet<string>; sportlots?: ReadonlySet<string> },
): {
  autoMatched: MatchedPair[];
  unmatchedBsc: PlatformItem[];
  unmatchedSl: PlatformItem[];
} {
  const autoMatched: MatchedPair[] = [];
  const isBlocked = (side: "bsc" | "sportlots", item: PlatformItem) =>
    blocked?.[side]?.has(item.platformValue) === true;
  // Blocked items never enter a pass; they are put back, in order, at the end.
  const remainingBsc = bscItems.filter((b) => !isBlocked("bsc", b));
  const remainingSl = slItems.filter((sl) => !isBlocked("sportlots", sl));

  // Stripped SL values used only for comparison; the original SL value is
  // preserved in the emitted pair so the UI shows the marketplace name.
  // Index-aligned with `remainingSl` and resliced together.
  const slStripped = remainingSl.map((sl) =>
    slStripPrefix ? stripSlBasePrefix(sl.value, slStripPrefix) : sl.value,
  );

  // NEO-325 — EXACTLY-ONE GUARD (CLAUDE.md invariant 7). Every pass below
  // auto-pairs only when its key matches exactly one candidate on EACH side.
  // Two SportLots sets (or two BSC sets) that normalize to the same name are
  // twins the name cannot tell apart; pairing "the first" one silently linked
  // whichever the marketplace happened to list first. Tied twins fall through
  // to `unmatchedBsc` / `unmatchedSl` and stay Pending for the operator, who
  // sees their ids. No pass may consume a twin: the exact and bag passes refuse
  // the key outright, and the fuzzy pass refuses a tied best score (twins
  // always tie, since the ratio is computed on the normalized name).
  const keyCount = (keys: readonly string[], key: string): number => {
    let n = 0;
    for (const k of keys) if (k === key) n++;
    return n;
  };

  // Pass 1: Exact match on normalized strings
  for (let i = remainingBsc.length - 1; i >= 0; i--) {
    const bscNorm = normalizeForMatch(remainingBsc[i].value);
    const bscNorms = remainingBsc.map((b) => normalizeForMatch(b.value));
    const slNorms = slStripped.map((sl) => normalizeForMatch(sl));
    if (
      keyCount(bscNorms, bscNorm) !== 1 ||
      keyCount(slNorms, bscNorm) !== 1
    ) {
      continue;
    }
    const slIndex = slNorms.indexOf(bscNorm);
    if (slIndex !== -1) {
      autoMatched.push({
        displayName: remainingBsc[i].value,
        bsc: remainingBsc[i],
        sl: remainingSl[slIndex],
        confidence: 1.0,
      });
      remainingBsc.splice(i, 1);
      remainingSl.splice(slIndex, 1);
      slStripped.splice(slIndex, 1);
    }
  }

  // Pass 2: Bag-of-words match — same multiset of normalized tokens in any
  // order. Catches "Prizms Red" ↔ "Red Prizm" without leaning on fuzzy edit
  // distance (which fails when word swaps create many character-level
  // changes). Sorted-token join preserves duplicate-token semantics.
  const bagOf = (s: string): string =>
    normalizeForMatch(s).split(" ").filter(Boolean).sort().join(" ");
  for (let i = remainingBsc.length - 1; i >= 0; i--) {
    const bscBag = bagOf(remainingBsc[i].value);
    if (!bscBag) continue;
    const bscBags = remainingBsc.map((b) => bagOf(b.value));
    const slBags = slStripped.map((sl) => bagOf(sl));
    if (keyCount(bscBags, bscBag) !== 1 || keyCount(slBags, bscBag) !== 1) {
      continue;
    }
    const slIndex = slBags.indexOf(bscBag);
    if (slIndex !== -1) {
      autoMatched.push({
        displayName: remainingBsc[i].value,
        bsc: remainingBsc[i],
        sl: remainingSl[slIndex],
        confidence: 0.95,
      });
      remainingBsc.splice(i, 1);
      remainingSl.splice(slIndex, 1);
      slStripped.splice(slIndex, 1);
    }
  }

  // Pass 3: Fuzzy match remaining with Levenshtein ratio < 0.40, but only
  // when the token sets stand in a subset/superset relationship. The
  // subset guard prevents single-meaningful-token mismatches ("red" vs
  // "chrome") from sneaking through; the looser char-ratio lets shorter
  // BSC names ("Aqua Lava Refractors") match their SL counterparts that
  // carry an extra brand-prefix token ("Chrome Aqua Lava Refractor").
  const MAX_RATIO = 0.4;
  for (let i = remainingBsc.length - 1; i >= 0; i--) {
    const bscNorm = normalizeForMatch(remainingBsc[i].value);
    // A BSC twin cannot be told from its sibling by name either.
    if (
      keyCount(
        remainingBsc.map((b) => normalizeForMatch(b.value)),
        bscNorm,
      ) !== 1
    ) {
      continue;
    }
    let bestSlIndex = -1;
    let bestRatio = Infinity;
    // NEO-325 — `ratio < bestRatio` alone kept the FIRST of several equally
    // good SportLots candidates. A tie for best is ambiguous, not a win.
    let bestTied = false;

    for (let j = 0; j < remainingSl.length; j++) {
      const slNorm = normalizeForMatch(slStripped[j]);
      const maxLen = Math.max(bscNorm.length, slNorm.length);
      if (maxLen === 0) continue;
      const ratio = levenshteinDistance(bscNorm, slNorm) / maxLen;
      if (ratio < bestRatio) {
        bestRatio = ratio;
        bestSlIndex = j;
        bestTied = false;
      } else if (ratio === bestRatio) {
        bestTied = true;
      }
    }

    if (
      bestSlIndex !== -1 &&
      !bestTied &&
      bestRatio < MAX_RATIO &&
      isTokenSubsetOrSuperset(
        remainingBsc[i].value,
        slStripped[bestSlIndex],
      )
    ) {
      autoMatched.push({
        displayName: remainingBsc[i].value,
        bsc: remainingBsc[i],
        sl: remainingSl[bestSlIndex],
        confidence: 1 - bestRatio,
      });
      remainingBsc.splice(i, 1);
      remainingSl.splice(bestSlIndex, 1);
      slStripped.splice(bestSlIndex, 1);
    }
  }

  const leftBsc = new Set(remainingBsc);
  const leftSl = new Set(remainingSl);
  const unmatchedBsc = bscItems.filter(
    (b) => leftBsc.has(b) || isBlocked("bsc", b),
  );
  const unmatchedSl = slItems.filter(
    (sl) => leftSl.has(sl) || isBlocked("sportlots", sl),
  );
  return { autoMatched, unmatchedBsc, unmatchedSl };
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/** A small deterministic generator: the list is the same on every run. */
function lcg(seed: number) {
  let x = seed;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 0x1_0000_0000;
  };
}

const ADJ = ["Gold", "Blue", "Red", "Green", "Purple", "Orange", "Silver", "Black", "Teal", "Pink"];
const NOUN = ["Wave", "Shimmer", "Refractor", "Prizm", "Foil", "Lava", "Mojo", "Ice"];
const SUFFIX = ["", " Autos", " Variation", " Relics", " RC"];

function buildLists() {
  const rand = lcg(325);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const bsc: PlatformItem[] = [];
  const sl: PlatformItem[] = [];
  let n = 0;
  const add = (side: PlatformItem[], tag: string, value: string) =>
    side.push({ value, platformValue: `${tag}-${n++}` });

  const seen = new Set<string>();
  const unique = () => {
    for (;;) {
      const v = `${pick(ADJ)} ${pick(NOUN)}${pick(SUFFIX)}`;
      const key = v.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        return v;
      }
    }
  };

  // Unique pairs of every shape.
  for (let i = 0; i < 24; i++) {
    const v = unique();
    add(bsc, "b", v);
    add(sl, "s", v.toUpperCase()); // exact after normalising
  }
  for (let i = 0; i < 14; i++) {
    const v = unique();
    add(bsc, "b", v);
    add(sl, "s", v.split(" ").reverse().join(" ")); // same bag, reordered
  }
  for (let i = 0; i < 10; i++) {
    const v = unique();
    add(bsc, "b", v + "s");
    add(sl, "s", `Chrome ${v}`); // fuzzy superset
  }
  add(bsc, "b", "Rookie Autos");
  add(sl, "s", "RC Autographs"); // synonyms
  // Twins: two ids under one name, on one side and on both.
  for (let i = 0; i < 4; i++) {
    const v = unique();
    add(bsc, "b", v);
    add(sl, "s", v);
    add(sl, "s", v);
  }
  for (let i = 0; i < 3; i++) {
    const v = unique();
    add(bsc, "b", v);
    add(bsc, "b", v);
    add(sl, "s", v);
  }
  {
    const v = unique();
    add(bsc, "b", v);
    add(bsc, "b", v);
    add(sl, "s", v);
    add(sl, "s", v);
  }
  // A twin only the FUZZY pass could eat.
  {
    const v = unique();
    add(bsc, "b", v);
    add(bsc, "b", v);
    add(sl, "s", `Chrome ${v}`);
  }
  // Unrelated tails on each side.
  for (let i = 0; i < 9; i++) add(bsc, "b", `Zq${i} Only On Bsc`);
  for (let i = 0; i < 9; i++) add(sl, "s", `Xw${i} Only On Sl`);
  // Shuffle each side so pass order is not the build order.
  const shuffle = <T,>(xs: T[]) => {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [xs[i], xs[j]] = [xs[j], xs[i]];
    }
  };
  shuffle(bsc);
  shuffle(sl);
  return { bsc, sl };
}

describe("computeMatches — the hoisted keys answer exactly as the per-iteration recount did (NEO-325)", () => {
  const { bsc, sl } = buildLists();

  test("the list really does exercise every pass and the guards", () => {
    const ref = referenceMatches(bsc, sl);
    const confidences = new Set(ref.autoMatched.map((m) => m.confidence));
    expect(confidences.has(1)).toBe(true);
    expect(confidences.has(0.95)).toBe(true);
    expect([...confidences].some((c) => c < 0.95)).toBe(true);
    expect(ref.autoMatched.length).toBeGreaterThan(40);
    // Twins are left over, not paired.
    expect(ref.unmatchedBsc.length).toBeGreaterThan(10);
    expect(ref.unmatchedSl.length).toBeGreaterThan(10);
    expect(bsc.length).toBeGreaterThan(70);
  });

  test("same pairs, same order, same leftovers on the whole list", () => {
    const got = computeMatches(bsc, sl);
    const ref = referenceMatches(bsc, sl);
    expect(got.autoMatched).toEqual(ref.autoMatched);
    expect(got.unmatchedBsc).toEqual(ref.unmatchedBsc);
    expect(got.unmatchedSl).toEqual(ref.unmatchedSl);
  });

  test("the same with a Base prefix to strip from the SportLots side", () => {
    const prefixed = sl.map((s) => ({ ...s, value: `Bowman ${s.value}` }));
    const got = computeMatches(bsc, prefixed, "Bowman");
    const ref = referenceMatches(bsc, prefixed, "Bowman");
    expect(got.autoMatched).toEqual(ref.autoMatched);
    expect(got.unmatchedBsc).toEqual(ref.unmatchedBsc);
    expect(got.unmatchedSl).toEqual(ref.unmatchedSl);
  });

  test("the same with some ids blocked on each side", () => {
    const blocked = {
      bsc: new Set(bsc.filter((_, i) => i % 9 === 0).map((b) => b.platformValue)),
      sportlots: new Set(sl.filter((_, i) => i % 11 === 0).map((s) => s.platformValue)),
    };
    const got = computeMatches(bsc, sl, undefined, blocked);
    const ref = referenceMatches(bsc, sl, undefined, blocked);
    expect(got.autoMatched).toEqual(ref.autoMatched);
    expect(got.unmatchedBsc).toEqual(ref.unmatchedBsc);
    expect(got.unmatchedSl).toEqual(ref.unmatchedSl);
    for (const m of got.autoMatched) {
      expect(blocked.bsc.has(m.bsc.platformValue)).toBe(false);
      expect(blocked.sportlots.has(m.sl.platformValue)).toBe(false);
    }
  });
});

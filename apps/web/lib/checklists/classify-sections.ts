/**
 * NEO-496 — which of a checklist's sections is the set's Base, which belong
 * to the Base (its subsets: "Base Rated Prospects", cards 101-200 after a
 * 1-100 base), which are the Base's parallels ("Base Red Ice", "BASE CARDS
 * LIGHTBOARD LOGO VARIATION"), and which are everything else (inserts, their
 * parallels, autographs, relics, variations).
 *
 * Read from the checklist's own section names and card numbers (input data,
 * plan D2, allowed by rule 4), never from an NB title or a marketplace value.
 *
 *  - **base**: the one section whose name, once the set's own name is taken
 *    off its front ("2026 Donruss Base" → "base"), case, spacing and dashes
 *    ignored, is "base", "base cards", "base card" or "base set", optionally
 *    followed by "checklist" and a series ("I", "II", "III", "IV", "1"-"9",
 *    "Series 2"): "Base Cards I", "Base Set Checklist", "Base Cards – Series
 *    1". None, or more than one, and there is no base: the operator picks it
 *    in Map Base Set.
 *
 * Every other section is tied to the section it names itself after: the
 * longest other section whose name, plus a space, starts this one ("Bomb
 * Squad" for "Bomb Squad Red Ice"), its *link*. Two rules hold the link:
 *
 *  1. **Never through an autograph or relic.** When the words the section
 *     adds to its link hold Autograph(s), Auto(s), Signature(s), Signed,
 *     Relic(s), Memorabilia, Patch(es), Jersey(s), Material(s) or
 *     Swatch(es), it has no link: "FUTURE STARS AUTOGRAPHS" is its own
 *     insert, not a parallel of FUTURE STARS. Words in the link's own name
 *     don't count ("Jersey Kings Blue" still links "Jersey Kings").
 *  2. **The card numbers decide what the link means** (`relation`): a
 *     section whose numbers mostly sit inside its link's numbers and cover
 *     at least half of them is a *parallel*; inside but covering less is a
 *     *variation* ("BASE CARDS IMAGE VARIATIONS", 50 of 300); numbers that
 *     repeat none of the link's but are numbered the same way ("101" after
 *     "1"-"100") make a *subset*; anything else is *unrelated*. With no
 *     numbers to read on either side the link is taken as a parallel, which
 *     is how the names alone always read.
 *
 * Then:
 *  - **base-subset**: linked to the base and a subset of it. Map Base Set
 *    offers it beside the base; Sync Parallels does not.
 *  - **base-child**: a parallel of the base, of a base subset, or of another
 *    base-child ("Base Rated Prospects Red", "Base Optic Gold"). Sync
 *    Parallels shows these by default.
 *  - **other**: the rest. `parent` is its link when that link is another
 *    "other" section it is a parallel or variation of; a section with no
 *    such parent is a root.
 *
 * A base child is compared against the base AND its subsets together, so a
 * parallel that runs the base's whole numbering ("Base Red", 1-200, when
 * "Base" is 1-100 and "Base Rated Prospects" 101-200) is still a parallel.
 *
 * Numbers come in one of two forms: every card number of the section (the
 * client has the parsed rows), or the stored summary (`firstNumber`,
 * `lastNumber`, `rowCount`), which is read as a range and only decides when
 * it is clear-cut. Strings alone (names only) keep the names-only reading.
 *
 * Pure. The variant sync's default filter (Parallels dialog = base-child,
 * Inserts dialog = other), Map Base's list and preselect, and Sync Variant
 * Types' kinds (plan D7, D16) read this one answer.
 */

import { checklistSectionKey } from "./checklist-sections";

export type SectionKind = "base" | "base-subset" | "base-child" | "other";

export type ClassifiedSection = {
  name: string;
  kind: SectionKind;
  /**
   * For base-subset, the base section's name. For base-child, the section
   * it is a parallel of (the base, a base subset or another base child).
   * For other, the other section it is a parallel or variation of, when
   * there is one.
   */
  parent?: string;
};

export type SectionClassification = {
  /** The base section's name, or null when none or several qualify. */
  base: string | null;
  /** Every section, in the order given. */
  sections: ClassifiedSection[];
};

/**
 * A section with the card numbers that place it. Give `numbers` when the
 * rows are at hand; otherwise the stored summary. Both optional: a section
 * with neither is read by its name alone.
 */
export type SectionEvidence = {
  name: string;
  /** Every card number in the section, as printed ("NNO" is ignored). */
  numbers?: readonly string[];
  /** The first numbered row's card number, in file order. */
  firstNumber?: string;
  /** The last numbered row's card number, in file order. */
  lastNumber?: string;
  /** How many rows the section holds. */
  rowCount?: number;
};

export type SectionInput = string | SectionEvidence;

/** How one section stands to the section it is linked to. */
export type SectionRelation = "parallel" | "variation" | "subset" | "unrelated" | "unknown";

/** "Base", "Base Cards", "Base Set Checklist", "Base Cards – Series 1", "Base Cards II". */
const BASE_NAME =
  /^base(?: cards?| set)?(?: checklist)?(?: (?:series )?(?:i{1,3}|iv|[1-9]))?$/;

/** True when a folded name (set name already off) names the base. */
function isBaseName(folded: string): boolean {
  const plain = folded
    .replace(/\s*[-–—:]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return BASE_NAME.test(plain);
}

/**
 * Words that make a section its own thing however it is named: an
 * autograph or a relic of a run is never that run's parallel.
 */
const NEVER_A_PARALLEL = new Set([
  "autograph",
  "autographs",
  "autographed",
  "auto",
  "autos",
  "signature",
  "signatures",
  "signed",
  "relic",
  "relics",
  "memorabilia",
  "patch",
  "patches",
  "jersey",
  "jerseys",
  "material",
  "materials",
  "swatch",
  "swatches",
]);

function holdsAutoOrRelic(foldedWords: string): boolean {
  return foldedWords.split(" ").some((word) => NEVER_A_PARALLEL.has(word));
}

/** `name` with the first of `setNames` that leads it taken off, folded. */
function withoutSetName(name: string, setNames: readonly string[]): string {
  const folded = checklistSectionKey(name);
  for (const setName of setNames) {
    const prefix = checklistSectionKey(setName);
    if (prefix !== "" && folded.startsWith(`${prefix} `)) return folded.slice(prefix.length + 1);
  }
  return folded;
}

// ── Card numbers ───────────────────────────────────────────────────────────

/**
 * A card number's numbering ("" for "101", "FS-" for "FS-7", "91CB-" for
 * "91CB-12", "RA-" for "RA-MT") and its trailing number, when it has one.
 */
type ParsedNumber = { style: string; n: number | null; text: string };

function parseNumber(raw: string): ParsedNumber | null {
  const text = raw.trim().toUpperCase();
  if (text === "" || text === "NNO") return null;
  const trailing = /^(.*?)(\d+)$/.exec(text);
  if (trailing) return { style: trailing[1], n: Number(trailing[2]), text };
  const dash = text.lastIndexOf("-");
  return { style: dash >= 0 ? text.slice(0, dash + 1) : text, n: null, text };
}

/** What a section's numbers say, in the form both evidence shapes share. */
type NumberProfile = {
  /** Every distinct number, when the rows were given. */
  set: ReadonlySet<string> | null;
  /** The numbering most of the section uses. */
  style: string;
  /** The range of that numbering's trailing numbers, when they have one. */
  min: number | null;
  max: number | null;
  /** Distinct numbers (rows given) or rows (summary). */
  count: number;
};

function profileOf(input: SectionInput): NumberProfile | null {
  if (typeof input === "string") return null;
  if (input.numbers) {
    const parsed = new Map<string, ParsedNumber>();
    for (const raw of input.numbers) {
      const p = parseNumber(raw);
      if (p && !parsed.has(p.text)) parsed.set(p.text, p);
    }
    if (parsed.size === 0) return null;
    const styles = new Map<string, number>();
    for (const p of parsed.values()) styles.set(p.style, (styles.get(p.style) ?? 0) + 1);
    let style = "";
    let most = -1;
    for (const [s, n] of styles) {
      if (n > most) {
        style = s;
        most = n;
      }
    }
    let min: number | null = null;
    let max: number | null = null;
    for (const p of parsed.values()) {
      if (p.style !== style || p.n === null) continue;
      min = min === null ? p.n : Math.min(min, p.n);
      max = max === null ? p.n : Math.max(max, p.n);
    }
    return { set: new Set(parsed.keys()), style, min, max, count: parsed.size };
  }
  const first = input.firstNumber === undefined ? null : parseNumber(input.firstNumber);
  const last = input.lastNumber === undefined ? null : parseNumber(input.lastNumber);
  if (!first || !last || first.style !== last.style) return null;
  const ranged = first.n !== null && last.n !== null;
  return {
    set: null,
    style: first.style,
    min: ranged ? Math.min(first.n!, last.n!) : null,
    max: ranged ? Math.max(first.n!, last.n!) : null,
    count: Math.max(1, input.rowCount ?? 1),
  };
}

/** More than this share of a section's numbers inside its link's: it sits inside. */
const INSIDE_SHARE = 0.5;
/** At most this share inside: it repeats none of them (a subset, or unrelated). */
const OUTSIDE_SHARE = 0.2;
/** A parallel covers at least this share of the numbers it parallels. */
const PARALLEL_COVERAGE = 0.5;

/**
 * How `child` stands to `family`: its link, and for a base link the base's
 * subsets as well (the first member is the link itself). See the module
 * comment; "unknown" when the numbers can't say.
 */
function relation(
  child: NumberProfile | null,
  family: ReadonlyArray<NumberProfile | null>,
): SectionRelation {
  const members = family.filter((m): m is NumberProfile => m !== null);
  const link = family[0] ?? null;
  if (!child || !link || members.length === 0) return "unknown";

  if (child.set && members.every((m) => m.set)) {
    let inside = 0;
    for (const n of child.set) if (members.some((m) => m.set!.has(n))) inside++;
    const share = inside / child.set.size;
    if (share > INSIDE_SHARE) {
      let coverage = 0;
      for (const m of members) {
        let shared = 0;
        for (const n of child.set) if (m.set!.has(n)) shared++;
        coverage = Math.max(coverage, shared / m.set!.size);
      }
      return coverage >= PARALLEL_COVERAGE ? "parallel" : "variation";
    }
    if (share <= OUTSIDE_SHARE) return child.style === link.style ? "subset" : "unrelated";
    return "unrelated";
  }

  // A summary: a range per section. Decide only when it is clear-cut.
  const sameStyle = members.filter((m) => m.style === child.style);
  if (sameStyle.length === 0) return "unrelated";
  if (child.min === null || child.max === null) return "unknown";
  const ranged = sameStyle.filter((m) => m.min !== null && m.max !== null);
  if (ranged.length === 0) return "unknown";
  const overlapping = ranged.filter((m) => m.min! <= child.max! && child.min! <= m.max!);
  if (overlapping.length === 0) return link.style === child.style ? "subset" : "unrelated";
  const low = Math.min(...ranged.map((m) => m.min!));
  const high = Math.max(...ranged.map((m) => m.max!));
  if (child.min < low || child.max > high) return "unknown";
  const across = overlapping.reduce((sum, m) => sum + m.count, 0);
  return child.count / across >= PARALLEL_COVERAGE ? "parallel" : "variation";
}

// ── Classification ─────────────────────────────────────────────────────────

/**
 * Classify a checklist's sections, given as names or with their card
 * numbers (`SectionEvidence`). `setNames` are the set's own names to strip
 * from a section's front ("2026 Donruss", "Donruss"); the longest that
 * leads a name is used.
 */
export function classifySections(
  inputs: readonly SectionInput[],
  options: { setNames?: readonly string[] } = {},
): SectionClassification {
  const setNames = [...(options.setNames ?? [])].sort((a, b) => b.length - a.length);
  const all = inputs.map((input, index) => {
    const name = typeof input === "string" ? input : input.name;
    return { index, name, key: checklistSectionKey(name), profile: profileOf(input) };
  });
  type Entry = (typeof all)[number];

  const bases = all.filter((s) => isBaseName(withoutSetName(s.name, setNames)));
  const baseEntry = bases.length === 1 ? bases[0] : null;

  // Each section's link: the longest other section it names itself after,
  // unless the words it adds hold an autograph or relic word.
  const linkOf = new Map<Entry, Entry>();
  for (const s of all) {
    let link: Entry | null = null;
    for (const candidate of all) {
      if (candidate.key === s.key || !s.key.startsWith(`${candidate.key} `)) continue;
      if (!link || candidate.key.length > link.key.length) link = candidate;
    }
    if (link && !holdsAutoOrRelic(s.key.slice(link.key.length + 1))) linkOf.set(s, link);
  }

  const kinds = new Map<Entry, ClassifiedSection>();
  if (baseEntry) {
    for (const s of all) {
      if (s.key === baseEntry.key) kinds.set(s, { name: s.name, kind: "base" });
    }
    // Subsets first, so a base parallel is read against the whole base.
    for (const s of all) {
      if (kinds.has(s) || linkOf.get(s) !== baseEntry) continue;
      if (relation(s.profile, [baseEntry.profile]) === "subset") {
        kinds.set(s, { name: s.name, kind: "base-subset", parent: baseEntry.name });
      }
    }
  }
  const subsets = all.filter((s) => kinds.get(s)?.kind === "base-subset");

  // Shortest first: a link is always shorter than the section it leads.
  const byLength = [...all].sort((a, b) => a.key.length - b.key.length || a.index - b.index);
  for (const s of byLength) {
    if (kinds.has(s)) continue;
    const link = linkOf.get(s);
    const linkKind = link ? kinds.get(link)?.kind : undefined;
    let out: ClassifiedSection = { name: s.name, kind: "other" };
    if (link && linkKind) {
      const family =
        linkKind === "base" ? [link.profile, ...subsets.map((x) => x.profile)] : [link.profile];
      const rel = relation(s.profile, family);
      const parallel = rel === "parallel" || rel === "unknown";
      if (linkKind === "other") {
        if (parallel || rel === "variation") out = { name: s.name, kind: "other", parent: link.name };
      } else if (parallel) {
        out = { name: s.name, kind: "base-child", parent: link.name };
      } else if (rel === "subset" && linkKind === "base-subset") {
        out = { name: s.name, kind: "base-subset", parent: link.name };
      }
    }
    kinds.set(s, out);
  }
  return { base: baseEntry?.name ?? null, sections: all.map((s) => kinds.get(s)!) };
}

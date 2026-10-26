/**
 * NEO-364 — players sort the way a collector files them: by last name, then
 * first. "Ken Griffey Jr." files under Griffey (the suffix is not a surname),
 * "Elly De La Cruz" under De La Cruz (the particles belong to the surname),
 * and a one-name player ("Ichiro") under that one name.
 *
 * Pure string work on NB's own player names; no lookups.
 */

/** Generational suffixes: never a surname. Compared without the dot, case-folded. */
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v", "vi"]);

/** Lower-case words that join the surname that follows ("de la", "van der"). */
const PARTICLES = new Set(["de", "del", "della", "der", "den", "la", "le", "da", "di", "do", "dos", "du", "van", "von", "st", "ter"]);

const fold = (word: string) => word.toLowerCase().replace(/[.,]/g, "");

export interface PlayerNameParts {
  /** The surname the name files under: "Griffey", "De La Cruz", "Ichiro". */
  last: string;
  /** Everything before it: "Ken", "Elly", "" for a one-name player. */
  first: string;
  /** "Jr.", "III", or "" when there is none. */
  suffix: string;
}

/** Split a display name into what it files under. */
export function playerNameParts(name: string): PlayerNameParts {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) return { last: "", first: "", suffix: "" };

  // "Griffey, Ken" or "Griffey Jr., Ken": already surname-first.
  const comma = trimmed.indexOf(",");
  if (comma > 0) {
    const before = trimmed.slice(0, comma).trim();
    const after = trimmed.slice(comma + 1).trim();
    // "Ken Griffey, Jr." is a suffix after the comma, not surname-first.
    if (after && SUFFIXES.has(fold(after))) return { ...playerNameParts(before), suffix: after };
    const head = before.split(" ");
    const suffix = head.length > 1 && SUFFIXES.has(fold(head[head.length - 1])) ? head.pop()! : "";
    return { last: head.join(" "), first: after, suffix };
  }

  const words = trimmed.split(" ");
  let suffix = "";
  if (words.length > 1 && SUFFIXES.has(fold(words[words.length - 1]))) suffix = words.pop()!;
  if (words.length === 1) return { last: words[0], first: "", suffix };

  // The last word, plus any particles just before it (never the first word).
  let start = words.length - 1;
  while (start > 1 && PARTICLES.has(fold(words[start - 1]))) start--;
  return { last: words.slice(start).join(" "), first: words.slice(0, start).join(" "), suffix };
}

const collator = new Intl.Collator("en-US", { sensitivity: "base", numeric: true });

/**
 * Order two player names by last name, then first, then suffix (Sr. before
 * Jr. falls out of the alphabet, which is fine; II before III by number).
 * A missing name sorts after every named one.
 */
export function comparePlayerNames(a: string | null | undefined, b: string | null | undefined): number {
  const x = playerNameParts(a ?? "");
  const y = playerNameParts(b ?? "");
  if (!x.last || !y.last) return x.last ? -1 : y.last ? 1 : 0;
  return (
    collator.compare(x.last, y.last) ||
    collator.compare(x.first, y.first) ||
    collator.compare(x.suffix, y.suffix) ||
    collator.compare(a ?? "", b ?? "")
  );
}

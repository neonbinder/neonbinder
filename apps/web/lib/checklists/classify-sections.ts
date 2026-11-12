/**
 * NEO-496 — which of a checklist's sections is the set's Base, which extend
 * it (its parallels: "Base Red Ice", "BASE CARDS IMAGE VARIATIONS"), and
 * which are everything else (inserts and their own parallels).
 *
 * Read from the publisher's own section names (input data, plan D2), never
 * from an NB title or a marketplace value:
 *
 *  - **base**: the one section named "base", "base cards" or "base set"
 *    once the set's own name is taken off its front ("2026 Donruss Base" →
 *    "base"), case and spacing ignored. None, or more than one, and there is
 *    no base: the operator picks it in Map Base Set.
 *  - **base-child**: a section whose name is the base section's name, a
 *    space, and more ("Base Rated Prospects", "Base Red Ice").
 *  - **other**: the rest. `parent` names the longest other section whose
 *    name, plus a space, starts this one ("Bomb Squad" for "Bomb Squad Red
 *    Ice"); a section with no parent is a root.
 *
 * Pure. The variant sync's default filter (Parallels dialog = base-child,
 * Inserts dialog = the rest), Map Base's preselect and Sync Variant Types'
 * kinds (plan D7, D16) read this one answer.
 */

import { checklistSectionKey } from "./checklist-sections";

export type SectionKind = "base" | "base-child" | "other";

export type ClassifiedSection = {
  name: string;
  kind: SectionKind;
  /**
   * For base-child, the base section's name; for other, the longest other
   * section this one extends, when there is one.
   */
  parent?: string;
};

export type SectionClassification = {
  /** The base section's name, or null when none or several qualify. */
  base: string | null;
  /** Every section, in the order given. */
  sections: ClassifiedSection[];
};

const BASE_NAMES = new Set(["base", "base cards", "base card", "base set"]);

/** `name` with the first of `setNames` that leads it taken off, folded. */
function withoutSetName(name: string, setNames: readonly string[]): string {
  const folded = checklistSectionKey(name);
  for (const setName of setNames) {
    const prefix = checklistSectionKey(setName);
    if (prefix !== "" && folded.startsWith(`${prefix} `)) return folded.slice(prefix.length + 1);
  }
  return folded;
}

/**
 * Classify a checklist's section names. `setNames` are the set's own names
 * to strip from a section's front ("2026 Donruss", "Donruss"); longest
 * first is best, as the first that matches is used.
 */
export function classifySections(
  names: readonly string[],
  options: { setNames?: readonly string[] } = {},
): SectionClassification {
  const setNames = [...(options.setNames ?? [])].sort((a, b) => b.length - a.length);
  const bases = names.filter((n) => BASE_NAMES.has(withoutSetName(n, setNames)));
  const base = bases.length === 1 ? bases[0] : null;
  const baseKey = base === null ? null : checklistSectionKey(base);

  const keyed = names.map((name) => ({ name, key: checklistSectionKey(name) }));
  const isBaseChild = (key: string) => baseKey !== null && key.startsWith(`${baseKey} `);
  const others = keyed.filter((s) => s.key !== baseKey && !isBaseChild(s.key));

  const sections = keyed.map(({ name, key }): ClassifiedSection => {
    if (base !== null && key === baseKey) return { name, kind: "base" };
    if (base !== null && isBaseChild(key)) return { name, kind: "base-child", parent: base };
    let parent: { name: string; key: string } | null = null;
    for (const candidate of others) {
      if (candidate.key === key || !key.startsWith(`${candidate.key} `)) continue;
      if (!parent || candidate.key.length > parent.key.length) parent = candidate;
    }
    return parent ? { name, kind: "other", parent: parent.name } : { name, kind: "other" };
  });
  return { base, sections };
}

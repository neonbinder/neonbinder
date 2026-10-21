/**
 * NEO-339 — a count the spec expects, judged against the run's paused
 * marketplaces.
 *
 * The counts in a spec (`expectCards`, `expectRows`, `group.expectUngrouped`)
 * are measured with every marketplace live. A run with a marketplace paused
 * fetches less: a Base mapped `whenPaused: "bsc-only"` gets BSC's cards only,
 * a one-sided variant sync stores every BSC set, and so on. So the live number
 * is never asserted against a paused run. Instead:
 *
 *  - nothing paused: the live value is asserted, exactly as before;
 *  - something paused and the spec gives the paused value
 *    (`expectCardsWhenPaused`, …): that value is asserted;
 *  - something paused and no paused value: nothing is asserted, and the step
 *    says so ("count not asserted: sportlots paused"). Never a silent pass.
 *
 * Which marketplaces count as paused is the run's declared `PausedContext`
 * (which `checkPausedPlatforms` has already agreed with the deployment), plus
 * any side a fetch itself reported paused. The declared pause is the one that
 * matters: a fetch reports a side paused only when that side would otherwise
 * have resolved, so the Base a paused run mapped `bsc-only` (no SportLots id
 * attached at all) fetches with `pausedSides: []` and still holds fewer cards
 * than the live count. Test-spec plumbing only: no product rule reads this.
 */

import { parseDeclaredPaused, type PausedContext } from "./sync-column";

/** What one count check does in this run. */
export type CountCheck =
  | { kind: "none" }
  | {
      kind: "assert";
      want: number;
      /** The live field's name (`expectCards`), for messages. */
      field: string;
      /** Set when the PAUSED value is asserted: the paused marketplaces, as words ("sportlots"). */
      pausedBy?: string;
    }
  | { kind: "skip"; field: string; note: string };

const SIDE_TO_SITE: Record<string, string> = { bsc: "buysportscards", sportlots: "sportlots" };

/**
 * The paused marketplaces, by credential site key, sorted: the run's declared
 * pause plus any platform-slot side a fetch reported paused. Pure.
 */
export function pausedNames(paused: PausedContext | undefined, reportedSides: readonly string[] = []): string[] {
  const out = new Set<string>(paused ? [...paused.sites] : []);
  for (const side of reportedSides) out.add(SIDE_TO_SITE[side] ?? side);
  return [...out].sort();
}

/** The note a skipped count carries. */
export function notAssertedNote(paused: readonly string[]): string {
  return `count not asserted: ${paused.join(", ")} paused`;
}

/**
 * Judge one count: `live` is the spec's value (`expectCards`), `whenPaused`
 * its paused sibling (`expectCardsWhenPaused`), `paused` the paused
 * marketplaces (`pausedNames`). Pure.
 */
export function countCheck(
  field: string,
  live: number | undefined,
  whenPaused: number | undefined,
  paused: readonly string[],
): CountCheck {
  if (paused.length === 0) return live === undefined ? { kind: "none" } : { kind: "assert", want: live, field };
  if (whenPaused !== undefined) return { kind: "assert", want: whenPaused, field, pausedBy: paused.join(", ") };
  if (live === undefined) return { kind: "none" };
  return { kind: "skip", field, note: notAssertedNote(paused) };
}

/** The number to compare against, or undefined when nothing is asserted. */
export function wanted(c: CountCheck): number | undefined {
  return c.kind === "assert" ? c.want : undefined;
}

/**
 * "the spec expects 336" (live, byte-for-byte the old wording), or "the spec
 * expects 335 with sportlots paused (expectCardsWhenPaused)".
 */
export function specExpects(c: Extract<CountCheck, { kind: "assert" }>): string {
  return c.pausedBy === undefined
    ? `the spec expects ${c.want}`
    : `the spec expects ${c.want} with ${c.pausedBy} paused (${c.field}WhenPaused)`;
}

/** The spec location of the value asserted: `<at>.expectRows`, or `<at>.expectRowsWhenPaused`. */
export function fieldAt(base: string, c: Extract<CountCheck, { kind: "assert" }>): string {
  return `${base}.${c.field}${c.pausedBy === undefined ? "" : "WhenPaused"}`;
}

/** `; <note>` for a skipped count, else "" (so a detail line reads the same when nothing is paused). */
export function skipSuffix(c: CountCheck): string {
  return c.kind === "skip" ? `; ${c.note}` : "";
}

// ---------------------------------------------------------------------------
// The smokes' expectation files (mcp-smoke, oneshot-smoke)
// ---------------------------------------------------------------------------

/** A smoke check skipped because its expected value was measured with every marketplace live. */
export function notCheckedNote(paused: readonly string[]): string {
  return `not checked: ${paused.join(", ")} paused`;
}

/** "not checked (sportlots paused): Base cards, Parallel rows" — the parts of a check a paused run left out. */
export function uncheckedNote(paused: readonly string[], unchecked: readonly string[]): string {
  return `not checked (${paused.join(", ")} paused): ${unchecked.join(", ")}`;
}

/** The paused marketplaces a smoke was told about (`--paused-platforms`, else env PAUSED_PLATFORMS), sorted. Throws on an unknown key. */
export function declaredPausedNames(raw: string | undefined): string[] {
  return pausedNames(parseDeclaredPaused(raw));
}

/**
 * An expectation file's `counts`, judged for this run: nothing paused, every
 * count; something paused, only the `countsWhenPaused` ones, and the rest
 * named as unchecked. Pure.
 */
export function countsFor(
  counts: Record<string, number>,
  countsWhenPaused: Record<string, number> | undefined,
  paused: readonly string[],
): { counts: Record<string, number>; unchecked: string[] } {
  if (paused.length === 0) return { counts, unchecked: [] };
  const checked = countsWhenPaused ?? {};
  return { counts: checked, unchecked: Object.keys(counts).filter((k) => !(k in checked)).map((k) => `counts.${k}`) };
}

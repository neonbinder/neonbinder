/**
 * NEO-212 — the ONE place that decides whether a string is a Wikidata entity
 * id, and the only sanctioned way to turn one into a URL.
 *
 * ## Why a shared module rather than a regex per call site
 *
 * `Q<digits>` was being re-declared in three places (a `WIKIDATA_QID` constant
 * in `convex/players.ts`, another in `components/admin/PlayerManagement.tsx`)
 * while two RENDER sites interpolated the stored value straight into an
 * `href` with no check at all:
 *
 *   href={`https://www.wikidata.org/wiki/${qid}`}
 *
 * A stored id is not operator-typed at the moment it renders — it arrives from
 * `adapters/wikidata.ts` (an external SPARQL endpoint), from a legacy row
 * written before `savePlayerFields` validated anything, or from a batch write
 * that never passed through the editor. Interpolating an arbitrary string into
 * an `href` is how `javascript:` or `data:` reaches an anchor, and React will
 * not stop it: it warns on a `javascript:` URL and renders it anyway.
 *
 * So validation moves to a chokepoint that BOTH the write path and the render
 * path go through, and the render path is expressed as "give me a URL for this
 * id, or nothing" rather than "build a URL and hope".
 *
 * Pure and dependency-free on purpose: it is imported by Convex functions
 * (`convex/players.ts`, `convex/teams.ts`, `convex/adapters/wikidata.ts`) AND
 * by browser components, exactly like its `./team-tenure` neighbour. Nothing
 * here may import `_generated/server`, which would drag the Convex server
 * runtime into the client bundle.
 */

/**
 * A Wikidata entity id: the letter Q followed by digits, and nothing else.
 *
 * Anchored at both ends, with no `g` flag — a `g`-flagged regex carries
 * `lastIndex` between `.test()` calls and would answer differently on
 * alternate invocations for the same input.
 */
export const WIKIDATA_QID = /^Q\d+$/;

/**
 * Type guard: is this a Wikidata entity id?
 *
 * Takes `unknown` rather than `string` so it can also stand in front of a
 * value read back off a document, where the schema says `string` but the row
 * may predate any validation. Does NOT trim — a value with surrounding
 * whitespace is not a valid id, and silently accepting one would put the
 * untrimmed form into a URL. Callers that accept operator typing (the editor
 * in `savePlayerFields`) trim first, deliberately, and then ask.
 */
export function isWikidataQid(value: unknown): value is string {
  return typeof value === "string" && WIKIDATA_QID.test(value);
}

/**
 * The canonical Wikidata record URL for an id, or `null` when the value is not
 * an id at all.
 *
 * `null` rather than a throw or a placeholder URL: every caller is a render
 * site, and the right response to an unusable id is to show the id as plain
 * text — the operator still sees what is stored, which is exactly the
 * information they need to go fix it, and no anchor is created.
 */
export function wikidataUrl(qid: unknown): string | null {
  return isWikidataQid(qid) ? `https://www.wikidata.org/wiki/${qid}` : null;
}

/**
 * The English Wikipedia article URL for an article TITLE.
 *
 * Unlike a QID a title has no validatable shape — it is free text from
 * Wikidata's `schema:name` — so this escapes rather than validates. Spaces
 * become underscores (Wikipedia's own convention, and the form that survives
 * a copy-paste) and `encodeURIComponent` handles everything else, which is
 * also what makes a `javascript:`-shaped title inert: the colon is encoded, so
 * the result is always a path segment under the https origin and can never
 * become a scheme.
 */
export function wikipediaUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(
    title.trim().replace(/ /g, "_"),
  )}`;
}

/**
 * NEO-346 — fold a `captureFromCli` result into the committed recording,
 * `__fixtures__/enrichment-lookups.json`.
 *
 * A capture returns its entries as a LIST of `{ key, entry }`: a fixture key
 * embeds the looked-up name, and Convex refuses a non-ASCII field name in a
 * return value, so an object keyed by name cannot leave the deployment (see
 * `capturedEntryValidator`). This module builds the keyed object on the
 * laptop, where JSON has no such limit, and writes it in the file's committed
 * format so a merge diffs as additions only.
 *
 * ## The committed format
 *
 * Python's `json.dumps(data, indent=2, ensure_ascii=True) + "\n"` with the
 * entries sorted by key — the format §4a of the runbook first wrote the file
 * in. `formatFixtureFile` reproduces it byte for byte from `JSON.stringify`:
 * the two agree on indentation, separators and control-character escapes,
 * and differ only in that Python escapes every character outside printable
 * ASCII as `\uXXXX` (lowercase hex, UTF-16 code units, so an astral character
 * is a surrogate pair), where `JSON.stringify` leaves it raw.
 *
 * ## What a merge does
 *
 * - A key the file lacks is ADDED.
 * - A key the file already holds with the same answer is left alone.
 * - A key the file holds with a DIFFERENT answer keeps the committed answer
 *   and is reported, unless the caller passes `replace` (a deliberate
 *   re-capture; runbook §4). A capture never silently rewrites a recording.
 * - The file's `version`, `capturedAt` and `sportQid` are kept as they are.
 *
 * Refused, with nothing written: a file that does not parse, is not valid,
 * or is not already in the committed format (the "additions only" promise
 * cannot hold for it); a capture for another sport or version; a captured
 * entry whose key is not `fixtureKey(kind, sportQid, name)` or whose
 * `wikidataId` is not a QID (`parseFixtureFile`'s checks); a key captured
 * twice.
 *
 * Pure: no filesystem, no network. The CLI wrapper is
 * `scripts/merge-enrichment-capture.ts`. Not a Convex function, so it lives
 * beside the fixture module rather than at the convex/ root; it is here (not
 * under scripts/) so `npm run typecheck` covers it.
 */

import {
  FIXTURE_VERSION,
  compareFixtureKeys,
  parseFixtureFile,
  type EnrichmentFixtureEntry,
} from "./enrichmentFixtures";

// ---------------------------------------------------------------------------
// The committed format
// ---------------------------------------------------------------------------

/**
 * Serialise as Python's `json.dumps(value, indent=2, ensure_ascii=True)`
 * plus a trailing newline. Object key order is the caller's: sort before
 * calling.
 */
export function formatFixtureFile(value: unknown): string {
  // Applied to the serialised text, where a non-ASCII character can only sit
  // inside a string literal, so escaping it there is always valid JSON.
  // U+007F (DEL) is included: Python escapes everything outside " "–"~".
  const escaped = JSON.stringify(value, null, 2).replace(
    /[\u007f-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `${escaped}\n`;
}

/** Key-order-independent equality for two recorded entries. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const fields = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Reading a capture
// ---------------------------------------------------------------------------

export type CaptureSkip = { kind: string; name: string; reason: string };

export type ParsedCapture = {
  sportQid: string;
  /** In capture order; keys unique. */
  entries: Array<{ key: string; entry: EnrichmentFixtureEntry }>;
  skippedTransport: CaptureSkip[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read what `npx convex run enrichmentFixtures:captureFromCli … > capture.json`
 * wrote: the whole result (`{ fixture, skippedTransport, … }`) or its bare
 * `fixture`. `entries` is the list `captureFromCli` returns; an object keyed
 * by fixture key (a capture from before NEO-346) is accepted too. Every entry
 * goes through `parseFixtureFile`, the same validation the runtime applies to
 * the committed file. Throws with the reason on anything else.
 */
export function parseCapture(raw: unknown): ParsedCapture {
  if (!isRecord(raw)) throw new Error("capture is not a JSON object");
  const fixture = isRecord(raw.fixture) ? raw.fixture : raw;
  if (fixture.version !== FIXTURE_VERSION) {
    throw new Error(`capture fixture version ${String(fixture.version)} is not ${FIXTURE_VERSION}`);
  }
  if (typeof fixture.sportQid !== "string") throw new Error("capture fixture has no sportQid");

  let pairs: Array<[string, unknown]>;
  if (Array.isArray(fixture.entries)) {
    pairs = fixture.entries.map((item, index): [string, unknown] => {
      if (!isRecord(item) || typeof item.key !== "string" || !("entry" in item)) {
        throw new Error(`capture entry #${index} is not { key, entry }`);
      }
      return [item.key, item.entry];
    });
  } else if (isRecord(fixture.entries)) {
    pairs = Object.entries(fixture.entries);
  } else {
    throw new Error("capture fixture entries must be a list of { key, entry }");
  }

  const byKey: Record<string, unknown> = {};
  for (const [key, entry] of pairs) {
    if (Object.prototype.hasOwnProperty.call(byKey, key)) {
      throw new Error(`capture holds key ${key} twice`);
    }
    byKey[key] = entry;
  }
  const parsed = parseFixtureFile({
    version: fixture.version,
    capturedAt: typeof fixture.capturedAt === "string" ? fixture.capturedAt : "",
    sportQid: fixture.sportQid,
    entries: byKey,
  });
  if (!parsed.ok) throw new Error(`capture rejected: ${parsed.reason}`);

  const skippedTransport: CaptureSkip[] = [];
  if (Array.isArray(raw.skippedTransport)) {
    for (const skip of raw.skippedTransport) {
      if (isRecord(skip) && typeof skip.name === "string") {
        skippedTransport.push({
          kind: String(skip.kind),
          name: skip.name,
          reason: String(skip.reason),
        });
      }
    }
  }

  return {
    sportQid: fixture.sportQid,
    entries: pairs.map(([key]) => ({ key, entry: parsed.fixture.entries[key] })),
    skippedTransport,
  };
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

export type MergeResult = {
  /** The new file text, in the committed format. Equal to the input when nothing was added. */
  text: string;
  /** Keys added (absent from the file before). */
  added: string[];
  /** Keys whose committed answer was replaced (only with `replace`). */
  replaced: string[];
  /** Keys the file already held with the same answer. */
  unchanged: string[];
  /** Keys the file holds with a DIFFERENT answer, kept as committed (without `replace`). */
  differing: string[];
};

/** The file object with its entries re-inserted in key order; every other field kept in place. */
function withSortedEntries(
  file: Record<string, unknown>,
  entries: Record<string, unknown>,
): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(entries).sort(compareFixtureKeys)) sorted[key] = entries[key];
  return { ...file, entries: sorted };
}

/**
 * Merge one parsed capture into the committed file's text. See the header
 * for the rules; throws (writing nothing) on any refusal.
 */
export function mergeCaptureIntoFixtureText(
  fileText: string,
  capture: ParsedCapture,
  options: { replace?: boolean } = {},
): MergeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(fileText);
  } catch (error) {
    throw new Error(`fixture file is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const current = parseFixtureFile(raw);
  if (!current.ok) throw new Error(`fixture file is invalid: ${current.reason}`);
  // The raw parse, not `current.fixture`: it carries the file's own field
  // order, which is what keeps the untouched entries byte-identical.
  const file = raw as Record<string, unknown> & { entries: Record<string, unknown> };
  if (formatFixtureFile(withSortedEntries(file, file.entries)) !== fileText) {
    throw new Error(
      "fixture file is not in its committed format (json.dumps indent=2, \\u escapes, entries sorted by key, " +
        "trailing newline); a merge would rewrite unrelated lines, so it is refused",
    );
  }
  if (capture.sportQid !== current.fixture.sportQid) {
    throw new Error(
      `capture is for sport ${capture.sportQid}; the fixture file records ${current.fixture.sportQid}`,
    );
  }

  const entries: Record<string, unknown> = { ...file.entries };
  const result: Omit<MergeResult, "text"> = { added: [], replaced: [], unchanged: [], differing: [] };

  for (const { key, entry } of capture.entries) {
    if (!Object.prototype.hasOwnProperty.call(entries, key)) {
      entries[key] = entry;
      result.added.push(key);
    } else if (canonical(entries[key]) === canonical(entry)) {
      result.unchanged.push(key);
    } else if (options.replace) {
      entries[key] = entry;
      result.replaced.push(key);
    } else {
      result.differing.push(key);
    }
  }

  const merged = withSortedEntries(file, entries);

  const check = parseFixtureFile(merged);
  if (!check.ok) throw new Error(`merged fixture is invalid: ${check.reason}`);

  return { text: formatFixtureFile(merged), ...result };
}

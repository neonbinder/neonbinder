/**
 * NEO-346 — folding a `captureFromCli` result into the committed recording.
 *
 * `captureFromCli` returns its entries as a `{ key, entry }` list because a
 * key embeds the name and Convex refuses non-ASCII field names; the merge
 * (`adapters/enrichmentFixtureMerge.ts`) builds the keyed object and writes
 * the file in its committed format. These tests pin that format byte for
 * byte against the real committed file, the additions-only diff, the
 * `\uXXXX` round trip of an accented name, and every refusal.
 *
 * Pure: no convex-test, no network.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  fixtureKey,
  parseFixtureFile,
  type EnrichmentFixtureEntry,
} from "./adapters/enrichmentFixtures";
import {
  formatFixtureFile,
  mergeCaptureIntoFixtureText,
  parseCapture,
} from "./adapters/enrichmentFixtureMerge";

const FIXTURE_PATH = join(__dirname, "adapters", "__fixtures__", "enrichment-lookups.json");
const COMMITTED = readFileSync(FIXTURE_PATH, "utf8");
const SPORT_QID = "Q5369";

const CIEGO = "Ciego de Ávila";
const CIEGO_KEY = fixtureKey("league", SPORT_QID, CIEGO);
const CIEGO_ENTRY: EnrichmentFixtureEntry = {
  kind: "league",
  name: CIEGO,
  result: { wikidataId: "Q5119616", yearsActive: { from: 1977 } },
};

type CaptureEntry = { key: string; entry: EnrichmentFixtureEntry };

/** A `captureFromCli` result as `npx convex run … > capture.json` writes it. */
function captureResult(entries: CaptureEntry[], extra: Record<string, unknown> = {}) {
  return {
    fixture: { version: 1, capturedAt: "2026-10-13T00:00:00.000Z", sportQid: SPORT_QID, entries },
    skippedTransport: [],
    total: entries.length,
    offset: 0,
    scanned: entries.length,
    since: null,
    sinceSource: "none",
    ...extra,
  };
}

/** A small file in the committed format. */
function smallFile(entries: Record<string, EnrichmentFixtureEntry>): string {
  const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return formatFixtureFile({ version: 1, capturedAt: "2026-09-20T21:19:12.386Z", sportQid: SPORT_QID, entries: sorted });
}

const gwynnKey = fixtureKey("player", SPORT_QID, "Tony Gwynn");
const gwynn: EnrichmentFixtureEntry = {
  kind: "player",
  name: "Tony Gwynn",
  result: { wikidataId: "Q1000", careerTeams: [{ name: "San Diego Padres", fromYear: 1982, toYear: 2001 }] },
};

/**
 * The lines `after` adds to `before`, asserting it removes or changes none:
 * `before`'s lines must appear in `after` in order, untouched.
 */
function addedLines(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const added: string[] = [];
  let i = 0;
  for (const line of b) {
    if (i < a.length && line === a[i]) i += 1;
    else added.push(line);
  }
  expect(i, "every original line survives, in order").toBe(a.length);
  return added;
}

describe("formatFixtureFile — the committed format", () => {
  test("reproduces the committed file byte for byte", () => {
    expect(formatFixtureFile(JSON.parse(COMMITTED))).toBe(COMMITTED);
  });

  test("escapes like Python's json.dumps(indent=2, ensure_ascii=True)", () => {
    // Expected strings are Python's own output for the same values.
    expect(formatFixtureFile({ name: CIEGO })).toBe('{\n  "name": "Ciego de \\u00c1vila"\n}\n');
    expect(formatFixtureFile({ "ciego de ávila": 1 })).toBe('{\n  "ciego de \\u00e1vila": 1\n}\n');
    expect(formatFixtureFile({ s: "Ōtani – 大谷" })).toBe('{\n  "s": "\\u014ctani \\u2013 \\u5927\\u8c37"\n}\n');
    // Astral: a surrogate pair, lowercase hex. DEL is escaped; "/" is not.
    expect(formatFixtureFile({ s: "⚾🏟" })).toBe('{\n  "s": "\\u26be\\ud83c\\udfdf"\n}\n');
    expect(formatFixtureFile({ s: "a\u007fb/c" })).toBe('{\n  "s": "a\\u007fb/c"\n}\n');
    expect(formatFixtureFile({ s: "tab\there\u0001" })).toBe('{\n  "s": "tab\\there\\u0001"\n}\n');
    expect(formatFixtureFile({ a: [], o: {}, n: null, list: [1, "x"] })).toBe(
      '{\n  "a": [],\n  "o": {},\n  "n": null,\n  "list": [\n    1,\n    "x"\n  ]\n}\n',
    );
  });

  test("the output is pure ASCII and parses back to the same values", () => {
    const value = { name: CIEGO, nested: { team: "Leones del Escogido – Santo Domingo" } };
    const text = formatFixtureFile(value);
    expect(/^[\x20-\x7e\n]*$/.test(text)).toBe(true);
    expect(JSON.parse(text)).toEqual(value);
  });
});

describe("parseCapture", () => {
  test("reads the whole captureFromCli result, entries as a { key, entry } list", () => {
    const parsed = parseCapture(
      captureResult([{ key: CIEGO_KEY, entry: CIEGO_ENTRY }], {
        skippedTransport: [{ kind: "player", name: "Omar Linares", reason: "wikidata_transport" }],
      }),
    );
    expect(parsed.sportQid).toBe(SPORT_QID);
    expect(parsed.entries).toEqual([{ key: CIEGO_KEY, entry: CIEGO_ENTRY }]);
    expect(parsed.skippedTransport).toEqual([{ kind: "player", name: "Omar Linares", reason: "wikidata_transport" }]);
  });

  test("accepts a bare fixture, and the pre-NEO-346 keyed-object entries", () => {
    const bare = captureResult([{ key: CIEGO_KEY, entry: CIEGO_ENTRY }]).fixture;
    expect(parseCapture(bare).entries).toEqual([{ key: CIEGO_KEY, entry: CIEGO_ENTRY }]);
    const legacy = { ...bare, entries: { [CIEGO_KEY]: CIEGO_ENTRY } };
    expect(parseCapture({ fixture: legacy }).entries).toEqual([{ key: CIEGO_KEY, entry: CIEGO_ENTRY }]);
  });

  test("refuses a key that is not fixtureKey(kind, sportQid, name)", () => {
    expect(() =>
      parseCapture(captureResult([{ key: fixtureKey("league", SPORT_QID, "Ciego de Avila"), entry: CIEGO_ENTRY }])),
    ).toThrow(/does not match its own kind\/name/);
  });

  test("refuses a non-QID wikidataId, a duplicate key, a wrong version and a non-list", () => {
    const badId: EnrichmentFixtureEntry = { ...CIEGO_ENTRY, result: { wikidataId: "https://example.test/Q1" } };
    expect(() => parseCapture(captureResult([{ key: CIEGO_KEY, entry: badId }]))).toThrow(/non-QID/);
    expect(() =>
      parseCapture(
        captureResult([
          { key: CIEGO_KEY, entry: CIEGO_ENTRY },
          { key: CIEGO_KEY, entry: CIEGO_ENTRY },
        ]),
      ),
    ).toThrow(/twice/);
    expect(() => parseCapture({ fixture: { version: 2, sportQid: SPORT_QID, entries: [] } })).toThrow(/version 2/);
    expect(() => parseCapture({ fixture: { version: 1, sportQid: SPORT_QID, entries: "x" } })).toThrow(/list/);
    expect(() => parseCapture({ fixture: { version: 1, sportQid: SPORT_QID, entries: [{ key: 1 }] } })).toThrow(
      /#0/,
    );
  });
});

describe("mergeCaptureIntoFixtureText", () => {
  test("an accented name round-trips into the committed file as \\u escapes, additions only", () => {
    // Precondition: the name is not already recorded, so this is an addition.
    expect(JSON.parse(COMMITTED).entries[CIEGO_KEY]).toBeUndefined();
    const existingKey = Object.keys(JSON.parse(COMMITTED).entries)[0];
    const existing = JSON.parse(COMMITTED).entries[existingKey] as EnrichmentFixtureEntry;

    const capture = parseCapture(
      captureResult([
        { key: CIEGO_KEY, entry: CIEGO_ENTRY },
        // A key the file already holds with the same answer: left alone.
        { key: existingKey, entry: existing },
      ]),
    );
    const merged = mergeCaptureIntoFixtureText(COMMITTED, capture);

    expect(merged.added).toEqual([CIEGO_KEY]);
    expect(merged.unchanged).toEqual([existingKey]);
    expect(merged.differing).toEqual([]);
    expect(merged.replaced).toEqual([]);

    // Escaped exactly as Python would write it; no raw non-ASCII anywhere.
    expect(merged.text).toContain('    "league|Q5369|ciego de \\u00e1vila": {\n');
    expect(merged.text).toContain('      "name": "Ciego de \\u00c1vila",\n');
    expect(/^[\x20-\x7e\n]*$/.test(merged.text)).toBe(true);

    // Additions only: every committed line survives in order, and the new
    // lines are the one entry block plus nothing else.
    const added = addedLines(COMMITTED, merged.text);
    expect(added).toEqual([
      '    "league|Q5369|ciego de \\u00e1vila": {',
      '      "kind": "league",',
      '      "name": "Ciego de \\u00c1vila",',
      '      "result": {',
      '        "wikidataId": "Q5119616",',
      '        "yearsActive": {',
      '          "from": 1977',
      "        }",
      "      }",
      "    },",
    ]);

    // And it reads back as the runtime reads the file.
    const reread = parseFixtureFile(JSON.parse(merged.text));
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.fixture.entries[CIEGO_KEY]).toEqual(CIEGO_ENTRY);
    expect(reread.fixture.capturedAt).toBe(JSON.parse(COMMITTED).capturedAt);
    const keys = Object.keys(reread.fixture.entries);
    expect(keys).toEqual([...keys].sort());
  });

  test("merging the same capture twice changes nothing the second time", () => {
    const capture = parseCapture(captureResult([{ key: CIEGO_KEY, entry: CIEGO_ENTRY }]));
    const once = mergeCaptureIntoFixtureText(COMMITTED, capture);
    const twice = mergeCaptureIntoFixtureText(once.text, capture);
    expect(twice.added).toEqual([]);
    expect(twice.unchanged).toEqual([CIEGO_KEY]);
    expect(twice.text).toBe(once.text);
  });

  test("pages merge in any order to the same file", () => {
    const pageA = parseCapture(captureResult([{ key: CIEGO_KEY, entry: CIEGO_ENTRY }]));
    const pageB = parseCapture(captureResult([{ key: gwynnKey, entry: gwynn }]));
    const base = smallFile({});
    const ab = mergeCaptureIntoFixtureText(mergeCaptureIntoFixtureText(base, pageA).text, pageB).text;
    const ba = mergeCaptureIntoFixtureText(mergeCaptureIntoFixtureText(base, pageB).text, pageA).text;
    expect(ab).toBe(ba);
    expect(Object.keys(JSON.parse(ab).entries)).toEqual([CIEGO_KEY, gwynnKey]);
  });

  test("a key recorded with a different answer keeps the committed one unless --replace", () => {
    const base = smallFile({ [gwynnKey]: gwynn });
    const recaptured: EnrichmentFixtureEntry = { ...gwynn, result: null };
    const capture = parseCapture(captureResult([{ key: gwynnKey, entry: recaptured }]));

    const kept = mergeCaptureIntoFixtureText(base, capture);
    expect(kept.differing).toEqual([gwynnKey]);
    expect(kept.added).toEqual([]);
    expect(kept.text).toBe(base);

    const replaced = mergeCaptureIntoFixtureText(base, capture, { replace: true });
    expect(replaced.replaced).toEqual([gwynnKey]);
    expect(JSON.parse(replaced.text).entries[gwynnKey]).toEqual(recaptured);
  });

  test("the same answer with fields in another order is unchanged, not differing", () => {
    const base = smallFile({ [gwynnKey]: gwynn });
    const reordered = { result: gwynn.result, name: gwynn.name, kind: gwynn.kind } as EnrichmentFixtureEntry;
    const merged = mergeCaptureIntoFixtureText(base, parseCapture(captureResult([{ key: gwynnKey, entry: reordered }])));
    expect(merged.unchanged).toEqual([gwynnKey]);
    expect(merged.text).toBe(base);
  });

  test("refuses a capture for another sport", () => {
    const capture = parseCapture({
      fixture: {
        version: 1,
        capturedAt: "x",
        sportQid: "Q41466",
        entries: [
          { key: fixtureKey("player", "Q41466", "Vladislav Tretiak"), entry: { kind: "player", name: "Vladislav Tretiak", result: null } },
        ],
      },
    });
    expect(() => mergeCaptureIntoFixtureText(COMMITTED, capture)).toThrow(/sport Q41466.*records Q5369/);
  });

  test("refuses a file that is not in the committed format, so a merge never rewrites other lines", () => {
    const capture = parseCapture(captureResult([{ key: CIEGO_KEY, entry: CIEGO_ENTRY }]));
    const parsed = JSON.parse(COMMITTED);
    // Raw UTF-8 instead of \u escapes.
    expect(() => mergeCaptureIntoFixtureText(`${JSON.stringify(parsed, null, 2)}\n`, capture)).toThrow(
      /committed format/,
    );
    // No trailing newline.
    expect(() => mergeCaptureIntoFixtureText(COMMITTED.trimEnd(), capture)).toThrow(/committed format/);
    // Entries out of order.
    const [first, second] = Object.keys(parsed.entries);
    const swapped = { ...parsed, entries: { [second]: parsed.entries[second], [first]: parsed.entries[first] } };
    expect(() => mergeCaptureIntoFixtureText(formatFixtureFile(swapped), capture)).toThrow(/committed format/);
    // Not JSON, and not a valid fixture.
    expect(() => mergeCaptureIntoFixtureText("{", capture)).toThrow(/not JSON/);
    expect(() => mergeCaptureIntoFixtureText(formatFixtureFile({ version: 2 }), capture)).toThrow(/invalid/);
  });
});

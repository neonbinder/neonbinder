// NEO-330 — build -> check -> transform -> schema validation, end to end over
// the synthetic fixture export (make-fixture.mjs). No Convex, no network; the
// only processes are the `zip`/`unzip` binaries the scripts already need.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  TABLES,
  BUNDLE_TABLES,
  BUNDLE_FORMAT,
  decodeId,
  countIntegerLiterals,
  readZipText,
  makeTempDir,
  parseJsonl,
  walkIds,
} from "./lib.mjs";
import { buildBundle } from "./build.mjs";
import { parseBundle, transformBundle, emptyImportFiles, checkFiles, validateAgainstSchema } from "./transform.mjs";
import {
  makeFixtureExport,
  fixtureTables,
  fixtureTargetSports,
  FIXTURE_SOURCE_TABLE_NUMBERS,
  FIXTURE_TARGET_TABLE_NUMBERS,
  FIXTURE_REMAP_EXPECTED,
  FIXTURE_IMPORT_EXPECTED,
} from "./make-fixture.mjs";
import schema from "../../convex/schema";

const EXPORTED_SCHEMA = JSON.parse(schema.export());
const TARGET = new Map(Object.entries(FIXTURE_TARGET_TABLE_NUMBERS));

let dir;
let bundleZip;
let bundleFiles; // Map<path, text>
let manifest;
let ids; // the fixture's named ids

const clone = (files) => new Map(files);
const rowsOf = (files, table) => parseJsonl(files.get(`${table}/documents.jsonl`) ?? "", table);

beforeAll(async () => {
  dir = makeTempDir("pipeline-test");
  const fx = makeFixtureExport(path.join(dir, "export.zip"));
  ids = fx.ids;
  bundleZip = path.join(dir, "bundle.zip");
  ({ manifest } = await buildBundle(fx.path, bundleZip, { log: () => {} }));
  bundleFiles = readZipText(bundleZip);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("build", () => {
  test("carries exactly the eight tables, the manifest and sports.json, and nothing from the rest of the export", () => {
    const entries = [...bundleFiles.keys()].sort();
    const want = [
      "_tables/documents.jsonl",
      "manifest.json",
      "sports.json",
      ...BUNDLE_TABLES.flatMap((t) => [`${t}/documents.jsonl`, `${t}/generated_schema.jsonl`]),
    ].sort();
    expect(entries).toEqual(want);
  });

  test("row counts: only sport rows of selectorOptions, every row of the seven tables", () => {
    expect(manifest.counts).toEqual({ selectorOptions: 2, leagues: 2, franchises: 2, teams: 3, teamAliases: 3, players: 3, playerAliases: 3, playerSports: 2 });
    for (const t of BUNDLE_TABLES) expect(rowsOf(bundleFiles, t)).toHaveLength(manifest.counts[t]);
    expect(rowsOf(bundleFiles, "selectorOptions").every((r) => r.level === "sport")).toBe(true);
    expect(manifest.sports.selectorOptionsRowsScanned).toBe(3);
  });

  test("manifest shape: format, source table numbers, sports and recorded sections", () => {
    expect(manifest.format).toBe(BUNDLE_FORMAT);
    expect(manifest.tables).toEqual(BUNDLE_TABLES);
    expect(manifest.sourceTableNumbers).toEqual(Object.fromEntries(BUNDLE_TABLES.map((t) => [t, FIXTURE_SOURCE_TABLE_NUMBERS[t]])));
    expect(manifest.sports).toMatchObject({ count: 2, names: ["Baseball", "Curling"] });
    expect(manifest.integrity).toEqual(expect.objectContaining({ dangling: expect.any(Object), nonSportRefs: {}, outsideRefs: {}, rowsSkippedForBadId: {} }));
    expect(JSON.parse(bundleFiles.get("manifest.json")).format).toBe(BUNDLE_FORMAT);
  });

  test("createdByUserId is stripped from every row and the count recorded", () => {
    for (const t of BUNDLE_TABLES) for (const r of rowsOf(bundleFiles, t)) expect(r).not.toHaveProperty("createdByUserId");
    expect(manifest.strippedFields).toEqual({ selectorOptions: { createdByUserId: 1 }, players: { createdByUserId: 2 } });
  });

  test("sport rows keep their marketplace ids and sport config; children are cleared", () => {
    const { tables } = fixtureTables();
    const [baseball, curling] = rowsOf(bundleFiles, "selectorOptions");
    const src = Object.fromEntries(tables.selectorOptions.map((r) => [r.value, r]));
    expect(baseball.value).toBe("Baseball");
    expect(baseball.platformData).toEqual(src.Baseball.platformData);
    expect(baseball.primaryPlatformId).toEqual(src.Baseball.primaryPlatformId);
    expect(baseball.platformSlotSeq).toEqual(src.Baseball.platformSlotSeq);
    expect(baseball.sportConfig).toEqual(src.Baseball.sportConfig);
    expect(curling.platformData).toEqual(src.Curling.platformData);
    expect(baseball.children).toEqual([]);
    expect(manifest.clearedSportRowRefs).toEqual({ "selectorOptions.children": 1 });
  });

  test("sports.json lists each sport row by id and name", () => {
    const sports = JSON.parse(bundleFiles.get("sports.json"));
    expect(sports.map((s) => [s._id, s.value])).toEqual([
      [ids.S1, "Baseball"],
      [ids.S2, "Curling"],
    ]);
  });

  test("a reference to a team absent from the export is kept and recorded as dangling", () => {
    expect(manifest.integrity.dangling).toEqual({ "players.teamYears[].teamId": 1 });
    const p3 = rowsOf(bundleFiles, "players").find((r) => r._id === ids.P3);
    expect(p3.teamYears[0].teamId).toBe(ids.TX);
  });

  test("no row carries a bare integer literal (integral floats are written N.0)", () => {
    for (const t of BUNDLE_TABLES) expect(countIntegerLiterals(bundleFiles.get(`${t}/documents.jsonl`))).toBe(0);
    expect(bundleFiles.get("players/documents.jsonl")).toContain('"birthYear":2005.0');
  });

  test("a bundle under the load floors carries a `load will refuse` warning per short table", () => {
    const w = manifest.warnings.filter((x) => x.startsWith("load will refuse this bundle: "));
    expect(w.some((x) => /players: 3, needs at least 1000/.test(x))).toBe(true);
    expect(w.some((x) => /teams: 3, needs at least 100/.test(x))).toBe(true);
    expect(w.some((x) => x.includes("leagues"))).toBe(false); // 2 rows clears the floor of 1
    expect(w.every((x) => !x.includes("(manifest)"))).toBe(true);
  });

  test("throws on an export missing one of the eight tables rather than writing it empty", async () => {
    const partial = path.join(dir, "partial-export.zip");
    execFileSync("cp", [path.join(dir, "export.zip"), partial]);
    execFileSync("zip", ["-q", "-d", partial, "leagues/documents.jsonl", "leagues/generated_schema.jsonl"]);
    await expect(buildBundle(partial, path.join(dir, "partial-bundle.zip"), { log: () => {} })).rejects.toThrow(/export has no leagues\/documents\.jsonl/);
  });

  test("refuses an output that is not .zip or is the export itself", async () => {
    await expect(buildBundle(path.join(dir, "export.zip"), path.join(dir, "out.txt"), { log: () => {} })).rejects.toThrow(/\.zip/);
    await expect(buildBundle(path.join(dir, "export.zip"), path.join(dir, "export.zip"), { log: () => {} })).rejects.toThrow(/differ/);
  });
});

describe("check", () => {
  test("accepts the bundle, tolerating only the dangling reference the manifest recorded", () => {
    const r = checkFiles(bundleFiles);
    expect(r.problems).toEqual({});
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("bundle");
    expect(Object.keys(r.notes)).toEqual([expect.stringContaining("players.teamYears[].teamId dangling")]);
  });

  test("rejects a bare integer literal", () => {
    const f = clone(bundleFiles);
    f.set("players/documents.jsonl", f.get("players/documents.jsonl").replace('"birthYear":2005.0', '"birthYear":2005'));
    const r = checkFiles(f);
    expect(r.ok).toBe(false);
    expect(Object.keys(r.problems)).toEqual([expect.stringMatching(/players: plain integer literals/)]);
  });

  test("rejects a table outside the eight, in files and in _tables", () => {
    const f = clone(bundleFiles);
    f.set("users/documents.jsonl", "");
    expect(checkFiles(f).problems).toHaveProperty("unexpected table users");
    const g = clone(bundleFiles);
    g.set("_tables/documents.jsonl", g.get("_tables/documents.jsonl") + '{"name":"cardChecklist","id":10008}\n');
    expect(checkFiles(g).problems).toHaveProperty("unexpected table cardChecklist");
  });

  test("rejects more dangling references than the manifest recorded", () => {
    const f = clone(bundleFiles);
    const m = JSON.parse(f.get("manifest.json"));
    m.integrity.dangling = {};
    f.set("manifest.json", JSON.stringify(m));
    const r = checkFiles(f);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual({ "players.teamYears[].teamId dangling": 1 });
  });

  test("rejects a v1 manifest", () => {
    const f = clone(bundleFiles);
    const m = JSON.parse(f.get("manifest.json"));
    m.format = "neonbinder-reference-seed/1";
    f.set("manifest.json", JSON.stringify(m));
    expect(checkFiles(f).problems).toHaveProperty(`manifest format is not ${BUNDLE_FORMAT}`);
    expect(() => parseBundle(f)).toThrow(/bundle format is neonbinder-reference-seed\/1/);
  });

  test("rejects a surviving createdByUserId, a non-sport selectorOptions row and an id on the wrong table", () => {
    const withUser = clone(bundleFiles);
    withUser.set("players/documents.jsonl", withUser.get("players/documents.jsonl").replace('"birthYear"', '"createdByUserId":"u","birthYear"'));
    expect(checkFiles(withUser).problems).toHaveProperty("players.createdByUserId present");

    const nonSport = clone(bundleFiles);
    nonSport.set("selectorOptions/documents.jsonl", nonSport.get("selectorOptions/documents.jsonl").replace('"level":"sport"', '"level":"year"'));
    expect(checkFiles(nonSport).problems).toHaveProperty("selectorOptions: row that is not a sport");

    const wrongTable = clone(bundleFiles);
    wrongTable.set("leagues/documents.jsonl", bundleFiles.get("franchises/documents.jsonl"));
    expect(checkFiles(wrongTable).problems).toHaveProperty("leagues._id on the wrong table number");
  });

  test("rejects a manifest count that disagrees with the rows", () => {
    const f = clone(bundleFiles);
    const m = JSON.parse(f.get("manifest.json"));
    m.counts.teams = 99;
    f.set("manifest.json", JSON.stringify(m));
    expect(checkFiles(f).problems).toHaveProperty("manifest count for teams disagrees with its rows");
  });
});

// Which table an id in a given field must point at, stated independently of
// transform.mjs: it is the schema's own foreign-key map for these eight tables.
const FIELD_TARGET = {
  sportId: "selectorOptions",
  alsoSportIds: "selectorOptions",
  leagueId: "leagues",
  franchiseId: "franchises",
  teamId: "teams",
  playerId: "players",
};
const lastSegment = (p) => p.replace(/\[\]/g, "").split(".").pop();

/** Every id in every row must sit on the target number of the table its field points at. */
function expectEveryIdOnItsOwnTable(files, numbers, { skipSport = false } = {}) {
  let checked = 0;
  for (const t of BUNDLE_TABLES) {
    for (const row of rowsOf(files, t)) {
      expect(decodeId(row._id).table, `${t}._id`).toBe(numbers.get(t));
      walkIds(row, (p, d) => {
        if (p === "_id") return;
        const field = lastSegment(p);
        const target = FIELD_TARGET[field];
        expect(target, `unmapped id field ${t}.${p}`).toBeDefined();
        if (skipSport && target === "selectorOptions") return;
        expect(d.table, `${t}.${p}`).toBe(numbers.get(target));
        checked++;
      });
    }
  }
  return checked;
}

describe("transform, sports: import", () => {
  let out;
  let parsed;
  let before;
  beforeAll(() => {
    parsed = parseBundle(bundleFiles);
    before = JSON.stringify(parsed);
    out = transformBundle(parsed, { tableNumbers: TARGET }, { sports: "import" });
  });

  test("keeps every row of all eight tables", () => {
    expect(out.expected).toEqual(FIXTURE_IMPORT_EXPECTED);
    expect(out.tables).toEqual(BUNDLE_TABLES);
    for (const t of BUNDLE_TABLES) expect(rowsOf(out.files, t)).toHaveLength(FIXTURE_IMPORT_EXPECTED[t]);
  });

  test("no id is left on a wrong table number (production's numbers collide with a fresh deployment's)", () => {
    // The fixture's source `players` number is the target's `teamAliases` number:
    // a raw import would land player ids on the wrong table.
    expect(FIXTURE_SOURCE_TABLE_NUMBERS.players).toBe(FIXTURE_TARGET_TABLE_NUMBERS.teamAliases);
    expect(FIXTURE_SOURCE_TABLE_NUMBERS.selectorOptions).toBe(FIXTURE_TARGET_TABLE_NUMBERS.franchises);
    expect(expectEveryIdOnItsOwnTable(out.files, TARGET)).toBeGreaterThan(15);
  });

  test("the written _tables map is the target's numbers for the eight tables", () => {
    expect(out.files.get("_tables/documents.jsonl").trim().split("\n").map((l) => JSON.parse(l))).toEqual(
      BUNDLE_TABLES.map((name) => ({ name, id: FIXTURE_TARGET_TABLE_NUMBERS[name] })),
    );
  });

  test("a re-encoded id keeps its document part", () => {
    const p1 = rowsOf(out.files, "players").find((r) => r.name === "Fixture Player One");
    expect(decodeId(p1._id).internal).toEqual(decodeId(ids.P1).internal);
  });

  test("writes no bare integer literal", () => {
    for (const t of BUNDLE_TABLES) expect(countIntegerLiterals(out.files.get(`${t}/documents.jsonl`))).toBe(0);
    expect(out.files.get("players/documents.jsonl")).toContain('"birthYear":2005.0');
  });

  test("sport rows keep their marketplace platform data", () => {
    const { tables } = fixtureTables();
    const src = Object.fromEntries(tables.selectorOptions.filter((r) => r.level === "sport").map((r) => [r.value, r]));
    for (const row of rowsOf(out.files, "selectorOptions")) {
      expect(row.platformData).toEqual(src[row.value].platformData);
      expect(row.primaryPlatformId).toEqual(src[row.value].primaryPlatformId);
    }
  });

  test("the import ZIP passes its own check, tolerating the recorded dangling reference", () => {
    const r = checkFiles(out.files, { toleratedDangling: manifest.integrity.dangling });
    expect(r.problems).toEqual({});
  });

  test("copies the generated schemas through", () => {
    for (const t of BUNDLE_TABLES) expect(out.files.get(`${t}/generated_schema.jsonl`)).toBe(bundleFiles.get(`${t}/generated_schema.jsonl`));
  });

  test("leaves the parsed bundle it was given unchanged", () => {
    expect(JSON.stringify(parsed)).toBe(before);
  });

  test("the plan flags the tables a raw import would have collided on", () => {
    const by = Object.fromEntries(out.report.tableNumbers.map((n) => [n.table, n.raw]));
    expect(by.players).toMatch(/collide with target teamAliases/);
    expect(by.teams).toBe("same");
  });
});

describe("transform, sports: remap", () => {
  let out;
  let targetSports;
  let before;
  beforeAll(() => {
    targetSports = fixtureTargetSports();
    const parsed = parseBundle(bundleFiles);
    before = JSON.stringify(parsed);
    out = transformBundle(parsed, { tableNumbers: TARGET, sports: targetSports }, { sports: "remap" });
    out.parsed = parsed;
  });

  const byName = (table) => Object.fromEntries(rowsOf(out.files, table).map((r) => [r.name ?? r.aliasNormalized ?? r._id, r]));

  test("keeps the rows the fixture table says, and drops the rest", () => {
    expect(out.expected).toEqual(FIXTURE_REMAP_EXPECTED);
    expect(out.tables).toEqual(TABLES);
    expect(out.files.has("selectorOptions/documents.jsonl")).toBe(false);
    for (const t of TABLES) expect(rowsOf(out.files, t)).toHaveLength(FIXTURE_REMAP_EXPECTED[t]);
  });

  test("reports the sport mapping by exact name", () => {
    expect(out.report.sportMapping).toEqual([
      { name: "Baseball", outcome: "matched" },
      { name: "Curling", outcome: "dropped: absent on target" },
    ]);
  });

  test("no id inside the set is left on a wrong table number, and every sport id is the target's sport row", () => {
    expect(expectEveryIdOnItsOwnTable(out.files, TARGET, { skipSport: true })).toBeGreaterThan(5);
    const sportId = targetSports[0].sportId;
    for (const t of TABLES) {
      for (const r of rowsOf(out.files, t)) {
        expect(r.sportId).toBe(sportId);
        for (const s of r.alsoSportIds ?? []) expect(s).toBe(sportId);
      }
    }
  });

  test("drops a Curling row and its dependants, and says which kind of drop it was", () => {
    expect(out.report.rows.leagues.droppedBySport).toEqual({ Curling: 1 });
    expect(out.report.rows.teamAliases).toMatchObject({ droppedBySport: { Curling: 1 }, droppedAsDependant: 1 });
    expect(out.report.rows.playerAliases).toMatchObject({ droppedBySport: { Curling: 1 }, droppedAsDependant: 1 });
    expect(out.report.rows.players.droppedBySport).toEqual({ Curling: 1 });
  });

  test("blanks a kept team's league and franchise that were dropped, rather than leaving a dangling id", () => {
    const team = byName("teams")["Cross Sport Nine"];
    expect(team).toBeDefined();
    expect(team).not.toHaveProperty("leagueId");
    expect(team).not.toHaveProperty("franchiseId");
    const kept = byName("teams")["Fixture Nine"];
    expect(kept.leagueId).toBeDefined();
    expect(kept.franchiseId).toBeDefined();
    expect(out.report.repairs["teams.leagueId blanked (league dropped)"]).toBe(1);
    expect(out.report.repairs["teams.franchiseId blanked (franchise dropped)"]).toBe(1);
  });

  test("prunes a player's dropped team, drops an unmatched also-sport and keeps the matched one", () => {
    const p1 = byName("players")["Fixture Player One"];
    expect(p1.teamYears).toHaveLength(1);
    expect(p1.alsoSportIds).toBeUndefined();
    const p3 = byName("players")["Fixture Player Three"];
    expect(p3.alsoSportIds).toEqual([targetSports[0].sportId]);
    expect(out.report.repairs).toMatchObject({
      "players.teamYears entries removed (team dropped)": 1,
      "players.alsoSportIds elements dropped (sport unmatched)": 2,
      "players.alsoSportIds omitted (became empty)": 1,
    });
  });

  test("keeps the dangling team reference the export already had", () => {
    const p3 = byName("players")["Fixture Player Three"];
    expect(decodeId(p3.teamYears[0].teamId).internal).toEqual(decodeId(ids.TX).internal);
  });

  test("writes no bare integer literal", () => {
    for (const t of TABLES) expect(countIntegerLiterals(out.files.get(`${t}/documents.jsonl`))).toBe(0);
  });

  test("the import ZIP passes its own check when the sport table is named as external", () => {
    const r = checkFiles(out.files, {
      toleratedDangling: manifest.integrity.dangling,
      externalTableNumbers: { selectorOptions: TARGET.get("selectorOptions") },
    });
    expect(r.problems).toEqual({});
  });

  test("leaves the parsed bundle it was given unchanged", () => {
    expect(JSON.stringify(out.parsed)).toBe(before);
  });

  test("refuses when no bundle sport matches a target sport", () => {
    expect(() => transformBundle(parseBundle(bundleFiles), { tableNumbers: TARGET, sports: [{ sportId: "x", sport: "Hockey" }] }, { sports: "remap" })).toThrow(/nothing to import/);
  });

  test("an ambiguous target name (two rows) is dropped, never guessed", () => {
    const two = [...targetSports, { sportId: targetSports[0].sportId + "x", sport: "Baseball" }];
    expect(() => transformBundle(parseBundle(bundleFiles), { tableNumbers: TARGET, sports: two }, { sports: "remap" })).toThrow(/nothing to import/);
  });
});

describe("transform, argument checks", () => {
  test("rejects an unknown sports mode", () => {
    expect(() => transformBundle(parseBundle(bundleFiles), { tableNumbers: TARGET }, { sports: "both" })).toThrow(/"import" or "remap"/);
  });

  test("refuses to guess a table number the target does not have", () => {
    const partial = new Map(TARGET);
    partial.delete("players");
    expect(() => transformBundle(parseBundle(bundleFiles), { tableNumbers: partial }, { sports: "import" })).toThrow(/no players table/);
  });

  test("emptyImportFiles writes the eight tables empty at the target's numbers", () => {
    const f = emptyImportFiles(TARGET);
    for (const t of BUNDLE_TABLES) expect(f.get(`${t}/documents.jsonl`)).toBe("");
    expect(checkFiles(f).ok).toBe(true);
    const partial = new Map(TARGET);
    partial.delete("teams");
    expect(() => emptyImportFiles(partial)).toThrow(/no teams table/);
  });
});

// The early warning for the day a REQUIRED field is added to one of the eight
// tables (or a field is retyped): the bundle in prod's storage then fails the
// importer. Validated against the CURRENT convex/schema.ts.
describe("schema validation", () => {
  test("the fixture bundle validates against the current schema.ts", () => {
    const r = validateAgainstSchema(bundleFiles, EXPORTED_SCHEMA);
    expect(r.errors).toEqual({});
    expect(r.ok).toBe(true);
    expect(Object.keys(r.counts)).toEqual(BUNDLE_TABLES);
    expect(r.counts.players.rows).toBe(3);
  });

  test("the import-mode output validates against the current schema.ts", () => {
    const out = transformBundle(parseBundle(bundleFiles), { tableNumbers: TARGET }, { sports: "import" });
    const r = validateAgainstSchema(out.files, EXPORTED_SCHEMA);
    expect(r.errors).toEqual({});
  });

  test("the remap-mode output validates against the current schema.ts", () => {
    const out = transformBundle(parseBundle(bundleFiles), { tableNumbers: TARGET, sports: fixtureTargetSports() }, { sports: "remap" });
    const r = validateAgainstSchema(out.files, EXPORTED_SCHEMA);
    expect(r.errors).toEqual({});
    expect(Object.keys(r.counts)).toEqual(TABLES);
  });

  test("the validator does catch a missing required field, a retyped field and an unknown field", () => {
    const f = clone(bundleFiles);
    const rows = rowsOf(f, "teams").map((r, i) => {
      if (i === 0) delete r.name;
      if (i === 1) r.sportId = "not-an-id";
      if (i === 2) r.addedLater = "x";
      return r;
    });
    f.set("teams/documents.jsonl", rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const r = validateAgainstSchema(f, EXPORTED_SCHEMA);
    expect(r.ok).toBe(false);
    expect(Object.keys(r.errors).sort()).toEqual(["teams: addedLater: not in schema", "teams: name: missing", "teams: sportId: wrong type"]);
    expect(r.counts.teams.invalid).toBe(3);
  });

  test("a bare integer where the schema wants a float64 is accepted by the validator but caught by check", () => {
    // validateAgainstSchema treats any JSON number as float64; the bare-integer
    // guard is checkFiles' job, so both must run.
    const f = clone(bundleFiles);
    f.set("players/documents.jsonl", f.get("players/documents.jsonl").replace('"birthYear":2005.0', '"birthYear":2005'));
    expect(validateAgainstSchema(f, EXPORTED_SCHEMA).ok).toBe(true);
    expect(checkFiles(f).ok).toBe(false);
  });
});

#!/usr/bin/env node
// A tiny synthetic Convex snapshot export for the reference-seed tests
// (NEO-330). No real data: every name, id and marketplace slug is invented.
//
//   import { makeFixtureExport } from "./make-fixture.mjs";
//   const fx = makeFixtureExport("/tmp/x/fixture-export.zip");
//
//   node scripts/reference-seed/make-fixture.mjs <out-export.zip>
//
// It mirrors the real export's layout: root `_tables/documents.jsonl`,
// `<table>/documents.jsonl` + `<table>/generated_schema.jsonl`, a
// `_components/**` subtree and README.md.
//
// The two traps it encodes:
//
// 1. Table-number collision. Source numbers copy production's creation order
//    (FIXTURE_SOURCE_TABLE_NUMBERS). FIXTURE_TARGET_TABLE_NUMBERS numbers the
//    same tables the way a fresh deployment does (alphabetically), so a raw
//    import collides: the bundle's `players` number is the target's
//    `teamAliases`, its `selectorOptions` number is the target's `franchises`,
//    and `teams` happens to keep its number.
// 2. int64. Numbers are written the way the real export writes them, integral
//    float64 as "N.0" (birthYear 2005.0, fromYear 1990.0, lastUpdated
//    timestamps, platformSlotSeq counters, every fourth _creationTime). A
//    writer that round-trips through JSON.stringify emits "2005", which the
//    importer reads as int64 and a v.number() validator rejects.
//
// Sports: "Baseball" (on the remap target) and "Curling" (not on it), plus a
// non-sport year row the build must leave out. Sport rows carry invented
// marketplace ids in platformData, which import mode must keep. Baseball's
// `children` points at the year row and must be cleared at build; Curling
// carries createdByUserId, which must be stripped.
//
// Expected outcome in REMAP mode (target has Baseball, not Curling), by row:
//   leagues       L1 Baseball keep · L2 Curling drop
//   franchises    F1 Baseball keep · F2 Curling drop
//   teams         T1 keep · T2 keep, leagueId(L2) + franchiseId(F2) blanked · T3 Curling drop
//   teamAliases   A1→T1 keep · A2→T3 Curling drop by sport · A3 Baseball→T3 drop as dependant
//   players       P1 keep, teamYears T3 entry removed, alsoSportIds [Curling] omitted,
//                 createdByUserId stripped at build · P2 Curling drop ·
//                 P3 keep, alsoSportIds [Baseball, Curling] → [Baseball],
//                 teamYears holds a DANGLING team id (kept, recorded in the manifest)
//   playerAliases PA1→P1 keep · PA2→P2 Curling drop · PA3 Baseball→P2 drop as dependant
//   playerSports  PS1 P1/Curling drop · PS2 P3/Baseball keep
//   → kept: leagues 1, franchises 1, teams 2, teamAliases 1, players 2, playerAliases 1, playerSports 1
//
// Variant: makeFixtureExport(out, { emptyTables: ["playerSports"] }) writes
// playerSports as a 0-byte documents.jsonl, as production's export does.
// Every other table's expectation is unchanged; playerSports expects 0.
//
// Expected outcome in IMPORT mode: every row of the eight tables kept (2 sport
// rows, 2/2/3/3/3/3/2), every id re-encoded onto the target's numbers, sport
// rows' platformData unchanged.

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { encodeId, zipDir, makeTempDir, convexJson, requireZipTools } from "./lib.mjs";

/** Production-style creation-order numbers, as written into the fixture export. */
export const FIXTURE_SOURCE_TABLE_NUMBERS = Object.freeze({
  prizePool: 10001,
  selectorOptions: 10002,
  users: 10004,
  cardChecklist: 10008,
  players: 10009,
  teams: 10010,
  leagues: 10019,
  franchises: 10023,
  playerAliases: 10024,
  teamAliases: 10025,
  playerSports: 10029,
});

/** A fresh deployment's numbers for the same tables (alphabetical from 10001). */
export const FIXTURE_TARGET_TABLE_NUMBERS = Object.freeze(
  Object.fromEntries(
    Object.keys(FIXTURE_SOURCE_TABLE_NUMBERS)
      .sort()
      .map((t, i) => [t, 10001 + i]),
  ),
);

/** Expected kept rows per table after a REMAP load onto a Baseball-only target. */
export const FIXTURE_REMAP_EXPECTED = Object.freeze({
  leagues: 1,
  franchises: 1,
  teams: 2,
  teamAliases: 1,
  players: 2,
  playerAliases: 1,
  playerSports: 1,
});

/** Expected rows per table after an IMPORT load (nothing dropped). */
export const FIXTURE_IMPORT_EXPECTED = Object.freeze({
  selectorOptions: 2,
  leagues: 2,
  franchises: 2,
  teams: 3,
  teamAliases: 3,
  players: 3,
  playerAliases: 3,
  playerSports: 2,
});

/** Deterministic, globally unique 16-byte internal ids. */
function makeIdFactory(numbers) {
  let n = 0;
  return (table) => {
    n++;
    const internal = new Uint8Array(16);
    internal[0] = 0x4e; // "N"
    internal[1] = 0x42; // "B"
    internal[14] = (n >> 8) & 0xff;
    internal[15] = n & 0xff;
    return encodeId(numbers[table], internal);
  };
}

/**
 * The fixture's rows, keyed by table, plus the named ids tests assert on.
 * Pure: no I/O.
 *
 * @param {{ emptyTables?: string[] }} [opts] tables to write with no rows (a
 *   0-byte documents.jsonl in the export), the way production's playerSports
 *   is. Only tables nothing else references may be emptied (playerSports), so
 *   the default fixture's expectations hold for every other table.
 */
export function fixtureTables({ emptyTables = [] } = {}) {
  const id = makeIdFactory(FIXTURE_SOURCE_TABLE_NUMBERS);
  let clock = 1_700_000_000_000;
  // Mostly fractional like real _creationTime values; every fourth integral,
  // the case that slipped through in production rows.
  let ctN = 0;
  const ct = () => (clock += 1000) + (++ctN % 4 === 0 ? 0 : 0.5);

  const S1 = id("selectorOptions"); // Baseball
  const S2 = id("selectorOptions"); // Curling
  const Y1 = id("selectorOptions"); // a year row, not a sport
  const L1 = id("leagues"), L2 = id("leagues");
  const F1 = id("franchises"), F2 = id("franchises");
  const T1 = id("teams"), T2 = id("teams"), T3 = id("teams"), TX = id("teams"); // TX never written
  const P1 = id("players"), P2 = id("players"), P3 = id("players");
  const A1 = id("teamAliases"), A2 = id("teamAliases"), A3 = id("teamAliases");
  const PA1 = id("playerAliases"), PA2 = id("playerAliases"), PA3 = id("playerAliases");
  const PS1 = id("playerSports"), PS2 = id("playerSports");
  const U1 = id("users");

  const tables = {
    selectorOptions: [
      {
        _id: S1,
        _creationTime: ct(),
        level: "sport",
        value: "Baseball",
        platformData: { bsc: { "1": "fixture-bsc-baseball" }, sportlots: { "1": "FXB" } },
        primaryPlatformId: { bsc: "fixture-bsc-baseball", sportlots: "FXB" },
        platformSlotSeq: { bsc: 1, sportlots: 1 },
        children: [Y1],
        sportConfig: { skuCode: "BB", espn: { path: "baseball/mlb", leagueName: "MLB" } },
        lastUpdated: 1759999999999,
      },
      {
        _id: S2,
        _creationTime: ct(),
        level: "sport",
        value: "Curling",
        platformData: { bsc: { "1": "fixture-bsc-curling" } },
        children: [],
        createdByUserId: "user_fixture",
        lastUpdated: 1,
      },
      { _id: Y1, _creationTime: ct(), level: "year", value: "1989", parentId: S1, platformData: {}, lastUpdated: 1 },
    ],
    leagues: [
      { _id: L1, _creationTime: ct(), name: "Fixture League", abbreviation: "FXL", nameNormalized: "fixture league", sportId: S1, level: "major", lastUpdated: 1 },
      { _id: L2, _creationTime: ct(), name: "Fixture Curling League", nameNormalized: "curling fixture league", sportId: S2, lastUpdated: 1 },
    ],
    franchises: [
      { _id: F1, _creationTime: ct(), name: "Fixture Nine", nameNormalized: "fixture nine", sportId: S1, lastUpdated: 1 },
      { _id: F2, _creationTime: ct(), name: "Fixture Stones", nameNormalized: "fixture stones", sportId: S2, lastUpdated: 1 },
    ],
    teams: [
      { _id: T1, _creationTime: ct(), name: "Fixture Nine", nameNormalized: "fixture nine", sportId: S1, leagueId: L1, franchiseId: F1, location: "Fixture City", lastUpdated: 1 },
      { _id: T2, _creationTime: ct(), name: "Cross Sport Nine", nameNormalized: "cross nine sport", sportId: S1, leagueId: L2, franchiseId: F2, lastUpdated: 1 },
      { _id: T3, _creationTime: ct(), name: "Fixture Stones", nameNormalized: "fixture stones", sportId: S2, leagueId: L2, franchiseId: F2, lastUpdated: 1 },
    ],
    teamAliases: [
      { _id: A1, _creationTime: ct(), teamId: T1, sportId: S1, aliasNormalized: "nine" },
      { _id: A2, _creationTime: ct(), teamId: T3, sportId: S2, aliasNormalized: "stones" },
      { _id: A3, _creationTime: ct(), teamId: T3, sportId: S1, aliasNormalized: "stones bb" },
    ],
    players: [
      { _id: P1, _creationTime: ct(), name: "Fixture Player One", nameNormalized: "fixture one player", sportId: S1, teamYears: [{ teamId: T1, fromYear: 1990, toYear: 1995 }, { teamId: T3, fromYear: 1996 }], alsoSportIds: [S2], createdByUserId: "user_fixture", birthYear: 2005, lastUpdated: 1759999999999 },
      { _id: P2, _creationTime: ct(), name: "Fixture Curler", nameNormalized: "curler fixture", sportId: S2, createdByUserId: "user_fixture", lastUpdated: 1 },
      { _id: P3, _creationTime: ct(), name: "Fixture Player Three", nameNormalized: "fixture player three", sportId: S1, teamYears: [{ teamId: TX, fromYear: 2001 }], alsoSportIds: [S1, S2], isHallOfFame: true, birthYear: 1972, lastUpdated: 1759999999999.25 },
    ],
    playerAliases: [
      { _id: PA1, _creationTime: ct(), playerId: P1, sportId: S1, aliasNormalized: "one" },
      { _id: PA2, _creationTime: ct(), playerId: P2, sportId: S2, aliasNormalized: "curler" },
      { _id: PA3, _creationTime: ct(), playerId: P2, sportId: S1, aliasNormalized: "curler bb" },
    ],
    playerSports: [
      { _id: PS1, _creationTime: ct(), playerId: P1, sportId: S2, nameNormalized: "fixture one player" },
      { _id: PS2, _creationTime: ct(), playerId: P3, sportId: S1, nameNormalized: "fixture player three" },
    ],
    // Outside the reference set: the build must ignore these.
    users: [{ _id: U1, _creationTime: ct(), name: "Fixture User" }],
    cardChecklist: [{ _id: id("cardChecklist"), _creationTime: ct(), selectorOptionId: Y1, playerId: P1 }],
    prizePool: [],
  };

  for (const t of emptyTables) {
    if (!(t in tables)) throw new Error(`fixtureTables: no table ${t}`);
    if (t !== "playerSports") throw new Error(`fixtureTables: emptying ${t} would leave references dangling; only playerSports may be emptied`);
    tables[t] = [];
  }

  const ids = { S1, S2, Y1, L1, L2, F1, F2, T1, T2, T3, TX, P1, P2, P3, A1, A2, A3, PA1, PA2, PA3, PS1, PS2, U1 };
  return { tables, ids };
}

/**
 * Target sports for a REMAP transform: Baseball only, on the target's
 * selectorOptions number (so the ids differ from the bundle's).
 */
export function fixtureTargetSports() {
  const id = makeIdFactory(FIXTURE_TARGET_TABLE_NUMBERS);
  return [{ sportId: id("selectorOptions"), sport: "Baseball" }];
}

/**
 * Writes the fixture export ZIP.
 * @param {string} outZip
 * @param {{ emptyTables?: string[] }} [opts] see fixtureTables()
 * @returns {{ path: string, ids: Record<string,string>, tables: Record<string, object[]> }}
 */
export function makeFixtureExport(outZip, { emptyTables = [] } = {}) {
  requireZipTools();
  const out = path.resolve(outZip);
  const { tables, ids } = fixtureTables({ emptyTables });
  const dir = makeTempDir("fixture");
  try {
    const w = (rel, body) => {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), body);
    };
    w("README.md", "# Welcome to your Convex snapshot export!\n");
    w(
      "_tables/documents.jsonl",
      Object.entries(FIXTURE_SOURCE_TABLE_NUMBERS)
        .map(([name, n]) => JSON.stringify({ name, id: n }))
        .join("\n") + "\n",
    );
    for (const [t, rows] of Object.entries(tables)) {
      // Real-export number notation: integral float64 values as "N.0".
      w(`${t}/documents.jsonl`, rows.map((r) => convexJson(r) + "\n").join(""));
      w(`${t}/generated_schema.jsonl`, '"uniform"\n');
    }
    w("_components/fixturePool/_tables/documents.jsonl", JSON.stringify({ name: "work", id: 10001 }) + "\n");
    w("_components/fixturePool/work/documents.jsonl", "");
    w("_components/fixturePool/work/generated_schema.jsonl", '"uniform"\n');
    zipDir(dir, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { path: out, ids, tables };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const out = process.argv[2];
  if (!out || process.argv.length > 3) {
    console.error("usage: node make-fixture.mjs <out-export.zip>");
    process.exit(2);
  }
  const fx = makeFixtureExport(out);
  console.log(`fixture export: ${fx.path}`);
}

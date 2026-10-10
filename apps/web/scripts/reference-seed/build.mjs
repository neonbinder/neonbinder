// buildBundle(exportZip, outZip): cut the reference seed out of a full Convex
// snapshot export (`npx convex export --prod --path X.zip`).
//
// The bundle is a small snapshot-format ZIP:
//
//   _tables/documents.jsonl          {name,id} for the eight tables, with the
//                                    SOURCE table numbers (load re-encodes ids
//                                    onto the target's)
//   selectorOptions/documents.jsonl  the level == "sport" rows only, marketplace
//                                    ids kept, `children` cleared (it points at
//                                    year rows the bundle does not carry)
//   <table>/documents.jsonl          the seven reference tables, `_id` and
//                                    `_creationTime` kept, STRIP_FIELDS removed
//   <table>/generated_schema.jsonl   copied verbatim when the export has it
//   sports.json                      [{_id, value, sportConfig}] per sport row
//                                    (remap mode matches these by name)
//   manifest.json                    format, provenance, counts, stripped
//                                    fields, id-reference shapes, integrity
//
// Streams each export entry through `unzip -p`; the export is never extracted
// to disk. Prints counts, table names, field paths and sport names only.

import { mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import {
  TABLES,
  SPORT_TABLE,
  BUNDLE_TABLES,
  BUNDLE_FORMAT,
  STRIP_FIELDS,
  SPORT_ROW_CLEARED_ARRAYS,
  SUSPICIOUS_KEY,
  decodeId,
  walkIds,
  listZip,
  zipJsonl,
  readZipEntry,
  readTableNumbers,
  requireZipTools,
  zipDir,
  JsonlWriter,
  makeTempDir,
  tablesJsonl,
  fmt,
} from "./lib.mjs";

const bump = (obj, k, by = 1) => (obj[k] = (obj[k] ?? 0) + by);

/**
 * @param {string} exportZip a full snapshot export
 * @param {string} outZip    the bundle to write (must end in .zip)
 * @param {{ log?: (line: string) => void }} [opts]
 * @returns {Promise<{ manifest: object }>} the manifest written into the bundle
 */
export async function buildBundle(exportZip, outZip, { log = console.log } = {}) {
  requireZipTools();
  outZip = path.resolve(outZip);
  if (!outZip.endsWith(".zip")) throw new Error("output must end in .zip");
  if (path.resolve(exportZip) === outZip) throw new Error("output must differ from the export");
  statSync(exportZip); // throws ENOENT with the path

  const entries = listZip(exportZip);
  const warnings = [];

  // ── Table numbers ─────────────────────────────────────────────────────────
  // Prefer `_tables`; fall back to the first row's `_id` (the inference the
  // Convex importer makes) for any table it does not list.
  const sourceNumbers = await readTableNumbers(exportZip, entries);
  if (sourceNumbers.size === 0) warnings.push("export has no _tables/documents.jsonl; table numbers inferred from _id");
  for (const t of BUNDLE_TABLES) {
    const e = `${t}/documents.jsonl`;
    if (!entries.has(e)) {
      if (t === SPORT_TABLE) throw new Error(`export has no ${e}; cannot carry the sport rows`);
      warnings.push(`export has no ${e}; ${t} will be written empty`);
    }
  }
  for (const t of BUNDLE_TABLES) {
    if (sourceNumbers.has(t) || !entries.has(`${t}/documents.jsonl`)) continue;
    for await (const o of zipJsonl(exportZip, `${t}/documents.jsonl`)) {
      const d = decodeId(o._id);
      if (d) sourceNumbers.set(t, d.table);
      break;
    }
  }
  for (const t of BUNDLE_TABLES) {
    if (!sourceNumbers.has(t)) throw new Error(`no table number for ${t}: not in _tables and no rows to infer it from`);
  }
  const numberToTable = new Map([...sourceNumbers].map(([n, num]) => [num, n]));

  const staging = makeTempDir("bundle");
  const counts = {};
  const stripped = {}; // table -> field -> rows
  const cleared = {}; // "selectorOptions.children" -> ids removed
  const suspiciousKeys = {}; // table -> Set(key)
  const keysSeen = {}; // table -> Set(top-level key)
  const perSport = {}; // table -> sport name -> rows
  const idRefs = {}; // "table.path" -> { table, count }
  const dangling = {}; // "table.path" -> refs into the set whose row is absent
  const nonSportRefs = {}; // "table.path" -> selectorOptions refs that are not sport rows
  const outsideRefs = {}; // "table.path" -> ids into tables outside the eight
  const badIds = {}; // table -> rows skipped for a missing/invalid/wrong-table _id
  const idsByTable = new Map(BUNDLE_TABLES.map((t) => [t, new Set()]));
  const sports = [];
  const sportValueById = new Map();
  let selectorRows = 0;

  const noteRow = (table, row) => {
    for (const f of STRIP_FIELDS) {
      if (f in row) {
        delete row[f];
        bump((stripped[table] ??= {}), f);
      }
    }
    for (const k of Object.keys(row)) {
      keysSeen[table].add(k);
      if (SUSPICIOUS_KEY.test(k)) (suspiciousKeys[table] ??= new Set()).add(k);
    }
  };

  // Every in-set reference is checked once all eight id sets are known.
  const pendingRefs = []; // [key, targetTable, idString]
  const collectRefs = (table, row) =>
    walkIds(row, (p, dec, _set, str) => {
      if (p === "_id") return;
      const key = `${table}.${p}`;
      const target = numberToTable.get(dec.table) ?? `#${dec.table}`;
      idRefs[key] ??= { table: target, count: 0 };
      idRefs[key].count++;
      if (idsByTable.has(target)) pendingRefs.push([key, target, str]);
      else bump(outsideRefs, key);
    });

  try {
    // ── Sport rows ──────────────────────────────────────────────────────────
    keysSeen[SPORT_TABLE] = new Set();
    const sportRows = [];
    for await (const o of zipJsonl(exportZip, `${SPORT_TABLE}/documents.jsonl`)) {
      selectorRows++;
      if (o.level !== "sport") continue;
      const d = decodeId(o._id);
      if (!d || d.table !== sourceNumbers.get(SPORT_TABLE) || typeof o.value !== "string") {
        bump(badIds, SPORT_TABLE);
        continue;
      }
      for (const f of SPORT_ROW_CLEARED_ARRAYS) {
        if (Array.isArray(o[f]) && o[f].length) {
          bump(cleared, `${SPORT_TABLE}.${f}`, o[f].length);
          o[f] = [];
        }
      }
      noteRow(SPORT_TABLE, o);
      idsByTable.get(SPORT_TABLE).add(o._id);
      sportValueById.set(o._id, o.value);
      const s = { _id: o._id, value: o.value };
      if (o.sportConfig !== undefined) s.sportConfig = o.sportConfig;
      sports.push(s);
      sportRows.push(o);
    }
    const names = sports.map((s) => s.value);
    const dupNames = [...new Set(names.filter((v, i) => names.indexOf(v) !== i))];
    if (dupNames.length) warnings.push(`sport name(s) on more than one sport row: ${dupNames.join(", ")}`);
    if (sports.length === 0) throw new Error("export holds no sport rows");

    mkdirSync(path.join(staging, SPORT_TABLE), { recursive: true });
    {
      const w = new JsonlWriter(path.join(staging, SPORT_TABLE, "documents.jsonl"));
      for (const row of sportRows) {
        collectRefs(SPORT_TABLE, row);
        await w.write(row);
      }
      await w.close();
      counts[SPORT_TABLE] = w.count;
    }

    // ── The seven reference tables ──────────────────────────────────────────
    for (const table of TABLES) {
      const src = `${table}/documents.jsonl`;
      mkdirSync(path.join(staging, table), { recursive: true });
      const w = new JsonlWriter(path.join(staging, table, "documents.jsonl"));
      keysSeen[table] = new Set();
      perSport[table] = {};
      if (entries.has(src)) {
        for await (const row of zipJsonl(exportZip, src)) {
          const d = decodeId(row._id);
          if (!d || d.table !== sourceNumbers.get(table)) {
            bump(badIds, table);
            continue; // never ship a row the importer would reject
          }
          idsByTable.get(table).add(row._id);
          noteRow(table, row);
          bump(perSport[table], sportValueById.get(row.sportId) ?? "(unknown sport id)");
          collectRefs(table, row);
          await w.write(row);
        }
      }
      await w.close();
      counts[table] = w.count;
    }

    for (const [key, target, str] of pendingRefs) {
      if (idsByTable.get(target).has(str)) continue;
      // A selectorOptions id that is not one of the sport rows is a different
      // failure from a reference to a deleted row.
      if (target === SPORT_TABLE) bump(nonSportRefs, key);
      else bump(dangling, key);
    }

    for (const t of BUNDLE_TABLES) {
      const schemaEntry = `${t}/generated_schema.jsonl`;
      if (entries.has(schemaEntry)) writeFileSync(path.join(staging, t, "generated_schema.jsonl"), readZipEntry(exportZip, schemaEntry));
    }
    mkdirSync(path.join(staging, "_tables"), { recursive: true });
    writeFileSync(path.join(staging, "_tables", "documents.jsonl"), tablesJsonl(BUNDLE_TABLES, sourceNumbers));
    writeFileSync(path.join(staging, "sports.json"), JSON.stringify(sports, null, 2) + "\n");

    const manifest = {
      format: BUNDLE_FORMAT,
      source: "convex snapshot export",
      sourceFile: path.basename(exportZip),
      generatedAt: new Date().toISOString(),
      tables: BUNDLE_TABLES,
      sourceTableNumbers: Object.fromEntries(BUNDLE_TABLES.map((t) => [t, sourceNumbers.get(t)])),
      counts,
      sports: { count: sports.length, names, selectorOptionsRowsScanned: selectorRows },
      rowsPerSport: perSport,
      strippedFields: stripped,
      clearedSportRowRefs: cleared,
      topLevelKeys: Object.fromEntries(Object.entries(keysSeen).map(([t, s]) => [t, [...s].sort()])),
      idRefs,
      integrity: { dangling, nonSportRefs, outsideRefs, rowsSkippedForBadId: badIds },
      warnings,
    };
    writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

    zipDir(staging, outZip);

    // ── Report (counts, names, shapes; never row contents) ──────────────────
    log(`bundle: ${outZip}`);
    log(`source: ${path.basename(exportZip)}`);
    log(`sports: ${sports.length} sport rows (of ${fmt(selectorRows)} selectorOptions rows scanned): ${names.join(", ")}`);
    log("rows:");
    for (const t of BUNDLE_TABLES) log(`  ${t.padEnd(16)} ${fmt(counts[t]).padStart(9)}   (source table #${sourceNumbers.get(t)})`);
    const section = (label, obj) => {
      const e = Object.entries(obj);
      if (!e.length) return;
      log(`${label}:`);
      for (const [k, n] of e.sort()) log(`  ${k}: ${fmt(n)}`);
    };
    for (const t of Object.keys(stripped)) section(`stripped fields (${t}, rows)`, stripped[t]);
    section("sport-row references cleared (ids)", cleared);
    log("id references found (shape only):");
    for (const [k, v] of Object.entries(idRefs).sort()) log(`  ${k} -> ${v.table}: ${fmt(v.count)}`);
    section("DANGLING refs (target row absent from the export; kept, recorded in the manifest)", dangling);
    section("selectorOptions refs that are NOT sport rows", nonSportRefs);
    section("ids pointing OUTSIDE the eight tables", outsideRefs);
    section("rows SKIPPED for a missing/invalid _id", badIds);
    for (const [t, s] of Object.entries(suspiciousKeys)) log(`REVIEW: ${t} has user/audit-looking keys not stripped: ${[...s].join(", ")}`);
    for (const w of warnings) log(`warning: ${w}`);
    return { manifest };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

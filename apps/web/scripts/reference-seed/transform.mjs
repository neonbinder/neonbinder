// Pure functions over reference-seed ZIP contents (NEO-330).
//
// Everything here takes and returns plain data: a ZIP is represented as
// Map<entryPath, text>. Nothing spawns a process, touches the network or the
// file system, so unit tests call these directly. cli.mjs does the I/O around
// them.
//
//   parseBundle(files)                     bundle ZIP contents → structured bundle
//   transformBundle(bundle, target, opts)  bundle → import ZIP contents, both sport modes
//   emptyImportFiles(targetNumbers)        the eight tables, empty (the `clear` import)
//   checkFiles(files, opts)                structural integrity of a bundle or import ZIP
//   validateAgainstSchema(files, schema)   rows vs `schema.export()` validators
//
// Reports carry counts, table names, field paths and NB sport names only,
// never row contents.

import {
  TABLES,
  SPORT_TABLE,
  BUNDLE_TABLES,
  BUNDLE_FORMAT,
  STRIP_FIELDS,
  SPORT_ID_FIELD,
  SPORT_ID_ARRAY_FIELD,
  SPORT_ID_FIELDS,
  decodeId,
  retableId,
  walkIds,
  countIntegerLiterals,
  toJsonl,
  tablesJsonl,
  parseJsonl,
  jsonlLines,
  parseTableNumbers,
} from "./lib.mjs";

const bump = (o, k, by = 1) => (o[k] = (o[k] ?? 0) + by);
const asMap = (m) => (m instanceof Map ? m : new Map(Object.entries(m ?? {})));

// ── Bundle ──────────────────────────────────────────────────────────────────

/**
 * @param {Map<string,string>} files bundle ZIP contents
 * @returns {{
 *   manifest: object,
 *   sports: Array<{_id:string, value:string, sportConfig?:object}>,
 *   tableNumbers: Map<string,number>,
 *   tables: Record<string, object[]>,
 *   generatedSchemas: Record<string, string>,
 * }}
 */
export function parseBundle(files) {
  for (const need of ["manifest.json", "_tables/documents.jsonl"]) {
    if (!files.has(need)) throw new Error(`bundle has no ${need}; build it with \`cli.mjs build\``);
  }
  const manifest = JSON.parse(files.get("manifest.json"));
  if (manifest.format !== BUNDLE_FORMAT) {
    throw new Error(`bundle format is ${manifest.format ?? "unknown"}, expected ${BUNDLE_FORMAT}; rebuild it from a fresh export`);
  }
  const sports = files.has("sports.json") ? JSON.parse(files.get("sports.json")) : [];
  const tables = {};
  const generatedSchemas = {};
  for (const t of BUNDLE_TABLES) {
    const e = `${t}/documents.jsonl`;
    tables[t] = files.has(e) ? parseJsonl(files.get(e), e) : [];
    const s = `${t}/generated_schema.jsonl`;
    if (files.has(s)) generatedSchemas[t] = files.get(s);
  }
  return { manifest, sports, tableNumbers: parseTableNumbers(files.get("_tables/documents.jsonl")), tables, generatedSchemas };
}

// ── Transform ───────────────────────────────────────────────────────────────

/**
 * Builds the import ZIP contents for one target deployment.
 *
 * Both modes re-encode every id inside the set onto the TARGET's table
 * numbers: a Convex id embeds its table number and a snapshot import keeps
 * the exported one, and production's creation-order numbers collide with a
 * fresh deployment's, so a raw import fails or, worse, lands ids on the wrong
 * table.
 *
 * - `sports: "import"` (CI, after a reset that left the eight tables alone):
 *   the bundle's sport rows are imported as rows of their own, marketplace ids
 *   and all, and replace the target's whole selectorOptions table. Nothing is
 *   dropped; sport ids are re-encoded like any other id.
 * - `sports: "remap"` (a developer's deployment): selectorOptions is not
 *   imported. Each bundle sport maps by exact name to the ONE target sport row
 *   with that name; rows of an unmatched sport are dropped with their
 *   dependants, and references to dropped rows are repaired.
 *
 * @param {ReturnType<typeof parseBundle>} bundle
 * @param {{ tableNumbers: Map<string,number>|Record<string,number>,
 *           sports?: Array<{sportId:string, sport:string}> }} target
 *   `sports` (from splitTeamLocations:listSportsForSplit) is required for remap.
 * @param {{ sports: "import"|"remap" }} opts
 */
export function transformBundle(bundle, target, { sports: mode }) {
  if (mode !== "import" && mode !== "remap") throw new Error(`sports mode must be "import" or "remap", got ${mode}`);
  const T = asMap(target.tableNumbers);
  const B = bundle.tableNumbers;
  const tables = mode === "import" ? BUNDLE_TABLES : TABLES;
  for (const t of tables) {
    if (!T.has(t)) throw new Error(`target has no ${t} table in its _tables map; refusing to guess a number`);
    if (!B.has(t)) throw new Error(`bundle has no source table number for ${t}`);
  }
  const bNumToTable = new Map([...B].map(([t, n]) => [n, t]));
  const sportRows = bundle.tables[SPORT_TABLE] ?? [];
  if (mode === "import" && sportRows.length === 0) throw new Error("bundle carries no sport rows; import mode needs them");

  // Work on copies: the caller's parsed bundle stays untouched.
  const clone = (rows) => rows.map((r) => structuredClone(r));

  const report = {
    mode,
    rows: {}, // table -> { bundle, kept, droppedBySport, droppedAsDependant }
    sportNames: [], // NB sport names in the bundle
    sportMapping: [], // remap: { name, outcome }
    repairs: {},
    reencoded: {}, // "table.path" -> count
    foreignIds: {}, // "table.path" -> count (number not in the bundle's _tables)
  };
  const files = new Map();

  // Bundle sport id -> name, from the sport rows (fall back to sports.json).
  const sportName = new Map();
  for (const s of sportRows.length ? sportRows : bundle.sports) sportName.set(s._id, s.value);
  report.sportNames = [...sportName.values()];

  const reencode = (table, row, skipKeys) =>
    walkIds(
      row,
      (p, dec, set, str) => {
        const t = bNumToTable.get(dec.table);
        if (t && T.has(t) && (mode === "import" || t !== SPORT_TABLE)) {
          const nv = retableId(str, T.get(t));
          if (nv !== str) set(nv);
          bump(report.reencoded, `${table}.${p}`);
        } else {
          bump(report.foreignIds, `${table}.${p}`);
        }
      },
      skipKeys,
    );

  if (mode === "import") {
    for (const t of BUNDLE_TABLES) {
      const rows = clone(bundle.tables[t] ?? []);
      for (const row of rows) reencode(t, row, new Set());
      report.rows[t] = { bundle: rows.length, kept: rows.length, droppedBySport: {}, droppedAsDependant: 0 };
      files.set(`${t}/documents.jsonl`, toJsonl(rows, t));
      if (bundle.generatedSchemas[t] !== undefined) files.set(`${t}/generated_schema.jsonl`, bundle.generatedSchemas[t]);
    }
  } else {
    const targetSports = target.sports ?? [];
    const targetByName = new Map();
    for (const s of targetSports) targetByName.set(s.sport, [...(targetByName.get(s.sport) ?? []), s.sportId]);
    const sportMap = new Map(); // bundle sport id -> target sport id
    for (const [id, name] of sportName) {
      const hits = targetByName.get(name) ?? [];
      if (hits.length === 1) {
        sportMap.set(id, hits[0]);
        report.sportMapping.push({ name, outcome: "matched" });
      } else {
        report.sportMapping.push({ name, outcome: hits.length ? `dropped: ambiguous (${hits.length} target rows)` : "dropped: absent on target" });
      }
    }
    if (sportMap.size === 0) throw new Error("no bundle sport matches a target sport; nothing to import");

    const dropped = new Map(TABLES.map((t) => [t, new Set()]));
    const isDropped = (t, id) => dropped.get(t).has(id);
    const repairs = (report.repairs = {
      "teams.leagueId blanked (league dropped)": 0,
      "teams.franchiseId blanked (franchise dropped)": 0,
      "players.teamYears entries removed (team dropped)": 0,
      "players.teamYears omitted (became empty)": 0,
      "players.alsoSportIds elements dropped (sport unmatched)": 0,
      "players.alsoSportIds omitted (became empty)": 0,
    });

    for (const table of TABLES) {
      const st = (report.rows[table] = { bundle: 0, kept: 0, droppedBySport: {}, droppedAsDependant: 0 });
      const out = [];
      for (const row of clone(bundle.tables[table] ?? [])) {
        st.bundle++;
        const targetSport = sportMap.get(row[SPORT_ID_FIELD]);
        if (!targetSport) {
          bump(st.droppedBySport, sportName.get(row[SPORT_ID_FIELD]) ?? "(sport not in bundle)");
          dropped.get(table).add(row._id);
          continue;
        }
        const parentDropped =
          (table === "teamAliases" && isDropped("teams", row.teamId)) ||
          ((table === "playerAliases" || table === "playerSports") && isDropped("players", row.playerId));
        if (parentDropped) {
          st.droppedAsDependant++;
          dropped.get(table).add(row._id);
          continue;
        }
        if (table === "teams") {
          if (row.leagueId && isDropped("leagues", row.leagueId)) {
            delete row.leagueId;
            repairs["teams.leagueId blanked (league dropped)"]++;
          }
          if (row.franchiseId && isDropped("franchises", row.franchiseId)) {
            delete row.franchiseId;
            repairs["teams.franchiseId blanked (franchise dropped)"]++;
          }
        }
        if (table === "players" && Array.isArray(row.teamYears)) {
          const before = row.teamYears.length;
          row.teamYears = row.teamYears.filter((ty) => !isDropped("teams", ty.teamId));
          repairs["players.teamYears entries removed (team dropped)"] += before - row.teamYears.length;
          if (row.teamYears.length === 0 && before > 0) {
            delete row.teamYears;
            repairs["players.teamYears omitted (became empty)"]++;
          }
        }
        // Ids inside the set first, so a target sport id is never re-encoded.
        reencode(table, row, SPORT_ID_FIELDS);
        row[SPORT_ID_FIELD] = targetSport;
        if (SPORT_ID_ARRAY_FIELD in row) {
          const arr = Array.isArray(row[SPORT_ID_ARRAY_FIELD]) ? row[SPORT_ID_ARRAY_FIELD] : [];
          const mapped = arr.map((s) => sportMap.get(s)).filter(Boolean);
          repairs["players.alsoSportIds elements dropped (sport unmatched)"] += arr.length - mapped.length;
          if (mapped.length) row[SPORT_ID_ARRAY_FIELD] = mapped;
          else {
            delete row[SPORT_ID_ARRAY_FIELD];
            repairs["players.alsoSportIds omitted (became empty)"]++;
          }
        }
        out.push(row);
      }
      st.kept = out.length;
      files.set(`${table}/documents.jsonl`, toJsonl(out, table));
      if (bundle.generatedSchemas[table] !== undefined) files.set(`${table}/generated_schema.jsonl`, bundle.generatedSchemas[table]);
    }
  }

  files.set("_tables/documents.jsonl", tablesJsonl(tables, T));
  const expected = Object.fromEntries(tables.map((t) => [t, report.rows[t].kept]));

  // Table-number view for the plan: what a raw (un-re-encoded) import would hit.
  const tNumToTable = new Map([...T].map(([t, n]) => [n, t]));
  report.tableNumbers = tables.map((t) => {
    const b = B.get(t);
    const tn = T.get(t);
    const holder = tNumToTable.get(b);
    const raw = b === tn ? "same" : holder && holder !== t ? `raw import would collide with target ${holder}` : "differs";
    return { table: t, bundle: b, target: tn, raw };
  });

  return { files, tables, expected, report };
}

/** Import ZIP contents that empty the eight tables (`cli.mjs clear`). */
export function emptyImportFiles(targetNumbers) {
  const T = asMap(targetNumbers);
  for (const t of BUNDLE_TABLES) if (!T.has(t)) throw new Error(`target has no ${t} table in its _tables map`);
  const files = new Map();
  for (const t of BUNDLE_TABLES) files.set(`${t}/documents.jsonl`, "");
  files.set("_tables/documents.jsonl", tablesJsonl(BUNDLE_TABLES, T));
  return files;
}

// ── Check ───────────────────────────────────────────────────────────────────

/**
 * Structural integrity of a bundle (has manifest.json) or an import ZIP.
 * Fails on: a missing `_tables`, a table outside the eight, a bad or
 * duplicate `_id` or one on the wrong table number, a missing
 * `_creationTime`, any bare integer literal (Convex reads it as int64 and a
 * float64 validator rejects it), a stripped field that survived, a
 * selectorOptions row that is not a sport, an id whose table number the ZIP
 * does not know, and a reference into a table the ZIP carries that does not
 * resolve. A dangling reference the bundle's manifest already recorded as
 * dangling in the source export is a note, not a failure, up to the recorded
 * count per field.
 *
 * @param {Map<string,string>} files
 * @param {{ toleratedDangling?: Record<string, number>,
 *           externalTableNumbers?: Map<string,number>|Record<string,number> }} [opts]
 *   `toleratedDangling` defaults to manifest.integrity.dangling for a bundle.
 *   `externalTableNumbers` names tables the ZIP points into but does not
 *   carry: a remap-mode import ZIP's sport ids are the target's own
 *   selectorOptions rows, so pass `{ selectorOptions: <target number> }`.
 */
export function checkFiles(files, opts = {}) {
  const problems = {};
  const notes = {};
  const isBundle = files.has("manifest.json");
  let manifest = null;
  if (isBundle) {
    try {
      manifest = JSON.parse(files.get("manifest.json"));
    } catch {
      bump(problems, "manifest.json is not valid JSON");
    }
    if (manifest && manifest.format !== BUNDLE_FORMAT) bump(problems, `manifest format is not ${BUNDLE_FORMAT}`);
  }
  const tolerated = { ...(opts.toleratedDangling ?? manifest?.integrity?.dangling ?? {}) };

  if (!files.has("_tables/documents.jsonl")) {
    bump(problems, "_tables/documents.jsonl missing");
    return { ok: false, kind: isBundle ? "bundle" : "import", tables: {}, rows: {}, inSetRefs: 0, problems, notes };
  }
  let T;
  try {
    T = parseTableNumbers(files.get("_tables/documents.jsonl"));
  } catch {
    bump(problems, "_tables/documents.jsonl is not valid JSONL");
    return { ok: false, kind: isBundle ? "bundle" : "import", tables: {}, rows: {}, inSetRefs: 0, problems, notes };
  }
  const byNum = new Map([...T].map(([t, n]) => [n, t]));
  const extByNum = new Map([...asMap(opts.externalTableNumbers)].map(([t, n]) => [n, t]));
  if (byNum.size !== T.size) bump(problems, "_tables assigns one number to two tables");

  const present = [];
  for (const e of files.keys()) {
    const m = /^([^/]+)\/documents\.jsonl$/.exec(e);
    if (!m || m[1] === "_tables") continue;
    if (!BUNDLE_TABLES.includes(m[1])) problems[`unexpected table ${m[1]}`] = 1;
    else present.push(m[1]);
  }
  present.sort((a, b) => BUNDLE_TABLES.indexOf(a) - BUNDLE_TABLES.indexOf(b));
  for (const t of present) if (!T.has(t)) bump(problems, `${t} missing from _tables`);
  for (const t of T.keys()) {
    if (!BUNDLE_TABLES.includes(t)) problems[`unexpected table ${t}`] = 1;
    else if (!present.includes(t)) bump(problems, `_tables lists ${t} with no documents.jsonl`);
  }

  // Pass 1: rows, ids, numbers.
  const parsed = new Map();
  const ids = new Map(present.map((t) => [t, new Set()]));
  for (const t of present) {
    const rows = [];
    let n = 0;
    for (const line of jsonlLines(files.get(`${t}/documents.jsonl`))) {
      n++;
      const ints = countIntegerLiterals(line);
      if (ints) bump(problems, `${t}: plain integer literals (would import as int64)`, ints);
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        bump(problems, `${t}: line ${n} is not valid JSON`);
        continue;
      }
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        bump(problems, `${t}: line ${n} is not a JSON object`);
        continue;
      }
      const d = decodeId(r._id);
      if (!d) bump(problems, `${t}._id not a Convex id`);
      else if (d.table !== T.get(t)) bump(problems, `${t}._id on the wrong table number`);
      if (typeof r._creationTime !== "number") bump(problems, `${t}._creationTime missing`);
      if (ids.get(t).has(r._id)) bump(problems, `${t}._id duplicated`);
      ids.get(t).add(r._id);
      for (const f of STRIP_FIELDS) if (f in r) bump(problems, `${t}.${f} present`);
      if (t === SPORT_TABLE && r.level !== "sport") bump(problems, `${t}: row that is not a sport`);
      rows.push(r);
    }
    parsed.set(t, rows);
  }

  // Pass 2: references.
  let refs = 0;
  const dangling = {};
  for (const t of present) {
    for (const r of parsed.get(t)) {
      walkIds(r, (p, d, _s, str) => {
        if (p === "_id") return;
        const key = `${t}.${p}`;
        const tt = byNum.get(d.table);
        if (!tt) {
          // A remap-mode import ZIP points sportId at the target's own sport
          // rows, which the ZIP does not carry; the caller names that table.
          const ext = extByNum.get(d.table);
          if (ext === SPORT_TABLE && SPORT_ID_FIELDS.has(p.split(/[.[]/)[0])) bump(notes, `${key} -> target ${ext} (not in this zip)`);
          else bump(problems, `${key} -> unknown table number`);
          return;
        }
        if (!ids.has(tt)) return bump(problems, `${key} -> ${tt}, which this zip does not carry`);
        refs++;
        if (!ids.get(tt).has(str)) bump(dangling, key);
      });
    }
  }
  for (const [key, n] of Object.entries(dangling)) {
    const allowed = tolerated[key] ?? 0;
    if (n <= allowed) bump(notes, `${key} dangling (recorded in the source export)`, n);
    else bump(problems, `${key} dangling`, n);
  }

  // Bundle bookkeeping: manifest counts and sports.json agree with the rows.
  if (manifest) {
    for (const t of present) {
      if (manifest.counts?.[t] !== undefined && manifest.counts[t] !== parsed.get(t).length) bump(problems, `manifest count for ${t} disagrees with its rows`);
    }
    if (!present.includes(SPORT_TABLE)) bump(problems, `bundle carries no ${SPORT_TABLE} sport rows`);
    if (files.has("sports.json")) {
      let sj = null;
      try {
        sj = JSON.parse(files.get("sports.json"));
      } catch {
        bump(problems, "sports.json is not valid JSON");
      }
      if (sj && ids.has(SPORT_TABLE)) {
        const a = new Set(sj.map((s) => s._id));
        const b = ids.get(SPORT_TABLE);
        if (a.size !== b.size || [...a].some((x) => !b.has(x))) bump(problems, "sports.json disagrees with the sport rows");
      }
    } else bump(problems, "sports.json missing");
  }

  const ok = Object.keys(problems).length === 0;
  return {
    ok,
    kind: isBundle ? "bundle" : "import",
    tables: Object.fromEntries(T),
    rows: Object.fromEntries([...parsed].map(([t, rows]) => [t, rows.length])),
    inSetRefs: refs,
    problems,
    notes,
  };
}

// ── Schema validation ───────────────────────────────────────────────────────

/**
 * Validates every row of a bundle or import ZIP against the deployed schema's
 * validators, the way the importer will: exact field sets (system fields
 * allowed at top level), plain numbers are float64 (int64 needs
 * {"$integer"}), ids decode and carry the ZIP's number for their table.
 *
 * @param {Map<string,string>} files
 * @param {{tables: Array<{tableName:string, documentType:object}>}} exportedSchema
 *   `JSON.parse(schema.export())` for apps/web/convex/schema.ts
 * @returns {{ ok: boolean, counts: Record<string,{rows:number, invalid:number}>, errors: Record<string,number> }}
 *   error keys are "table: field path: reason", never values
 */
export function validateAgainstSchema(files, exportedSchema) {
  const schema = new Map(exportedSchema.tables.map((t) => [t.tableName, t.documentType]));
  const T = parseTableNumbers(files.get("_tables/documents.jsonl") ?? "");
  const errors = {};
  const counts = {};
  for (const t of BUNDLE_TABLES) {
    const e = `${t}/documents.jsonl`;
    if (!files.has(e)) continue;
    const ty = schema.get(t);
    if (!ty) {
      bump(errors, `${t}: table not in schema`);
      continue;
    }
    counts[t] = { rows: 0, invalid: 0 };
    for (const line of jsonlLines(files.get(e))) {
      const r = JSON.parse(line);
      counts[t].rows++;
      const local = {};
      if (typeof r._creationTime !== "number" || decodeId(r._id)?.table !== T.get(t)) bump(local, "bad system fields");
      checkValue(r, ty, "", T, local);
      if (Object.keys(local).length) {
        counts[t].invalid++;
        for (const [k, n] of Object.entries(local)) bump(errors, `${t}: ${k}`, n);
      }
    }
  }
  return { ok: Object.keys(errors).length === 0, counts, errors };
}

function checkValue(v, ty, p, T, errs) {
  switch (ty?.type) {
    case "any":
      return true;
    case "null":
      return v === null;
    case "boolean":
      return typeof v === "boolean";
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number";
    case "bigint":
      return !!v && typeof v === "object" && typeof v.$integer === "string";
    case "bytes":
      return !!v && typeof v === "object" && typeof v.$bytes === "string";
    case "literal":
      return v === ty.value;
    case "id": {
      const d = decodeId(v);
      if (!d) return false;
      return !T.has(ty.tableName) || d.table === T.get(ty.tableName);
    }
    case "array":
      return Array.isArray(v) && v.every((x) => checkValue(x, ty.value, `${p}[]`, T, errs));
    case "union":
      // Probe each branch silently; report once if none matches.
      return ty.value.some((u) => checkValue(v, u, p, T, {}));
    case "record":
      return (
        !!v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        Object.values(v).every((x) => checkValue(x, ty.values.fieldType, `${p}{}`, T, errs))
      );
    case "object": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return false;
      let ok = true;
      for (const [k, f] of Object.entries(ty.value)) {
        if (!(k in v)) {
          if (!f.optional) {
            bump(errs, `${p}${k}: missing`);
            ok = false;
          }
          continue;
        }
        if (!checkValue(v[k], f.fieldType, `${p}${k}.`, T, errs)) {
          bump(errs, `${p}${k}: wrong type`);
          ok = false;
        }
      }
      for (const k of Object.keys(v)) {
        if (p === "" && (k === "_id" || k === "_creationTime")) continue;
        if (!(k in ty.value)) {
          bump(errs, `${p}${k}: not in schema`);
          ok = false;
        }
      }
      return ok;
    }
    default:
      bump(errs, `${p}: unhandled validator ${ty?.type}`);
      return true;
  }
}

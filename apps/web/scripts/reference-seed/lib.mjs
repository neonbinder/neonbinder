// Shared helpers for the reference-seed scripts (NEO-330).
//
// Plain ESM, Node 18+ built-ins only, no npm dependencies. ZIP I/O shells out
// to the `zip` and `unzip` binaries found on PATH; requireZipTools() checks
// for both up front.
//
// Nothing in here prints row contents. Callers print counts, table names,
// field paths and NB sport names only.
//
// Runbook: docs/operations/neo330-reference-seed.md

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

// ── Where things are ────────────────────────────────────────────────────────

const HERE = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));

/** apps/web, where every `npx convex` child runs (it reads convex.json there). */
export const WEB_DIR = path.resolve(HERE, "..", "..");

/**
 * The project's production Convex deployment. Every guard refuses it. Must
 * stay equal to PROD_DEPLOYMENT_NAME in apps/web/e2e-baseline.sh; a unit test
 * asserts the two agree.
 */
export const PROD_DEPLOYMENT_NAME = "first-starfish-800";

/**
 * The Convex CLI every child runs, pinned to the version e2e-baseline.sh pins
 * and whose deploy-key precedence its guards were checked against. `npx --yes`
 * makes it hermetic: CI's seed job has no node_modules for apps/web.
 */
export const CONVEX_CLI = "convex@1.45.0";

/**
 * A plain Convex Cloud deployment name: adjective-animal-123, where the animal
 * may itself be hyphenated. No "dev:"/"prod:" prefixes, no project:ref forms.
 */
export const DEPLOYMENT_NAME = /^[a-z]+(?:-[a-z]+)+-\d+$/;

// ── The closed reference set ────────────────────────────────────────────────
//
// Processing order is topological: every table appears after the tables its
// ids point at, so a single pass can check or drop dependants.
export const TABLES = [
  "leagues",
  "franchises",
  "teams",
  "teamAliases",
  "players",
  "playerAliases",
  "playerSports",
];

/** The sport rows' table. The bundle carries only its level == "sport" rows. */
export const SPORT_TABLE = "selectorOptions";

/** Every table a bundle carries and an import-mode load replaces (eight). */
export const BUNDLE_TABLES = [SPORT_TABLE, ...TABLES];

/** Fields that point at selectorOptions sport rows. */
export const SPORT_ID_FIELD = "sportId"; // on all seven tables
export const SPORT_ID_ARRAY_FIELD = "alsoSportIds"; // players only
export const SPORT_ID_FIELDS = new Set([SPORT_ID_FIELD, SPORT_ID_ARRAY_FIELD]);

/**
 * User/audit id fields removed from every row at build. From schema.ts the
 * seven tables carry exactly one, `players.createdByUserId`; selectorOptions
 * carries the same field. Listed generically so a table gaining one is covered.
 */
export const STRIP_FIELDS = ["createdByUserId"];

/**
 * Fields on a sport row that point at selectorOptions rows the bundle does
 * not carry (its years). Cleared at build so the bundle holds no reference
 * outside itself; the app re-adds children as years are synced.
 */
export const SPORT_ROW_CLEARED_ARRAYS = ["children"];

/** Any top-level key matching this that is not stripped is reported. */
export const SUSPICIOUS_KEY = /user|owner|author|email|clerk|token|secret/i;

/** Bundle format written by build and required by load. */
export const BUNDLE_FORMAT = "neonbinder-reference-seed/2";

// ── Convex document-id codec ────────────────────────────────────────────────
//
// Mirrors convex-backend crates/value/src/id_v6.rs + base32.rs:
//   bytes  = vint(tableNumber) ++ internalId[16] ++ footer[2]
//   footer = fletcher16(vint ++ internalId) ^ VERSION(0), little-endian
//   string = base32 (alphabet below, big-endian 5-bit groups, no padding)
// decodeId() is strict: it rejects anything that does not re-encode to
// itself, exactly like the backend.

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const DECODE = new Map([...ALPHABET].map((c, i) => [c, i]));
const MIN_ID_LEN = 31; // 1-byte table number
const MAX_ID_LEN = 37; // 5-byte table number

function base32Encode(bytes) {
  let out = "";
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf = ((buf << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buf >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(buf << (5 - bits)) & 31];
  return out;
}

function base32Decode(s) {
  const out = [];
  let buf = 0;
  let bits = 0;
  for (const ch of s) {
    const v = DECODE.get(ch);
    if (v === undefined) return null;
    buf = ((buf << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((buf >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function fletcher16(bytes) {
  let c0 = 0;
  let c1 = 0;
  for (const b of bytes) {
    c0 = (c0 + b) & 0xff;
    c1 = (c1 + c0) & 0xff;
  }
  return (c1 << 8) | c0;
}

function vintEncode(n) {
  const out = [];
  for (;;) {
    if (n < 0x80) {
      out.push(n);
      return out;
    }
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
}

/** @returns {{table:number, internal:Uint8Array}|null} */
export function decodeId(s) {
  if (typeof s !== "string" || s.length < MIN_ID_LEN || s.length > MAX_ID_LEN) return null;
  const buf = base32Decode(s);
  if (!buf) return null;
  let pos = 0;
  let n = 0;
  for (let i = 0; ; i++) {
    if (i >= 5 || pos >= buf.length) return null;
    const byte = buf[pos++];
    n += (byte & 0x7f) * 2 ** (7 * i);
    if (byte < 0x80) break;
  }
  if (n === 0) return null;
  if (buf.length !== pos + 16 + 2) return null;
  const internal = buf.slice(pos, pos + 16);
  const expected = fletcher16(buf.subarray(0, pos + 16));
  const footer = buf[pos + 16] | (buf[pos + 17] << 8);
  if (expected !== footer) return null;
  if (encodeId(n, internal) !== s) return null; // canonical form only
  return { table: n, internal };
}

export function encodeId(table, internal) {
  const head = vintEncode(table);
  const body = Uint8Array.from([...head, ...internal]);
  const f = fletcher16(body);
  return base32Encode(Uint8Array.from([...body, f & 0xff, f >> 8]));
}

/** Same document, other table number (keeps the 16 internal-id bytes). */
export function retableId(id, newTable) {
  const d = decodeId(id);
  if (!d) throw new Error("retableId: not a Convex id");
  return encodeId(newTable, d.internal);
}

// ── Deep walk over a row, reporting every string that is a Convex id ────────

/**
 * Calls visit(path, decoded, replace, str) for every string that decodes as an
 * id. `path` is a shape path ("teamYears[].teamId"), never a value.
 * `replace(v)` swaps the string in place. Top-level keys in `skipKeys` are not
 * walked.
 */
export function walkIds(row, visit, skipKeys = new Set()) {
  const rec = (node, p, setter) => {
    if (typeof node === "string") {
      const d = decodeId(node);
      if (d) visit(p, d, setter, node);
    } else if (Array.isArray(node)) {
      node.forEach((v, i) => rec(v, `${p}[]`, (nv) => (node[i] = nv)));
    } else if (node && typeof node === "object") {
      for (const k of Object.keys(node)) {
        if (p === "" && skipKeys.has(k)) continue;
        rec(node[k], p === "" ? k : `${p}.${k}`, (nv) => (node[k] = nv));
      }
    }
  };
  rec(row, "", () => {});
}

// ── Snapshot JSON numbers ───────────────────────────────────────────────────
//
// In a Convex snapshot every plain JSON number is a float64; int64 travels as
// {"$integer": "<base64>"} and bytes as {"$bytes": ...}. The export spells an
// integral float with a decimal point ("2005.0") and the importer reads a bare
// "2005" as int64, which a v.number() (float64) validator rejects. JSON.parse
// cannot keep that distinction, so every writer of row JSON must use
// convexJson(), never JSON.stringify().
//
// `_tables/documents.jsonl` is the exception: its `id` is a bare integer in
// the real export, and the importer reads it as a float either way.

/** JSON.stringify for snapshot rows: integral numbers are written as "N.0". */
export function convexJson(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "number":
      return convexNumber(value);
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : convexJson(v))).join(",")}]`;
      // $integer / $bytes / $float wrappers hold strings, so they pass through
      // as ordinary objects untouched.
      const parts = [];
      for (const k of Object.keys(value)) {
        const v = value[k];
        if (v === undefined || typeof v === "function") continue;
        parts.push(`${JSON.stringify(k)}:${convexJson(v)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new Error(`convexJson: cannot serialize a ${typeof value}`);
  }
}

function convexNumber(n) {
  if (!Number.isFinite(n)) throw new Error("convexJson: non-finite number (would need a $float wrapper)");
  if (Object.is(n, -0)) return "-0.0";
  const s = String(n); // shortest round-trip form, same value as the source text
  if (Number.isInteger(n) && !/[.eE]/.test(s)) return `${s}.0`;
  return s; // has a fraction or an exponent: already float notation
}

/**
 * Number tokens in raw JSON text that the importer would read as int64 (no
 * ".", "e" or "E"). Strings are skipped, so $integer payloads never count.
 */
export function countIntegerLiterals(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (c === "-" || (c >= "0" && c <= "9")) {
      let j = i + 1;
      while (j < text.length && /[0-9.eE+-]/.test(text[j])) j++;
      if (!/[.eE]/.test(text.slice(i, j))) n++;
      i = j - 1;
    }
  }
  return n;
}

/** Field paths of integral numbers in a parsed row (for per-field reports). */
export function integralNumberPaths(row, visit) {
  const rec = (node, p) => {
    if (typeof node === "number") {
      if (Number.isInteger(node)) visit(p);
    } else if (Array.isArray(node)) node.forEach((v) => rec(v, `${p}[]`));
    else if (node && typeof node === "object") for (const k of Object.keys(node)) rec(node[k], p ? `${p}.${k}` : k);
  };
  rec(row, "");
}

/** Rows to JSONL text via convexJson. Refuses to emit a bare integer. */
export function toJsonl(rows, label = "rows") {
  let out = "";
  rows.forEach((row, i) => {
    const line = convexJson(row);
    if (countIntegerLiterals(line) !== 0) throw new Error(`${label}: row ${i + 1} would carry an int64 literal`);
    out += line + "\n";
  });
  return out;
}

/** `_tables/documents.jsonl` text for the given tables (bare-integer ids, as the export writes). */
export function tablesJsonl(tables, numbers) {
  const get = (t) => (numbers instanceof Map ? numbers.get(t) : numbers[t]);
  return tables.map((t) => JSON.stringify({ name: t, id: get(t) })).join("\n") + "\n";
}

/** Parses JSONL text into objects; errors name the entry and line, never the content. */
export function parseJsonl(text, entry) {
  const rows = [];
  let n = 0;
  for (const line of text.split("\n")) {
    n++;
    if (line.trim() === "") continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new Error(`${entry}: line ${n} is not valid JSON`);
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`${entry}: line ${n} is not a JSON object`);
    rows.push(obj);
  }
  return rows;
}

/** Non-empty raw lines of JSONL text. */
export function jsonlLines(text) {
  return text.split("\n").filter((l) => l.trim() !== "");
}

/** `_tables/documents.jsonl` text → Map<name, number>. */
export function parseTableNumbers(text) {
  const map = new Map();
  if (!text) return map;
  for (const o of parseJsonl(text, "_tables/documents.jsonl")) {
    if (typeof o.name === "string" && typeof o.id === "number") map.set(o.name, o.id);
  }
  return map;
}

// ── Deployment guards (pure; cli.mjs runs them before any convex call) ─────

/**
 * Returns null when `name` is an acceptable non-production deployment name,
 * else the reason it is refused.
 */
export function deploymentNameProblem(name) {
  if (typeof name !== "string" || name === "") return "no --deployment given";
  if (/^(prod|production)$/i.test(name) || /(^|:)prod(uction)?$/i.test(name)) return `"${name}" names production`;
  if (name.includes(PROD_DEPLOYMENT_NAME)) return `"${name}" is the production deployment`;
  if (!DEPLOYMENT_NAME.test(name)) {
    return `"${name}" is not a plain deployment name (adjective-animal-123); prefixes like dev: or prod: and project:ref forms are not accepted`;
  }
  return null;
}

/**
 * The deploy-key guard, mirroring apps/web/e2e-baseline.sh. The Convex CLI
 * reads CONVEX_DEPLOY_KEY (from the environment or .env.local) before any
 * other selector, so a production or project-wide key would reach production
 * whatever --deployment says. Never returns or prints the key.
 *
 * @param {string|null|undefined} key
 * @param {string|null|undefined} deployment the --deployment value
 * @returns {string|null} the refusal, or null when the key is acceptable
 */
export function deployKeyProblem(key, deployment) {
  if (!key) return null;
  if (/^(prod|project):/.test(key) || key.includes(PROD_DEPLOYMENT_NAME)) {
    return "CONVEX_DEPLOY_KEY is a production or project-wide deploy key; it, not --deployment, selects the target. Unset it or use a preview or dev key.";
  }
  if (!deployment) {
    return "CONVEX_DEPLOY_KEY is set, so the key's deployment would be used, not a name this script could print; pass --deployment.";
  }
  // A dev key names its own deployment ("dev:<name>|…"). It cannot act on
  // another one, so a mismatch is a mistake, not a choice.
  const m = /^dev:([^|]+)\|/.exec(key);
  if (m && m[1] !== deployment) return `CONVEX_DEPLOY_KEY belongs to a different dev deployment than --deployment ${deployment}.`;
  return null;
}

/**
 * The CONVEX_DEPLOY_KEY the Convex CLI would use from `webDir`. The CLI
 * dotenv-loads `.env.local` and then `.env` (deploymentSelection.js:
 * `dotenv.config({ path: ".env.local" }); dotenv.config();`), and dotenv
 * never overrides a variable already set, so the precedence is: the
 * environment, then `.env.local`, then `.env`. Read for the guard only;
 * never printed.
 */
export function effectiveDeployKey(env = process.env, webDir = WEB_DIR) {
  if (env.CONVEX_DEPLOY_KEY) return env.CONVEX_DEPLOY_KEY;
  for (const name of [".env.local", ".env"]) {
    const key = deployKeyFromFile(path.join(webDir, name));
    if (key) return key;
  }
  return "";
}

function deployKeyFromFile(file) {
  if (!existsSync(file)) return "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^CONVEX_DEPLOY_KEY=(.*)$/.exec(line);
    if (m) {
      return m[1]
        .replace(/\s*#.*$/, "")
        .replace(/^["']/, "")
        .replace(/["']$/, "")
        .trim();
    }
  }
  return "";
}

// ── Convex CLI output, safe for a public CI log ─────────────────────────────

/**
 * Markers after which a Convex CLI error line quotes document data: a
 * schema-validation rejection prints the offending row ("Object: {...}"),
 * the validator it failed, and sometimes the bad value.
 */
export const CONVEX_OUTPUT_REDACT_MARKERS = ["Object:", "Validator:", "Value:"];

/** Longest error line ever echoed, after redaction. */
export const CONVEX_OUTPUT_MAX_LINE = 300;

/**
 * One line summarising a failed Convex CLI call, with any row data removed.
 * Drops everything from the first redaction marker on (per stream), then
 * takes the first remaining line naming an error or failure, else the first
 * other error-looking line, else the last line (stderr before stdout), and
 * caps its length. Pure.
 */
export function redactConvexOutput(stdout = "", stderr = "") {
  // Within each stream, everything from the first marker on is dropped,
  // including later lines: a quoted document can span several lines, and any
  // of them could happen to contain a word like "fail".
  const safeLines = (text) => {
    const out = [];
    for (const raw of `${text}`.split("\n")) {
      let line = raw;
      let cut = -1;
      for (const marker of CONVEX_OUTPUT_REDACT_MARKERS) {
        const i = line.indexOf(marker);
        if (i !== -1 && (cut === -1 || i < cut)) cut = i;
      }
      if (cut !== -1) line = line.slice(0, cut);
      if (line.trim()) out.push(line.trim());
      if (cut !== -1) break;
    }
    return out;
  };
  const lines = [...safeLines(stderr), ...safeLines(stdout)];
  if (lines.length === 0) return `${stdout}${stderr}`.trim() ? "(error text withheld: it quoted document data)" : "(no output)";
  let pick =
    lines.find((l) => /error|fail/i.test(l)) ??
    lines.find((l) => /✖|invalid|cannot|could not|not found|unauthori[sz]ed|forbidden/i.test(l)) ??
    lines[lines.length - 1];
  if (pick.length > CONVEX_OUTPUT_MAX_LINE) pick = `${pick.slice(0, CONVEX_OUTPUT_MAX_LINE)}…`;
  return pick;
}

// ── Bundle floors ───────────────────────────────────────────────────────────
//
// A bundle can be structurally sound and still hollow: an export taken from
// the wrong deployment, or cut short, passes `check` and would seed a preview
// with nothing, so every flow would then run against an empty catalogue that
// looks like a passing seed. `load` refuses a bundle under these floors.
// Production holds about 100k players and several thousand teams; the floors
// sit far below that so a real refresh never trips them, and far above
// anything a dev or preview deployment accumulates by hand.

/**
 * Reference tables that may legitimately be empty in production, so a bundle
 * without rows in them is not hollow. `playerSports` records extra sports for
 * multi-sport players; production held none when the first real bundle was
 * built (2026-10-10).
 */
export const TABLES_THAT_MAY_BE_EMPTY = ["playerSports"];

/** Fewest players a loadable bundle may carry. */
export const MIN_BUNDLE_PLAYERS = 1000;

/** Fewest teams a loadable bundle may carry. */
export const MIN_BUNDLE_TEAMS = 100;

/**
 * Reasons a bundle is too hollow to load, from its manifest counts and its
 * actual rows (both must clear every floor). Every one of the seven
 * reference tables except TABLES_THAT_MAY_BE_EMPTY needs at least one row;
 * import mode also needs at least one sport row. Pure.
 *
 * @param {Record<string,number>|undefined} manifestCounts manifest.counts
 * @param {Record<string,number>} rowCounts rows actually in the bundle, per table
 * @param {"import"|"remap"} mode
 * @returns {string[]} empty when the bundle may be loaded
 */
export function hollowBundleProblems(manifestCounts, rowCounts, mode) {
  const problems = [];
  const sources = [
    ["manifest", manifestCounts ?? {}],
    ["rows", rowCounts ?? {}],
  ];
  const floor = (t, min, why) => {
    for (const [label, counts] of sources) {
      const n = counts[t] ?? 0;
      if (n < min) problems.push(`${t}: ${n} (${label}), needs at least ${min}${why}`);
    }
  };
  for (const t of TABLES) if (!TABLES_THAT_MAY_BE_EMPTY.includes(t)) floor(t, 1, "");
  floor("players", MIN_BUNDLE_PLAYERS, " (MIN_BUNDLE_PLAYERS)");
  floor("teams", MIN_BUNDLE_TEAMS, " (MIN_BUNDLE_TEAMS)");
  if (mode === "import") floor(SPORT_TABLE, 1, " (import mode replaces selectorOptions with these)");
  return [...new Set(problems)];
}

// ── ZIP I/O via the zip/unzip binaries on PATH ──────────────────────────────

/** Throws unless both `zip` and `unzip` run from PATH. */
export function requireZipTools() {
  const missing = [];
  for (const [bin, args] of [
    ["unzip", ["-v"]],
    ["zip", ["-v"]],
  ]) {
    const r = spawnSync(bin, args, { stdio: "ignore" });
    if (r.error || r.status !== 0) missing.push(bin);
  }
  if (missing.length) throw new Error(`${missing.join(" and ")} not found on PATH; install them first`);
}

export function listZip(zipPath) {
  const r = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`unzip: ${r.error.message}`);
  // unzip -Z1 exits 1 on an archive with no members.
  if (r.status !== 0 && !/Empty zipfile|zipfile is empty/i.test(`${r.stdout}${r.stderr}`)) {
    throw new Error(`unzip -Z1 failed (${r.status}): ${r.stderr.trim()}`);
  }
  return new Set(r.stdout.split("\n").filter(Boolean));
}

function assertSafeEntry(entry) {
  // unzip treats the member name as a wildcard pattern; table names are
  // [A-Za-z0-9_], so refuse anything else rather than match the wrong member.
  if (!/^[A-Za-z0-9_./-]+$/.test(entry)) throw new Error(`unsafe zip entry name: ${entry}`);
}

/**
 * Async iterator of non-empty raw lines of one ZIP entry, streamed.
 *
 * Splits the child's stdout by hand instead of using readline. readline's
 * async iterator pauses the interface when a slow consumer falls behind, and
 * if `unzip` finishes while it is paused, the next resume() throws
 * ERR_USE_AFTER_CLOSE ("readline was closed") and the entry's last line is
 * lost. A Readable's own async iterator has no such race, and an empty or
 * instantly-closed member simply yields nothing.
 */
export async function* zipLines(zipPath, entry) {
  assertSafeEntry(entry);
  const child = spawn("unzip", ["-p", zipPath, entry], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => (stderr += d));
  const exited = once(child, "close");
  child.stdout.setEncoding("utf8"); // decodes multi-byte characters across chunk edges
  let finished = false;
  try {
    let rest = "";
    for await (const chunk of child.stdout) {
      const parts = (rest + chunk).split("\n");
      rest = parts.pop();
      for (const raw of parts) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (line.trim() !== "") yield line;
      }
    }
    if (rest.trim() !== "") yield rest.endsWith("\r") ? rest.slice(0, -1) : rest;
    const [code] = await exited;
    finished = true;
    if (code !== 0) throw new Error(`unzip -p ${entry} exited ${code}: ${stderr.trim()}`);
  } finally {
    // The consumer stopped early (break/return/throw): do not leave unzip running.
    if (!finished && child.exitCode === null) child.kill();
  }
}

/** Async iterator of parsed JSON objects of one JSONL entry. */
export async function* zipJsonl(zipPath, entry) {
  let n = 0;
  for await (const line of zipLines(zipPath, entry)) {
    n++;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new Error(`${entry}: line ${n} is not valid JSON`); // no content echoed
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`${entry}: line ${n} is not a JSON object`);
    yield obj;
  }
}

export function readZipEntry(zipPath, entry) {
  assertSafeEntry(entry);
  const r = spawnSync("unzip", ["-p", zipPath, entry], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  if (r.error) throw new Error(`unzip -p ${entry}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`unzip -p ${entry} failed (${r.status})`);
  return r.stdout;
}

/** Every file entry of a (small) ZIP as Map<path, text>. Bundles only, never an export. */
export function readZipText(zipPath) {
  const files = new Map();
  for (const e of listZip(zipPath)) {
    if (e.endsWith("/")) continue;
    files.set(e, readZipEntry(zipPath, e));
  }
  return files;
}

/** Writes all of `dir` (relative paths preserved) into a fresh ZIP. */
export function zipDir(dir, outZip) {
  rmSync(outZip, { force: true });
  const r = spawnSync("zip", ["-q", "-X", "-D", "-r", path.resolve(outZip), "."], { cwd: dir, encoding: "utf8" });
  if (r.error) throw new Error(`zip: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`zip failed (${r.status}): ${r.stderr.trim()}`);
}

/** Backpressure-aware JSONL writer that refuses int64 literals. */
export class JsonlWriter {
  constructor(file) {
    this.stream = createWriteStream(file);
    this.count = 0;
  }
  async write(obj) {
    this.count++;
    const line = convexJson(obj);
    if (countIntegerLiterals(line) !== 0) throw new Error(`JsonlWriter: row ${this.count} would carry an int64 literal`);
    if (!this.stream.write(line + "\n")) await once(this.stream, "drain");
  }
  async close() {
    this.stream.end();
    await once(this.stream, "finish");
  }
}

/** A fresh private directory under the OS temp dir. */
export function makeTempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), `nb-reference-seed-${prefix}-`));
}

/**
 * Reads a snapshot's root `_tables/documents.jsonl` ({name, id} per line)
 * into Map<name, number>. `_components/**` is ignored.
 */
export async function readTableNumbers(zipPath, entries) {
  const map = new Map();
  if (!entries.has("_tables/documents.jsonl")) return map;
  for await (const o of zipJsonl(zipPath, "_tables/documents.jsonl")) {
    if (typeof o.name === "string" && typeof o.id === "number") map.set(o.name, o.id);
  }
  return map;
}

export function fmt(n) {
  return n.toLocaleString("en-US");
}

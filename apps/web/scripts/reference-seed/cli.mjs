#!/usr/bin/env node
// Reference seed CLI (NEO-330). Runbook: docs/operations/neo330-reference-seed.md
//
//   cli.mjs build <export.zip> <bundle.zip>
//   cli.mjs check <zip>
//   cli.mjs load  <bundle.zip> --deployment <name> --sports import|remap [--dry-run] [--yes]
//   cli.mjs clear --deployment <name> [--yes]
//
// build  Cuts the eight reference tables out of a full snapshot export.
// check  Structural integrity of a bundle or import ZIP (exit 1 on a problem).
// load   Replaces the reference tables on a NON-production deployment with the
//        bundle, ids re-encoded onto the target's table numbers, then verifies
//        the counts from a second read-only export.
//          --sports import  CI. Imports the bundle's sport rows too and replaces
//                           the target's WHOLE selectorOptions table, so it
//                           refuses unless cardChecklist is empty (run the reset
//                           first).
//          --sports remap   A developer's deployment. Leaves selectorOptions
//                           alone; maps sports by name onto the target's rows.
// clear  Empties the eight tables with one atomic import. Needs no deployed
//        code, so it works when a schema change has left a preview unable to
//        deploy over stale rows.
//
// Guards (load and clear), all before any write:
//   - --prod, the production deployment name and anything that is not a plain
//     deployment name are refused.
//   - CONVEX_DEPLOY_KEY (environment or .env.local) is checked the way
//     e2e-baseline.sh checks it: prod: and project: keys are refused, and
//     --deployment is required whenever a key is set. CI authenticates with
//     a preview key, so the key is passed through to the Convex CLI.
//   - With no key, `convex dashboard --prod` resolves production's name and
//     --deployment must differ from it and resolve to itself.
//   - Without --yes, you retype the deployment name on a TTY; no TTY and no
//     --yes is a refusal.
//
// Exit codes: 0 ok, 1 failed, 2 usage, 3 refused.
// Prints counts, table names, field paths and NB sport names only.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  WEB_DIR,
  CONVEX_CLI,
  SPORT_TABLE,
  BUNDLE_TABLES,
  SPORT_ID_FIELD,
  SPORT_ID_ARRAY_FIELD,
  decodeId,
  deploymentNameProblem,
  deployKeyProblem,
  effectiveDeployKey,
  requireZipTools,
  listZip,
  zipLines,
  zipJsonl,
  readZipText,
  readTableNumbers,
  zipDir,
  makeTempDir,
  fmt,
} from "./lib.mjs";
import { parseBundle, transformBundle, emptyImportFiles, checkFiles } from "./transform.mjs";
import { buildBundle } from "./build.mjs";

export const USAGE = `usage:
  cli.mjs build <export.zip> <bundle.zip>
  cli.mjs check <zip>
  cli.mjs load <bundle.zip> --deployment <name> --sports import|remap [--dry-run] [--yes]
  cli.mjs clear --deployment <name> [--yes]`;

export class UsageError extends Error {}
export class RefusedError extends Error {}

/** Tables a reset leaves behind that an import-mode load would orphan. */
const SELECTOR_DEPENDANT_TABLES = ["cardChecklist"];

// ── Args ────────────────────────────────────────────────────────────────────

/**
 * Parses argv (without node and the script path). Pure.
 * @returns {{cmd:"build", exportZip:string, bundleZip:string}
 *         | {cmd:"check", zip:string}
 *         | {cmd:"load", bundle:string, deployment:string, sports:"import"|"remap", dryRun:boolean, yes:boolean}
 *         | {cmd:"clear", deployment:string, yes:boolean}}
 * @throws {UsageError|RefusedError}
 */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const positional = [];
  const flags = { deployment: undefined, sports: undefined, dryRun: false, yes: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const value = (name) => {
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${name} requires a value`);
      return v;
    };
    if (a === "--prod" || a.startsWith("--prod=")) throw new RefusedError("--prod is never allowed; this tool cannot target production");
    else if (a === "--deployment" || a.startsWith("--deployment=")) flags.deployment = value("--deployment");
    else if (a === "--sports" || a.startsWith("--sports=")) flags.sports = value("--sports");
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a.startsWith("-")) throw new UsageError(`unknown flag ${a}`);
    else positional.push(a);
  }
  const noFlags = (allowed) => {
    for (const [k, v] of Object.entries(flags)) {
      if (!allowed.includes(k) && v !== undefined && v !== false) throw new UsageError(`${cmd} takes no --${k === "dryRun" ? "dry-run" : k}`);
    }
  };
  switch (cmd) {
    case "build":
      noFlags([]);
      if (positional.length !== 2) throw new UsageError("build takes <export.zip> <bundle.zip>");
      if (!positional[1].endsWith(".zip")) throw new UsageError("the bundle path must end in .zip");
      return { cmd, exportZip: positional[0], bundleZip: positional[1] };
    case "check":
      noFlags([]);
      if (positional.length !== 1) throw new UsageError("check takes <zip>");
      return { cmd, zip: positional[0] };
    case "load":
      noFlags(["deployment", "sports", "dryRun", "yes"]);
      if (positional.length !== 1) throw new UsageError("load takes one <bundle.zip>");
      if (!flags.deployment) throw new UsageError("load requires --deployment <name>");
      if (flags.sports !== "import" && flags.sports !== "remap") throw new UsageError("load requires --sports import|remap");
      return { cmd, bundle: positional[0], deployment: flags.deployment, sports: flags.sports, dryRun: flags.dryRun, yes: flags.yes };
    case "clear":
      noFlags(["deployment", "yes"]);
      if (positional.length !== 0) throw new UsageError("clear takes no positional arguments");
      if (!flags.deployment) throw new UsageError("clear requires --deployment <name>");
      return { cmd, deployment: flags.deployment, yes: flags.yes };
    default:
      throw new UsageError(cmd ? `unknown command ${cmd}` : "no command");
  }
}

// ── Convex CLI ──────────────────────────────────────────────────────────────

function convex(args, env, { inherit = false } = {}) {
  const r = spawnSync("npx", ["--yes", CONVEX_CLI, ...args], {
    cwd: WEB_DIR,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
  });
  if (r.error) throw new Error(`npx ${CONVEX_CLI}: ${r.error.message}`);
  return r;
}

const lastLine = (r) => `${r.stderr ?? ""}`.trim().split("\n").slice(-1)[0] ?? "";

function dashboardName(args, env) {
  const r = convex(["dashboard", ...args, "--no-open"], env);
  const m = /dashboard\.convex\.dev\/d\/([a-z]+(?:-[a-z]+)+-\d+)/.exec(`${r.stdout}\n${r.stderr}`);
  return r.status === 0 && m ? m[1] : null;
}

/**
 * Every guard that does not need a write. Throws RefusedError. Returns a
 * function to call again right before the write.
 */
function guardTarget(deployment, env, log) {
  const nameProblem = deploymentNameProblem(deployment);
  if (nameProblem) throw new RefusedError(nameProblem);
  if (env.CONVEX_SELF_HOSTED_URL || env.CONVEX_SELF_HOSTED_ADMIN_KEY) {
    throw new RefusedError("CONVEX_SELF_HOSTED_* is set; it would redirect every convex call. Unset it.");
  }
  const key = effectiveDeployKey(env, WEB_DIR);
  const keyProblem = deployKeyProblem(key, deployment);
  if (keyProblem) throw new RefusedError(keyProblem);

  const probe = () => {
    if (key) return; // a dev/preview key cannot reach production; the probe would fail under it anyway
    const prodName = dashboardName(["--prod"], env);
    if (!prodName) throw new RefusedError("could not resolve the project's production deployment name; failing closed");
    if (prodName === deployment) throw new RefusedError(`"${deployment}" is the project's production deployment`);
    const resolved = dashboardName(["--deployment", deployment], env);
    if (resolved !== deployment) throw new RefusedError(`"${deployment}" did not resolve to itself (got ${resolved ?? "nothing"})`);
  };
  probe();
  log(
    key
      ? `target: ${deployment} (deploy key in use: production and project-wide keys refused, prod name refused; dashboard probe skipped)`
      : `target: ${deployment} (verified not production)`,
  );
  return probe;
}

/** Fails fast, before any convex call, when a write could never be confirmed. */
function requireConfirmable(yes) {
  if (!yes && !process.stdin.isTTY) throw new RefusedError("no TTY to confirm on; pass --yes to run non-interactively");
}

async function confirm(deployment, what, { yes, log }) {
  if (yes) return;
  if (!process.stdin.isTTY) throw new RefusedError("no TTY to confirm on; pass --yes to run non-interactively");
  log(`\nThis ${what} on ${deployment}.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question("Type the deployment name to continue: ", resolve));
  rl.close();
  if (answer.trim() !== deployment) throw new RefusedError("confirmation did not match; nothing changed");
}

/** Read-only export of the target; `readExport(zip, entries)` runs before it is deleted. */
async function withTargetExport(deployment, env, label, readExport) {
  const dir = makeTempDir(`target-${label}`);
  try {
    const zip = path.join(dir, "target.zip");
    const r = convex(["export", "--deployment", deployment, "--path", zip], env);
    if (r.status !== 0) throw new Error(`export of ${deployment} failed: ${lastLine(r)}`);
    return await readExport(zip, listZip(zip));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function countLines(zip, entries, table) {
  const e = `${table}/documents.jsonl`;
  if (!entries.has(e)) return 0;
  let n = 0;
  for await (const _ of zipLines(zip, e)) n++;
  return n;
}

function writeImportZip(files) {
  const dir = makeTempDir("import");
  const staging = path.join(dir, "staging");
  for (const [rel, text] of files) {
    mkdirSync(path.dirname(path.join(staging, rel)), { recursive: true });
    writeFileSync(path.join(staging, rel), text);
  }
  const zip = path.join(dir, "import.zip");
  zipDir(staging, zip);
  return { dir, zip };
}

function importZip(deployment, zip, env) {
  const r = convex(["import", "--deployment", deployment, "--replace", "-y", zip], env, { inherit: true });
  if (r.status !== 0) {
    throw new Error(`import failed (exit ${r.status}); Convex imports atomically, so a rejected import left the target unchanged`);
  }
}

function printCheck(result, log) {
  log(`check: ${result.ok ? "ok" : "FAILED"} (${result.kind})`);
  for (const [t, n] of Object.entries(result.rows)) log(`  ${t.padEnd(16)} ${fmt(n).padStart(9)} rows   table #${result.tables[t]}`);
  log(`  in-set references resolved: ${fmt(result.inSetRefs)}`);
  for (const [k, n] of Object.entries(result.notes)) log(`  note: ${k}: ${fmt(n)}`);
  for (const [k, n] of Object.entries(result.problems)) log(`  PROBLEM: ${k}: ${fmt(n)}`);
}

// ── Commands ────────────────────────────────────────────────────────────────

async function cmdCheck({ zip }, { log }) {
  requireZipTools();
  statSync(zip);
  const result = checkFiles(readZipText(zip));
  printCheck(result, log);
  return result.ok ? 0 : 1;
}

async function cmdLoad({ bundle, deployment, sports, dryRun, yes }, { env, log }) {
  requireZipTools();
  statSync(bundle);
  if (!dryRun) requireConfirmable(yes);
  const recheck = guardTarget(deployment, env, log);

  const bundleFiles = readZipText(bundle);
  const bundleCheck = checkFiles(bundleFiles);
  if (!bundleCheck.ok) {
    printCheck(bundleCheck, log);
    throw new RefusedError("the bundle fails its own check; rebuild it");
  }
  const parsed = parseBundle(bundleFiles);
  log(`bundle: ${path.basename(bundle)} (generated ${parsed.manifest.generatedAt}); sports mode: ${sports}`);

  const pre = await withTargetExport(deployment, env, "pre", async (zip, entries) => {
    const tableNumbers = await readTableNumbers(zip, entries);
    const counts = {};
    for (const t of [...BUNDLE_TABLES, ...SELECTOR_DEPENDANT_TABLES]) counts[t] = await countLines(zip, entries, t);
    return { tableNumbers, counts };
  });

  let targetSports;
  if (sports === "remap") {
    const r = convex(["run", "--deployment", deployment, "splitTeamLocations:listSportsForSplit", "{}", "--typecheck", "disable", "--codegen", "disable"], env);
    if (r.status !== 0) throw new Error(`listSportsForSplit failed: ${lastLine(r)}`);
    targetSports = JSON.parse(r.stdout);
  } else {
    for (const t of SELECTOR_DEPENDANT_TABLES) {
      if (pre.counts[t] > 0) {
        throw new RefusedError(
          `${deployment} holds ${fmt(pre.counts[t])} ${t} rows; --sports import replaces the whole ${SPORT_TABLE} table and would orphan them. Run the reset first (e2e-baseline.sh reset), or use --sports remap.`,
        );
      }
    }
  }

  const { files, tables, expected, report } = transformBundle(parsed, { tableNumbers: pre.tableNumbers, sports: targetSports }, { sports });
  const importCheck = checkFiles(files, {
    toleratedDangling: parsed.manifest.integrity?.dangling ?? {},
    externalTableNumbers: sports === "remap" ? { [SPORT_TABLE]: pre.tableNumbers.get(SPORT_TABLE) } : {},
  });

  // ── Plan ──────────────────────────────────────────────────────────────────
  if (sports === "remap") {
    log("\nsport mapping (bundle -> target, by exact name):");
    for (const m of report.sportMapping) log(`  ${m.name.padEnd(16)} ${m.outcome}`);
  } else {
    log(`\nsport rows imported as-is (${report.sportNames.length}): ${report.sportNames.join(", ")}`);
  }
  log("\ntable numbers (bundle -> target):");
  for (const n of report.tableNumbers) log(`  ${n.table.padEnd(16)} #${n.bundle} -> #${n.target}   (${n.raw})`);
  log("\nrows (bundle -> import; the target's current rows are all replaced):");
  for (const t of tables) {
    const st = report.rows[t];
    const bySport = Object.entries(st.droppedBySport).map(([k, n]) => `${k}: ${fmt(n)}`).join(", ");
    log(
      `  ${t.padEnd(16)} ${fmt(st.bundle).padStart(9)} -> ${fmt(st.kept).padStart(9)}   target now ${fmt(pre.counts[t]).padStart(9)}` +
        (bySport ? `   dropped by sport {${bySport}}` : "") +
        (st.droppedAsDependant ? `   dropped as dependant ${fmt(st.droppedAsDependant)}` : ""),
    );
  }
  if (Object.keys(report.repairs).length) {
    log("\nrepairs:");
    for (const [k, n] of Object.entries(report.repairs)) log(`  ${k}: ${fmt(n)}`);
  }
  log("\nid re-encodes onto target table numbers (by field):");
  for (const [k, n] of Object.entries(report.reencoded).sort()) log(`  ${k}: ${fmt(n)}`);
  if (Object.keys(report.foreignIds).length) {
    log("\nids outside the set, left untouched (by field):");
    for (const [k, n] of Object.entries(report.foreignIds).sort()) log(`  ${k}: ${fmt(n)}`);
  }
  log("");
  printCheck(importCheck, log);
  if (!importCheck.ok) throw new Error("the import zip fails its check; nothing imported");

  if (dryRun) {
    log("\nDRY RUN: nothing imported.");
    return 0;
  }

  const replaced = tables.join(", ");
  await confirm(
    deployment,
    sports === "import" ? `replaces ${replaced} (every selectorOptions row, not only sports)` : `replaces ${replaced}`,
    { yes, log },
  );
  recheck();

  const written = writeImportZip(files);
  try {
    log("\nimporting…");
    importZip(deployment, written.zip, env);
  } finally {
    rmSync(written.dir, { recursive: true, force: true });
  }

  // ── Verify (second read-only export) ──────────────────────────────────────
  const ok = await withTargetExport(deployment, env, "post", async (zip, entries) => {
    const T = await readTableNumbers(zip, entries);
    let sportIds;
    if (sports === "remap") sportIds = new Set(targetSports.map((s) => s.sportId));
    else {
      sportIds = new Set();
      if (entries.has(`${SPORT_TABLE}/documents.jsonl`)) {
        for await (const row of zipJsonl(zip, `${SPORT_TABLE}/documents.jsonl`)) if (row.level === "sport") sportIds.add(row._id);
      }
    }
    let allOk = true;
    log("\nverify:");
    for (const t of tables) {
      let n = 0;
      let badSport = 0;
      let badTable = 0;
      const e = `${t}/documents.jsonl`;
      if (entries.has(e)) {
        for await (const row of zipJsonl(zip, e)) {
          n++;
          if (decodeId(row._id)?.table !== T.get(t)) badTable++;
          if (t === SPORT_TABLE) continue;
          if (!sportIds.has(row[SPORT_ID_FIELD])) badSport++;
          for (const s of row[SPORT_ID_ARRAY_FIELD] ?? []) if (!sportIds.has(s)) badSport++;
        }
      }
      const pass = n === expected[t] && badSport === 0 && badTable === 0;
      allOk &&= pass;
      log(
        `  ${pass ? "ok  " : "FAIL"} ${t.padEnd(16)} ${fmt(n).padStart(9)} rows (expected ${fmt(expected[t])})` +
          (badSport ? `, ${badSport} sport ids that are not sport rows` : "") +
          (badTable ? `, ${badTable} ids on the wrong table` : ""),
      );
    }
    return allOk;
  });
  log(ok ? "\nVERIFIED." : "\nVERIFICATION FAILED.");
  return ok ? 0 : 1;
}

async function cmdClear({ deployment, yes }, { env, log }) {
  requireZipTools();
  requireConfirmable(yes);
  const recheck = guardTarget(deployment, env, log);
  const pre = await withTargetExport(deployment, env, "pre", async (zip, entries) => {
    const tableNumbers = await readTableNumbers(zip, entries);
    const counts = {};
    for (const t of [...BUNDLE_TABLES, ...SELECTOR_DEPENDANT_TABLES]) counts[t] = await countLines(zip, entries, t);
    return { tableNumbers, counts };
  });
  const files = emptyImportFiles(pre.tableNumbers);
  log("\nrows to remove:");
  for (const t of BUNDLE_TABLES) log(`  ${t.padEnd(16)} ${fmt(pre.counts[t]).padStart(9)}`);
  for (const t of SELECTOR_DEPENDANT_TABLES) {
    if (pre.counts[t] > 0) log(`note: ${fmt(pre.counts[t])} ${t} rows stay and will point at removed rows until the next reset`);
  }
  await confirm(deployment, `empties ${BUNDLE_TABLES.join(", ")} (every selectorOptions row, not only sports)`, { yes, log });
  recheck();
  const written = writeImportZip(files);
  try {
    log("\nclearing…");
    importZip(deployment, written.zip, env);
  } finally {
    rmSync(written.dir, { recursive: true, force: true });
  }
  const ok = await withTargetExport(deployment, env, "post", async (zip, entries) => {
    let allOk = true;
    log("\nverify:");
    for (const t of BUNDLE_TABLES) {
      const n = await countLines(zip, entries, t);
      allOk &&= n === 0;
      log(`  ${n === 0 ? "ok  " : "FAIL"} ${t.padEnd(16)} ${fmt(n).padStart(9)} rows`);
    }
    return allOk;
  });
  log(ok ? "\nCLEARED." : "\nCLEAR FAILED.");
  return ok ? 0 : 1;
}

/**
 * Runs one command. Returns the exit code; never calls process.exit.
 * @param {string[]} argv arguments after the script path
 * @param {{ env?: NodeJS.ProcessEnv, log?: (s:string)=>void, error?: (s:string)=>void }} [io]
 */
export async function main(argv, { env = process.env, log = console.log, error = console.error } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof RefusedError) {
      error(`REFUSED: ${e.message}`);
      return 3;
    }
    error(`error: ${e.message}\n${USAGE}`);
    return 2;
  }
  try {
    switch (args.cmd) {
      case "build":
        await buildBundle(args.exportZip, args.bundleZip, { log });
        return 0;
      case "check":
        return await cmdCheck(args, { log });
      case "load":
        return await cmdLoad(args, { env, log });
      case "clear":
        return await cmdClear(args, { env, log });
    }
  } catch (e) {
    if (e instanceof RefusedError) {
      error(`REFUSED: ${e.message}`);
      return 3;
    }
    error(`error: ${e.message}`);
    return 1;
  }
  return 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}

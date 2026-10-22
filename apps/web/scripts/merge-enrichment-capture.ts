/**
 * NEO-346 — merge one or more `captureFromCli` results into the committed
 * enrichment recording, `convex/adapters/__fixtures__/enrichment-lookups.json`.
 *
 *     npx tsx scripts/merge-enrichment-capture.ts capture-0.json [capture-100.json …]
 *         [--replace] [--dry-run] [--fixture <path>]
 *
 * Run from `apps/web`. Each argument is a file `npx convex run
 * enrichmentFixtures:captureFromCli … > capture.json` wrote. Pages are merged
 * in the order given. By default only keys the file lacks are added, so the
 * diff is additions only; a key the file already holds with a different
 * answer is kept and listed. `--replace` takes the capture's answer for those
 * (a deliberate re-capture, runbook §4). `--dry-run` reports without writing.
 * `--fixture` points at another copy of the file (tests, a scratch check).
 *
 * The rules and the file format live in
 * `convex/adapters/enrichmentFixtureMerge.ts`; this is only the file I/O.
 * Runbook: docs/operations/neo289-enrichment-fixtures.md, §4.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  mergeCaptureIntoFixtureText,
  parseCapture,
  type CaptureSkip,
} from "../convex/adapters/enrichmentFixtureMerge";

const DEFAULT_FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../convex/adapters/__fixtures__/enrichment-lookups.json",
);

type Options = { captures: string[]; replace: boolean; dryRun: boolean; fixture: string };

function parseArgs(argv: string[]): Options {
  const options: Options = { captures: [], replace: false, dryRun: false, fixture: DEFAULT_FIXTURE };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--replace") options.replace = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--fixture") {
      const value = argv[(i += 1)];
      if (!value) throw new Error("--fixture needs a path");
      options.fixture = path.resolve(value);
    } else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else options.captures.push(path.resolve(arg));
  }
  if (options.captures.length === 0) {
    throw new Error("usage: npx tsx scripts/merge-enrichment-capture.ts <capture.json>… [--replace] [--dry-run]");
  }
  return options;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  let text = readFileSync(options.fixture, "utf8");
  const original = text;
  const totals = { added: 0, replaced: 0, unchanged: 0, differing: [] as string[] };
  const skipped: CaptureSkip[] = [];

  for (const file of options.captures) {
    const capture = parseCapture(JSON.parse(readFileSync(file, "utf8")));
    const result = mergeCaptureIntoFixtureText(text, capture, { replace: options.replace });
    text = result.text;
    totals.added += result.added.length;
    totals.replaced += result.replaced.length;
    totals.unchanged += result.unchanged.length;
    totals.differing.push(...result.differing);
    skipped.push(...capture.skippedTransport);
    console.log(
      `${path.basename(file)}: ${capture.entries.length} captured, ${result.added.length} added, ` +
        `${result.unchanged.length} unchanged, ${result.replaced.length} replaced, ` +
        `${result.differing.length} differing (kept)`,
    );
  }

  if (totals.differing.length > 0) {
    console.log(
      `\nKept the committed answer for ${totals.differing.length} key(s) the capture answered differently ` +
        "(re-run with --replace to take the capture's):",
    );
    for (const key of totals.differing) console.log(`  ${key}`);
  }
  if (skipped.length > 0) {
    console.log(`\nNot recorded (lookup did not complete; re-capture once the source recovers):`);
    for (const skip of skipped) console.log(`  ${skip.kind}: ${skip.name} (${skip.reason})`);
  }

  if (text === original) {
    console.log("\nNo change to the fixture file.");
    return;
  }
  if (options.dryRun) {
    console.log(`\n--dry-run: would add ${totals.added} and replace ${totals.replaced}; nothing written.`);
    return;
  }
  writeFileSync(options.fixture, text);
  const relative = path.relative(process.cwd(), options.fixture);
  const shown = relative.startsWith("..") ? options.fixture : relative;
  console.log(`\nWrote ${shown}: ${totals.added} added, ${totals.replaced} replaced.`);
}

try {
  main();
} catch (error) {
  console.error(`merge-enrichment-capture: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

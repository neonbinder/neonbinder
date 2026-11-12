// Keep, per base report name, only the newest attempt <= the current one.
//
// e2e.yml uploads every diagnostic artifact as `<base>-a<run_attempt>` so a
// rerun cannot overwrite an earlier attempt's evidence. The `report` job
// downloads `pw-report-*`, which after "Re-run failed jobs" holds a mix: a
// shard that passed in attempt 1 and was not rerun keeps only its `-a1`
// blob, a rerun shard has `-a1` and `-a2`. Merging both would double-count
// the shard, so for each base name only the highest attempt <= current is
// kept (a higher one is a stale leftover from a later attempt and is ignored).
//
//   node scripts/pick-report-attempts.mjs <download-dir> <current-attempt>
//
// Prints the kept directory names, and deletes the others from <download-dir>.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** @param {string[]} names @param {number} current @returns {{keep: string[], drop: string[]}} */
export function pickReportAttempts(names, current) {
  const best = new Map(); // base -> { attempt, name }
  const drop = [];
  for (const name of names) {
    const m = /^(.*)-a(\d+)$/.exec(name);
    if (!m) {
      // Unsuffixed (pre-suffix runs): treat as attempt 0 of its own base.
      const cur = best.get(name);
      if (!cur) best.set(name, { attempt: 0, name });
      else drop.push(name);
      continue;
    }
    const base = m[1];
    const attempt = Number(m[2]);
    if (attempt > current) {
      drop.push(name);
      continue;
    }
    const cur = best.get(base);
    if (!cur) best.set(base, { attempt, name });
    else if (attempt > cur.attempt) {
      drop.push(cur.name);
      best.set(base, { attempt, name });
    } else drop.push(name);
  }
  return { keep: [...best.values()].map((b) => b.name).sort(), drop: drop.sort() };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [dir, attemptArg] = process.argv.slice(2);
  const current = Number(attemptArg);
  if (!dir || !Number.isInteger(current) || current < 1) {
    console.error("usage: pick-report-attempts.mjs <download-dir> <current-attempt>");
    process.exit(2);
  }
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const { keep, drop } = pickReportAttempts(names, current);
  for (const d of drop) rmSync(join(dir, d), { recursive: true, force: true });
  console.log(`kept: ${keep.join(", ") || "(none)"}`);
  if (drop.length) console.log(`dropped: ${drop.join(", ")}`);
}

/**
 * NEO-339 — the plan/apply report as JSON (for CI and the MCP) and as
 * markdown (for a person, and the CI step summary).
 *
 * A report holds what the runner put in it: names, NB ids, marketplace ids,
 * counts — and, on a stop or a failure, an upstream error message, which the
 * tool does not control. So every byte written to disk goes through the same
 * `scrub` the MCP layer uses (secret env values + anything JWT-shaped) before
 * it is uploaded as a CI artifact.
 */

import { writeFile } from "node:fs/promises";
import { scrub } from "../auth/token-source";
import { countOpenDecisions, type ApplyReport, type OpenDecisions, type PlanReport } from "../service";

export function isApplyReport(r: PlanReport | ApplyReport): r is ApplyReport {
  return "counts" in r;
}

export function reportJson(r: PlanReport | ApplyReport): string {
  return `${JSON.stringify(r, null, 2)}\n`;
}

function openLines(d: OpenDecisions): string[] {
  const lines: string[] = [];
  for (const n of d.names) {
    lines.push(`- \`${n.at}\` ${n.kind} "${n.name}": ${n.candidates.length === 0 ? "no match" : `${n.candidates.length} candidates (${n.candidates.map((c) => c.name).join(", ")})`}`);
  }
  for (const b of d.baseCandidates) {
    lines.push(`- \`${b.at}\` ${b.path} ${b.side} Base: pick one of ${b.candidates.map((c) => `${c.id} (${c.name})`).join(", ") || "(none offered)"}`);
  }
  for (const r of d.reconcile) {
    for (const p of r.proposedPairs) {
      lines.push(`- \`${r.at}\` ${r.path} › ${r.type}: proposed "${p.name}" (BSC ${p.buysportscards.join(",") || "-"}; SL ${p.sportlots.join(",") || "-"})`);
    }
    for (const p of r.pending) lines.push(`- \`${r.at}\` ${r.path} › ${r.type}: pending ${p.side} ${p.id} "${p.name}"`);
  }
  for (const k of ["leagues", "teams", "players"] as const) {
    for (const item of d.review[k]) {
      lines.push(`- \`${item.at}\` ${k.slice(0, -1)} "${item.name}": ${item.reason}${item.detail ? ` — ${item.detail}` : ""}`);
    }
  }
  for (const s of d.slReview) for (const row of s.rows) lines.push(`- \`${s.at}\` ${s.path}: SportLots ${row.slId} "${row.name}"`);
  for (const c of d.conflicts) lines.push(`- \`${c.at}\` #${c.cardNumber}: ${c.detail}`);
  for (const g of d.grouping ?? []) lines.push(`- \`${g.at}\` ${g.path} › ${g.type}: ${g.problem} "${g.name}" — ${g.detail}`);
  return lines;
}

export function reportMarkdown(r: PlanReport | ApplyReport): string {
  const apply = isApplyReport(r);
  const open = countOpenDecisions(r.openDecisions);
  const out: string[] = [];
  out.push(`## setbuild ${apply ? "apply" : "plan"}: ${r.scope}`);
  out.push("");
  out.push(`Target \`${r.target.host}\` · confirm with \`${r.confirmPhrase}\``);
  if (apply) {
    out.push("");
    const counts = Object.entries(r.counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    const stops = r.stops ?? (r.stoppedAt ? [r.stoppedAt] : []);
    const head =
      stops.length > 1
        ? `**Stopped** at ${stops.length} open decisions (the rest ran)`
        : r.stoppedAt
          ? `**Stopped** at step ${r.stoppedAt.step}: ${r.stoppedAt.reason}`
          : "**Done**";
    out.push(`${head} in ${(r.durationMs / 1000).toFixed(1)}s — ${counts}`);
    if (stops.length > 1) for (const s of stops) out.push(`- step ${s.step}: ${s.reason}`);
  }
  out.push("");
  out.push("| # | Step | Path | Action | Status |");
  out.push("|---|---|---|---|---|");
  for (const s of r.steps) {
    const action = `${s.action}${s.detail ? ` (${s.detail})` : ""}`.replace(/\|/g, "\\|");
    out.push(`| ${s.index} | ${s.kind} | ${s.path} | ${action} | ${s.status} |`);
  }
  if (open > 0) {
    out.push("");
    out.push(`### ${open} open decision${open === 1 ? "" : "s"}`);
    out.push("");
    out.push(...openLines(r.openDecisions));
    out.push("");
    out.push("Fill in the template (JSON report, `template`) and run again.");
  }
  return `${out.join("\n")}\n`;
}

/**
 * Write `<path>` (JSON) and `<path minus .json>.md` (markdown), both scrubbed
 * of `secrets` and of anything JWT-shaped. Returns the markdown path.
 */
export async function writeReportFiles(
  path: string,
  r: PlanReport | ApplyReport,
  secrets: Iterable<string | undefined | null>,
): Promise<string> {
  const keep = [...secrets];
  await writeFile(path, scrub(reportJson(r), keep), "utf8");
  const md = path.replace(/\.json$/i, "") + ".md";
  await writeFile(md, scrub(reportMarkdown(r), keep), "utf8");
  return md;
}

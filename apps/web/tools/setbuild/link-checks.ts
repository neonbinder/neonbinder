/**
 * NEO-339 — the live link assertions the two smoke harnesses share.
 *
 * A Set Builder link in a report is only worth anything if it opens the row.
 * Three things are checked, all against what the run itself returned:
 *
 *   1. FORM: the Set Builder route with the drill's own query keys
 *      (`/admin/set-builder?sport=…&year=…&brand=…&set=…`), absolute on the
 *      app origin when the run was given one (CI passes `--app-url`),
 *      root-relative otherwise, and nothing else in the query;
 *   2. OPENS: the ids in those params, taken in the page's order, are handed
 *      to the page's own read-only resolver (`resolveDrillPath`) through the
 *      tool's client, and it must answer every one of them: a link built from
 *      live ids is proven to open the row, not just to look right;
 *   3. a SET link is four ids deep (sport, year, brand, set).
 *
 * The checks return problem strings and never throw; the resolver is
 * injected so a unit test can drive them without a deployment.
 */

import { DRILL_LEVELS, DRILL_PARAMS } from "../../components/SetSelector/drill-url";
import { api } from "../../convex/_generated/api";
import type { NbClient } from "./client/convex-client";
import type { InspectReport, InspectRow, SetLink } from "./service";
import { SET_BUILDER_ROUTE } from "./lib/set-builder-link";

/** `resolveDrillPath`'s answer, as far as the checks read it. */
export type DrillResolver = (ids: string[]) => Promise<ReadonlyArray<{ _id: string; level: string }>>;

/** The page's read-only resolver, through the tool's own client. */
export function drillResolverOf(client: NbClient): DrillResolver {
  return (ids) => client.query(api.drillPath.resolveDrillPath, { ids });
}

/** A set is the fourth level of the drill. */
export const SET_DEPTH = DRILL_LEVELS.indexOf("setName") + 1;

const DRILL_KEYS: readonly string[] = DRILL_LEVELS.map((l) => DRILL_PARAMS[l]);

/** The ids a Set Builder link's query carries, in the page's level order; a problem when it is not one. */
export function parseDrillLink(
  link: unknown,
  appOrigin?: string,
): { ids: string[] } | { problem: string } {
  if (typeof link !== "string" || link === "") return { problem: "no link" };
  let url: URL;
  try {
    url = new URL(link, "http://relative.invalid");
  } catch {
    return { problem: `"${link}" is not a URL` };
  }
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(link);
  if (appOrigin !== undefined) {
    if (!absolute) return { problem: `"${link}" is not absolute, expected it on ${new URL(appOrigin).origin}` };
    if (url.origin !== new URL(appOrigin).origin) return { problem: `"${link}" is not on the app origin` };
  } else if (absolute) {
    return { problem: `"${link}" is absolute but no app origin was given` };
  }
  if (url.pathname !== SET_BUILDER_ROUTE) return { problem: `"${link}" is not the Set Builder (${SET_BUILDER_ROUTE})` };
  const stray = [...url.searchParams.keys()].filter((k) => !DRILL_KEYS.includes(k));
  if (stray.length > 0) return { problem: `"${link}" carries ${stray.join(", ")}, which is not a drill key` };
  const ids: string[] = [];
  for (const level of DRILL_LEVELS) {
    const values = url.searchParams.getAll(DRILL_PARAMS[level]);
    if (values.length > 1) return { problem: `"${link}" repeats ${DRILL_PARAMS[level]}` };
    if (values.length === 0) break;
    if (values[0] === "") return { problem: `"${link}" has an empty ${DRILL_PARAMS[level]}` };
    ids.push(values[0]);
  }
  // A deeper key after a gap is not a path.
  if (ids.length !== [...url.searchParams.keys()].length) return { problem: `"${link}" skips a level of the drill` };
  if (ids.length === 0) return { problem: `"${link}" opens the Set Builder at its root, not at the row` };
  return { ids };
}

/**
 * Problems with one link: its form, then whether the resolver answers every id
 * it carries. `depth` additionally pins how many ids the link must carry.
 */
export async function linkProblems(
  what: string,
  link: unknown,
  o: { appOrigin?: string; resolve: DrillResolver; depth?: number },
): Promise<string[]> {
  const parsed = parseDrillLink(link, o.appOrigin);
  if ("problem" in parsed) return [`${what}: ${parsed.problem}`];
  if (o.depth !== undefined && parsed.ids.length !== o.depth) {
    return [`${what}: the link is ${parsed.ids.length} ids deep, expected ${o.depth}`];
  }
  let resolved: ReadonlyArray<{ _id: string; level: string }>;
  try {
    resolved = await o.resolve(parsed.ids);
  } catch (err) {
    return [`${what}: resolveDrillPath failed (${err instanceof Error ? err.message : String(err)})`];
  }
  if (resolved.length !== parsed.ids.length) {
    return [`${what}: resolveDrillPath answered ${resolved.length} of ${parsed.ids.length} levels, so the link does not open the row`];
  }
  const wrong = parsed.ids.findIndex((id, i) => String(resolved[i]._id) !== id);
  if (wrong >= 0) return [`${what}: resolveDrillPath answered another row at ${DRILL_LEVELS[wrong]}`];
  return [];
}

/** Run `linkProblems` over many links, once per distinct link. */
async function allLinkProblems(
  links: Array<{ what: string; link: unknown; depth?: number }>,
  o: { appOrigin?: string; resolve: DrillResolver },
): Promise<string[]> {
  const seen = new Set<string>();
  const unique = links.filter((l) => {
    const key = `${String(l.link)}|${l.depth ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const out: string[] = [];
  for (let i = 0; i < unique.length; i += 8) {
    const batch = await Promise.all(
      unique.slice(i, i + 8).map((l) => linkProblems(l.what, l.link, { ...o, depth: l.depth })),
    );
    for (const b of batch) out.push(...b);
  }
  return out;
}

/** Every link an apply report carries: it must carry at least one, each a set, each opening it. */
export async function setLinkProblems(
  setLinks: ReadonlyArray<Pick<SetLink, "path" | "link">> | undefined,
  o: { appOrigin?: string; resolve: DrillResolver },
): Promise<string[]> {
  if (!setLinks || setLinks.length === 0) return ["the report has no setLinks, though the run touched a set"];
  return allLinkProblems(
    setLinks.map((l) => ({ what: `setLinks "${l.path}"`, link: l.link, depth: SET_DEPTH })),
    o,
  );
}

/** Every `link` an nb_inspect report carries: the node, its sets, its Base, every type and row. */
export async function inspectLinkProblems(
  report: InspectReport,
  o: { appOrigin?: string; resolve: DrillResolver },
): Promise<string[]> {
  if (!report.found) return [];
  const links: Array<{ what: string; link: unknown }> = [];
  if (report.link !== undefined) links.push({ what: `${report.pathText} link`, link: report.link });
  for (const s of report.sets ?? []) links.push({ what: `set "${s.name}" link`, link: s.link });
  const row = (what: string, r: InspectRow) => {
    links.push({ what: `${what} link`, link: r.link });
    for (const p of r.parallels ?? []) links.push({ what: `${what} › ${p.name} link`, link: p.link });
  };
  if (report.base) row("Base", report.base);
  for (const t of report.variantTypes ?? []) {
    links.push({ what: `${t.type} link`, link: t.link });
    for (const r of t.rows) row(`${t.type} › ${r.name}`, r);
  }
  // A set report must link its own node, and the set's link is a set.
  if (report.sets === undefined && report.variantTypes !== undefined && report.link === undefined) {
    return ["the set report has no link of its own", ...(await allLinkProblems(links, o))];
  }
  const problems = await allLinkProblems(links, o);
  return problems.length > 8 ? [...problems.slice(0, 8), `+${problems.length - 8} more link problems`] : problems;
}

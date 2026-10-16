/**
 * NEO-339 — `inspect`: what a path holds now. Read-only (public admin queries
 * only), and the numbers `mcp-smoke` asserts against: the Base row's card
 * count and links, every variant type's rows with their card counts, and an
 * insert row's parallels (the `parallel` level under it) beneath it.
 */

import { variantTypeKind } from "../../../convex/variantRole";
import type { NbClient } from "../client/convex-client";
import type { Target } from "../client/target";
import { formatPath, isSetPath, ResolveError, type InspectReport, type InspectRow, type MarketplaceLinks, type NodePath } from "../service";
import { childrenOf, resolveBrandYear, resolveSetPath, type SelectorRow } from "../spec/resolve";
import { cardCount } from "../lib/commit";

/** The marketplace ids in a row's platform slots, per side. */
export function linksOf(row: Pick<SelectorRow, "platformData">): MarketplaceLinks {
  const pd = (row.platformData ?? {}) as { bsc?: Record<string, string>; sportlots?: Record<string, string> };
  return {
    buysportscards: Object.values(pd.bsc ?? {}).filter(Boolean),
    sportlots: Object.values(pd.sportlots ?? {}).filter(Boolean),
  };
}

export function isBaseRow(row: SelectorRow): boolean {
  return variantTypeKind(row) === "base";
}

async function inspectRow(client: NbClient, row: SelectorRow, isBase: boolean): Promise<InspectRow> {
  return { name: row.value, cards: await cardCount(client, row._id), isBase, links: linksOf(row) };
}

export async function inspectPath(
  client: NbClient,
  target: Pick<Target, "convexUrl" | "host">,
  path: NodePath,
): Promise<InspectReport> {
  const pathText = formatPath(path);
  const head = { target: { convexUrl: target.convexUrl, host: target.host }, path, pathText };
  try {
    if (!isSetPath(path)) {
      const brand = await resolveBrandYear(client, path);
      const sets = await childrenOf(client, "setName", brand.manufacturerId);
      return { ...head, found: true, sets: sets.map((s) => ({ name: s.value, links: linksOf(s) })) };
    }
    const set = await resolveSetPath(client, path);
    const types = await childrenOf(client, "variantType", set.setId);
    let base: InspectRow | null = null;
    const variantTypes: NonNullable<InspectReport["variantTypes"]> = [];
    for (const t of types) {
      if (isBaseRow(t)) {
        const row = await inspectRow(client, t, true);
        base = row;
        variantTypes.push({ type: t.value, rows: [row] });
        continue;
      }
      const rows = await childrenOf(client, "insert", t._id);
      const out: InspectRow[] = [];
      for (const r of rows) {
        const row = await inspectRow(client, r, false);
        const parallels = await childrenOf(client, "parallel", r._id);
        if (parallels.length > 0) {
          row.parallels = [];
          for (const p of parallels) row.parallels.push(await inspectRow(client, p, false));
        }
        out.push(row);
      }
      variantTypes.push({ type: t.value, rows: out });
    }
    return { ...head, found: true, base, variantTypes };
  } catch (err) {
    if (err instanceof ResolveError) return { ...head, found: false };
    throw err;
  }
}

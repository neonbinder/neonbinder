/**
 * NEO-339 — `inspect`: what a path holds now. Read-only (public admin queries
 * only), and the numbers `mcp-smoke` asserts against: the Base row's card
 * count and links, every variant type's rows with their card counts, and an
 * insert row's parallels (the `parallel` level under it) beneath it.
 *
 * Every node and row it lists carries its Set Builder link, built from the ids
 * the walk already holds (`setBuilderUrlForPath`): no query per link.
 *
 * `attention: true` adds what the node still needs from a person (the totals
 * and line `nb_attention` leads with). Opt-in: it reads every card of every
 * row and each column's name suggestions.
 */

import { variantTypeKind } from "../../../convex/variantRole";
import type { NbClient } from "../client/convex-client";
import type { Target } from "../client/target";
import {
  formatPath,
  isSetPath,
  linksNoteFor,
  ResolveError,
  type InspectOptions,
  type InspectReport,
  type InspectRow,
  type MarketplaceLinks,
  type NodePath,
} from "../service";
import { childrenOf, resolveBrandYear, resolveSetPath, type SelectorRow } from "../spec/resolve";
import { cardCount } from "../lib/commit";
import { setBuilderUrlForPath } from "../lib/set-builder-link";
import { attentionSummaryOf } from "./attention";

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

async function inspectRow(client: NbClient, row: SelectorRow, isBase: boolean, link: string): Promise<InspectRow> {
  return { name: row.value, cards: await cardCount(client, row._id), isBase, links: linksOf(row), link };
}

export async function inspectPath(
  client: NbClient,
  target: Pick<Target, "convexUrl" | "host" | "appOrigin">,
  path: NodePath,
  opts: InspectOptions = {},
): Promise<InspectReport> {
  const pathText = formatPath(path);
  const head = { target: { convexUrl: target.convexUrl, host: target.host }, path, pathText };
  const linkTo = (ids: readonly string[]) => setBuilderUrlForPath(ids, target.appOrigin);
  try {
    if (!isSetPath(path)) {
      const brand = await resolveBrandYear(client, path);
      const at = [brand.sportId, brand.yearId, brand.manufacturerId];
      const sets = await childrenOf(client, "setName", brand.manufacturerId);
      return {
        ...head,
        found: true,
        link: linkTo(at),
        sets: sets.map((s) => ({ name: s.value, links: linksOf(s), link: linkTo([...at, s._id]) })),
        ...(opts.attention ? { attention: await attentionSummaryOf(client, path, brand) } : {}),
        ...linksNoteFor(target),
      };
    }
    const set = await resolveSetPath(client, path);
    const setIds = [set.sportId, set.yearId, set.manufacturerId, set.setId];
    const types = await childrenOf(client, "variantType", set.setId);
    let base: InspectRow | null = null;
    const variantTypes: NonNullable<InspectReport["variantTypes"]> = [];
    for (const t of types) {
      const typeIds = [...setIds, t._id];
      if (isBaseRow(t)) {
        const row = await inspectRow(client, t, true, linkTo(typeIds));
        base = row;
        variantTypes.push({ type: t.value, link: linkTo(typeIds), rows: [row] });
        continue;
      }
      const rows = await childrenOf(client, "insert", t._id);
      const out: InspectRow[] = [];
      for (const r of rows) {
        const row = await inspectRow(client, r, false, linkTo([...typeIds, r._id]));
        const parallels = await childrenOf(client, "parallel", r._id);
        if (parallels.length > 0) {
          row.parallels = [];
          for (const p of parallels) row.parallels.push(await inspectRow(client, p, false, linkTo([...typeIds, r._id, p._id])));
        }
        out.push(row);
      }
      variantTypes.push({ type: t.value, link: linkTo(typeIds), rows: out });
    }
    return {
      ...head,
      found: true,
      link: linkTo(setIds),
      base,
      variantTypes,
      ...(opts.attention ? { attention: await attentionSummaryOf(client, path, set) } : {}),
      ...linksNoteFor(target),
    };
  } catch (err) {
    if (err instanceof ResolveError) return { ...head, found: false };
    throw err;
  }
}

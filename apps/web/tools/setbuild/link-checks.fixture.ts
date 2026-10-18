/**
 * NEO-339 — a tiny Set Builder world for the harness tests: real-looking
 * deep links over a handful of known ids, and a stand-in for the page's
 * `resolveDrillPath` that answers exactly as the server does for them (every
 * id up to the first one it does not know).
 *
 * Test-only: imported by `link-checks.test.ts`, `mcp-smoke.test.ts` and
 * `mcp-oneshot.test.ts`.
 */

import { DRILL_LEVELS } from "../../components/SetSelector/drill-url";
import type { DrillResolver } from "./link-checks";

export const APP = "https://app.example.test";

/** Root-first ids of one set and a few rows beneath it. */
export const CHAIN = ["sp1", "yr1", "br1", "set1", "vt-base", "vt-ins", "vt-par"] as const;
const ALSO_KNOWN = ["vt-par-2", "ins-row", "par-row"];

const KEYS = ["sport", "year", "brand", "set", "type", "insert", "parallel"] as const;

/** `/admin/set-builder?sport=…` for the first `depth` ids of `CHAIN`, absolute on `origin` when given. */
export function linkAt(depth: number, origin?: string, ids: readonly string[] = CHAIN): string {
  const q = ids
    .slice(0, depth)
    .map((id, i) => `${KEYS[i]}=${id}`)
    .join("&");
  return `${origin ?? ""}/admin/set-builder?${q}`;
}

export const SET_LINK = linkAt(4);
export const SET_LINK_ABS = linkAt(4, APP);

/** The server's `resolveDrillPath` for the ids this world knows; a spy-able function. */
export function knownResolver(known: readonly string[] = [...CHAIN, ...ALSO_KNOWN]): DrillResolver {
  return async (ids) => {
    const out: Array<{ _id: string; level: string }> = [];
    for (const [i, id] of ids.entries()) {
      if (!known.includes(id)) break;
      out.push({ _id: id, level: DRILL_LEVELS[i] });
    }
    return out;
  };
}

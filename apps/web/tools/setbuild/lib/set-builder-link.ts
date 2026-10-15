/**
 * NEO-339 — a deep link into the Set Builder, for every message that sends
 * the operator there (Jason: "as close to the set they are working as is
 * possible").
 *
 * The link is the Set Builder's own address-bar drill (NEO-224):
 * `/admin/set-builder?sport=…&year=…&brand=…&set=…&type=…&insert=…&parallel=…`,
 * NB `selectorOptions` ids, root first, built with the same level table and
 * serializer the page reads it with (`components/SetSelector/drill-url.ts`).
 * The chain comes from `selectorOptions.getAncestorChain`, the admin query the
 * tool already reads ancestors through; nothing is derived from a name.
 *
 * Absolute on the target's `appOrigin` (`--app-url` / `NB_SETBUILD_APP_URL`)
 * when there is one, root-relative otherwise: the tool does not know which web
 * app serves a deployment unless told, and a guessed host could open a
 * different deployment's Set Builder, where these ids mean nothing.
 */

import type { FunctionReturnType } from "convex/server";
import { DRILL_LEVELS, serializeDrillPath } from "../../../components/SetSelector/drill-url";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { NbClient } from "../client/convex-client";

/** The Set Builder's route (src/main.tsx: `/admin` › `set-builder`). */
export const SET_BUILDER_ROUTE = "/admin/set-builder";

type ChainRow = Pick<FunctionReturnType<typeof api.selectorOptions.getAncestorChain>[number], "_id" | "level">;

/**
 * The drill path for a row's ancestor chain (root first, the row last): the
 * ids from the root down for as long as each sits at the level the cascade
 * expects there. A chain that breaks off (a row not hanging where the cascade
 * would show it) links to the deepest point that holds.
 */
export function drillPathOf(chain: ReadonlyArray<ChainRow>): string[] {
  const path: string[] = [];
  for (let i = 0; i < chain.length && i < DRILL_LEVELS.length; i++) {
    if (chain[i].level !== DRILL_LEVELS[i]) break;
    path.push(String(chain[i]._id));
  }
  return path;
}

/** The Set Builder URL for a chain: absolute on `appOrigin`, else root-relative. */
export function setBuilderUrl(chain: ReadonlyArray<ChainRow>, appOrigin?: string): string {
  const query = serializeDrillPath(drillPathOf(chain)).toString();
  const path = query ? `${SET_BUILDER_ROUTE}?${query}` : SET_BUILDER_ROUTE;
  return appOrigin ? new URL(path, appOrigin).toString() : path;
}

/**
 * The Set Builder URL for one row, opened on that row. A link is an aid to the
 * message it sits in, never a reason to lose that message: if the chain cannot
 * be read, the link opens the Set Builder at its root.
 */
export async function setBuilderLink(client: NbClient, rowId: Id<"selectorOptions">): Promise<string> {
  let chain: ReadonlyArray<ChainRow> = [];
  try {
    chain = await client.query(api.selectorOptions.getAncestorChain, { id: rowId });
  } catch {
    // Fall through to the root link.
  }
  return setBuilderUrl(chain, client.target.appOrigin);
}

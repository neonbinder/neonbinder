/**
 * Marketplace display labels on the wire, keyed by marketplace id WITHOUT the
 * id ever becoming a field name.
 *
 * Convex field names must be non-control ASCII. A marketplace id is not: BSC
 * slugs carry accents (`topps-chrome-exposé`), and a SportLots value is
 * whatever SportLots typed. An object keyed by one is rejected by Convex
 * ("Field name … has invalid character") the moment it crosses a function
 * boundary, and the whole call is lost. So a marketplace value only ever
 * travels as a VALUE: here, a list of `{ id, label }` pairs.
 *
 * Stored labels are unaffected: `platformLabels` on a row is keyed by SLOT
 * (`b0`, `s0`), which NB mints and which is always ASCII.
 */

import { v, type Infer } from "convex/values";

export const platformLabelPairValidator = v.object({
  id: v.string(),
  label: v.string(),
});

export type PlatformLabelPair = Infer<typeof platformLabelPairValidator>;

/**
 * One side's labels as a caller sends them.
 *
 * The pair list is the shape every caller in this repo sends. The id-keyed
 * record is the shape an SPA bundle built before the change still sends from
 * an open tab across a deploy; it keeps working for ids that are valid field
 * names (any other id never reached the handler in that shape anyway, Convex
 * refused it at the boundary). Remove the record arm once no old bundle can be
 * open, which costs nothing: the handler reads both through `labelForId`.
 */
export const platformLabelSideValidator = v.union(
  v.array(platformLabelPairValidator),
  v.record(v.string(), v.string()),
);

export type PlatformLabelSide = Infer<typeof platformLabelSideValidator>;

/** The label a caller sent for `id`, or undefined. Last pair for an id wins. */
export function labelForId(
  side: PlatformLabelSide | undefined,
  id: string,
): string | undefined {
  if (side === undefined) return undefined;
  if (Array.isArray(side)) {
    let found: string | undefined;
    for (const pair of side) if (pair.id === id) found = pair.label;
    return found;
  }
  return Object.prototype.hasOwnProperty.call(side, id) ? side[id] : undefined;
}

// NEO-520: query-string parser for the test-only seed-pick-order page's eBay `line` params.

export type EbayLine = { quantity: number; title?: string };

/**
 * `["1:2024 Topps Chrome #7 Thing", "2:"]` →
 * `[{quantity:1,title:"2024 Topps Chrome #7 Thing"},{quantity:2}]`: the text
 * before the first ":" is the quantity, the rest the title as given (empty =
 * none, so a title may hold ":"). Null when any entry is malformed or none is given.
 */
export function parseEbayLines(raws: readonly string[]): EbayLine[] | null {
  const out: EbayLine[] = [];
  for (const raw of raws) {
    const at = raw.indexOf(":");
    if (at <= 0) return null;
    const quantity = Number(raw.slice(0, at));
    if (!Number.isInteger(quantity)) return null;
    const title = raw.slice(at + 1);
    out.push(title.trim() ? { quantity, title } : { quantity });
  }
  return out.length > 0 ? out : null;
}

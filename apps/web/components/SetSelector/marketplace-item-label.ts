/**
 * NEO-325 — how a marketplace item is NAMED on screen when its name is not
 * enough to tell it apart.
 *
 * SportLots routinely lists several distinct sets under one name (a year's
 * "Anime" can be three different radio ids). The id is the item's identity;
 * the name is only what it is called. So every control that acts on an item
 * keys on `platformValue`, and this file only decides the words a person sees
 * and hears for it.
 *
 * Decision D2 (Jason): the id is shown ONLY when the name is shared by more
 * than one item on that side. A unique name renders exactly as it always did,
 * so existing accessible names ("Make its own set: Anime") keep matching.
 *
 * Wording (Jason): `Anime (#378117)`, the same on both sides. Every row that
 * shows a twin already carries its SL / BSC badge or sits under its side's
 * heading, so the suffix does not repeat the marketplace. Keep the wording in
 * THIS file: every caller goes through `itemLabelParts` / `itemLabel` /
 * `sharedTitleLabels` / `siblingTwinSuffixes`, so a wording change is one
 * edit here.
 */
import { SIDE_LABEL } from "./selector-sync-feedback";

export type MarketplaceSide = "bsc" | "sl";

/** The comparison key for "same name": case-folded and trimmed. */
export function nameKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The names (as `nameKey`s) that more than one DISTINCT item carries.
 *
 * An item is counted once per `platformValue` when it has one: the same
 * marketplace set mapped by two NB sets is still one set, not a twin of
 * itself. Items without a `platformValue` are each counted.
 */
export function duplicateNames(
  items: ReadonlyArray<{ value: string; platformValue?: string }>,
): Set<string> {
  const seenIds = new Set<string>();
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.platformValue !== undefined) {
      if (seenIds.has(item.platformValue)) continue;
      seenIds.add(item.platformValue);
    }
    const key = nameKey(item.value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const dups = new Set<string>();
  for (const [key, n] of counts) if (n > 1) dups.add(key);
  return dups;
}

/** The marketplace id as a person reads it: `#378117`, `#anime-slug`. */
function idText(platformValue: string): string {
  return `#${platformValue}`;
}

/**
 * The name and, for a duplicated name only, the suffix that disambiguates it.
 * Split so a row can style the suffix as secondary; `itemLabel` joins them
 * for accessible names, so what is heard always contains what is seen.
 *
 * `side` no longer changes the words: both sides read `(#id)`, because the
 * row's own badge or column already names the marketplace. It stays in the
 * signature so each call site says which side's `dups` it is reading.
 */
export function itemLabelParts(
  item: { value: string; platformValue: string },
  side: MarketplaceSide,
  dups: ReadonlySet<string>,
): { name: string; suffix: string | null } {
  if (!dups.has(nameKey(item.value))) return { name: item.value, suffix: null };
  return { name: item.value, suffix: `(${idText(item.platformValue)})` };
}

/** `value`, or `value (#12345)` / `value (#bsc-slug)` when the name is shared. */
export function itemLabel(
  item: { value: string; platformValue: string },
  side: MarketplaceSide,
  dups: ReadonlySet<string>,
): string {
  const { name, suffix } = itemLabelParts(item, side, dups);
  return suffix ? `${name} ${suffix}` : name;
}

/** `(#378117)` / `(#378117, #378118)` — ids from ONE marketplace. */
function idsSuffix(platformValues: readonly string[]): string {
  return `(${platformValues.map(idText).join(", ")})`;
}

/**
 * NEO-325 — ids from BOTH marketplaces, each side named, so nobody has to
 * guess which id is whose: `BSC #chrome-update-sapphire · SportLots #378118`.
 * The same form as `twinLeftIdsText` (keep the two in step).
 */
export function sideNamedIdsText(
  bsc: readonly string[],
  sportlots: readonly string[],
): string {
  const sides: string[] = [];
  if (bsc.length > 0) sides.push(`${SIDE_LABEL.bsc} ${bsc.map(idText).join(", ")}`);
  if (sportlots.length > 0) {
    sides.push(`${SIDE_LABEL.sportlots} ${sportlots.map(idText).join(", ")}`);
  }
  return sides.join(" · ");
}

/**
 * The marketplace ids a stored `selectorOptions` row carries, BSC first, each
 * side in slot order. Read structurally: the column queries hand rows over as
 * loosely-typed `SelectorItem`s, and a legacy row may still hold a bare
 * string where NEO-137 put a slot map.
 */
export function rowMarketplaceIds(platformData: unknown): string[] {
  if (!platformData || typeof platformData !== "object") return [];
  const out: string[] = [];
  for (const side of ["bsc", "sportlots"] as const) {
    const raw = (platformData as Record<string, unknown>)[side];
    if (typeof raw === "string") {
      if (raw) out.push(raw);
      continue;
    }
    if (Array.isArray(raw)) {
      for (const id of raw) if (typeof id === "string" && id) out.push(id);
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const slotNumber = (slot: string) => {
      const n = Number(slot.slice(1));
      return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
    };
    for (const [, id] of Object.entries(raw as Record<string, unknown>).sort(
      ([a], [b]) => slotNumber(a) - slotNumber(b),
    )) {
      if (typeof id === "string" && id) out.push(id);
    }
  }
  return out;
}

/**
 * NEO-325 — the `(#id)` a stored row wears in a column list (Sports, Years,
 * Manufacturers, Sets, and every column below them, which share the one list
 * component) when a SIBLING carries the same name.
 *
 * Column sync gives each same-named marketplace twin its own row, so a
 * year can hold three "Anime" sets under one brand. Each such row is followed
 * by the ids in its own slots — the only stable thing that differs between
 * them. A unique name gets no entry and renders exactly as before (Decision
 * D2), so every existing visible text and accessible name is unchanged.
 *
 * Siblings are rows with the same `parentId`: the All Brands view lists every
 * brand's sets together, and "Chrome" under Bowman and "Chrome" under Topps
 * are not twins (the view's brand line already tells those apart). A twin
 * with no marketplace id has nothing to show, so it gets no entry either.
 *
 * Returns `_id` → suffix, e.g. `(#378117)`.
 */
export function siblingTwinSuffixes(
  rows: ReadonlyArray<{
    _id: string;
    value?: unknown;
    parentId?: unknown;
    platformData?: unknown;
  }>,
): Map<string, string> {
  const groupOf = (row: { value?: unknown; parentId?: unknown }) =>
    `${String(row.parentId ?? "")}\u0000${nameKey(String(row.value ?? ""))}`;
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.value !== "string") continue;
    const g = groupOf(row);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const suffixes = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.value !== "string") continue;
    if ((counts.get(groupOf(row)) ?? 0) < 2) continue;
    const ids = rowMarketplaceIds(row.platformData);
    if (ids.length > 0) suffixes.set(row._id, idsSuffix(ids));
  }
  return suffixes;
}

/**
 * NEO-325 — what each NeonBinder set in the reconciler is CALLED in the
 * accessible names of its own controls ("Remove set …", "NeonBinder set name
 * for …", "Toggle details for …", and every sentence that names it).
 *
 * The title is the operator's, and it is what is stored, so it is never
 * altered here. But "Make its own set" on two SportLots twins makes two sets
 * with the same title, and then every control on the two rows has the same
 * name. So a title more than one set carries (same `nameKey` fold as item
 * names) is followed by the ids of the marketplace sets mapped to that row,
 * in the same `(#id)` form a twin item wears:
 *
 *   Chrome Update Sapphire (#378117)
 *   Chrome Update Sapphire (BSC #chrome-update-sapphire · SportLots #378118)
 *
 * Ids from one marketplace stay bare (the row's chips name the side); ids
 * from both name each side, or a slug and a number read as one list.
 *
 * The ids are the row's only stable difference: the operator may rename both
 * twins to the same new title, but the sets mapped to each stay distinct.
 * They are also on screen, in the row's own chips. If two rows with the same
 * title also map exactly the same ids (rare; a marketplace set may back
 * several NB sets), list position finishes the job: `…, 2 of 2`.
 *
 * A unique title maps to itself, unchanged.
 */
export function sharedTitleLabels(
  sets: ReadonlyArray<{
    key: string;
    title: string;
    bsc: ReadonlyArray<{ platformValue: string }>;
    sl: ReadonlyArray<{ platformValue: string }>;
  }>,
): Map<string, string> {
  const titleCounts = new Map<string, number>();
  for (const set of sets) {
    const k = nameKey(set.title);
    titleCounts.set(k, (titleCounts.get(k) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const set of sets) {
    if ((titleCounts.get(nameKey(set.title)) ?? 0) < 2) {
      labels.set(set.key, set.title);
      continue;
    }
    const ids = [...set.bsc, ...set.sl].map((i) => i.platformValue);
    const suffix =
      set.bsc.length > 0 && set.sl.length > 0
        ? `(${sideNamedIdsText(
            set.bsc.map((i) => i.platformValue),
            set.sl.map((i) => i.platformValue),
          )})`
        : idsSuffix(ids);
    labels.set(
      set.key,
      ids.length > 0 ? `${set.title.trim()} ${suffix}` : set.title,
    );
  }
  // Last resort for rows the ids could not tell apart.
  const byLabel = new Map<string, string[]>();
  for (const set of sets) {
    const label = labels.get(set.key)!;
    if (label === set.title) continue;
    const k = nameKey(label);
    byLabel.set(k, [...(byLabel.get(k) ?? []), set.key]);
  }
  for (const keys of byLabel.values()) {
    if (keys.length < 2) continue;
    keys.forEach((key, n) => {
      labels.set(key, `${labels.get(key)}, ${n + 1} of ${keys.length}`);
    });
  }
  return labels;
}

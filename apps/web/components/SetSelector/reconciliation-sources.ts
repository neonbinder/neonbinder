/**
 * NEO-496 (C1a) — the sources a reconciliation lines up, and the reducer that
 * builds NeonBinder sets out of them.
 *
 * The Reconcile dialog used to know exactly two lists, BSC and SportLots, and
 * spelled them out everywhere: `bsc`/`sl` arrays on every Ready set,
 * `pendingBsc`/`pendingSl` in the state, a branch per side in every action.
 * Everything here is keyed by `SourceKey` instead, and the dialog draws one
 * column per `SourceDescriptor` it is handed. A new source (the published
 * checklist, NEO-496 C1b) is one descriptor plus its data: no reducer branch.
 *
 * What stays tied to a marketplace stays tied to it, outside this module: the
 * SportLots name prefixes, held and twin ids, the SportLots candidates and the
 * Base check probe. Those are facts about one marketplace's catalogue, not
 * about lining sets up.
 *
 * Pure: no React, so it is testable on its own.
 */

import type { Id } from "../../convex/_generated/dataModel";

// ===== ITEMS AND SETS =====

export type PlatformItem = {
  value: string;
  platformValue: string;
};

/**
 * What the modal lets an operator say about a set beyond its title and its
 * marketplace mappings. NEO-291: only the card prefix. Insert/Parallel used to
 * be here as checkboxes, but which of those a row IS is a fact of where it sits
 * in the hierarchy (its level and its variant type), not a box to tick.
 */
export type ItemMetadata = {
  cardNumberPrefix?: string;
};

// ===== SOURCES =====

/** Everything a reconciliation can line up. Marketplace keys match `platformData`. */
export type SourceKey = "bsc" | "sportlots" | "checklist";

/** The sources that are marketplaces: their ids are what Save writes to `platformData`. */
export type MarketplaceSourceKey = Exclude<SourceKey, "checklist">;

/** Every source, in the order a new set takes its default title from. */
export const SOURCE_KEYS: readonly SourceKey[] = ["bsc", "sportlots", "checklist"];

export const isMarketplaceSource = (
  key: SourceKey,
): key is MarketplaceSourceKey => key !== "checklist";

/**
 * The colour role a source's column heading, badges and chips paint with.
 * The dialog maps each to its classes (Tailwind needs them written out).
 */
export type SourceTone = "blue" | "purple" | "teal";

type SourceDescriptorBase = {
  /** Full name, in headings: "BSC", "SportLots", "Checklist". */
  label: string;
  /**
   * The name inside a sentence ("Nothing pending on BSC", "Show checklist
   * sections already mapped"). The marketplaces are proper names and read the
   * same; the checklist is a common noun.
   */
  sentenceLabel: string;
  /** What one of its items is: "set" for a marketplace, "section" for a checklist. */
  noun: string;
  /** The short tag on a row's badge and a Ready set's chip: "BSC", "SL". */
  badge: string;
  /** The column's search box, as its accessible name ("…" is added for the placeholder). */
  filterLabel: string;
  tone: SourceTone;
};

/** One column of the Reconcile dialog. */
export type SourceDescriptor =
  | (SourceDescriptorBase & { kind: "marketplace"; key: MarketplaceSourceKey })
  | (SourceDescriptorBase & { kind: "checklist"; key: "checklist" });

export const BSC_SOURCE: SourceDescriptor = {
  key: "bsc",
  kind: "marketplace",
  label: "BSC",
  sentenceLabel: "BSC",
  noun: "set",
  badge: "BSC",
  filterLabel: "Filter BSC items",
  tone: "blue",
};

export const SPORTLOTS_SOURCE: SourceDescriptor = {
  key: "sportlots",
  kind: "marketplace",
  label: "SportLots",
  sentenceLabel: "SportLots",
  noun: "set",
  badge: "SL",
  filterLabel: "Search SportLots items",
  tone: "purple",
};

/**
 * NEO-496 (C1b) — the set's uploaded publisher checklist, as a column. Its
 * items are SECTIONS ("Future Stars", "Base Red"): `platformValue` is the
 * section's key, `value` its name as printed. Teal, the Print Shop's hue: a
 * checklist is the printed sheet, and teal is the one neon this dialog does
 * not already spend (green is Ready and the keep buttons, blue BSC, violet
 * SportLots, amber the Base check's findings, pink the errors).
 */
export const CHECKLIST_SOURCE: SourceDescriptor = {
  key: "checklist",
  kind: "checklist",
  label: "Checklist",
  sentenceLabel: "checklist",
  noun: "section",
  badge: "Checklist",
  filterLabel: "Filter checklist sections",
  tone: "teal",
};

/** What every Reconcile dialog lines up today. */
export const MARKETPLACE_SOURCES: readonly SourceDescriptor[] = [
  BSC_SOURCE,
  SPORTLOTS_SOURCE,
];

/** The marketplaces plus the checklist, in column order. */
export const SOURCES_WITH_CHECKLIST: readonly SourceDescriptor[] = [
  BSC_SOURCE,
  SPORTLOTS_SOURCE,
  CHECKLIST_SOURCE,
];

/**
 * NEO-496 — the title a set made from a checklist section starts with: the
 * section's name, in Title Case when the publisher printed it in capitals
 * ("TOPPS CHROME RADIATING ROOKIES" → "Topps Chrome Radiating Rookies"). A
 * name with any lower-case letter is the publisher's own casing and is kept.
 * Only a starting point: the title is ours, and the operator edits it.
 */
export function checklistSetTitle(name: string): string {
  const trimmed = name.trim();
  if (!/[A-Z]/.test(trimmed) || /[a-z]/.test(trimmed)) return trimmed;
  return trimmed
    .toLowerCase()
    .replace(/(^|[\s\-/(])(\p{L})/gu, (_, lead: string, letter: string) => lead + letter.toUpperCase());
}

/** The title an item gives a set made from it, by its source. */
export function defaultTitleOf(source: SourceKey, item: PlatformItem): string {
  return source === "checklist" ? checklistSetTitle(item.value) : item.value;
}
/**
 * A source's word in DOM and drag ids (`bsc-<id>`, `data-own-set="sl"`).
 * SportLots keeps the `sl` it always had: E2E specs and component tests find
 * rows by these, and dnd-kit ids must stay what announcements parse.
 */
export const SOURCE_TOKEN: Record<SourceKey, string> = {
  bsc: "bsc",
  sportlots: "sl",
  checklist: "checklist",
};

/** One value per source. */
export type BySource<T> = Record<SourceKey, T>;

/** A `BySource` built by calling `make` once per source, in `SOURCE_KEYS` order. */
export function bySource<T>(make: (key: SourceKey) => T): BySource<T> {
  return {
    bsc: make("bsc"),
    sportlots: make("sportlots"),
    checklist: make("checklist"),
  };
}

/** An item and the source it came from. */
export type SourcedItem = { source: SourceKey; item: PlatformItem };

// ===== READY SETS =====

/**
 * A NeonBinder set under construction.
 *
 * NB is the system of record. A set has a title that belongs to US, and maps
 * to 0-N items from each source — the sources completely independent of each
 * other. A marketplace id on a set records how that marketplace happens to
 * carve up the same cards; it is not an ownership claim and not a scarce
 * resource, so the same id may appear on any number of sets.
 *
 * This replaced a pair-shaped model (`{bsc, sl}`, one id per side) whose every
 * awkwardness came from treating marketplace sets as exclusive: an item with no
 * partner needed a special "keep as platform-only" shelf, and a set wanted by
 * two rows produced a winner and a loser.
 */
export type ReadySet = {
  /** Stable local key. Not persisted — `title` is the identity on save. */
  key: string;
  /**
   * NEO-211 (plan E): the `selectorOptions` row this set ALREADY is, when it was
   * seeded from `existingRows`. Absent for a set the operator just built here.
   *
   * Before this, the modal had no notion of `_id` at all and `title` WAS the
   * identity on save — so editing a title in this dialog was a delete of the old
   * row and an insert of a new one, taking the row's children, its checklist and
   * every cross-listing pointed at it. Carrying the id makes that edit a rename.
   */
  existingId?: Id<"selectorOptions">;
  /** The NeonBinder set name. Operator-editable; this is our data. */
  title: string;
  /** Every item mapped to this set, per source. A source with none is `[]`. */
  links: BySource<PlatformItem[]>;
  metadata?: ItemMetadata;
  /** Auto-match score, for display only. 0 once an operator has touched it. */
  confidence: number;
  /**
   * NEO-325 — made with "Make its own set" (PROMOTE_SOLO). Saved with
   * `identityOnly`: the store matches it by its marketplace ids or inserts it,
   * and never folds it into a same-named row by name — which is what withheld
   * a SportLots twin saved after its namesake. Kept through later attaches and
   * renames: the operator still meant it as its own set.
   */
  ownSet?: boolean;
  /**
   * NEO-496 — a set restored from a saved row whose checklist links were NOT
   * handed over. Its checklist list is not "none", it is unknown: a section is
   * never attached to it (saving would replace links we cannot see, and losing
   * a link is a bug), and its links are never sent on Save.
   */
  checklistLinksUnknown?: true;
};

/** A Ready set's links with one source's list replaced. */
function withLinks(
  links: BySource<PlatformItem[]>,
  source: SourceKey,
  items: PlatformItem[],
): BySource<PlatformItem[]> {
  return { ...links, [source]: items };
}

/** Links holding `items` on their sources and nothing anywhere else. */
export function linksOf(...items: SourcedItem[]): BySource<PlatformItem[]> {
  const links = bySource<PlatformItem[]>(() => []);
  for (const { source, item } of items) links[source].push(item);
  return links;
}

// ===== STATE AND ACTIONS =====

export type ReconciliationState = {
  /** Sets that will be written on save. */
  ready: ReadySet[];
  /** Items not yet assigned to any NB set, per source. NOT saved. */
  pending: BySource<PlatformItem[]>;
  /** Monotonic source of ReadySet keys. Never rewound, so a key is never reused. */
  seq: number;
};

export type ReconciliationAction =
  // Two pending items from different sources become a new set. The 1:1 case,
  // which is 95%+ of real reconciliation and stays a single drag.
  | { type: "PROMOTE_PAIR"; a: SourcedItem; b: SourcedItem }
  // One item becomes a set on its own. Replaces "keep as platform-only":
  // a set with ids on one side only is ordinary, not special.
  | { type: "PROMOTE_SOLO"; source: SourceKey; item: PlatformItem }
  // NEO-300 — "Keep all": every item a column is SHOWING becomes its own set,
  // in ONE action. A column can list 141 BSC sets; N PROMOTE_SOLOs would be N
  // reducer passes each copying the Ready and Pending arrays (quadratic), and
  // one action is also one undo-able step in the operator's head.
  | { type: "PROMOTE_SOLO_MANY"; source: SourceKey; items: PlatformItem[] }
  // An item joins an existing set. This is what makes 0-N per source
  // reachable, in every direction.
  | { type: "ATTACH"; key: string; source: SourceKey; item: PlatformItem }
  | { type: "DETACH"; key: string; source: SourceKey; platformValue: string }
  | { type: "DISBAND"; key: string }
  | { type: "RENAME"; key: string; title: string }
  | { type: "UPDATE_METADATA"; key: string; metadata: ItemMetadata };

/**
 * Remove an item from a Pending column IF it is there.
 *
 * An item being mapped does NOT consume it: a marketplace set may back any
 * number of NB sets, so the same item can be mapped again later from the
 * "already mapped" reveal. Only the first mapping empties it out of Pending;
 * subsequent ones find nothing to remove and leave the column alone.
 */
function withoutPending(
  list: PlatformItem[],
  item: PlatformItem,
): PlatformItem[] {
  return list.some((i) => i.platformValue === item.platformValue)
    ? list.filter((i) => i.platformValue !== item.platformValue)
    : list;
}

/**
 * Return items to a Pending column, skipping any id already there.
 *
 * NEO-325: Pending is keyed by `platformValue` (React keys, dnd ids, selection),
 * so the same id twice in one column is a key collision. It happens when a
 * marketplace set mapped by two NB sets is detached from, or disbanded out of,
 * both — each return used to append another copy.
 */
function withPendingAdded(
  list: PlatformItem[],
  items: PlatformItem[],
): PlatformItem[] {
  const have = new Set(list.map((i) => i.platformValue));
  const added: PlatformItem[] = [];
  for (const item of items) {
    if (have.has(item.platformValue)) continue;
    have.add(item.platformValue);
    added.push(item);
  }
  return added.length === 0 ? list : [...list, ...added];
}

/** Rank of a source when a new set picks its default title. */
const titleRank = (source: SourceKey) => SOURCE_KEYS.indexOf(source);

/** The dialog's reducer: every action, for every source. */
export function reconcileSources(
  state: ReconciliationState,
  action: ReconciliationAction,
): ReconciliationState {
  switch (action.type) {
    case "PROMOTE_PAIR": {
      const { a, b } = action;
      // A pair is one item from each of two sources; two from one source is
      // not something a drop or a click can ask for.
      if (a.source === b.source) return state;
      // BSC names are closer to how collectors say a set's name, so it wins
      // the default (SOURCE_KEYS order). The operator can rename — the title
      // is ours.
      const titled = titleRank(a.source) <= titleRank(b.source) ? a : b;
      let pending = state.pending;
      for (const { source, item } of [a, b]) {
        pending = { ...pending, [source]: withoutPending(pending[source], item) };
      }
      return {
        ...state,
        seq: state.seq + 1,
        ready: [
          ...state.ready,
          {
            key: `set-${state.seq}`,
            title: defaultTitleOf(titled.source, titled.item),
            links: linksOf(a, b),
            confidence: 0,
          },
        ],
        pending,
      };
    }
    case "PROMOTE_SOLO": {
      const { source, item } = action;
      return {
        ...state,
        seq: state.seq + 1,
        ready: [
          ...state.ready,
          {
            key: `set-${state.seq}`,
            title: defaultTitleOf(source, item),
            links: linksOf({ source, item }),
            confidence: 0,
            ownSet: true,
          },
        ],
        pending: {
          ...state.pending,
          [source]: withoutPending(state.pending[source], item),
        },
      };
    }
    case "PROMOTE_SOLO_MANY": {
      // Exactly PROMOTE_SOLO applied to each item in order — same title, same
      // one-sided mapping, keys drawn from the same never-rewound `seq` — but
      // one pass. An item listed twice becomes one set, not two.
      const { source } = action;
      const seen = new Set<string>();
      const items = action.items.filter((i) => {
        if (seen.has(i.platformValue)) return false;
        seen.add(i.platformValue);
        return true;
      });
      if (items.length === 0) return state;
      const created: ReadySet[] = items.map((item, n) => ({
        key: `set-${state.seq + n}`,
        title: defaultTitleOf(source, item),
        links: linksOf({ source, item }),
        confidence: 0,
        // NEO-325 — "Keep all" is "Make its own set" on every row, so each
        // set it makes is saved by identity (`identityOnly`) the same way.
        ownSet: true,
      }));
      return {
        ...state,
        seq: state.seq + items.length,
        ready: [...state.ready, ...created],
        pending: {
          ...state.pending,
          [source]: state.pending[source].filter((i) => !seen.has(i.platformValue)),
        },
      };
    }
    case "ATTACH": {
      const { source, item } = action;
      const target = state.ready.find((s) => s.key === action.key);
      if (!target) return state;
      // NEO-496 — never onto a set whose saved checklist links are unknown:
      // Save would have to replace a list nobody here can see.
      if (source === "checklist" && target.checklistLinksUnknown) return state;
      // Same marketplace id twice on ONE set would make two slots pointing at
      // the same place. Across DIFFERENT sets it is fine and expected — that is
      // the 1996 Score case, where one SportLots set legitimately backs two NB
      // sets — so this check is per-set, never global.
      if (target.links[source].some((i) => i.platformValue === item.platformValue)) {
        return state;
      }
      return {
        ...state,
        ready: state.ready.map((s) =>
          s.key === action.key
            ? { ...s, links: withLinks(s.links, source, [...s.links[source], item]) }
            : s,
        ),
        pending: {
          ...state.pending,
          [source]: withoutPending(state.pending[source], item),
        },
      };
    }
    case "DETACH": {
      const { source } = action;
      const target = state.ready.find((s) => s.key === action.key);
      if (!target) return state;
      const from = target.links[source];
      const item = from.find((i) => i.platformValue === action.platformValue);
      if (!item) return state;
      const remaining = from.filter(
        (i) => i.platformValue !== action.platformValue,
      );
      const nextSet: ReadySet = {
        ...target,
        links: withLinks(target.links, source, remaining),
      };
      // A set with nothing mapped has no reason to exist — it would save as a
      // row with an empty platformData and never sync anything.
      const emptied = SOURCE_KEYS.every((k) => nextSet.links[k].length === 0);
      return {
        ...state,
        ready: emptied
          ? state.ready.filter((s) => s.key !== action.key)
          : state.ready.map((s) => (s.key === action.key ? nextSet : s)),
        pending: {
          ...state.pending,
          [source]: withPendingAdded(state.pending[source], [item]),
        },
      };
    }
    case "DISBAND": {
      const target = state.ready.find((s) => s.key === action.key);
      if (!target) return state;
      return {
        ...state,
        ready: state.ready.filter((s) => s.key !== action.key),
        pending: bySource((k) =>
          withPendingAdded(state.pending[k], target.links[k]),
        ),
      };
    }
    case "RENAME": {
      return {
        ...state,
        ready: state.ready.map((s) =>
          s.key === action.key ? { ...s, title: action.title } : s,
        ),
      };
    }
    case "UPDATE_METADATA": {
      return {
        ...state,
        ready: state.ready.map((s) =>
          s.key === action.key
            ? { ...s, metadata: { ...(s.metadata ?? {}), ...action.metadata } }
            : s,
        ),
      };
    }
    default:
      return state;
  }
}

// ===== THE TWO-MARKETPLACE VOCABULARY =====

/**
 * The reducer as the NEO-300 "Keep all" reducer test drives it: BSC and
 * SportLots only, Pending as `pendingBsc`/`pendingSl`, sides named
 * `"bsc"`/`"sl"`. A thin translation onto `reconcileSources`, which the dialog
 * dispatches to directly; it returns the very state it was given when nothing
 * changed, as `reconcileSources` does.
 */
export type TwoMarketplaceSide = "bsc" | "sl";

export type TwoMarketplaceState = {
  ready: ReadySet[];
  pendingBsc: PlatformItem[];
  pendingSl: PlatformItem[];
  seq: number;
};

export type TwoMarketplaceAction =
  | { type: "PROMOTE_PAIR"; bsc: PlatformItem; sl: PlatformItem }
  | { type: "PROMOTE_SOLO"; side: TwoMarketplaceSide; item: PlatformItem }
  | { type: "PROMOTE_SOLO_MANY"; side: TwoMarketplaceSide; items: PlatformItem[] }
  | { type: "ATTACH"; key: string; side: TwoMarketplaceSide; item: PlatformItem }
  | { type: "DETACH"; key: string; side: TwoMarketplaceSide; platformValue: string }
  | { type: "DISBAND"; key: string }
  | { type: "RENAME"; key: string; title: string }
  | { type: "UPDATE_METADATA"; key: string; metadata: ItemMetadata };

const SIDE_SOURCE: Record<TwoMarketplaceSide, MarketplaceSourceKey> = {
  bsc: "bsc",
  sl: "sportlots",
};

function toSourceAction(action: TwoMarketplaceAction): ReconciliationAction {
  switch (action.type) {
    case "PROMOTE_PAIR":
      return {
        type: "PROMOTE_PAIR",
        a: { source: "bsc", item: action.bsc },
        b: { source: "sportlots", item: action.sl },
      };
    case "PROMOTE_SOLO":
      return { type: action.type, source: SIDE_SOURCE[action.side], item: action.item };
    case "PROMOTE_SOLO_MANY":
      return { type: action.type, source: SIDE_SOURCE[action.side], items: action.items };
    case "ATTACH":
      return {
        type: action.type,
        key: action.key,
        source: SIDE_SOURCE[action.side],
        item: action.item,
      };
    case "DETACH":
      return {
        type: action.type,
        key: action.key,
        source: SIDE_SOURCE[action.side],
        platformValue: action.platformValue,
      };
    default:
      return action;
  }
}

export function reconciliationReducer(
  state: TwoMarketplaceState,
  action: TwoMarketplaceAction,
): TwoMarketplaceState {
  const inner: ReconciliationState = {
    ready: state.ready,
    pending: { bsc: state.pendingBsc, sportlots: state.pendingSl, checklist: [] },
    seq: state.seq,
  };
  const next = reconcileSources(inner, toSourceAction(action));
  if (next === inner) return state;
  return {
    ...state,
    ready: next.ready,
    pendingBsc: next.pending.bsc,
    pendingSl: next.pending.sportlots,
    seq: next.seq,
  };
}

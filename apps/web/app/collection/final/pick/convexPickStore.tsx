import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { variantTypeKindFromTitle } from "@/convex/variantRole";
import { toCardWithPath } from "../data/convexStore";
import type { Card, Condition } from "../data/types";
import { PageApiContext } from "../pageApi";
import { listedTitle } from "./model";
import { PickListStoreContext } from "./store";
import type { ListedCard, PickBox, PickListData, PickListStore, PickPhoto, SaleLine } from "./types";

// The title rule lives with the model, so the demo writes its titles the same way.
export { listedTitle };

/**
 * NEO-500 — the signed-in seller's Pick List, on Convex. The same
 * `PickListStore` the demo supplies (`./demoPickStore`), over four functions
 * (`convex/pickList.ts`):
 *
 *   - `open` (subscribed): the lines still to pull. Small, so a poll or a
 *     pull re-runs it cheaply.
 *   - `cards` and `soldPhotos`: read once per card and per copy, on demand
 *     (`useConvex().query`), never subscribed: a pull never re-runs them.
 *   - `setPulled`: the mark, optimistic, rolled back with a word on the
 *     status line when it fails.
 *
 * The server forgets a pulled line (it drops out of `open`), but the page
 * keeps every line the seller touched this session, so a pulled card stays
 * on screen checked, Undo brings it back, and the "N of M pulled" count
 * holds. A refresh starts the pull over with only what is left.
 *
 * A line that first shows after the list loaded is New ("Sold since you
 * started"). One order item taken from two boxes is two rows, one per box,
 * sharing the item's mark (`${id}@${k}`).
 *
 * NEO-509: a line NB could not tie to a card carries the sale's own words
 * for it (`listed`). The store reads its sport through `sports` (once per
 * sport, like `cards`), turns the words into a `ListedCard`, and titles the
 * line with them (`listedTitle`): "2021 Score 1991 Throwback #TB2 · Justin Fields".
 * Only a line that says nothing is "Unmatched sale (n of m)".
 */

type OpenAnswer = FunctionReturnType<typeof api.pickList.open>;
type RawLine = OpenAnswer["lines"][number];
type RawListed = NonNullable<RawLine["listed"]>;

/** Card ids `pickList.cards` takes at once (the server's `MAX_CARDS_BY_ID`). */
const CARDS_PER_CALL = 200;
/** Copy ids `pickList.soldPhotos` takes at once (the server's `MAX_SOLD_PHOTOS`). */
const PHOTOS_PER_CALL = 100;
/** Line ids `pickList.setPulled` takes at once (the server's `MAX_SET_PULLED`). */
const PULLS_PER_CALL = 200;
/** Sport ids `pickList.sports` takes at once (the server's `MAX_SPORTS_BY_ID`). */
const SPORTS_PER_CALL = 20;

const VENUE: Record<RawLine["platform"], string> = { bsc: "BSC", ebay: "eBay" };

/** NB's own conditions, as the list writes them. */
const NB_CONDITION: Record<Condition, string> = {
  Mint: "MT",
  "Near Mint": "NM",
  Excellent: "EX",
  "Very Good": "VG",
  Good: "GD",
  Poor: "PR",
};

/**
 * A sale line's own condition, shown only when NB noted no copy for it: eBay
 * lines carry NB's bucket code already; BSC lines carry BSC's words.
 */
const MARKET_CONDITION: Record<string, string> = {
  near_mint: "NM",
  excellent: "EX",
  very_good: "VG",
  poor: "PR",
  mint: "MT",
  "nm-mt": "NM-MT",
  nm: "NM",
  "ex-mt": "EX-MT",
  ex: "EX",
  "vg-ex": "VG-EX",
  vg: "VG",
  good: "GD",
  fair: "FR",
  "poor-v": "PR",
};

function marketCondition(raw: string): string {
  return MARKET_CONDITION[raw] ?? raw;
}

/** The line id a row's id came from (a row per box shares its line's mark). */
export function lineOf(rowId: string): string {
  const at = rowId.indexOf("@");
  return at < 0 ? rowId : rowId.slice(0, at);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface Hydrated {
  card: Card | null;
  sportCode: string | null;
}

/** NB's sport row a sale names: its name and SKU code. */
interface SportRow {
  name: string;
  code: string | null;
}

/** A listing's words, trimmed; blank is absent. */
function words(text: string | undefined): string | undefined {
  const t = text?.replace(/\s+/g, " ").trim();
  return t ? t : undefined;
}

/** The years a set files under; a listing's year outside them is a misread. */
const FIRST_YEAR = 1800;
const LAST_YEAR = 2100;

/** "2021" is 2021; a season files under its start: "2023-24" and "2023/2024" are 2023. */
export function listedYear(season: string): number | undefined {
  const m = /^(\d{4})(?:\s*[-/]\s*(?:\d{2}|\d{4}))?$/.exec(season);
  if (!m) return undefined;
  const year = Number(m[1]);
  return year >= FIRST_YEAR && year <= LAST_YEAR ? year : undefined;
}

/**
 * A sale's words for its card, resolved: NB's sport when the sale named one
 * NB has (`sport` loaded), else the listing's sport word; the year as a
 * number; the variant's divider only when its word IS one (Base, Insert,
 * Parallel). A word NB does not file by ("Variation", "SP", "Promo") is kept
 * as written (`variantWord`), never read as a role, and the listing's
 * variant name is kept whatever the word. Undefined when the words say nothing.
 */
export function toListedCard(raw: RawListed, sport: SportRow | null | undefined): ListedCard | undefined {
  const season = words(raw.year);
  const year = season ? listedYear(season) : undefined;
  const variant = words(raw.variant);
  const variantName = words(raw.variantName);
  const kind = variantTypeKindFromTitle(variant);
  const sportName = sport?.name ?? words(raw.sport);
  const out: ListedCard = {
    ...(sport && raw.sportId ? { sportId: raw.sportId } : {}),
    ...(sportName ? { sportName } : {}),
    ...(sport?.code ? { sportCode: sport.code } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(season ? { season } : {}),
    ...(words(raw.setName) ? { setName: words(raw.setName) } : {}),
    ...(words(raw.players) ? { players: words(raw.players) } : {}),
    ...(words(raw.cardNo) ? { cardNumber: words(raw.cardNo) } : {}),
    ...(kind ? { role: kind } : {}),
    // A word NB does not file by ("Variation") is how the seller tells the copy from the base: kept as written.
    ...(variant && !kind ? { variantWord: variant } : {}),
    ...(variantName ? { variantName } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/**
 * One server line as the rows the UI draws. `card` is undefined while the
 * card is still loading (the line waits), null when it is gone.
 */
export function toSaleLines(
  raw: RawLine,
  hydrated: Hydrated | null | undefined,
  photos: ReadonlyMap<string, PickPhoto | null>,
  options: {
    isNew: boolean;
    /** This line's place among its order's lines with the same title, when more than one shares it. */
    lostIndex?: { n: number; of: number };
    /** What the sale says the card is, resolved (`toListedCard`). */
    listed?: ListedCard;
  },
): SaleLine[] {
  const venue = VENUE[raw.platform];
  const order = { id: raw.saleId, venue, number: raw.orderNo };
  const isNew = options.isNew || undefined;
  const lostTitle = () => {
    const nth = options.lostIndex && options.lostIndex.of > 1 ? ` (${options.lostIndex.n} of ${options.lostIndex.of})` : "";
    // The Order column (a link to the sale) says which order; the toggle's name adds it.
    const said = options.listed ? listedTitle(options.listed) : "";
    return `${said || "Unmatched sale"}${nth}`;
  };

  if (raw.cantFind || !raw.cardId || !hydrated?.card) {
    const problem =
      raw.cantFind === "linkMismatch"
        ? "This listing's card doesn't match NB's card. Check the order's photo."
        : raw.cantFind === "unmatched" || !raw.cardId
          ? "NB couldn't match this line. Check the order's photo."
          : "This card isn't in NB's catalog any more. Check the order's photo.";
    const listed = options.listed && listedTitle(options.listed) ? options.listed : undefined;
    return [
      {
        id: raw.id,
        card: null,
        sportCode: listed?.sportCode ?? null,
        listingTitle: lostTitle(),
        ...(listed ? { listed } : {}),
        problem,
        quantity: raw.quantity,
        condition: marketCondition(raw.condition),
        order,
        isNew,
      },
    ];
  }

  const shared = {
    card: hydrated.card,
    sportCode: hydrated.sportCode,
    listingTitle: hydrated.card.players.map((p) => p.name).join(" / "),
    order,
    isNew,
    ...(raw.lastOnes ? { lastOnes: true } : {}),
  };

  if (raw.from.length === 0) {
    return [
      {
        ...shared,
        id: raw.id,
        quantity: raw.quantity,
        condition: marketCondition(raw.condition),
        ...(raw.skuBoxId ? { spot: { boxId: raw.skuBoxId } } : {}),
        ...(raw.boxUnrecorded ? { boxUnrecorded: true } : {}),
        ...(raw.shortBy ? { short: raw.shortBy } : {}),
      },
    ];
  }

  return raw.from.map((entry, k) => {
    const photo = photos.get(entry.copyId);
    return {
      ...shared,
      id: raw.from.length > 1 ? `${raw.id}@${k}` : raw.id,
      quantity: entry.quantity,
      condition: NB_CONDITION[entry.condition],
      ...(entry.serialNumber ? { serial: entry.serialNumber } : {}),
      ...(entry.boxId ? { spot: { boxId: entry.boxId, ...(entry.slot !== undefined ? { slot: entry.slot } : {}) } } : {}),
      ...(photo ? { photo } : {}),
      // The shortfall is the line's, said once.
      ...(k === 0 && raw.shortBy ? { short: raw.shortBy } : {}),
    };
  });
}

function askBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  // Older browsers show the prompt only when this is set.
  event.returnValue = "";
}

/** While `on`, leaving the page (reload, close, typed URL) asks first. */
export function useUnsavedGuard(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    window.addEventListener("beforeunload", askBeforeUnload);
    return () => window.removeEventListener("beforeunload", askBeforeUnload);
  }, [on]);
}

/** Mounts the signed-in Pick List store for everything below it. */
export function ConvexPickListProvider({ children }: { children: ReactNode }) {
  const store = useConvexPickListStore();
  return <PickListStoreContext.Provider value={store}>{children}</PickListStoreContext.Provider>;
}

function useConvexPickListStore(): PickListStore {
  const open = useQuery(api.pickList.open, {});
  const convex = useConvex();
  const mutate = useMutation(api.pickList.setPulled);
  const pageApi = useContext(PageApiContext);

  const [cards, setCards] = useState<ReadonlyMap<string, Hydrated | null>>(() => new Map());
  const [photos, setPhotos] = useState<ReadonlyMap<string, PickPhoto | null>>(() => new Map());
  const [sports, setSports] = useState<ReadonlyMap<string, SportRow | null>>(() => new Map());
  const askedCards = useRef(new Set<string>());
  const askedPhotos = useRef(new Set<string>());
  const askedSports = useRef(new Set<string>());
  /** Line ids in the first answer: anything after is New. */
  const [baseline, setBaseline] = useState<ReadonlySet<string> | null>(null);
  /** Lines the seller marked this session, as last seen, so they stay on screen once the server drops them. */
  const [kept, setKept] = useState<ReadonlyMap<string, RawLine>>(() => new Map());
  /** Line ids marked pulled this session (optimistic). */
  const [pulledLines, setPulledLines] = useState<ReadonlySet<string>>(() => new Set());
  const [loadedOnce, setLoadedOnce] = useState(false);
  /** Marks sent and not yet saved. */
  const [saving, setSaving] = useState(0);

  // Set while rendering (React's "adjust state when a prop changes"), so the
  // first answer never draws every line as New for a frame.
  if (open && baseline === null) setBaseline(new Set(open.lines.map((l) => l.id)));

  // Every line on screen: the server's, plus the kept ones it no longer sends.
  const rawLines = useMemo<RawLine[]>(() => {
    if (!open) return [];
    const ids = new Set(open.lines.map((l) => l.id));
    return [...open.lines, ...[...kept.values()].filter((l) => !ids.has(l.id))];
  }, [open, kept]);

  // Cards, once each.
  useEffect(() => {
    const missing = [...new Set(rawLines.flatMap((l) => (l.cardId && !l.cantFind ? [l.cardId] : [])))].filter(
      (id) => !askedCards.current.has(id),
    );
    if (!missing.length) return;
    for (const id of missing) askedCards.current.add(id);
    for (const batch of chunks(missing, CARDS_PER_CALL)) {
      convex.query(api.pickList.cards, { cardIds: batch }).then(
        (answer) =>
          setCards((prev) => {
            const next = new Map(prev);
            batch.forEach((id, i) => {
              const hit = answer[i];
              next.set(id, hit ? { card: toCardWithPath(hit.card), sportCode: hit.sportCode } : null);
            });
            return next;
          }),
        () => {
          for (const id of batch) askedCards.current.delete(id);
          pageApi?.inform("Some cards on the Pick List didn't load. Refresh to try again.");
        },
      );
    }
  }, [rawLines, convex, pageApi]);

  // The sports the sales' own words name, once each. A sport that does not
  // load is the listing's word instead (never a wait, never a guess).
  useEffect(() => {
    const missing = [...new Set(rawLines.flatMap((l) => (l.listed?.sportId ? [l.listed.sportId as string] : [])))].filter(
      (id) => !askedSports.current.has(id),
    );
    if (!missing.length) return;
    for (const id of missing) askedSports.current.add(id);
    const settle = (batch: string[], answer: ReadonlyArray<{ name: string; code: string | null } | null> | null) =>
      setSports((prev) => {
        const next = new Map(prev);
        batch.forEach((id, i) => {
          const hit = answer?.[i];
          next.set(id, hit ? { name: hit.name, code: hit.code } : null);
        });
        return next;
      });
    for (const batch of chunks(missing, SPORTS_PER_CALL)) {
      convex.query(api.pickList.sports, { sportIds: batch }).then(
        (answer) => settle(batch, answer),
        () => settle(batch, null),
      );
    }
  }, [rawLines, convex]);

  // Photos of the sold copies, once each; a row draws the card until its photo lands.
  useEffect(() => {
    const missing = [...new Set(rawLines.flatMap((l) => l.from.map((f) => f.copyId as string)))].filter(
      (id) => !askedPhotos.current.has(id),
    );
    if (!missing.length) return;
    for (const id of missing) askedPhotos.current.add(id);
    for (const batch of chunks(missing, PHOTOS_PER_CALL)) {
      convex.query(api.pickList.soldPhotos, { copyIds: batch as Id<"collectionCopies">[] }).then(
        (answer) =>
          setPhotos((prev) => {
            const next = new Map(prev);
            for (const id of batch) next.set(id, null);
            for (const p of answer) {
              const side = p.front ?? p.back;
              if (side) next.set(p.copyId, { thumbUrl: side.thumbUrl, imageUrl: side.imageUrl });
            }
            return next;
          }),
        // A photo is a nicety: the row keeps drawing the card.
        () => {
          for (const id of batch) askedPhotos.current.delete(id);
        },
      );
    }
  }, [rawLines, convex]);

  const allLoaded = rawLines.every(
    (l) => (l.cantFind || !l.cardId || cards.has(l.cardId)) && (!l.listed?.sportId || sports.has(l.listed.sportId)),
  );
  if (!loadedOnce && open && baseline && allLoaded) setLoadedOnce(true);

  const data = useMemo<PickListData | undefined>(() => {
    if (!open || !baseline || (!loadedOnce && !allLoaded)) return undefined;
    // A line NB could not tie to a card is titled by its own words; lines of
    // one order that read the same (or say nothing) are numbered "(n of m)",
    // so no two rows' controls read alike.
    const listedOf = new Map<string, ListedCard | undefined>();
    const titleKey = (raw: RawLine) => {
      const listed = listedOf.get(raw.id);
      return `${raw.saleId}\n${listed ? listedTitle(listed) : ""}`;
    };
    for (const raw of rawLines) {
      if (!raw.cantFind || !raw.listed) continue;
      const sportId = raw.listed.sportId as string | undefined;
      listedOf.set(raw.id, toListedCard(raw.listed, sportId ? sports.get(sportId) : undefined));
    }
    const lostCount = new Map<string, number>();
    for (const l of rawLines) if (l.cantFind) lostCount.set(titleKey(l), (lostCount.get(titleKey(l)) ?? 0) + 1);
    const lostSeen = new Map<string, number>();
    const lines: SaleLine[] = [];
    for (const raw of rawLines) {
      // A line whose card is still loading waits a moment rather than show as unmatched.
      if (!raw.cantFind && raw.cardId && !cards.has(raw.cardId)) continue;
      let lostIndex: { n: number; of: number } | undefined;
      if (raw.cantFind) {
        const key = titleKey(raw);
        const n = (lostSeen.get(key) ?? 0) + 1;
        lostSeen.set(key, n);
        lostIndex = { n, of: lostCount.get(key) ?? 1 };
      }
      const hydrated = raw.cardId ? cards.get(raw.cardId) : undefined;
      lines.push(...toSaleLines(raw, hydrated, photos, { isNew: !baseline.has(raw.id), lostIndex, listed: listedOf.get(raw.id) }));
    }
    const boxes: PickBox[] = open.boxes.map((b) => ({ id: b.id, name: b.name, ...(b.unsorted ? { unsorted: true } : {}) }));
    return { lines, boxes, ...(open.truncated ? { truncated: true } : {}) };
  }, [open, baseline, loadedOnce, allLoaded, rawLines, cards, photos, sports]);

  // The page's ids are rows; a row is pulled when its line is.
  const pulled = useMemo<ReadonlySet<string>>(
    () => new Set((data?.lines ?? []).filter((l) => pulledLines.has(lineOf(l.id))).map((l) => l.id)),
    [data, pulledLines],
  );

  const setPulled = useCallback(
    async (rowIds: readonly string[], on: boolean) => {
      const ids = [...new Set(rowIds.map(lineOf))];
      if (!ids.length) return;
      const byId = new Map(rawLines.map((l) => [l.id, l]));
      setKept((prev) => {
        const next = new Map(prev);
        for (const id of ids) {
          const raw = byId.get(id);
          if (raw) next.set(id, raw);
        }
        return next;
      });
      const flip = (set: ReadonlySet<string>, to: boolean) => {
        const next = new Set(set);
        for (const id of ids) {
          if (to) next.add(id);
          else next.delete(id);
        }
        return next;
      };
      setPulledLines((prev) => flip(prev, on));
      setSaving((n) => n + 1);
      try {
        for (const batch of chunks(ids, PULLS_PER_CALL)) await mutate({ ids: batch, pulled: on });
      } catch (error) {
        setPulledLines((prev) => flip(prev, !on));
        // The page says it didn't save (`PickListTab`'s mark).
        throw error;
      } finally {
        setSaving((n) => n - 1);
      }
    },
    [rawLines, mutate],
  );

  // A reload or a closed tab while a mark is still on its way would lose it.
  useUnsavedGuard(saving > 0);

  return useMemo<PickListStore>(() => ({ kind: "convex", data, pulled, setPulled }), [data, pulled, setPulled]);
}

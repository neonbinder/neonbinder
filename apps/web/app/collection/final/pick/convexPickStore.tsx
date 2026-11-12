import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toCardWithPath } from "../data/convexStore";
import type { Card, Condition } from "../data/types";
import { PageApiContext } from "../pageApi";
import { PickListStoreContext } from "./store";
import type { PickBox, PickListData, PickListStore, PickPhoto, SaleLine } from "./types";

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
 */

type OpenAnswer = FunctionReturnType<typeof api.pickList.open>;
type RawLine = OpenAnswer["lines"][number];

/** Card ids `pickList.cards` takes at once (the server's `MAX_CARDS_BY_ID`). */
const CARDS_PER_CALL = 200;
/** Copy ids `pickList.soldPhotos` takes at once (the server's `MAX_SOLD_PHOTOS`). */
const PHOTOS_PER_CALL = 100;
/** Line ids `pickList.setPulled` takes at once (the server's `MAX_SET_PULLED`). */
const PULLS_PER_CALL = 200;

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

/**
 * One server line as the rows the UI draws. `card` is undefined while the
 * card is still loading (the line waits), null when it is gone.
 */
export function toSaleLines(
  raw: RawLine,
  hydrated: Hydrated | null | undefined,
  photos: ReadonlyMap<string, PickPhoto | null>,
  options: { isNew: boolean; lostIndex?: { n: number; of: number } },
): SaleLine[] {
  const venue = VENUE[raw.platform];
  const order = { id: raw.saleId, venue, number: raw.orderNo };
  const where = `${venue} ${raw.orderNo}`;
  const isNew = options.isNew || undefined;
  const lostTitle = () => {
    const nth = options.lostIndex && options.lostIndex.of > 1 ? ` (${options.lostIndex.n} of ${options.lostIndex.of})` : "";
    return `Card NB couldn't match, ${where}${nth}`;
  };

  if (raw.cantFind || !raw.cardId || !hydrated?.card) {
    const problem =
      raw.cantFind === "linkMismatch"
        ? `This listing's card doesn't match NB's card. Open order ${where} to see which it is.`
        : raw.cantFind === "unmatched" || !raw.cardId
          ? `NB couldn't match this line. Open order ${where} to see the card.`
          : `This card isn't in NB's catalog any more. Open order ${where} to see it.`;
    return [
      {
        id: raw.id,
        card: null,
        sportCode: null,
        listingTitle: lostTitle(),
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
  const askedCards = useRef(new Set<string>());
  const askedPhotos = useRef(new Set<string>());
  /** Line ids in the first answer: anything after is New. */
  const [baseline, setBaseline] = useState<ReadonlySet<string> | null>(null);
  /** Lines the seller marked this session, as last seen, so they stay on screen once the server drops them. */
  const [kept, setKept] = useState<ReadonlyMap<string, RawLine>>(() => new Map());
  /** Line ids marked pulled this session (optimistic). */
  const [pulledLines, setPulledLines] = useState<ReadonlySet<string>>(() => new Set());
  const [loadedOnce, setLoadedOnce] = useState(false);

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

  const allLoaded = rawLines.every((l) => l.cantFind || !l.cardId || cards.has(l.cardId));
  if (!loadedOnce && open && baseline && allLoaded) setLoadedOnce(true);

  const data = useMemo<PickListData | undefined>(() => {
    if (!open || !baseline || (!loadedOnce && !allLoaded)) return undefined;
    const lostCount = new Map<string, number>();
    for (const l of rawLines) if (l.cantFind) lostCount.set(l.saleId, (lostCount.get(l.saleId) ?? 0) + 1);
    const lostSeen = new Map<string, number>();
    const lines: SaleLine[] = [];
    for (const raw of rawLines) {
      // A line whose card is still loading waits a moment rather than show as unmatched.
      if (!raw.cantFind && raw.cardId && !cards.has(raw.cardId)) continue;
      let lostIndex: { n: number; of: number } | undefined;
      if (raw.cantFind) {
        const n = (lostSeen.get(raw.saleId) ?? 0) + 1;
        lostSeen.set(raw.saleId, n);
        lostIndex = { n, of: lostCount.get(raw.saleId) ?? 1 };
      }
      const hydrated = raw.cardId ? cards.get(raw.cardId) : undefined;
      lines.push(...toSaleLines(raw, hydrated, photos, { isNew: !baseline.has(raw.id), lostIndex }));
    }
    const boxes: PickBox[] = open.boxes.map((b) => ({ id: b.id, name: b.name, ...(b.unsorted ? { unsorted: true } : {}) }));
    return { lines, boxes };
  }, [open, baseline, loadedOnce, allLoaded, rawLines, cards, photos]);

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
      try {
        for (const batch of chunks(ids, PULLS_PER_CALL)) await mutate({ ids: batch, pulled: on });
      } catch {
        setPulledLines((prev) => flip(prev, !on));
        pageApi?.inform(on ? "That pull didn't save. Try it again." : "That card didn't go back on the list. Try it again.");
      }
    },
    [rawLines, mutate, pageApi],
  );

  return useMemo<PickListStore>(() => ({ kind: "convex", data, pulled, setPulled }), [data, pulled, setPulled]);
}

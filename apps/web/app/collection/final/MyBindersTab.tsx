import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import NeonButton from "@/components/modules/NeonButton";
import { keyboardAwareCollision } from "@/lib/dnd/keyboard-aware-collision";
import { isEditableTarget } from "@/lib/dom/is-editable-target";
import CardFace from "../prototypes/_shared/CardFace";
import type { Notice } from "../prototypes/p1/notice";
import { useReducedMotion, useWideDesk } from "../prototypes/p2/hooks";
import "../prototypes/p2/p2.css";
import { SPREAD_DROP_ID, stepCount, stepOfPage } from "./binders/BinderDesk";
import BinderView from "./binders/BinderView";
import "./binders/binders.css";
import BoxDesk from "./binders/BoxDesk";
import { cardDragId, copyDragId, parseRowId, parseSlotId, pocketHop } from "./binders/dnd";
import EditContainerDialog from "./binders/EditContainerDialog";
import ForSaleView from "./binders/ForSaleView";
import { useCardMap, useLabelHints } from "./binders/hooks";
import { labelOf, PLAIN_LABEL } from "./binders/label";
import LabelEditorDialog from "./binders/LabelEditorDialog";
import {
  binderPages,
  cardPages,
  cardsOnPages,
  firstPocketVariant,
  followedChecklist,
  followedTally,
  guardPocket,
  movableCopies,
  NO_FILTERS,
  pilePages,
  placesOf,
  placeWords,
  pocketFor,
  pocketsOf,
  rowName,
  setPages,
  slotOf,
  slotRefOf,
  soleCopyId,
  stackPages,
  orderWants,
  wantPages,
  type CardsById,
  type LayoutMode,
  type PageModel,
  type PileFilters,
  type Place,
  type SlotRef,
  type SortKey,
  type ViewKey,
} from "./binders/model";
import NewBinderDialog from "./binders/NewBinderDialog";
import { defaultLayout, openView, viewKey, type Tally } from "./binders/openView";
import PackTray, { AIMED_TARGET, type Choosing, type MoveTarget, type SlotTarget } from "./binders/PackTray";
import Shelf from "./binders/Shelf";
import { useSearchText } from "./catalog/search";
import { shortCardName } from "./data/labels";
import {
  CONTAINER_COPIES_DEFAULT_LIMIT,
  emptyCopyDetails,
  homesOf,
  isWantedIn,
  OWNED_CARDS_DEFAULT_LIMIT,
  searchable,
  SET_CARDS_DEFAULT_LIMIT,
  systemContainer,
  useCapabilities,
  useCollectionActions,
  useContainerCopies,
  useContainers,
  useCopiesOfCards,
  useDemoExtension,
  useOwnedCards,
  useScope,
  useSearch,
  useSetCards,
  useSetSummary,
  useVariantCards,
  useWants,
  writeErrorMessage,
} from "./data/store";
import {
  isHome,
  type Card,
  type CardId,
  type Container,
  type ContainerLabel,
  type ContainerPatch,
  type Copy,
  type CopyId,
  type NewContainer,
  type Scope,
} from "./data/types";
import { useCollectionParams } from "./mode";
import { usePageApi, type OpenCardOptions } from "./pageApi";
import type { CollectionTab, GoToTabParams } from "./store";

/**
 * My Binders (NEO-350, on the shared store since NEO-359): a shelf of
 * spines (your binders and boxes, plus the special shelf: All my cards,
 * Want List, Up for Trade and the Inventory long box), an open binder of
 * nine-pocket pages or an open box of five rows, and the hunt tray, where
 * you look for a card: it shows where each copy lives and takes you there,
 * moves a copy into what is open, puts one up for trade, or adds a new one.
 * A card pressed in its sleeve slides out into the page's shared card drawer.
 *
 * Everything reads and writes through the store hooks (`./data/store`), so
 * the demo and the real collection run the same code. What is open lives on
 * the URL (`b=`, `set=`, `all=1`, `sale=1`), pushed so Back steps out of it;
 * opening a binder or box scopes the whole page to it on the same push.
 *
 * Every drag has a button or a key that does the same thing: Slot in / Move
 * here / Put here in the tray, Up for trade, a box card's row picker and
 * Alt+arrows, and the keyboard sensor's pocket hop.
 */

export interface MyBindersTabProps {
  openCard: (cardId: CardId, opts?: OpenCardOptions) => void;
  goToTab: (tab: CollectionTab, p?: GoToTabParams) => void;
  notify: (message: string, undo?: () => void) => void;
  /** The page's status line: the tray shows it, so it never floats over the search box. */
  notice: Notice | null;
  onUndo: () => void;
  onDismissNotice: () => void;
}

/** The tray asks for the copies of this many hits at once (one store chunk). */
const TRAY_COPIES = 50;

const NO_CARDS: Card[] = [];

/** An owned card waiting on "which copy?", and where it was dropped (a pocket or row). */
type Pending = Choosing & { slot: number | null };

interface OwnedPile {
  cards: CardsById;
  copies: Copy[];
  total: number;
  truncated: boolean;
}

export default function MyBindersTab({ openCard, goToTab, notify, notice, onUndo, onDismissNotice }: MyBindersTabProps) {
  const containers = useContainers();
  const capabilities = useCapabilities();
  const demo = useDemoExtension();
  const actions = useCollectionActions();
  const { run } = usePageApi();
  const scope = useScope();
  const wants = useWants();
  const wide = useWideDesk();
  const reducedMotion = useReducedMotion();

  // -- what is open ---------------------------------------------------------
  const [params, setParams] = useCollectionParams();
  const b = params.get("b");
  const s = params.get("set");
  let view: ViewKey | null = null;
  // While the shelf loads, an open binder on the URL stays open (it says so);
  // once it is in, an unknown or deleted one falls back to the shelf.
  if (b && (!containers || containers.some((c) => c.id === b))) view = { kind: "binder", binderId: b };
  else if (s) view = { kind: "set", setId: s };
  else if (params.get("sale")) view = { kind: "sale" };
  else if (params.get("all")) view = { kind: "all" };
  const viewId = view ? viewKey(view) : "shelf";
  const container = view?.kind === "binder" ? containers?.find((c) => c.id === view.binderId) : undefined;
  const isWant = container?.system === "want";
  const isTrade = container?.system === "trade";
  const isSmart = !!container?.rule;
  const isBox = !!container && container.kind === "box" && isHome(container);
  const homeOpen = isHome(container) ? container : undefined;

  const [stepState, setStepState] = useState<{ view: string; at: number }>({ view: "shelf", at: 0 });
  const [modes, setModes] = useState<Record<string, LayoutMode>>({});
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [sort, setSort] = useState<SortKey>("checklist");
  const [filters, setFilters] = useState<PileFilters>(NO_FILTERS);
  const [query, setQuery] = useState("");
  const [aimed, setAimed] = useState<SlotRef | null>(null);
  const [dialog, setDialog] = useState<"new" | "label" | "edit" | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  /** The pocket a hunt led to: ringed (and focused) until the binder closes. */
  const [found, setFound] = useState<SlotRef | null>(null);
  /** The box line item a hunt led to. */
  const [foundCopy, setFoundCopy] = useState<CopyId | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [allPile, setAllPile] = useState<OwnedPile | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const deskRef = useRef<HTMLDivElement>(null);

  const mode: LayoutMode = view ? (modes[viewId] ?? defaultLayout(view, container)) : "stack";
  const defaultLimit =
    view?.kind === "set" ? SET_CARDS_DEFAULT_LIMIT : view?.kind === "all" ? OWNED_CARDS_DEFAULT_LIMIT : CONTAINER_COPIES_DEFAULT_LIMIT;
  const limit = limits[viewId] ?? defaultLimit;
  const more = () => setLimits((l) => ({ ...l, [viewId]: limit + defaultLimit }));

  // -- what the open view reads ----------------------------------------------
  const listId = container && !isWant ? container.id : null;
  const listPage = useContainerCopies(listId, { limit });
  const listCopies = listPage?.copies;
  const wantIds = useMemo(() => (isWant && wants ? wants.map((w) => w.cardId) : null), [isWant, wants]);
  const listCardIds = useMemo(() => (listCopies ? listCopies.map((c) => c.cardId) : null), [listCopies]);
  const cards = useCardMap(isWant ? wantIds : listId ? listCardIds : null);
  // The Want List pages like a set: every want's card is read (for the
  // order), but copies only for the wants on screen, `limit` at a time.
  const orderedWants = useMemo(
    () => (isWant && wants && containers && cards ? orderWants(wants, containers, cards) : null),
    [isWant, wants, containers, cards],
  );
  const shownWants = useMemo(() => orderedWants?.slice(0, limit) ?? null, [orderedWants, limit]);
  const shownWantIds = useMemo(() => shownWants?.map((w) => w.cardId) ?? null, [shownWants]);
  const wantCopies = useCopiesOfCards(shownWantIds && shownWantIds.length ? shownWantIds : null);
  const wantsTruncated = !!orderedWants && !!shownWants && orderedWants.length > shownWants.length;

  // A binder whose numbered pockets follow a checklist: Need sleeves for the gaps.
  const pocketVariant =
    homeOpen && homeOpen.kind === "binder" && listCopies ? firstPocketVariant(listCopies) : null;
  const checklist = useVariantCards(pocketVariant);
  const followed = useMemo(
    () => (listCopies && pocketVariant ? followedChecklist(listCopies, checklist) : null),
    [listCopies, pocketVariant, checklist],
  );
  const followedIds = useMemo(() => followed?.map((c) => c.id) ?? null, [followed]);
  const followedCopies = useCopiesOfCards(followedIds);
  const ownedAnywhere = (id: CardId) => (followedCopies?.[id] ?? []).some((c) => c.quantity > 0);

  const setId = view?.kind === "set" ? view.setId : null;
  const setSummary = useSetSummary(setId);
  const setCards = useSetCards(setId, { limit });
  const setCardIds = useMemo(() => setCards?.cards.map((c) => c.id) ?? null, [setCards]);
  const setCopies = useCopiesOfCards(setCardIds);

  // -- the pages --------------------------------------------------------------
  let pages: PageModel[] = [];
  let loading = false;
  let truncated = false;
  if (view?.kind === "set") {
    if (setCards) pages = setPages(setCards.cards, setCopies, mode);
    loading = !setCards;
    truncated = !!setCards?.truncated;
  } else if (view?.kind === "all") {
    if (allPile) pages = pilePages(allPile.copies, allPile.cards, sort, filters);
    loading = !allPile;
    truncated = !!allPile?.truncated;
  } else if (isWant) {
    if (shownWants && cards && containers) pages = wantPages({ wants: shownWants, containers, cards, copiesByCard: wantCopies });
    loading = !wants || !cards;
    truncated = wantsTruncated;
  } else if (container && !isBox) {
    if (listCopies && cards) {
      if (isSmart) pages = mode === "pockets" ? cardPages(listCopies, cards) : stackPages(listCopies, cards);
      else if (isTrade || mode === "stack") pages = stackPages(listCopies, cards);
      else pages = binderPages({ binderId: container.id, copies: listCopies, cards, followed, ownedAnywhere });
    }
    loading = !listCopies || !cards;
    truncated = !!listPage?.truncated;
  } else if (isBox) {
    loading = !listCopies || !cards;
  } else if (view?.kind === "binder") {
    loading = true; // the shelf is still coming in
  }
  const listIds = cardsOnPages(pages);
  const steps = stepCount(pages.length, wide);
  const at = stepState.view === viewId ? Math.min(stepState.at, steps - 1) : 0;
  const turn = (to: number) => {
    const next = Math.max(0, Math.min(to, steps - 1));
    setStepState({ view: viewId, at: next });
    // A browsed set pages in from the store as the collector nears the end.
    // So does the Want List.
    if ((view?.kind === "set" || isWant) && truncated && next >= steps - 2) more();
  };

  // -- the cover --------------------------------------------------------------
  const hints = useLabelHints(container ?? null);
  const label: ContainerLabel =
    view?.kind === "all" ? labelOf("all") : container ? labelOf(container, hints) : PLAIN_LABEL;
  const tally: Tally = { have: null, need: null, cards: null };
  if (view?.kind === "set") {
    if (setCards && !setCards.truncated) {
      const have = setCards.cards.filter((c) => (setCopies?.[c.id] ?? []).some((x) => x.quantity > 0)).length;
      tally.have = setCopies ? have : null;
      tally.need = setCopies ? setCards.cards.length - have : null;
    }
    tally.cards = setSummary ? setSummary.totalCards : null;
  } else if (view?.kind === "all") {
    tally.cards = allPile ? allPile.total : null;
  } else if (isWant && wants) {
    // Landed / still needed only once every want's copies are in (a long
    // list pages in; until then, unknown, never a guess from one page).
    const all = shownWants && !wantsTruncated ? shownWants : null;
    const landed =
      all && (wantCopies || all.length === 0)
        ? all.filter((w) => (wantCopies?.[w.cardId] ?? []).some((c) => c.quantity > 0)).length
        : null;
    tally.have = landed;
    tally.need = landed === null || !all ? null : all.length - landed;
    tally.cards = wants.length;
  } else if (container) {
    tally.cards = container.count?.copies ?? null;
    if (followed && listCopies && followedCopies) {
      const t = followedTally(listCopies, followed, ownedAnywhere);
      tally.have = t.have;
      tally.need = t.need;
    }
  }
  const open = view
    ? openView({
        view,
        container,
        set: setSummary?.set,
        mode,
        tally,
        label,
        describeRule: demo?.describeRule,
        canShare: capabilities.share,
      })
    : null;
  const status = loading
    ? view?.kind === "set" && setSummary === null
      ? "That set isn't in the catalog anymore."
      : "Pulling it off the shelf…"
    : isBox || view?.kind === "sale"
      ? ""
      : undefined;

  // -- opening ----------------------------------------------------------------
  const goTo = (next: ViewKey | null, scopeTo?: Scope) => {
    setAimed(null);
    setFound(null);
    setFoundCopy(null);
    setPending(null);
    const p = new URLSearchParams({ tab: "binders" });
    if (next?.kind === "binder") p.set("b", next.binderId);
    if (next?.kind === "set") p.set("set", next.setId);
    if (next?.kind === "all") p.set("all", "1");
    if (next?.kind === "sale") p.set("sale", "1");
    // Opening scopes the page to it on the same push: a home to itself,
    // anything else that is a container (and All my cards) to everything.
    // A set to browse, or the shelf, keeps the scope.
    let to: Scope | null = scopeTo ?? null;
    if (!to && next?.kind === "binder") to = isHome(containers?.find((c) => c.id === next.binderId)) ? next.binderId : "all";
    if (!to && (next?.kind === "all" || next?.kind === "sale")) to = "all";
    if (to) p.set("scope", to);
    setParams(p);
  };

  // Focus follows the view: into one, its heading (and on a wide screen the
  // desk above the tray); back on the shelf, the spine just closed.
  const shownView = useRef(viewId);
  useEffect(() => {
    const prev = shownView.current;
    if (prev === viewId) return;
    shownView.current = viewId;
    if (viewId === "shelf") {
      const root = rootRef.current;
      const spine = root?.querySelector<HTMLElement>(`[data-spine="${CSS.escape(prev)}"]`);
      (spine ?? root?.querySelector<HTMLElement>("[data-shelf-heading]"))?.focus();
      return;
    }
    headingRef.current?.focus({ preventScroll: true });
    if (wide) deskRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
    else rootRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [viewId, wide]);

  // A hunt that found a pocket hands focus to it once its page is drawn.
  const drawn = pages.length;
  useEffect(() => {
    if (!found) return;
    const el = rootRef.current?.querySelector<HTMLElement>('[data-found="true"]');
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [found, viewId, drawn]);

  // PageUp / PageDown turn pages while something is open, unless focus is in
  // a field or somewhere else entirely (the card drawer, a dialog).
  const isOpen = view !== null;
  const dialogOpen = dialog !== null;
  useEffect(() => {
    if (!isOpen || dialogOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const t = e.target as Node | null;
      if (t !== document.body && !(t && rootRef.current?.contains(t))) return;
      const delta = e.key === "PageDown" ? 1 : e.key === "PageUp" ? -1 : 0;
      if (!delta) return;
      e.preventDefault();
      setStepState({ view: viewId, at: Math.max(0, Math.min(at + delta, steps - 1)) });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, dialogOpen, viewId, at, steps]);

  // -- the hunt -----------------------------------------------------------------
  const settled = useSearchText(query);
  const search = useSearch(searchable(settled) ? settled : "");
  const trimmed = query.trim();
  const allHits = searchable(settled) ? search?.cards : NO_CARDS;
  const trayHits = useMemo(() => allHits?.slice(0, TRAY_COPIES), [allHits]);
  const trayIds = useMemo(() => trayHits?.map((c) => c.id) ?? null, [trayHits]);
  const trayCopies = useCopiesOfCards(trayIds && trayIds.length ? trayIds : null);
  const trayTruncated = !!search?.truncated || (allHits?.length ?? 0) > TRAY_COPIES;
  const mine = (cardId: CardId) => (trayCopies?.[cardId] ?? []).filter((c) => c.quantity > 0);

  // -- writes -------------------------------------------------------------------
  const main = systemContainer(containers, "main");
  /** Where a plain add goes: the page's scope when that is a home, else Main. */
  const scopeHome = (scope !== "all" ? containers?.find((c) => c.id === scope && isHome(c)) : undefined) ?? main;
  const containerOf = (id: string) => containers?.find((c) => c.id === id);

  const whereIn = (home: Container, slot: number | undefined | null) => {
    if (slot === undefined || slot === null) return "";
    if (home.kind === "box") return `, ${rowName(slot)}`;
    const ref = slotRefOf(home.id, slot);
    return `, page ${ref.page + 1}, pocket ${ref.slot + 1}`;
  };

  const jumpTo = (slot: number) => {
    if (homeOpen && homeOpen.kind === "binder" && mode === "pockets") turn(stepOfPage(slotRefOf(homeOpen.id, slot).page, wide));
  };

  /** One new copy into a home (at a pocket or row), said the way the page says Have. */
  const addCopy = (card: Card, home: Container, slot?: number, savedFor?: Card | null) => {
    const details = { ...emptyCopyDetails(), homeId: home.id, ...(slot === undefined ? {} : { slot }) };
    const why = savedFor ? ` (that pocket's saved for ${shortCardName(savedFor)})` : "";
    return run(
      () => actions.addLineItem(card, details),
      () => `Added ${shortCardName(card)} to ${home.name}${whereIn(home, slot)}${why}`,
    );
  };

  const justAdd = (card: Card) => {
    if (scopeHome) void addCopy(card, scopeHome);
  };

  /** A new copy into an aimed or dropped pocket of the open binder. */
  const placeIn = (card: Card, ref: SlotRef) => {
    if (!homeOpen || ref.binderId !== homeOpen.id) return justAdd(card);
    const copies = listCopies ?? [];
    const guarded = guardPocket(copies, slotOf(ref), card, followed);
    if (pocketsOf(copies).has(guarded.slot)) {
      notify(`That pocket's full. Pick an empty one for ${shortCardName(card)}.`);
      return;
    }
    setAimed(null);
    jumpTo(guarded.slot);
    void addCopy(card, homeOpen, guarded.slot, guarded.savedFor);
  };

  /** A new copy filed in a home: the open binder's next pocket when it is laid out, else unslotted. */
  const fileIn = (card: Card, target: Container) => {
    if (homeOpen?.id === target.id && target.kind === "binder" && mode === "pockets" && listCopies) {
      const slot = pocketFor(listCopies, card, followed);
      jumpTo(slot);
      void addCopy(card, target, slot);
      return;
    }
    void addCopy(card, target);
  };

  const addWant = (card: Card) => {
    if (isWantedIn(wants, card.id, "all")) {
      notify(`${shortCardName(card)} is already on your Want List.`);
      return;
    }
    void run(
      () => actions.setWant(card.id, null, true),
      () => `${shortCardName(card)} is on your Want List. Happy hunting!`,
    );
  };

  // -- moving a copy you own ----------------------------------------------------------
  const moveTarget = homeOpen ?? null;
  const moves = (card: Card) => !!moveTarget && movableCopies(mine(card.id), moveTarget.id).length > 0;

  /** Moves this copy into the open home: the pocket or row given, the aimed pocket, or its own. */
  const moveInto = (card: Card, copy: Copy, dropped: number | null) => {
    if (!moveTarget) return;
    let slot: number | null = dropped;
    let savedFor: Card | null = null;
    if (moveTarget.kind === "binder") {
      if (slot === null && aimed && aimed.binderId === moveTarget.id) slot = slotOf(aimed);
      const copies = listCopies ?? [];
      if (slot !== null) {
        const guarded = guardPocket(copies, slot, card, followed);
        slot = guarded.slot;
        savedFor = guarded.savedFor;
        if (pocketsOf(copies).has(slot)) {
          notify(`That pocket's full. Pick an empty one for ${shortCardName(card)}.`);
          return;
        }
      } else if (mode === "pockets") {
        slot = pocketFor(copies, card, followed);
      }
    }
    setAimed(null);
    setPending(null);
    if (slot !== null) jumpTo(slot);
    const from = copy.homeName ? ` from ${copy.homeName}` : "";
    const why = savedFor ? ` (that pocket's saved for ${shortCardName(savedFor)})` : "";
    void run(
      () => actions.moveCopy(copy, moveTarget.id, slot === null ? {} : { slot }),
      () => `Moved ${shortCardName(card)}${from} to ${moveTarget.name}${whereIn(moveTarget, slot)}${why}.`,
    );
  };

  /** "Move here", or a drop: straight away with one copy to move, else ask which. */
  const askMove = (card: Card, dropped: number | null) => {
    if (!moveTarget) return;
    const movable = movableCopies(mine(card.id), moveTarget.id);
    if (movable.length === 0) return;
    if (movable.length === 1) return moveInto(card, movable[0], dropped);
    setPending({ card, verb: "move", slot: dropped });
  };

  const putUpForTrade = (card: Card, copy: Copy) => {
    setPending(null);
    void run(
      () => actions.setTrade(copy, true),
      () => `${shortCardName(card)} is up for trade. It stays in ${copy.homeName ?? "its binder"}.`,
    );
  };

  /** Into a row of the open box (or out of every row). Resolves with the line it is now. */
  const placeInBox = async (copy: Copy, row: number | null): Promise<CopyId | null> => {
    const card = cards?.get(copy.cardId);
    const name = card ? shortCardName(card) : "That card";
    const result = await run(
      () => actions.placeCopy(copy, row),
      () => (row === null ? `${name} is out of its row.` : `${name} is in ${rowName(row)}.`),
    );
    return result?.copyId ?? null;
  };

  /** Go where a copy lives: the pocket or box row, ringed, or the drawer on that copy. */
  const findAt = (card: Card, place: Place) => {
    const target = containerOf(place.homeId);
    if (target && place.pocket && target.kind === "binder") {
      const ref: SlotRef = { binderId: target.id, page: place.pocket.page, slot: place.pocket.slot };
      if (container?.id !== target.id) goTo({ kind: "binder", binderId: target.id });
      setModes((m) => ({ ...m, [target.id]: "pockets" }));
      setStepState({ view: target.id, at: stepOfPage(ref.page, wide) });
      setFound(ref);
      // Found it: fold the results away so the ringed pocket is in view.
      setQuery("");
      notify(`Found ${shortCardName(card)}: ${placeWords(place)}.`);
      return;
    }
    if (target && place.box) {
      if (container?.id !== target.id) goTo({ kind: "binder", binderId: target.id });
      setFoundCopy(place.copyIds[0] ?? null);
      setQuery("");
      notify(`Found ${shortCardName(card)}: ${placeWords(place)}.`);
      return;
    }
    openCard(card.id, { copyId: place.copyIds.length === 1 ? place.copyIds[0] : undefined, seed: card });
  };

  const onSlot = (card: Card, targetId: string) => {
    if (targetId === AIMED_TARGET && aimed) return placeIn(card, aimed);
    const target = containerOf(targetId);
    if (target && isHome(target)) fileIn(card, target);
    else justAdd(card);
  };

  const homes = homesOf(containers);
  const targets: SlotTarget[] = [
    ...(homeOpen ? [{ id: homeOpen.id, label: homeOpen.kind === "box" ? "This box" : "This binder" }] : []),
    ...homes.filter((h) => h.id !== homeOpen?.id).map((h) => ({ id: h.id, label: h.name })),
  ];
  const moveTo: MoveTarget | null = moveTarget ? { id: moveTarget.id, name: moveTarget.name } : null;

  // -- pockets ----------------------------------------------------------------
  const openPocket = (card: Card, pocketCopies: Copy[]) =>
    openCard(card.id, { copyId: soleCopyId(pocketCopies), list: listIds, seed: card });

  const addFromPocket = (card: Card, slot?: SlotRef, wantFor?: string | null) => {
    if (isWant) {
      // Landed a want for a binder: the add form files into that binder.
      openCard(card.id, { mode: "add", list: listIds, seed: card, binderId: wantFor ?? undefined });
      return;
    }
    if (slot) placeIn(card, slot);
    else justAdd(card);
  };

  const aim = (slot: SlotRef) => {
    setAimed(slot);
    searchRef.current?.focus();
  };
  const aimedAt =
    aimed && homeOpen && aimed.binderId === homeOpen.id
      ? `${homeOpen.name}, page ${aimed.page + 1}, pocket ${aimed.slot + 1}`
      : null;

  // -- drag and drop ----------------------------------------------------------
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: pocketHop }),
  );

  const cardOf = (id: UniqueIdentifier): Card | null => {
    const raw = String(id);
    if (!raw.startsWith("card:")) return null;
    return trayHits?.find((c) => c.id === raw.slice(5)) ?? null;
  };
  const copyOf = (id: UniqueIdentifier): Copy | null => {
    const raw = String(id);
    if (!raw.startsWith("copy:")) return null;
    return listCopies?.find((c) => c.id === raw.slice(5)) ?? null;
  };
  const nameOf = (id: UniqueIdentifier): string | null => {
    const card = cardOf(id);
    if (card) return shortCardName(card);
    const copy = copyOf(id);
    const c = copy ? cards?.get(copy.cardId) : undefined;
    return c ? shortCardName(c) : null;
  };
  const describeOver = (id: UniqueIdentifier): string => {
    if (id === SPREAD_DROP_ID) return isWant ? "your Want List" : `${container?.name ?? "the binder"}`;
    const row = parseRowId(id);
    if (row) return row.row === null ? "the table, out of every row" : rowName(row.row);
    const slot = parseSlotId(id);
    if (!slot) return "nowhere";
    const full = homeOpen && pocketsOf(listCopies ?? []).has(slotOf(slot)) ? ", which is full" : "";
    return `page ${slot.page + 1}, pocket ${slot.slot + 1}${full}`;
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      const name = nameOf(active.id);
      if (!name) return undefined;
      const card = cardOf(active.id);
      if (card && moves(card)) {
        const from = placesOf(mine(card.id), containers ?? []).map(placeWords).join(", ");
        return `Picked up ${name}, now in ${from}. Dropping it moves it to ${moveTarget?.name}. Arrow keys hop, Space drops it, Escape puts it back.`;
      }
      return `Picked up ${name}. Arrow keys hop, Space drops it, Escape puts it back.`;
    },
    onDragOver: ({ active, over }) => {
      const name = nameOf(active.id);
      if (!name) return undefined;
      return over ? `${name} is over ${describeOver(over.id)}.` : `${name} is not over anything it can drop on.`;
    },
    onDragEnd: ({ active, over }) => {
      const name = nameOf(active.id);
      if (!name) return undefined;
      return over ? `Dropped ${name} on ${describeOver(over.id)}.` : `${name} went back.`;
    },
    onDragCancel: ({ active }) => {
      const name = nameOf(active.id);
      return name ? `${name} went back.` : undefined;
    },
  };

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const over = e.over?.id;
    // A card already in the open box, onto another row (or the table).
    const copy = copyOf(e.active.id);
    if (copy) {
      const row = over !== undefined ? parseRowId(over) : null;
      if (!row || row.boxId !== copy.homeId) return;
      const at = copy.slot !== undefined && copy.slot >= 0 ? copy.slot : null;
      if (at !== row.row) void placeInBox(copy, row.row);
      return;
    }
    const card = cardOf(e.active.id);
    if (!card) return;
    if (over === undefined) {
      notify(
        `Missed! Drop ${shortCardName(card)} on ${isBox ? "a row" : "an empty pocket"}, or press ${
          isWant ? "Want it" : moves(card) ? "Move here" : "Slot in"
        }.`,
      );
      return;
    }
    const row = parseRowId(over);
    if (row && isBox && container && row.boxId === container.id) {
      if (moves(card)) return askMove(card, row.row);
      const here = mine(card.id).filter((c) => c.homeId === container.id);
      if (here.length === 1) return void placeInBox(here[0], row.row);
      return void addCopy(card, container, row.row ?? undefined);
    }
    const slot = parseSlotId(over);
    if (moves(card) && (slot || over === SPREAD_DROP_ID)) return askMove(card, slot ? slotOf(slot) : null);
    if (slot) return placeIn(card, slot);
    if (over === SPREAD_DROP_ID) {
      if (isWant) return addWant(card);
      if (homeOpen) return fileIn(card, homeOpen);
      return justAdd(card);
    }
  };

  // -- containers -----------------------------------------------------------------
  // The New and Edit dialogs wait on their write: each resolves with null
  // once it landed (and the dialog is closed), or with why it was refused,
  // which the dialog says itself.
  const createContainer = async (input: NewContainer): Promise<string | null> => {
    try {
      const result = await actions.createContainer(input);
      notify(
        input.rule
          ? `${input.name} is on the shelf. It fills itself.`
          : `${input.name} is on the shelf. Hunt for a card below and ${input.kind === "box" ? "drop it in a row" : "start slotting"}.`,
        result.undo,
      );
      setDialog(null);
      goTo({ kind: "binder", binderId: result.containerId }, input.rule ? "all" : result.containerId);
      return null;
    } catch (error) {
      return writeErrorMessage(error);
    }
  };

  const saveLabel = (next: ContainerLabel | null) => {
    if (!container) return;
    const c = container;
    setDialog(null);
    void run(
      () => actions.updateContainer(c, { label: next }),
      () => (next ? `New label on ${c.name}. Looking sharp.` : `${c.name} is back to its default label.`),
    );
  };

  const saveContainer = async (patch: ContainerPatch): Promise<string | null> => {
    if (!container) return null;
    const c = container;
    try {
      const result = await actions.updateContainer(c, patch);
      setDialog(null);
      notify(patch.name ? `${c.name} is now ${patch.name}.` : `Saved ${c.name}.`, result.undo);
      return null;
    } catch (error) {
      return writeErrorMessage(error);
    }
  };

  const deleteContainer = async (): Promise<string | null> => {
    if (!container) return null;
    const c = container;
    try {
      const { moved } = await actions.deleteContainer(c);
      setDialog(null);
      goTo(null, "all");
      notify(
        moved === 0
          ? `${c.name} is off the shelf.`
          : `${c.name} is off the shelf. ${moved === 1 ? "Its card went" : `Its ${moved} cards went`} back to Main.`,
      );
      return null;
    } catch (error) {
      return writeErrorMessage(error);
    }
  };

  /** The layout toggle: local to this view, never a history step. */
  const setMode = (next: LayoutMode) => {
    if (view) setModes((m) => ({ ...m, [viewId]: next }));
  };

  const wholeBinderDrop = !(homeOpen && homeOpen.kind === "binder" && mode === "pockets");
  const dragCopy = activeId ? copyOf(activeId) : null;
  const dragCard = activeId ? (cardOf(activeId) ?? (dragCopy ? cards?.get(dragCopy.cardId) : null)) : null;
  const trayMode = isWant ? "want" : isTrade ? "trade" : "file";

  return (
    <div ref={rootRef} className="nb-tray-clear scroll-mt-4" onFocus={(e) => keepClearOfTray(e.target)}>
      {view?.kind === "all" && <OwnedPileLoader limit={limit} onData={setAllPile} />}
      <DndContext
        sensors={sensors}
        collisionDetection={keyboardAwareCollision}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveId(null)}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable:
              "Press Space or Enter to pick up this card. Arrow keys hop between pockets, Space drops it in, Escape puts it back. Or use its button underneath.",
          },
        }}
      >
        {!view || !open ? (
          <Shelf onOpen={(next) => goTo(next)} onNewBinder={() => setDialog("new")} />
        ) : (
          <BinderView
            open={open}
            pages={pages}
            wide={wide}
            at={at}
            onTurn={turn}
            onBack={() => goTo(null)}
            onLayout={setMode}
            onEditLabel={() => setDialog("label")}
            onEditContainer={() => setDialog("edit")}
            onGoChecklists={() => goToTab("checklists")}
            pile={{
              sort,
              onSort: (next) => {
                setSort(next);
                turn(0);
              },
              filters,
              onFilters: (next) => {
                setFilters(next);
                setStepState({ view: viewId, at: 0 });
              },
            }}
            aimed={aimed}
            found={found}
            wholeBinderDrop={wholeBinderDrop}
            reducedMotion={reducedMotion}
            headingRef={headingRef}
            deskRef={deskRef}
            onOpen={openPocket}
            onAdd={addFromPocket}
            onAim={aim}
            status={status}
          >
            {view.kind === "sale" ? (
              <ForSaleView
                onOpenBox={(box) => goTo({ kind: "binder", binderId: box.id })}
                onOpenCard={(card, copy) => openCard(card.id, { copyId: copy.id, seed: card })}
              />
            ) : isBox && container ? (
              listCopies && cards ? (
                <BoxDesk
                  box={container}
                  copies={listCopies}
                  cards={cards}
                  truncated={!!listPage?.truncated}
                  onMore={more}
                  onOpen={(card, copy) =>
                    openCard(card.id, { copyId: copy.id, seed: card, list: listCopies.map((c) => c.cardId) })
                  }
                  onPlace={placeInBox}
                  found={foundCopy}
                  draggingId={activeId}
                />
              ) : (
                <p className="py-8 text-center text-ink-2">Lifting the lid…</p>
              )
            ) : undefined}
          </BinderView>
        )}

        {view && truncated && !isBox && view.kind !== "sale" && (
          <div className="mt-3 flex justify-center">
            <NeonButton type="button" variant="secondary" outline onClick={more} className="min-h-10">
              {view.kind === "set" ? "Load more of the set" : "Show more cards"}
            </NeonButton>
          </div>
        )}

        <PackTray
          mode={trayMode}
          query={query}
          onQuery={setQuery}
          hits={trimmed ? trayHits : NO_CARDS}
          truncated={trayTruncated}
          copiesByCard={trayIds && trayIds.length ? trayCopies : {}}
          containers={containers ?? []}
          isWanted={(cardId) => isWantedIn(wants, cardId, "all")}
          targets={targets}
          moveTo={isWant || isTrade ? null : moveTo}
          choosing={pending}
          onChoose={(c) => setPending({ ...c, slot: null })}
          onCancelChoose={() => setPending(null)}
          onSlot={onSlot}
          onMove={(card, copy) => moveInto(card, copy, pending?.card.id === card.id ? pending.slot : null)}
          onTrade={putUpForTrade}
          onFind={findAt}
          onWant={addWant}
          aimedAt={aimedAt}
          onCancelAim={() => setAimed(null)}
          notice={notice}
          onUndo={onUndo}
          onDismissNotice={onDismissNotice}
          onSay={(text) => notify(text)}
          inputRef={searchRef}
          draggingId={activeId?.startsWith("card:") ? activeId.slice(5) : null}
        />

        <DragOverlay dropAnimation={reducedMotion ? null : undefined}>
          {dragCard ? (
            <div className="p2-overlay">
              <CardFace model={dragCard} size="sm" />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {dialog === "new" && <NewBinderDialog onCreate={createContainer} onClose={() => setDialog(null)} />}
      {dialog === "label" && container && (
        <LabelEditorDialog binder={container} onSave={saveLabel} onClose={() => setDialog(null)} />
      )}
      {dialog === "edit" && container && !container.system && (
        <EditContainerDialog
          container={container}
          onSave={saveContainer}
          onDelete={deleteContainer}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

/**
 * WCAG 2.4.11: the pack tray is pinned over the bottom of the page, and a
 * control it covers still counts as on screen, so the browser never scrolls
 * to it. When the keyboard lands on one, scroll it up clear of the tray (its
 * height is `--nb-tray-h`, which PackTray publishes).
 */
function keepClearOfTray(target: EventTarget) {
  // The tray's own controls, and a dialog's (it sits over the tray), are left alone.
  if (!(target instanceof HTMLElement) || target.closest(".p2-pack, [role='dialog'], [role='alertdialog']")) return;
  const tray = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--nb-tray-h")) || 0;
  if (tray <= 0) return;
  const rect = target.getBoundingClientRect();
  const limit = window.innerHeight - tray - 16;
  // Never scroll a control taller than the room above the tray off its top.
  if (rect.bottom > limit && rect.top > 0) window.scrollBy({ top: Math.min(rect.bottom - limit, rect.top) });
}

/**
 * All my cards' copies, read only while that view is open: the owned-cards
 * list pages the server, so it is not something the shelf should pay for.
 * Hands what it has to the tab.
 */
function OwnedPileLoader({ limit, onData }: { limit: number; onData: (pile: OwnedPile | null) => void }) {
  const owned = useOwnedCards({ limit });
  const ids = useMemo(() => owned?.cards.map((c) => c.id) ?? null, [owned]);
  const copiesByCard = useCopiesOfCards(ids && ids.length ? ids : null);
  useEffect(() => {
    if (!owned || (ids && ids.length && !copiesByCard)) {
      onData(null);
      return;
    }
    const cards = new Map(owned.cards.map((c) => [c.id, c]));
    const copies = owned.cards.flatMap((c) => copiesByCard?.[c.id] ?? []);
    onData({ cards, copies, total: owned.total, truncated: owned.truncated });
  }, [owned, ids, copiesByCard, onData]);
  useEffect(() => () => onData(null), [onData]);
  return null;
}

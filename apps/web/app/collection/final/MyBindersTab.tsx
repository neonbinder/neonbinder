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
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import { keyboardAwareCollision } from "@/lib/dnd/keyboard-aware-collision";
import { isEditableTarget } from "@/lib/dom/is-editable-target";
import CardFace from "../prototypes/_shared/CardFace";
import {
  binderCopies,
  compareCards,
  getCard,
  getSet,
  searchCards,
  type BinderId,
  type Card,
  type Copy,
} from "../prototypes/_shared/data";
import type { Notice } from "../prototypes/p1/notice";
import { useReducedMotion, useWideDesk } from "../prototypes/p2/hooks";
import {
  fitsBinder,
  NO_FILTERS,
  shortName,
  type LayoutMode,
  type PileFilters,
  type SlotRef,
  type SortKey,
  type ViewKey,
} from "../prototypes/p2/model";
import "../prototypes/p2/p2.css";
import BinderDesk, { SPREAD_DROP_ID, stepCount, stepOfPage, whereLabel } from "./binders/BinderDesk";
import "./binders/binders.css";
import { parseSlotId, pocketHop, slotCopyId } from "./binders/dnd";
import type { BinderLabel } from "./binders/label";
import LabelEditorDialog from "./binders/LabelEditorDialog";
import {
  buildBinderPages,
  cardsOnPages,
  guardPocket,
  liveryOf,
  movableCopies,
  placesOf,
  placeWords,
  pocketFor,
  soleCopyId,
  wantPages,
  type Place,
} from "./binders/model";
import NewBinderDialog from "./binders/NewBinderDialog";
import PackTray, { AIMED_TARGET, type MoveTarget, type SlotTarget } from "./binders/PackTray";
import { Cover, MobileSummary, ModeToggle, PileTools, ScopeLine, scopeText, viewTitle } from "./binders/parts";
import ShareLink from "./binders/ShareLink";
import Shelf from "./binders/Shelf";
import { useCollectionParams } from "./mode";
import type { NewBinder } from "../prototypes/_shared/usePrototypeStore";
import type { BinderSelection, CollectionBinder, CollectionTabProps } from "./store";

/**
 * My Binders: prototype 2, "Nine-Pocket", on the consolidated page. A shelf
 * of spines in the Print Shop's spine-label look (yours, plus the special
 * shelf: All my cards, Want List, Up for Trade and the Inventory long box),
 * an open binder of nine-pocket pages, and the hunt tray, where you look for
 * one of your cards: it shows where each copy lives and takes you there
 * (ringing the pocket), moves a copy into the open binder, or adds a new
 * one. A card pressed in its sleeve slides out into the page's shared card
 * drawer.
 *
 * Opening a binder scopes the whole page to it (`setSelectedBinder`), so
 * Checklists and My Cards then show that binder's Have / Want / Trade.
 *
 * The status line is the page's (passed in as `notice`): the pack shows it,
 * so it never floats over the pack's search box.
 */

export interface MyBindersTabProps extends CollectionTabProps {
  notice: Notice | null;
  onUndo: () => void;
  onDismissNotice: () => void;
}

export default function MyBindersTab({
  store,
  openCard,
  goToTab,
  notify,
  notice,
  onUndo,
  onDismissNotice,
}: MyBindersTabProps) {
  const { copies, binders } = store.state;
  const wide = useWideDesk();
  const reducedMotion = useReducedMotion();

  // -- what is open ---------------------------------------------------------
  const [params, setParams] = useCollectionParams();
  const view: ViewKey | null = useMemo(() => {
    const b = params.get("b");
    if (b && binders.some((x) => x.id === b)) return { kind: "binder", binderId: b };
    const s = params.get("set");
    if (s) {
      try {
        getSet(s);
        return { kind: "set", setId: s };
      } catch {
        return null;
      }
    }
    if (params.get("all")) return { kind: "all" };
    return null;
  }, [params, binders]);
  const viewId = view
    ? view.kind === "binder"
      ? view.binderId
      : view.kind === "set"
        ? `set:${view.setId}`
        : "all"
    : "shelf";
  const binder: CollectionBinder | undefined =
    view?.kind === "binder" ? store.getBinder(view.binderId) : undefined;
  const isWant = binder?.system === "want";

  // Opening a binder scopes the page to it. A smart binder fills itself (no
  // copy is filed in it), so it scopes to everything; a set to browse leaves
  // the scope alone.
  const { setSelectedBinder } = store;
  const scopeTo: BinderSelection | null =
    view?.kind === "all"
      ? "all"
      : view?.kind === "binder" && binder
        ? binder.kind === "manual"
          ? binder.id
          : "all"
        : null;
  useEffect(() => {
    if (scopeTo) setSelectedBinder(scopeTo);
  }, [scopeTo, setSelectedBinder]);

  const [stepState, setStepState] = useState<{ view: string; at: number }>({ view: "shelf", at: 0 });
  const [modes, setModes] = useState<Record<string, LayoutMode>>({});
  const [sort, setSort] = useState<SortKey>("checklist");
  const [filters, setFilters] = useState<PileFilters>(NO_FILTERS);
  const [query, setQuery] = useState("");
  const [aimed, setAimed] = useState<SlotRef | null>(null);
  const [newBinder, setNewBinder] = useState(false);
  const [editingLabel, setEditingLabel] = useState(false);
  const [dragging, setDragging] = useState<Card | null>(null);
  /** The pocket a hunt led to: ringed (and focused) until the binder closes. */
  const [found, setFound] = useState<SlotRef | null>(null);
  /** An owned card waiting on "which copy moves?", and the pocket it was dropped on. */
  const [moving, setMoving] = useState<{ card: Card; slot: SlotRef | null } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const defaultMode = (b: CollectionBinder | undefined): LayoutMode =>
    !b ? "stack" : b.kind === "smart" || b.layout ? "pockets" : "stack";
  const mode: LayoutMode = binder ? (modes[binder.id] ?? defaultMode(binder)) : "stack";

  const pages = useMemo(() => {
    if (!view) return [];
    if (isWant) {
      return wantPages(store.wantsByBinder(), copies, (id) => store.getBinder(id)?.name);
    }
    return buildBinderPages({ view, mode, copies, binders, sort, filters });
  }, [view, isWant, store, mode, copies, binders, sort, filters]);
  const listIds = useMemo(() => cardsOnPages(pages), [pages]);
  const steps = stepCount(pages.length, wide);
  const at = stepState.view === viewId ? Math.min(stepState.at, steps - 1) : 0;
  const turn = (to: number) =>
    setStepState({ view: viewId, at: Math.max(0, Math.min(to, steps - 1)) });

  const open = (next: ViewKey | null) => {
    setAimed(null);
    setFound(null);
    setMoving(null);
    const p = new URLSearchParams({ tab: "binders" });
    if (next?.kind === "binder") p.set("b", next.binderId);
    if (next?.kind === "set") p.set("set", next.setId);
    if (next?.kind === "all") p.set("all", "1");
    setParams(p);
  };

  // Focus follows the view: into a binder, its heading (and on a wide
  // screen, the whole spread above the pack); back on the shelf, the spine
  // of the binder just closed. Not on first load.
  const shownView = useRef(viewId);
  const deskRef = useRef<HTMLDivElement>(null);
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

  // A hunt that found a pocket hands focus to it, so Enter opens the card.
  useEffect(() => {
    if (!found) return;
    const el = rootRef.current?.querySelector<HTMLElement>('[data-found="true"]');
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [found, viewId]);

  // PageUp / PageDown turn pages while a binder is open, unless focus is in
  // a field or somewhere else entirely (the card drawer, a dialog).
  const isOpen = view !== null;
  const dialogOpen = newBinder || editingLabel;
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

  // -- adding ---------------------------------------------------------------
  const undoAdd = (copy: Copy) => () => {
    store.removeCopy(copy.id);
  };

  const jumpTo = (slot: SlotRef) => {
    if (view?.kind === "binder" && view.binderId === slot.binderId && mode === "pockets") {
      turn(stepOfPage(slot.page, wide));
    }
  };

  const placeIn = (card: Card, aimedSlot: SlotRef) => {
    const target = store.getBinder(aimedSlot.binderId);
    // A checklist binder's numbered pocket is saved for its own card: anything
    // else (a second copy, a stray) goes to its own pocket or the Extras pages.
    const guarded =
      target?.kind === "manual"
        ? guardPocket(target, aimedSlot, card, copies)
        : { slot: aimedSlot, savedFor: null };
    const slot = guarded.slot;
    if (slotCopyId(target, slot)) {
      notify(`That pocket's full. Pick an empty one for ${shortName(card)}.`);
      return;
    }
    const copy = store.addCopy(card.id, { quantity: 1, binderIds: [slot.binderId] });
    store.placeInSlot(slot.binderId, slot.page, slot.slot, copy.id);
    setAimed(null);
    jumpTo(slot);
    const where = `page ${slot.page + 1}, pocket ${slot.slot + 1}`;
    notify(
      guarded.savedFor
        ? `That pocket's saved for ${shortName(guarded.savedFor)}, so ${shortName(card)} went to ${where}.`
        : `Slid ${shortName(card)} into ${target?.name ?? "the binder"}, ${where}.`,
      undoAdd(copy),
    );
  };

  /** One copy into the page's add target: the open binder, else Main. */
  const justAdd = (card: Card) => {
    const copy = store.addCopy(card.id, { quantity: 1 });
    const into = store.getBinder(copy.binderIds[0])?.name ?? "Main";
    const name = shortName(card);
    let text = `Got it! ${name} is in ${into}.`;
    if (binder?.kind === "smart") {
      text = fitsBinder(binder, card)
        ? `Got it! ${name} is in ${into}, and shows up in ${binder.name}.`
        : `Got it! ${name} is in ${into}. It doesn't fit ${binder.name}, so look for it in All my cards.`;
    }
    notify(text, undoAdd(copy));
  };

  const fileIn = (card: Card, target: CollectionBinder) => {
    if (target.kind !== "manual" || target.system === "want") return justAdd(card);
    if (target.layout) return placeIn(card, pocketFor(target, card, copies));
    const copy = store.addCopy(card.id, { quantity: 1, binderIds: [target.id] });
    notify(`Filed ${shortName(card)} in ${target.name}.`, undoAdd(copy));
  };

  /** The pack, while the Want List is open: a want, never a filed copy. */
  const addWant = (card: Card) => {
    const name = shortName(card);
    if (store.wants.some((w) => w.cardId === card.id && w.binderId === null)) {
      notify(`${name} is already on your Want List.`);
      return;
    }
    store.setWant(card.id, null, true);
    notify(`${name} is on your Want List. Happy hunting!`, () => store.setWant(card.id, null, false));
  };

  // -- moving a copy you own ----------------------------------------------------
  /** The open binder a copy can move into: a manual one you file in. */
  const moveTarget: CollectionBinder | null =
    binder && store.fileableBinders.some((b) => b.id === binder.id) ? binder : null;
  const canMoveHere = (card: Card) =>
    !!moveTarget && movableCopies(card.id, copies, moveTarget.id).length > 0;

  /** Move this copy into the open binder: the pocket given, aimed, or its own. */
  const moveInto = (card: Card, copyId: string, dropped: SlotRef | null = null) => {
    if (!moveTarget || moveTarget.kind !== "manual") return;
    let slot: SlotRef | null = dropped ?? (aimed && aimed.binderId === moveTarget.id ? aimed : null);
    let savedFor: Card | null = null;
    if (slot) {
      const guarded = guardPocket(moveTarget, slot, card, copies);
      slot = guarded.slot;
      savedFor = guarded.savedFor;
      if (slotCopyId(moveTarget, slot)) {
        notify(`That pocket's full. Pick an empty one for ${shortName(card)}.`);
        return;
      }
    } else if (moveTarget.layout && mode === "pockets") {
      slot = pocketFor(moveTarget, card, copies);
    }
    const result = store.moveCopy(
      copyId,
      moveTarget.id,
      slot ? { page: slot.page, slot: slot.slot } : undefined,
    );
    if (!result) return;
    setAimed(null);
    setMoving(null);
    if (slot) jumpTo(slot);
    const fromNames = result.from.map((id) => store.getBinder(id)?.name).filter(Boolean);
    const from = fromNames.length ? ` from ${fromNames.join(" and ")}` : "";
    const where = slot ? `, page ${slot.page + 1}, pocket ${slot.slot + 1}` : "";
    const why = savedFor ? ` (that pocket's saved for ${shortName(savedFor)})` : "";
    notify(`Moved ${shortName(card)}${from} to ${moveTarget.name}${where}${why}.`, result.undo);
  };

  /** "Move here": straight away with one copy to move; otherwise ask which. */
  const askMove = (card: Card, dropped: SlotRef | null = null) => {
    if (!moveTarget) return;
    const movable = movableCopies(card.id, copies, moveTarget.id);
    if (movable.length === 0) return;
    if (movable.length === 1) return moveInto(card, movable[0].id, dropped);
    setMoving({ card, slot: dropped });
  };

  /** Go to where a copy lives: the pocket, ringed, or the drawer on that copy. */
  const findAt = (card: Card, place: Place) => {
    const target = store.getBinder(place.binderId);
    if (place.pocket && target?.kind === "manual" && target.layout) {
      const ref: SlotRef = { binderId: target.id, page: place.pocket.page, slot: place.pocket.slot };
      if (!(view?.kind === "binder" && view.binderId === target.id)) open({ kind: "binder", binderId: target.id });
      setModes((m) => ({ ...m, [target.id]: "pockets" }));
      setStepState({ view: target.id, at: stepOfPage(ref.page, wide) });
      setFound(ref);
      // Found it: fold the results away so the ringed pocket is in view.
      setQuery("");
      notify(`Found ${shortName(card)}: ${placeWords(place)}.`);
      return;
    }
    openCard(card.id, { copyId: place.copyIds.length === 1 ? place.copyIds[0] : undefined });
  };

  const onSlot = (card: Card, targetId: string) => {
    if (targetId === AIMED_TARGET && aimed) return placeIn(card, aimed);
    const target = store.getBinder(targetId);
    if (target) fileIn(card, target);
    else justAdd(card);
  };

  const fileable = store.fileableBinders;
  const targets: SlotTarget[] = useMemo(() => {
    const here = binder && fileable.some((b) => b.id === binder.id) ? [binder] : [];
    const rest = fileable.filter((b) => b.id !== binder?.id);
    return [
      ...here.map((b) => ({ id: b.id, label: "This binder" })),
      ...rest.map((b) => ({ id: b.id, label: b.name })),
    ];
  }, [fileable, binder]);

  // -- pockets ----------------------------------------------------------------
  const openPocket = (card: Card, pocketCopies: Copy[]) =>
    openCard(card.id, { copyId: soleCopyId(pocketCopies), list: listIds });

  const addFromPocket = (card: Card, slot?: SlotRef, wantFor?: BinderId | null) => {
    if (isWant) {
      // Landed a want for a binder: the add form ticks that binder.
      openCard(card.id, { mode: "add", list: listIds, binderId: wantFor ?? undefined });
      return;
    }
    if (slot) placeIn(card, slot);
    else justAdd(card);
  };

  const aim = (slot: SlotRef) => {
    setAimed(slot);
    searchRef.current?.focus();
  };
  const aimedBinder = aimed ? store.getBinder(aimed.binderId) : undefined;
  const aimedAt = aimed
    ? `${aimedBinder?.name ?? "the binder"}, page ${aimed.page + 1}, pocket ${aimed.slot + 1}`
    : null;

  // -- drag and drop ----------------------------------------------------------
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: pocketHop }),
  );

  const cardOf = (id: UniqueIdentifier): Card | null => {
    const raw = String(id);
    return raw.startsWith("card:") ? getCard(raw.slice(5)) : null;
  };
  const moves = (c: Card) => !isWant && canMoveHere(c);
  const describeOver = (id: UniqueIdentifier): string => {
    if (id === SPREAD_DROP_ID) return isWant ? "your Want List" : "the open binder";
    const slot = parseSlotId(id);
    if (!slot) return "nowhere";
    const full = slotCopyId(store.getBinder(slot.binderId), slot) ? ", which is full" : "";
    return `page ${slot.page + 1}, pocket ${slot.slot + 1}${full}`;
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      const c = cardOf(active.id);
      if (!c) return undefined;
      if (moves(c)) {
        const from = placesOf(c.id, copies, binders).map(placeWords).join(", ");
        return `Picked up ${shortName(c)}, now in ${from}. Dropping it moves it to ${moveTarget?.name}. Arrow keys hop between pockets, Space moves it in, Escape puts it back.`;
      }
      return `Picked up ${shortName(c)}. Arrow keys hop between pockets, Space drops it in, Escape puts it back.`;
    },
    onDragOver: ({ active, over }) => {
      const c = cardOf(active.id);
      if (!c) return undefined;
      if (!over) return `${shortName(c)} is not over a pocket.`;
      return moves(c)
        ? `${shortName(c)} would move to ${describeOver(over.id)}.`
        : `${shortName(c)} is over ${describeOver(over.id)}.`;
    },
    onDragEnd: ({ active, over }) => {
      const c = cardOf(active.id);
      if (!c) return undefined;
      if (!over) return `${shortName(c)} went back in the tray.`;
      return moves(c)
        ? `Moving ${shortName(c)} to ${describeOver(over.id)}.`
        : `Dropped ${shortName(c)} on ${describeOver(over.id)}.`;
    },
    onDragCancel: ({ active }) => {
      const c = cardOf(active.id);
      return c ? `${shortName(c)} went back in the tray.` : undefined;
    },
  };

  const onDragStart = (e: DragStartEvent) => setDragging(cardOf(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const card = cardOf(e.active.id);
    if (!card) return;
    if (!e.over) {
      notify(
        `Missed! Drop ${shortName(card)} on an empty pocket, or press ${
          isWant ? "Want it" : moves(card) ? "Move here" : "Slot in"
        }.`,
      );
      return;
    }
    const slot = parseSlotId(e.over.id);
    // A card you own moves into the open binder; a new one is added.
    if (moves(card) && (slot || e.over.id === SPREAD_DROP_ID)) return askMove(card, slot);
    if (slot) return placeIn(card, slot);
    if (e.over.id === SPREAD_DROP_ID) {
      if (isWant) return addWant(card);
      if (binder?.kind === "manual") return fileIn(card, binder);
      return justAdd(card);
    }
  };

  // -- the rest --------------------------------------------------------------
  const hits = useMemo(() => (query.trim() ? searchCards(query) : []), [query]);

  const createBinder = (input: NewBinder, label?: BinderLabel) => {
    const b = store.createBinder(input, label);
    setNewBinder(false);
    open({ kind: "binder", binderId: b.id });
    notify(`${b.name} is on the shelf. Hunt for a card below and start slotting.`);
  };

  const saveLabel = (label: BinderLabel | null) => {
    if (!binder) return;
    const before = binder.label ?? null;
    const id = binder.id;
    store.setBinderLabel(id, label);
    setEditingLabel(false);
    notify(
      label ? `New label on the ${binder.name} spine. Looking sharp.` : `${binder.name} is back to its default label.`,
      () => store.setBinderLabel(id, before),
    );
  };

  const setMode = (next: LayoutMode) => {
    if (!binder) return;
    if (next === "pockets" && binder.kind === "manual" && !binder.layout) {
      // Give it real pages, filled in checklist order, so it can match the shelf.
      const filed = [...binderCopies(binder, copies)].sort((a, b) =>
        compareCards(getCard(a.cardId), getCard(b.cardId)),
      );
      if (filed.length === 0) store.placeInSlot(binder.id, 0, 0, null);
      filed.forEach((c, i) => store.placeInSlot(binder.id, Math.floor(i / 9), i % 9, c.id));
    }
    setModes((m) => ({ ...m, [binder.id]: next }));
  };

  const pocketVariant = view?.kind === "set" ? "browse" : "binder";
  const wholeBinderDrop = !(binder?.kind === "manual" && !isWant && mode === "pockets");
  const vinyl = view?.kind === "set" ? "#1e293b" : liveryOf(binder ?? "all").primary;
  const moveTo: MoveTarget | null =
    moveTarget && !isWant ? { id: moveTarget.id, name: moveTarget.name } : null;
  const scope = view ? scopeText(view, binder) : null;

  return (
    <div ref={rootRef} className="scroll-mt-4">
      <DndContext
        sensors={sensors}
        collisionDetection={keyboardAwareCollision}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable:
              "Press Space or Enter to pick up this card. Arrow keys hop between pockets, Space drops it in, Escape puts it back. Or use its button underneath.",
          },
        }}
      >
        {!view ? (
          <Shelf store={store} onOpen={open} onNewBinder={() => setNewBinder(true)} />
        ) : (
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <button
                type="button"
                onClick={() => open(null)}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-600 px-3 text-sm font-medium text-slate-100 hover:border-neon-blue focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
              >
                <ArrowLeftIcon aria-hidden="true" className="h-4 w-4" />
                Back to the shelf
              </button>
              <div className="flex min-w-0 items-center gap-2">
                <h2
                  ref={headingRef}
                  tabIndex={-1}
                  className="truncate text-2xl font-bold text-white focus:outline-none sm:text-3xl"
                >
                  {viewTitle(view, binder)}
                </h2>
                {binder?.kind === "smart" && (
                  <span className="rounded bg-neon-purple px-1.5 text-xs font-bold leading-5 text-black">Smart</span>
                )}
                {view.kind === "set" && (
                  <span className="rounded border border-neon-blue px-1.5 text-xs font-bold leading-5 text-neon-blue">
                    Browsing
                  </span>
                )}
              </div>
              <p aria-live="polite" className="text-sm tabular-nums text-slate-300">
                {whereLabel(pages.length, wide, at)}
              </p>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {binder && <ShareLink key={binder.id} binder={binder} />}
                {binder && !isWant && <ModeToggle mode={mode} onChange={setMode} />}
                {view.kind === "all" && (
                  <PileTools
                    sort={sort}
                    onSort={(s) => {
                      setSort(s);
                      turn(0);
                    }}
                    filters={filters}
                    onFilters={(f) => {
                      setFilters(f);
                      setStepState({ view: viewId, at: 0 });
                    }}
                  />
                )}
              </div>
            </div>

            {scope && <ScopeLine text={scope} onGo={() => goToTab("checklists")} />}

            {!wide && (
              <MobileSummary
                view={view}
                binder={binder}
                store={store}
                mode={mode}
                onEditLabel={binder ? () => setEditingLabel(true) : undefined}
              />
            )}

            <div ref={deskRef} className="scroll-mt-2">
              <BinderDesk
                pages={pages}
                wide={wide}
                at={at}
                onTurn={turn}
                vinyl={vinyl}
                cover={
                  <Cover
                    view={view}
                    binder={binder}
                    store={store}
                    mode={mode}
                    onEditLabel={binder ? () => setEditingLabel(true) : undefined}
                  />
                }
                variant={pocketVariant}
                aimed={aimed}
                found={found}
                wholeBinderDrop={wholeBinderDrop}
                reducedMotion={reducedMotion}
                name={viewTitle(view, binder)}
                onOpen={openPocket}
                onAdd={addFromPocket}
                onAim={aim}
              />
            </div>
          </div>
        )}

        <PackTray
          mode={isWant ? "want" : "file"}
          query={query}
          onQuery={setQuery}
          hits={hits}
          copies={copies}
          binders={binders}
          isWanted={(cardId) => store.wants.some((w) => w.cardId === cardId && w.binderId === null)}
          targets={targets}
          moveTo={moveTo}
          moving={moving?.card ?? null}
          onAskMove={(card) => askMove(card)}
          onCancelMove={() => setMoving(null)}
          onSlot={onSlot}
          onMove={(card, copyId) => moveInto(card, copyId, moving?.card.id === card.id ? moving.slot : null)}
          onFind={findAt}
          onWant={addWant}
          aimedAt={aimedAt}
          onCancelAim={() => setAimed(null)}
          notice={notice}
          onUndo={onUndo}
          onDismissNotice={onDismissNotice}
          onSay={(text) => notify(text)}
          inputRef={searchRef}
          draggingId={dragging?.id ?? null}
        />

        <DragOverlay dropAnimation={reducedMotion ? null : undefined}>
          {dragging ? (
            <div className="p2-overlay">
              <CardFace card={dragging} size="sm" />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {newBinder && <NewBinderDialog onCreate={createBinder} onClose={() => setNewBinder(false)} />}
      {editingLabel && binder && (
        <LabelEditorDialog binder={binder} onSave={saveLabel} onClose={() => setEditingLabel(false)} />
      )}
    </div>
  );
}

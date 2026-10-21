import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useSearchParams } from "react-router";
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
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import { keyboardAwareCollision } from "@/lib/dnd/keyboard-aware-collision";
import { isEditableTarget } from "@/lib/dom/is-editable-target";
import PrototypeBanner, { prototypeName } from "../_shared/PrototypeBanner";
import CardFace from "../_shared/CardFace";
import {
  binderCopies,
  compareCards,
  describeRule,
  getCard,
  getSet,
  searchCards,
  setLabel,
  type Binder,
  type Card,
  type CardId,
  type Copy,
} from "../_shared/data";
import { usePrototypeStore, type NewBinder } from "../_shared/usePrototypeStore";
import BinderDesk, { SPREAD_DROP_ID, stepCount, stepOfPage, whereLabel } from "./BinderDesk";
import CardDetail from "./CardDetail";
import { useReducedMotion, useWideDesk } from "./hooks";
import {
  binderCount,
  binderLivery,
  buildPages,
  fitsBinder,
  NO_FILTERS,
  pocketFor,
  shortName,
  type LayoutMode,
  type PileFilters,
  type SlotRef,
  type SortKey,
  type ViewKey,
} from "./model";
import NewBinderDialog from "./NewBinderDialog";
import PackTray, { AIMED_TARGET, type SlotTarget, type StatusNote } from "./PackTray";
import Shelf from "./Shelf";
import "./p2.css";

/**
 * NEO-350 — collection prototype 2, "Nine-Pocket". The collection IS binders:
 * a shelf of spines, an open binder of nine-pocket pages, a pack tray to rip
 * new cards from, and a card that slides out of its sleeve for details.
 */

const JUST_ADD = "none";

/** Arrow keys hop between drop targets during a keyboard drag. */
const pocketHop: KeyboardCoordinateGetter = (event, { context }) => {
  const dirs: Record<string, [number, number]> = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
  };
  const d = dirs[event.code];
  const { collisionRect, droppableRects, droppableContainers } = context;
  if (!d || !collisionRect) return undefined;
  event.preventDefault();
  const cx = collisionRect.left + collisionRect.width / 2;
  const cy = collisionRect.top + collisionRect.height / 2;
  let best: { left: number; top: number; width: number; height: number } | null = null;
  let bestScore = Infinity;
  for (const container of droppableContainers.getEnabled()) {
    const r = droppableRects.get(container.id);
    if (!r) continue;
    const dx = r.left + r.width / 2 - cx;
    const dy = r.top + r.height / 2 - cy;
    const along = dx * d[0] + dy * d[1];
    if (along <= 4) continue;
    const across = Math.abs(dx * d[1]) + Math.abs(dy * d[0]);
    const score = along + across * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = r;
    }
  }
  if (!best) return undefined;
  return {
    x: best.left + best.width / 2 - collisionRect.width / 2,
    y: best.top + best.height / 2 - collisionRect.height / 2,
  };
};

function parseSlotId(id: UniqueIdentifier): SlotRef | null {
  const parts = String(id).split(":");
  if (parts[0] !== "pocket" || parts.length !== 4) return null;
  return { binderId: parts[1], page: Number(parts[2]), slot: Number(parts[3]) };
}

function slotCopyId(binder: Binder | undefined, slot: SlotRef): string | null {
  if (!binder || binder.kind !== "manual") return null;
  return binder.layout?.[slot.page]?.slots[slot.slot] ?? null;
}

export default function CollectionPrototype2() {
  const name = prototypeName(2);
  useDocumentTitle(`${name} · Collection prototype`);
  const store = usePrototypeStore("p2");
  const { copies, binders } = store.state;
  const wide = useWideDesk();
  const reducedMotion = useReducedMotion();

  // -- what is open ---------------------------------------------------------
  const [params, setParams] = useSearchParams();
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
  const viewId = view ? (view.kind === "binder" ? view.binderId : view.kind === "set" ? `set:${view.setId}` : "all") : "shelf";
  const binder = view?.kind === "binder" ? store.getBinder(view.binderId) : undefined;

  const [stepState, setStepState] = useState<{ view: string; at: number }>({ view: "shelf", at: 0 });
  const [modes, setModes] = useState<Record<string, LayoutMode>>({});
  const [sort, setSort] = useState<SortKey>("checklist");
  const [filters, setFilters] = useState<PileFilters>(NO_FILTERS);
  const [query, setQuery] = useState("");
  const [aimed, setAimed] = useState<SlotRef | null>(null);
  const [status, setStatus] = useState<StatusNote | null>(null);
  const [detail, setDetail] = useState<CardId | null>(null);
  const [newBinder, setNewBinder] = useState(false);
  const [dragging, setDragging] = useState<Card | null>(null);

  const h1Ref = useRef<HTMLHeadingElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const noteId = useRef(0);

  const say = (note: Omit<StatusNote, "id">) => {
    noteId.current += 1;
    setStatus({ ...note, id: noteId.current });
  };

  const defaultMode = (b: Binder | undefined): LayoutMode =>
    !b ? "stack" : b.kind === "smart" || b.layout ? "pockets" : "stack";
  const mode: LayoutMode = binder ? (modes[binder.id] ?? defaultMode(binder)) : "stack";

  const pages = useMemo(
    () => (view ? buildPages({ view, mode, copies, binders, sort, filters }) : []),
    [view, mode, copies, binders, sort, filters],
  );
  const steps = stepCount(pages.length, wide);
  const at = stepState.view === viewId ? Math.min(stepState.at, steps - 1) : 0;
  const turn = (to: number) =>
    setStepState({ view: viewId, at: Math.max(0, Math.min(to, steps - 1)) });

  const open = (next: ViewKey | null) => {
    setAimed(null);
    setStatus(null);
    const p = new URLSearchParams();
    if (next?.kind === "binder") p.set("b", next.binderId);
    if (next?.kind === "set") p.set("set", next.setId);
    if (next?.kind === "all") p.set("all", "1");
    setParams(p);
    window.scrollTo({ top: 0 });
  };

  // Focus the new view's heading so a keyboard user lands in it (not on load).
  // On a wide screen, bring the whole spread (pager to bottom pocket) above
  // the pack: at 1024x629 the binder and the tray just fit together.
  const shownView = useRef(viewId);
  const deskRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (shownView.current === viewId) return;
    shownView.current = viewId;
    h1Ref.current?.focus({ preventScroll: true });
    if (wide) deskRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [viewId, wide]);

  // PageUp / PageDown turn pages while a binder is open.
  const isOpen = view !== null;
  useEffect(() => {
    if (!isOpen || detail || newBinder) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const delta = e.key === "PageDown" ? 1 : e.key === "PageUp" ? -1 : 0;
      if (!delta) return;
      e.preventDefault();
      setStepState({ view: viewId, at: Math.max(0, Math.min(at + delta, steps - 1)) });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, detail, newBinder, viewId, at, steps]);

  // -- adding ---------------------------------------------------------------
  const undoAdd = (copy: Copy) => () => {
    store.removeCopy(copy.id);
    say({ text: `Took ${shortName(getCard(copy.cardId))} back out.` });
  };

  const jumpTo = (slot: SlotRef) => {
    if (view?.kind === "binder" && view.binderId === slot.binderId && mode === "pockets") {
      turn(stepOfPage(slot.page, wide));
    }
  };

  const placeIn = (card: Card, slot: SlotRef) => {
    const target = store.getBinder(slot.binderId);
    if (slotCopyId(target, slot)) {
      say({ text: `That pocket's full. Pick an empty one for ${shortName(card)}.` });
      return;
    }
    const copy = store.addCopy(card.id);
    store.placeInSlot(slot.binderId, slot.page, slot.slot, copy.id);
    setAimed(null);
    jumpTo(slot);
    say({
      text: `Slid ${shortName(card)} into ${target?.name ?? "the binder"}, page ${slot.page + 1}, pocket ${slot.slot + 1}.`,
      undo: undoAdd(copy),
    });
  };

  const justAdd = (card: Card) => {
    const copy = store.addCopy(card.id);
    let text = `Got it! ${shortName(card)} is in your pile.`;
    if (binder?.kind === "smart") {
      text = fitsBinder(binder, card)
        ? `Got it! ${shortName(card)} is in your pile, and in ${binder.name}.`
        : `Got it! ${shortName(card)} is in your pile. It doesn't fit ${binder.name}, so look for it in All my cards.`;
    }
    say({ text, undo: undoAdd(copy) });
  };

  const fileIn = (card: Card, target: Binder) => {
    if (target.kind !== "manual") return justAdd(card);
    if (target.layout) return placeIn(card, pocketFor(target, card, copies));
    const copy = store.addCopy(card.id, { binderIds: [target.id] });
    say({ text: `Filed ${shortName(card)} in ${target.name}.`, undo: undoAdd(copy) });
  };

  const onSlot = (card: Card, targetId: string) => {
    if (targetId === AIMED_TARGET && aimed) return placeIn(card, aimed);
    const target = targetId === JUST_ADD ? undefined : store.getBinder(targetId);
    if (target) fileIn(card, target);
    else justAdd(card);
  };

  const targets: SlotTarget[] = useMemo(() => {
    const manual = binders.filter((b) => b.kind === "manual");
    const current = binder?.kind === "manual" ? [binder] : [];
    const rest = manual.filter((b) => b.id !== binder?.id);
    return [
      ...current.map((b) => ({ id: b.id, label: `This binder` })),
      ...rest.map((b) => ({ id: b.id, label: b.name })),
      { id: JUST_ADD, label: binder?.kind === "smart" ? "Just add it (it files itself)" : "Just add it, no binder" },
    ];
  }, [binders, binder]);

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
  const describeOver = (id: UniqueIdentifier): string => {
    if (id === SPREAD_DROP_ID) return "the open binder";
    const slot = parseSlotId(id);
    if (!slot) return "nowhere";
    const full = slotCopyId(store.getBinder(slot.binderId), slot) ? ", which is full" : "";
    return `page ${slot.page + 1}, pocket ${slot.slot + 1}${full}`;
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      const c = cardOf(active.id);
      return c
        ? `Picked up ${shortName(c)}. Arrow keys hop between pockets, Space drops it in, Escape puts it back.`
        : undefined;
    },
    onDragOver: ({ active, over }) => {
      const c = cardOf(active.id);
      return c ? (over ? `${shortName(c)} is over ${describeOver(over.id)}.` : `${shortName(c)} is not over a pocket.`) : undefined;
    },
    onDragEnd: ({ active, over }) => {
      const c = cardOf(active.id);
      return c ? (over ? `Dropped ${shortName(c)} on ${describeOver(over.id)}.` : `${shortName(c)} went back in the pack.`) : undefined;
    },
    onDragCancel: ({ active }) => {
      const c = cardOf(active.id);
      return c ? `${shortName(c)} went back in the pack.` : undefined;
    },
  };

  const onDragStart = (e: DragStartEvent) => setDragging(cardOf(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const card = cardOf(e.active.id);
    if (!card) return;
    if (!e.over) {
      say({ text: `Missed! Drop ${shortName(card)} on an empty pocket, or press Slot in.` });
      return;
    }
    const slot = parseSlotId(e.over.id);
    if (slot) return placeIn(card, slot);
    if (e.over.id === SPREAD_DROP_ID) {
      if (binder?.kind === "manual") return fileIn(card, binder);
      return justAdd(card);
    }
  };

  // -- the rest --------------------------------------------------------------
  const hits = useMemo(() => (query.trim() ? searchCards(query, { limit: 24 }) : []), [query]);

  const aim = (slot: SlotRef) => {
    setAimed(slot);
    searchRef.current?.focus();
  };
  const aimedBinder = aimed ? store.getBinder(aimed.binderId) : undefined;
  const aimedAt = aimed ? `${aimedBinder?.name ?? "the binder"}, page ${aimed.page + 1}, pocket ${aimed.slot + 1}` : null;

  const createBinder = (input: NewBinder) => {
    const b = store.createBinder(input);
    setNewBinder(false);
    open({ kind: "binder", binderId: b.id });
    say({ text: `${b.name} is on the shelf. Rip a pack and start slotting.` });
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
  const wholeBinderDrop = !(binder?.kind === "manual" && mode === "pockets");
  const vinyl = view?.kind === "set" ? "#1e293b" : binderLivery(binder ?? "all").primary;

  const title =
    view?.kind === "binder"
      ? (binder?.name ?? "Binder")
      : view?.kind === "set"
        ? setLabel(getSet(view.setId))
        : "All my cards";

  return (
    <div className="pb-40">
      <PrototypeBanner current={2} />
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
              "Press Space or Enter to pick up this card. Arrow keys hop between pockets, Space drops it in, Escape puts it back. Or use its Slot in button.",
          },
        }}
      >
        {!view ? (
          <Shelf store={store} h1Ref={h1Ref} onOpen={open} onNewBinder={() => setNewBinder(true)} />
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
                <h1 ref={h1Ref} tabIndex={-1} className="truncate text-2xl font-bold text-white focus:outline-none sm:text-3xl">
                  {title}
                </h1>
                {binder?.kind === "smart" && (
                  <span className="rounded bg-neon-purple px-1.5 text-xs font-bold leading-5 text-black">Smart</span>
                )}
                {view.kind === "set" && (
                  <span className="rounded border border-neon-blue px-1.5 text-xs font-bold leading-5 text-neon-blue">Browsing</span>
                )}
              </div>
              <p aria-live="polite" className="text-sm tabular-nums text-slate-300">
                {whereLabel(pages.length, wide, at)}
              </p>
              <div className="ml-auto">
                {binder && <ModeToggle mode={mode} onChange={setMode} />}
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

            {!wide && <MobileSummary view={view} binder={binder} store={store} mode={mode} />}

            <div ref={deskRef} className="scroll-mt-2">
            <BinderDesk
              pages={pages}
              wide={wide}
              at={at}
              onTurn={turn}
              vinyl={vinyl}
              cover={<Cover view={view} binder={binder} store={store} mode={mode} />}
              variant={pocketVariant}
              aimed={aimed}
              wholeBinderDrop={wholeBinderDrop}
              reducedMotion={reducedMotion}
              name={title}
              onOpen={(card) => setDetail(card.id)}
              onAdd={(card, slot) => (slot ? placeIn(card, slot) : justAdd(card))}
              onAim={aim}
            />
            </div>
          </div>
        )}

        <PackTray
          query={query}
          onQuery={setQuery}
          hits={hits}
          ownedCount={store.ownedCount}
          targets={targets}
          onSlot={onSlot}
          aimedAt={aimedAt}
          onCancelAim={() => setAimed(null)}
          status={status}
          onDismissStatus={() => setStatus(null)}
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

      {detail && (
        <CardDetail
          card={getCard(detail)}
          store={store}
          onClose={() => setDetail(null)}
          onStatus={say}
          reducedMotion={reducedMotion}
          fallbackFocus={() => h1Ref.current}
        />
      )}
      {newBinder && <NewBinderDialog onCreate={createBinder} onClose={() => setNewBinder(false)} />}
    </div>
  );
}

function ModeToggle({ mode, onChange }: { mode: LayoutMode; onChange: (m: LayoutMode) => void }) {
  const btn = (m: LayoutMode, label: string) => (
    <button
      type="button"
      aria-pressed={mode === m}
      onClick={() => onChange(m)}
      className={`min-h-10 rounded-md px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] ${
        mode === m ? "bg-neon-blue text-black" : "text-slate-200 hover:text-white"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="How to show this binder" className="flex rounded-lg border border-slate-600 bg-slate-900 p-0.5">
      {btn("pockets", "Lay out like my real binder")}
      {btn("stack", "Just a stack")}
    </div>
  );
}

function PileTools({
  sort,
  onSort,
  filters,
  onFilters,
}: {
  sort: SortKey;
  onSort: (s: SortKey) => void;
  filters: PileFilters;
  onFilters: (f: PileFilters) => void;
}) {
  const toggle = (key: keyof PileFilters, label: string) => (
    <button
      type="button"
      aria-pressed={filters[key]}
      onClick={() => onFilters({ ...filters, [key]: !filters[key] })}
      className={`min-h-10 rounded-md border px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] ${
        filters[key] ? "border-neon-blue bg-neon-blue text-black" : "border-slate-600 text-slate-200 hover:text-white"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 text-sm text-slate-300">
        Sort
        <select
          value={sort}
          onChange={(e) => onSort(e.target.value as SortKey)}
          className="min-h-10 rounded-md border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
        >
          <option value="checklist">Checklist order</option>
          <option value="newest">Newest first</option>
          <option value="player">Player, A to Z</option>
        </select>
      </label>
      <div role="group" aria-label="Only show" className="flex flex-wrap gap-2">
        {toggle("graded", "Graded")}
        {toggle("forSale", "For sale")}
        {toggle("rookies", "Rookies")}
      </div>
    </div>
  );
}

type Store = ReturnType<typeof usePrototypeStore>;

function summaryFor(view: ViewKey, binder: Binder | undefined, store: Store) {
  const { copies } = store.state;
  if (view.kind === "set") {
    const c = store.completion(view.setId);
    return { have: c.owned, need: c.total - c.owned, cards: null as number | null };
  }
  if (view.kind === "all") {
    return { have: null, need: null, cards: copies.reduce((n, c) => n + c.quantity, 0) };
  }
  if (!binder) return { have: null, need: null, cards: 0 };
  const count = binderCount(binder, copies);
  return { have: count.have ?? null, need: count.need ?? null, cards: count.cards };
}

function Tally({ have, need, cards }: { have: number | null; need: number | null; cards: number | null }) {
  if (have !== null && need !== null) {
    const total = have + need;
    return (
      <div>
        <p className="text-lg font-bold text-white tabular-nums">
          {have} have, {need} need
        </p>
        <div aria-hidden="true" className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-800">
          <div className="h-full rounded-full bg-neon-green" style={{ width: `${total ? (have / total) * 100 : 0}%` }} />
        </div>
      </div>
    );
  }
  return (
    <p className="text-lg font-bold text-white tabular-nums">
      {cards} {cards === 1 ? "card" : "cards"}
    </p>
  );
}

function blurb(view: ViewKey, binder: Binder | undefined, mode: LayoutMode): string[] {
  if (view.kind === "set") {
    return [
      "Every card in the set, in checklist order. Each insert starts a fresh page.",
      "Got one? Hit Add on its sleeve.",
    ];
  }
  if (view.kind === "all") {
    return [
      "Every card you own, one pocket per copy. A yellow tag means it's for sale.",
      "Press a card to slide it out and fill in the details.",
    ];
  }
  if (!binder) return [];
  const lines: string[] = [];
  if (binder.description) lines.push(binder.description);
  if (binder.kind === "smart") {
    lines.push(`Fills itself: ${describeRule(binder.rule)}.`);
    if (mode === "pockets") lines.push("Empty sleeves are your needs. Got one? Press it.");
  } else if (mode === "pockets") {
    lines.push("Drag a card from the pack into any pocket, or press an empty pocket to fill that one.");
  } else {
    lines.push("Drag a card from the pack onto the binder to file it here.");
  }
  return lines;
}

function Cover({ view, binder, store, mode }: { view: ViewKey; binder: Binder | undefined; store: Store; mode: LayoutMode }) {
  const t = summaryFor(view, binder, store);
  const name = view.kind === "binder" ? binder?.name : view.kind === "set" ? setLabel(getSet(view.setId)) : "All my cards";
  return (
    <div className="flex h-full flex-col gap-3 text-sm text-slate-300">
      <p
        aria-hidden="true"
        className="neon-header !text-[26px] leading-tight text-white"
        style={{ textShadow: "0 0 14px rgba(0,194,255,0.6)" } as CSSProperties}
      >
        {name}
      </p>
      <Tally {...t} />
      {blurb(view, binder, mode).map((line) => (
        <p key={line}>{line}</p>
      ))}
      <p className="mt-auto text-xs text-slate-400">PageUp and PageDown turn the pages.</p>
    </div>
  );
}

function MobileSummary({
  view,
  binder,
  store,
  mode,
}: {
  view: ViewKey;
  binder: Binder | undefined;
  store: Store;
  mode: LayoutMode;
}) {
  const t = summaryFor(view, binder, store);
  return (
    <div className="mb-3 space-y-1 text-sm text-slate-300">
      <Tally {...t} />
      <p>{blurb(view, binder, mode)[0]}</p>
    </div>
  );
}

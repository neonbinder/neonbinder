import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useDraggable } from "@dnd-kit/core";
import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { Input } from "@/components/primitives/Input";
import NeonButton from "@/components/modules/NeonButton";
import CardFace from "../../prototypes/_shared/CardFace";
import type { Notice } from "../../prototypes/p1/notice";
import { cardCaption, cardNumberLine } from "../captions";
import { cardLabel } from "../data/labels";
import { isForSale } from "../data/store";
import type { Card, CardId, Container, ContainerId, Copy } from "../data/types";
import { lineNames } from "../lineItems";
import { cardDragId } from "./dnd";
import IdTooltip, { IdLines } from "./IdTooltip";
import {
  movableCopies,
  placesOf,
  placeWords,
  resolveTyped,
  shortName,
  tradeableCopies,
  type Place,
} from "./model";

/**
 * The hunt tray (p2's PackTray, reworked for the consolidated page): a tray
 * pinned to the bottom of the screen where the collector hunts for one of
 * their cards. Type it the way you'd say it ("96 contenders white").
 *
 * Results come in two groups:
 *
 * - **In your binders**: cards you own, each with every place it lives
 *   ("'96 Contenders, page 2, pocket 4", "Show box, row 2", "Main ×2").
 *   Press a place to go there: the binder or box opens with the pocket
 *   ringed, or, for a copy in no pocket, the card drawer opens on it. With a
 *   binder or box open, "Move here" moves a copy into it (asking which, when
 *   there are several) and "Add another" adds a new one.
 * - **Not in your binders yet**: the catalog, so a card you don't own can
 *   still be slotted in (or wanted).
 *
 * Dragging a card onto a pocket or a box row does what its button does: an
 * owned card moves, a new one is added. Every drag has a button that does
 * the same job.
 *
 * Its status line is the page's shared one (with its Undo).
 *
 * Search never auto-picks: a card number is not unique, so every match
 * shows. Enter acts only when exactly one card fits; two or more and it asks
 * the collector to pick.
 *
 * Modes, by what is open: `file` (anything you can file into), `want` (the
 * Want List: the tray adds wants, never a copy), `trade` (Up for Trade: the
 * tray flags one of your copies, which stays where it lives).
 *
 * `copiesByCard` is what the page lets the tray see. In `trade` mode that is
 * box copies too (trade spans collection and inventory, NEO-359), so the
 * owned group reads "In your binders and boxes" when there are boxes, a box
 * place says "In Show box, for sale", and the which-copy chooser names a box
 * copy ", for sale".
 */

export interface SlotTarget {
  id: ContainerId;
  label: string;
}

/** The open binder or box a copy can move into. */
export interface MoveTarget {
  id: ContainerId;
  name: string;
}

export type TrayMode = "file" | "want" | "trade";

/** An owned card waiting on "which copy?": to move into the open home, or to put up for trade. */
export interface Choosing {
  card: Card;
  verb: "move" | "trade";
}

interface PackTrayProps {
  mode: TrayMode;
  query: string;
  onQuery: (q: string) => void;
  /** Every match, best first (the tray shows the first few); undefined while searching. */
  hits: readonly Card[] | undefined;
  /** True when the store stopped at its cap. */
  truncated: boolean;
  /** The collector's copies of each hit, by card id; undefined while they load. */
  copiesByCard: Readonly<Record<CardId, Copy[]>> | undefined;
  containers: readonly Container[];
  isWanted: (cardId: CardId) => boolean;
  /** Where Slot in can file a new copy (the open home first). */
  targets: SlotTarget[];
  /** The home "Move here" moves into, or null when none is open. */
  moveTo: MoveTarget | null;
  /** Which of a card's copies this screen may move (default: any). My Binders leaves a box's alone. */
  canMoveCopy?: (copy: Copy) => boolean;
  /** An owned card waiting on "which copy?", or null. */
  choosing: Choosing | null;
  onChoose: (choosing: Choosing) => void;
  onCancelChoose: () => void;
  /** Add a new copy (`targetId`: a home, or `AIMED_TARGET`). */
  onSlot: (card: Card, targetId: string) => void;
  /** Move that copy into `moveTo` (into the aimed pocket, if one is aimed). */
  onMove: (card: Card, copy: Copy) => void;
  /** Put that copy up for trade. */
  onTrade: (card: Card, copy: Copy) => void;
  onWant: (card: Card) => void;
  /** Go to where a copy lives. */
  onFind: (card: Card, place: Place) => void;
  /** Words for the pocket the collector clicked, or null. */
  aimedAt: string | null;
  onCancelAim: () => void;
  notice: Notice | null;
  onUndo: () => void;
  onDismissNotice: () => void;
  /** Say something on the shared status line (no Undo). */
  onSay: (text: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  draggingId: string | null;
}

export const AIMED_TARGET = "aimed";

const anyCopy = () => true;

/** Cards shown in each group at once; the line above still says how many fit. */
export const TRAY_LIMIT = 24;
/** Places listed under an owned card before "and N more". */
const PLACE_LIMIT = 3;

const FOCUS = "focus-outline";
const CHOICE = `min-h-9 rounded-md border border-control bg-sheet px-3 text-sm text-ink hover:border-neon-green hover:text-ink max-sm:min-h-11 ${FOCUS}`;

export default function PackTray(props: PackTrayProps) {
  const {
    mode,
    query,
    onQuery,
    hits,
    truncated,
    copiesByCard,
    containers,
    targets,
    moveTo,
    choosing,
    onChoose,
    onCancelChoose,
    onSlot,
    onMove,
    onTrade,
    onWant,
    onFind,
    aimedAt,
    onCancelAim,
    notice,
    onUndo,
    onDismissNotice,
    onSay,
    inputRef,
  } = props;
  const canMoveCopy = props.canMoveCopy ?? anyCopy;
  const movable = (copies: readonly Copy[], to: ContainerId) => movableCopies(copies, to).filter(canMoveCopy);
  const [slotting, setSlotting] = useState<Card | null>(null);
  const actButtons = useRef(new Map<string, HTMLButtonElement>());
  const chooserRef = useRef<HTMLDivElement>(null);
  const ownedHeadingId = useId();
  const catalogHeadingId = useId();
  const trayRef = useRef<HTMLElement>(null);

  // The tray is pinned over the bottom of the page: publish its height, so a
  // focused pocket, box card or row picker scrolls clear of it
  // (`scroll-margin-bottom` in binders.css / box.css) and the page ends above it.
  useEffect(() => {
    const el = trayRef.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty("--nb-tray-h", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    publish();
    if (typeof ResizeObserver === "undefined") return () => root.style.removeProperty("--nb-tray-h");
    const watch = new ResizeObserver(publish);
    watch.observe(el);
    return () => {
      watch.disconnect();
      root.style.removeProperty("--nb-tray-h");
    };
  }, []);

  useEffect(() => {
    if (slotting || choosing) chooserRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [slotting, choosing]);

  const closeChooser = (refocus: boolean) => {
    const card = slotting ?? choosing?.card;
    setSlotting(null);
    if (choosing) onCancelChoose();
    if (refocus && card) actButtons.current.get(card.id)?.focus();
  };

  const onChooserKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeChooser(true);
    }
  };

  const wantMode = mode === "want";
  const tradeMode = mode === "trade";
  const mineOf = (cardId: CardId) => (copiesByCard?.[cardId] ?? []).filter((c) => c.quantity > 0);
  const owned = (cardId: CardId) => mineOf(cardId).length > 0;
  // On the trade pile the tray sees box copies too: say so wherever it names where yours are.
  const withBoxes = tradeMode && containers.some((c) => c.kind === "box" && !c.rule);
  const yours = withBoxes ? "your binders and boxes" : "your binders";

  /** Add a new copy (or, on the Want List, want it). */
  const add = (card: Card) => {
    if (wantMode) return onWant(card);
    if (aimedAt) return onSlot(card, AIMED_TARGET);
    if (choosing) onCancelChoose();
    if (targets.length === 1) return onSlot(card, targets[0].id);
    setSlotting(card);
  };

  /** Move (or flag) one of the card's copies: straight away with one to pick from, else ask which. */
  const choose = (card: Card, verb: Choosing["verb"]) => {
    setSlotting(null);
    const list = verb === "move" ? (moveTo ? movable(mineOf(card.id), moveTo.id) : []) : tradeableCopies(mineOf(card.id));
    if (list.length === 0) return;
    if (list.length === 1) {
      if (verb === "move") onMove(card, list[0]);
      else onTrade(card, list[0]);
      return;
    }
    onChoose({ card, verb });
  };

  const list = hits ?? [];
  const onEnter = () => {
    const typed = resolveTyped(list, truncated);
    if (typed.kind === "one") {
      const card = typed.card;
      if (tradeMode) {
        if (owned(card.id)) return choose(card, "trade");
        onSay(`${shortName(card)} isn't in ${withBoxes ? "your binders or boxes" : "your binders"}, so it can't go up for trade yet.`);
        return;
      }
      if (wantMode || !owned(card.id)) return add(card);
      const places = placesOf(mineOf(card.id), containers);
      if (places.length === 1) return onFind(card, places[0]);
      onSay(`${shortName(card)} lives in ${places.length} places. Pick the one you're after.`);
      return;
    }
    if (typed.kind === "many") {
      onSay(`${typed.count}${truncated ? "+" : ""} cards fit "${query.trim()}". Pick yours, we won't guess.`);
      return;
    }
    if (query.trim() && hits) onSay(`Nothing fits "${query.trim()}". Try a year, a set and a last name.`);
  };

  const trimmed = query.trim();
  const mine = list.filter((c) => owned(c.id));
  const others = list.filter((c) => !owned(c.id));
  const verb = wantMode ? "Want it" : aimedAt ? "Put here" : "Slot in";
  const registerAct = (card: Card) => (el: HTMLButtonElement | null) => {
    if (el) actButtons.current.set(card.id, el);
    else actButtons.current.delete(card.id);
  };

  let summary = "";
  if (trimmed) {
    const more = truncated ? ` Showing the first ${list.length}: add a word to narrow it.` : "";
    if (!hits || (copiesByCard === undefined && list.length > 0)) summary = "Hunting…";
    else if (list.length === 0) summary = `Nothing matches "${trimmed}". Try a year, a set and a last name.`;
    else if (wantMode)
      summary = `${list.length} ${list.length === 1 ? "card matches" : "cards match"}. Press Want it to put one on your Want List.${more}`;
    else if (tradeMode)
      summary =
        mine.length === 0
          ? `None of these are yours yet. Only cards you own can go up for trade.${more}`
          : `${mine.length} in ${yours}. Press Up for trade on the one you'd swap.${more}`;
    else if (mine.length === 0)
      summary = `None in your binders yet. ${others.length} in the catalog: drag one into a pocket, or press Slot in.${more}`;
    else
      summary = `${mine.length} in your binders${
        others.length ? `, ${others.length} more in the catalog` : ""
      }. Press where one lives to go straight to it.${more}`;
  }

  const choosingCopies = choosing
    ? choosing.verb === "move"
      ? moveTo
        ? movable(mineOf(choosing.card.id), moveTo.id)
        : []
      : tradeableCopies(mineOf(choosing.card.id))
    : [];
  const choosingNames = lineNames(choosingCopies);
  // Flagging from the trade pile can pick a copy in a box: its choice says it is for sale.
  const choosingForSale = choosingCopies.map((c) => choosing?.verb === "trade" && isForSale(c));
  const choosingLabel = choosing
    ? choosing.verb === "move"
      ? `Which ${shortName(choosing.card)} moves to ${moveTo?.name ?? "here"}?`
      : `Which ${shortName(choosing.card)} goes up for trade?`
    : "";

  return (
    <section ref={trayRef} aria-label="Card hunt" className="pointer-events-none fixed inset-x-0 bottom-0 z-30 lg:right-[170px]">
      <div className="pointer-events-auto mx-auto max-w-6xl px-2 sm:px-6">
        <div className="p2-pack px-3 pb-[max(env(safe-area-inset-bottom),10px)] pt-3 sm:px-4">
          {/* data-notice-hold: the page holds the line's timer while it is pointed at or focused. */}
          <div className={notice ? "mb-2 flex flex-wrap items-center gap-2" : ""} data-notice-hold="">
            <p role="status" className="min-w-0 flex-1 basis-56 text-sm text-ink">
              {notice?.message ?? ""}
            </p>
            {notice?.undo && (
              <NeonButton type="button" variant="secondary" onClick={onUndo} className="max-sm:min-h-11">
                Undo
              </NeonButton>
            )}
            {notice && (
              <button
                type="button"
                onClick={onDismissNotice}
                aria-label="Dismiss message"
                className={`inline-flex min-h-8 min-w-8 items-center justify-center rounded-md text-ink-2 hover:text-ink max-sm:min-h-11 max-sm:min-w-11 ${FOCUS}`}
              >
                <XMarkIcon aria-hidden="true" className="h-4 w-4" />
              </button>
            )}
          </div>

          {aimedAt && !slotting && !choosing && mode === "file" && (
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-neon-blue/60 bg-neon-blue/10 px-3 py-1.5">
              <p className="min-w-0 flex-1 basis-56 text-sm text-ink">
                Filling {aimedAt}. Hunt for a card, then press Move here or Put here.
              </p>
              <NeonButton type="button" variant="secondary" outline onClick={onCancelAim} className="max-sm:min-h-11">
                Stop filling
              </NeonButton>
            </div>
          )}

          {slotting && (
            <div
              ref={chooserRef}
              role="group"
              aria-label={`Where should ${shortName(slotting)} go?`}
              onKeyDown={onChooserKey}
              className="mb-2 rounded-lg border border-control bg-field p-2"
            >
              <p className="mb-2 px-1 text-sm text-ink-2">
                Slot <strong className="text-ink">{shortName(slotting)}</strong> into:
              </p>
              <div className="flex flex-wrap gap-2">
                {targets.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      onSlot(slotting, t.id);
                      setSlotting(null);
                      inputRef.current?.focus();
                    }}
                    className={CHOICE}
                  >
                    {t.label}
                  </button>
                ))}
                <NeverMind onClick={() => closeChooser(true)} />
              </div>
            </div>
          )}

          {choosing && choosingCopies.length > 0 && (
            <div
              ref={chooserRef}
              role="group"
              aria-label={choosingLabel}
              onKeyDown={onChooserKey}
              className="mb-2 rounded-lg border border-control bg-field p-2"
            >
              <p className="mb-2 px-1 text-sm text-ink-2">{choosingLabel}</p>
              <div className="flex flex-wrap gap-2">
                {choosingCopies.map((copy, i) => (
                  <button
                    key={copy.id}
                    type="button"
                    aria-label={
                      choosing.verb === "move"
                        ? `Move ${choosingNames[i]} to ${moveTo?.name ?? "here"}`
                        : choosingForSale[i]
                          ? `Put ${choosingNames[i]}, the one for sale, up for trade`
                          : `Put ${choosingNames[i]} up for trade`
                    }
                    onClick={() => {
                      if (choosing.verb === "move") onMove(choosing.card, copy);
                      else onTrade(choosing.card, copy);
                      inputRef.current?.focus();
                    }}
                    className={CHOICE}
                  >
                    {choosingNames[i]}
                    {choosingForSale[i] && ", for sale"}
                  </button>
                ))}
                <NeverMind onClick={() => closeChooser(true)} />
              </div>
            </div>
          )}

          {/* The hunt's own polite line, apart from the notice: always mounted so each new summary is read. */}
          <p role="status" className={trimmed ? "mb-1 text-xs text-ink-2" : "sr-only"}>
            {summary}
          </p>
          {trimmed && (
            <div className="nb-hunt-results mb-2">
              {mine.length > 0 && (
                <>
                  <h3 id={ownedHeadingId} className="mt-1 text-sm font-bold text-ink">
                    {withBoxes ? "In your binders and boxes" : "In your binders"}
                  </h3>
                  <ul className="nb-owned-results" aria-labelledby={ownedHeadingId}>
                    {mine.slice(0, TRAY_LIMIT).map((card) => {
                      const copies = mineOf(card.id);
                      return (
                        <OwnedCard
                          key={card.id}
                          card={card}
                          places={placesOf(copies, containers)}
                          quantity={copies.reduce((n, c) => n + c.quantity, 0)}
                          mode={mode}
                          wanted={wantMode && props.isWanted(card.id)}
                          moveTo={mode === "file" ? moveTo : null}
                          canMove={!!moveTo && movable(copies, moveTo.id).length > 0}
                          canTrade={tradeableCopies(copies).length > 0}
                          lifted={props.draggingId === card.id}
                          onFind={(place) => onFind(card, place)}
                          onMove={() => choose(card, "move")}
                          onTrade={() => choose(card, "trade")}
                          onAdd={() => add(card)}
                          buttonRef={registerAct(card)}
                        />
                      );
                    })}
                  </ul>
                </>
              )}
              {others.length > 0 && !tradeMode && (
                <>
                  <h3 id={catalogHeadingId} className="mt-2 text-sm font-bold text-ink">
                    Not in your binders yet
                  </h3>
                  <ul className="p2-results" aria-labelledby={catalogHeadingId}>
                    {others.slice(0, TRAY_LIMIT).map((card) => (
                      <TrayCard
                        key={card.id}
                        card={card}
                        wanted={wantMode && props.isWanted(card.id)}
                        verb={verb}
                        lifted={props.draggingId === card.id}
                        onAct={() => add(card)}
                        buttonRef={registerAct(card)}
                      />
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <MagnifyingGlassIcon aria-hidden="true" className="h-5 w-5 shrink-0 text-neon-blue-text" />
            <Input
              bare
              ref={inputRef}
              type="search"
              surface="dark"
              aria-label={
                wantMode ? "Hunt for a card you want" : tradeMode ? "Hunt for a card to trade" : "Hunt for one of your cards"
              }
              placeholder={
                wantMode
                  ? "Chasing one? Try 24 chrome ohtani"
                  : tradeMode
                    ? "Got a dupe? Try 96 contenders favre"
                    : "Hunt your cards: try 96 contenders white"
              }
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  onQuery("");
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  onEnter();
                }
              }}
              className="min-w-0 flex-1 px-3 py-2 text-base"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  onQuery("");
                  inputRef.current?.focus();
                }}
                className={`min-h-10 rounded-md px-2 text-sm text-ink-2 hover:text-ink max-sm:min-h-11 ${FOCUS}`}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function NeverMind({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-9 rounded-md px-3 text-sm text-ink-2 underline underline-offset-4 hover:text-ink max-sm:min-h-11 ${FOCUS}`}
    >
      Never mind
    </button>
  );
}

/**
 * The card face as a drag handle: drag it onto a pocket or a box row. Hover
 * or focus raises its identity slip; the handle keeps dnd-kit's drag
 * instructions as its description.
 */
function DragFace({ card, name, lifted, disabled }: { card: Card; name: string; lifted: boolean; disabled: boolean }) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners } = useDraggable({
    id: cardDragId(card.id),
    data: { card },
    disabled,
    attributes: { roleDescription: "card you can drag" },
  });
  const face = <CardFace model={card} size="sm" />;
  // Nothing to drag it onto (the trade pile): just the face, which names itself.
  if (disabled) return <div className="p2-handle cursor-default">{face}</div>;
  return (
    <IdTooltip content={<IdLines title={cardCaption(card)} lines={[cardNumberLine(card)]} />}>
      <div
        ref={(el) => {
          setNodeRef(el);
          setActivatorNodeRef(el);
        }}
        {...attributes}
        {...listeners}
        aria-label={name}
        className={`p2-handle${lifted ? " p2-handle--lifted" : ""}`}
      >
        {face}
      </div>
    </IdTooltip>
  );
}

const ACT = "min-h-7 max-sm:min-h-11";

/** An owned card: where every copy lives, and Move here / Add another (or Up for trade). */
function OwnedCard({
  card,
  places,
  quantity,
  mode,
  wanted,
  moveTo,
  canMove,
  canTrade,
  lifted,
  onFind,
  onMove,
  onTrade,
  onAdd,
  buttonRef,
}: {
  card: Card;
  places: Place[];
  quantity: number;
  mode: TrayMode;
  wanted: boolean;
  moveTo: MoveTarget | null;
  canMove: boolean;
  canTrade: boolean;
  lifted: boolean;
  onFind: (place: Place) => void;
  onMove: () => void;
  onTrade: () => void;
  onAdd: () => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  const label = cardLabel(card);
  const short = shortName(card);
  const shown = places.slice(0, PLACE_LIMIT);
  const more = places.length - shown.length;
  const moves = !!moveTo && canMove;
  return (
    <li className="nb-owned flex gap-2.5">
      <div className="w-[88px] flex-none">
        <DragFace
          card={card}
          name={`${label}, have ${quantity}${moves ? `. Drag to move it to ${moveTo.name}` : ""}`}
          lifted={lifted}
          disabled={mode === "trade"}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-xs font-bold leading-tight text-ink">{short}</p>
        <p aria-hidden="true" className="line-clamp-2 text-[11px] leading-tight text-ink-2">
          {cardCaption(card)}
        </p>
        <ul aria-label={`Where ${short} lives`} className="flex flex-col items-start gap-1">
          {shown.map((place) => {
            const where = placeWords(place);
            return (
              <li key={`${place.homeId}:${place.pocket?.page ?? "-"}:${place.pocket?.slot ?? "-"}:${place.row ?? "-"}`}>
                <button
                  type="button"
                  aria-label={`Find ${short} in ${where}${place.box ? ", for sale" : ""}`}
                  onClick={() => onFind(place)}
                  className={`rounded-sm text-left text-xs leading-snug text-neon-blue-text underline decoration-neon-blue/50 underline-offset-2 hover:text-ink max-sm:min-h-8 ${FOCUS}`}
                >
                  In {where}
                  {place.box && ", for sale"}
                </button>
              </li>
            );
          })}
          {more > 0 && <li className="text-xs text-ink-2">and {more} more</li>}
        </ul>
        <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
          {mode === "want" ? (
            <NeonButton
              ref={buttonRef}
              type="button"
              size="1"
              onClick={onAdd}
              disabled={wanted}
              aria-label={wanted ? `Wanted: ${label}, on your Want List` : `Want it: ${label}`}
              className={ACT}
            >
              {wanted ? "Wanted" : "Want it"}
            </NeonButton>
          ) : mode === "trade" ? (
            <NeonButton
              ref={buttonRef}
              type="button"
              variant="tertiary"
              size="1"
              onClick={onTrade}
              disabled={!canTrade}
              aria-label={canTrade ? `Put ${label} up for trade` : `On the pile: ${label} is up for trade`}
              className={ACT}
            >
              {canTrade ? "Up for trade" : "On the pile"}
            </NeonButton>
          ) : (
            <>
              {moves && (
                <NeonButton
                  ref={buttonRef}
                  type="button"
                  variant="secondary"
                  size="1"
                  onClick={onMove}
                  aria-label={`Move here: ${label}, to ${moveTo.name}`}
                  className={ACT}
                >
                  Move here
                </NeonButton>
              )}
              <NeonButton
                ref={moves ? undefined : buttonRef}
                type="button"
                outline
                size="1"
                onClick={onAdd}
                aria-label={`Add another ${label}`}
                className={ACT}
              >
                Add another
              </NeonButton>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

function TrayCard({
  card,
  wanted,
  verb,
  lifted,
  onAct,
  buttonRef,
}: {
  card: Card;
  wanted: boolean;
  verb: "Want it" | "Put here" | "Slot in";
  lifted: boolean;
  onAct: () => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  const label = cardLabel(card);
  const name = verb === "Want it" ? `Want it: ${label}` : verb === "Put here" ? `Put here: ${label}` : `Slot in ${label}`;
  return (
    <li className="flex w-[88px] flex-none flex-col items-center gap-1">
      <DragFace card={card} name={`${label}, need`} lifted={lifted} disabled={false} />
      <p aria-hidden="true" className="line-clamp-3 h-[3.75em] w-full text-center text-[11px] leading-tight text-ink-2">
        {cardCaption(card)}
      </p>
      <p className="text-center text-[11px] leading-tight text-ink-2">Need</p>
      <NeonButton
        ref={buttonRef}
        type="button"
        size="1"
        onClick={onAct}
        disabled={wanted}
        aria-label={wanted ? `Wanted: ${label}, on your Want List` : name}
        className="min-h-7 w-full max-sm:min-h-11"
      >
        {wanted ? "Wanted" : verb}
      </NeonButton>
    </li>
  );
}

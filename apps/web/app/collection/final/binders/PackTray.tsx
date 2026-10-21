import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useDraggable } from "@dnd-kit/core";
import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { Input } from "@/components/primitives/Input";
import CardFace from "../../prototypes/_shared/CardFace";
import { cardLabel, type BinderId, type Card, type Copy, type SearchHit } from "../../prototypes/_shared/data";
import type { Notice } from "../../prototypes/p1/notice";
import { shortName } from "../../prototypes/p2/model";
import { cardCaption } from "../captions";
import { lineNames } from "../lineItems";
import type { CollectionBinder } from "../store";
import { movableCopies, placesOf, placeWords, resolveTyped, type Place } from "./model";

/**
 * The hunt tray (p2's PackTray, reworked for the consolidated page): a tray
 * pinned to the bottom of the screen where the collector hunts for one of
 * their cards. Type it the way you'd say it ("96 contenders white").
 *
 * Results come in two groups:
 *
 * - **In your binders**: cards you own, each with every place it lives
 *   ("'96 Contenders, page 2, pocket 4", "Main ×2"). Press a place to go
 *   there: the binder opens at that page with the pocket ringed, or, for a
 *   binder without pages, the card drawer opens on that copy. With a binder
 *   open, "Move here" moves a copy into it (asking which, when there are
 *   several) and "Add another" adds a new one.
 * - **Not in your binders yet**: the catalog, so a card you don't own can
 *   still be slotted in (or wanted).
 *
 * Dragging a card onto a pocket does what its button does: an owned card
 * moves, a new one is added. The drag always has a button that does the
 * same job.
 *
 * Its status line is the page's shared one (with its Undo).
 *
 * Search never auto-picks: a card number is not unique, so every match
 * shows. Enter acts only when exactly one card fits every word; two or more
 * and it asks the collector to pick.
 *
 * While the Want List is open (`mode: "want"`) the tray adds wants, not
 * copies: nothing is ever filed in, or moved into, the Want List.
 */

export interface SlotTarget {
  id: string;
  label: string;
}

/** The open binder a copy can move into. */
export interface MoveTarget {
  id: BinderId;
  name: string;
}

interface PackTrayProps {
  mode: "file" | "want";
  query: string;
  onQuery: (q: string) => void;
  /** Every match, best first (the tray shows the first few). */
  hits: SearchHit[];
  copies: Copy[];
  binders: CollectionBinder[];
  isWanted: (cardId: string) => boolean;
  targets: SlotTarget[];
  /** The binder "Move here" moves into, or null when none is open. */
  moveTo: MoveTarget | null;
  /** An owned card waiting on "which copy moves?", or null. */
  moving: Card | null;
  /** "Move here": moves the one copy, or asks which (sets `moving`). */
  onAskMove: (card: Card) => void;
  onCancelMove: () => void;
  /** Add a new copy. */
  onSlot: (card: Card, targetId: string) => void;
  /** Move that copy into `moveTo` (into the aimed pocket, if one is aimed). */
  onMove: (card: Card, copyId: string) => void;
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

/** Cards shown in each group at once; the line above still says how many fit. */
const TRAY_LIMIT = 24;
/** Places listed under an owned card before "and N more". */
const PLACE_LIMIT = 3;

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]";

export default function PackTray(props: PackTrayProps) {
  const {
    mode,
    query,
    onQuery,
    hits,
    copies,
    binders,
    targets,
    moveTo,
    moving,
    onAskMove,
    onCancelMove,
    onSlot,
    onMove,
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
  const [choosing, setChoosing] = useState<Card | null>(null);
  const actButtons = useRef(new Map<string, HTMLButtonElement>());
  const chooserRef = useRef<HTMLDivElement>(null);
  const ownedHeadingId = useId();
  const catalogHeadingId = useId();

  useEffect(() => {
    if (choosing || moving) chooserRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [choosing, moving]);

  const closeChooser = (refocus: boolean) => {
    const card = choosing ?? moving;
    setChoosing(null);
    if (moving) onCancelMove();
    if (refocus && card) actButtons.current.get(card.id)?.focus();
  };

  const onChooserKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeChooser(true);
    }
  };

  const wantMode = mode === "want";
  const owned = (cardId: string) => copies.some((c) => c.cardId === cardId && c.quantity > 0);

  /** Add a new copy (or, on the Want List, want it). */
  const add = (card: Card) => {
    if (wantMode) return onWant(card);
    if (aimedAt) return onSlot(card, AIMED_TARGET);
    if (moving) onCancelMove();
    setChoosing(card);
  };

  /** Move one of the card's copies into the open binder. */
  const move = (card: Card) => {
    setChoosing(null);
    onAskMove(card);
  };

  const onEnter = () => {
    const typed = resolveTyped(hits);
    if (typed.kind === "one") {
      const card = typed.card;
      if (wantMode || !owned(card.id)) return add(card);
      const places = placesOf(card.id, copies, binders);
      if (places.length === 1) return onFind(card, places[0]);
      onSay(`${shortName(card)} lives in ${places.length} places. Pick the one you're after.`);
      return;
    }
    if (typed.kind === "many") {
      onSay(`${typed.count} cards fit "${query.trim()}". Pick yours, we won't guess.`);
      return;
    }
    if (query.trim()) onSay(`Nothing fits every word of "${query.trim()}". Pick from the closest calls.`);
  };

  const matchedAll = hits.length > 0 && hits[0].matchedAll;
  const trimmed = query.trim();
  const mine = hits.filter((h) => owned(h.card.id));
  const others = hits.filter((h) => !owned(h.card.id));
  const verb = wantMode ? "Want it" : aimedAt ? "Put here" : "Slot in";
  const registerAct = (card: Card) => (el: HTMLButtonElement | null) => {
    if (el) actButtons.current.set(card.id, el);
    else actButtons.current.delete(card.id);
  };

  let summary = "";
  if (trimmed) {
    if (hits.length === 0) summary = `Nothing matches "${trimmed}". Try a year, a set and a last name.`;
    else if (!matchedAll) summary = "Nothing matches every word. Closest calls:";
    else if (wantMode)
      summary = `${hits.length} ${hits.length === 1 ? "card matches" : "cards match"}. Press Want it to put one on your Want List.`;
    else if (mine.length === 0)
      summary = `None in your binders yet. ${others.length} in the catalog: drag one into a pocket, or press Slot in.`;
    else
      summary = `${mine.length} in your binders${
        others.length ? `, ${others.length} more in the catalog` : ""
      }. Press where one lives to go straight to it.`;
  }

  const movingCopies = moving && moveTo ? movableCopies(moving.id, copies, moveTo.id) : [];
  const movingNames = lineNames(movingCopies, binders);

  return (
    <section
      aria-label="Card hunt"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-30 lg:right-[170px]"
    >
      <div className="pointer-events-auto mx-auto max-w-6xl px-2 sm:px-6">
        <div className="p2-pack px-3 pb-[max(env(safe-area-inset-bottom),10px)] pt-3 sm:px-4">
          <div className={notice ? "mb-2 flex flex-wrap items-center gap-2" : ""}>
            <p role="status" className="min-w-0 flex-1 basis-56 text-sm text-slate-100">
              {notice?.message ?? ""}
            </p>
            {notice?.undo && (
              <button
                type="button"
                onClick={onUndo}
                className="min-h-8 rounded-md bg-neon-blue px-3 text-sm font-bold text-black hover:bg-[#4dd5ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white max-sm:min-h-11"
              >
                Undo
              </button>
            )}
            {notice && (
              <button
                type="button"
                onClick={onDismissNotice}
                aria-label="Dismiss message"
                className={`inline-flex min-h-8 min-w-8 items-center justify-center rounded-md text-slate-300 hover:text-white max-sm:min-h-11 max-sm:min-w-11 ${FOCUS}`}
              >
                <XMarkIcon aria-hidden="true" className="h-4 w-4" />
              </button>
            )}
          </div>

          {aimedAt && !choosing && !moving && !wantMode && (
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-neon-blue/60 bg-neon-blue/10 px-3 py-1.5">
              <p className="min-w-0 flex-1 basis-56 text-sm text-slate-100">
                Filling {aimedAt}. Hunt for a card, then press Move here or Put here.
              </p>
              <button
                type="button"
                onClick={onCancelAim}
                className={`min-h-8 rounded-md border border-slate-500 px-3 text-sm text-slate-100 hover:border-slate-300 max-sm:min-h-11 ${FOCUS}`}
              >
                Stop filling
              </button>
            </div>
          )}

          {choosing && (
            <div
              ref={chooserRef}
              role="group"
              aria-label={`Where should ${shortName(choosing)} go?`}
              onKeyDown={onChooserKey}
              className="mb-2 rounded-lg border border-slate-600 bg-slate-900 p-2"
            >
              <p className="mb-2 px-1 text-sm text-slate-200">
                Slot <strong className="text-white">{shortName(choosing)}</strong> into:
              </p>
              <div className="flex flex-wrap gap-2">
                {targets.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      onSlot(choosing, t.id);
                      setChoosing(null);
                      inputRef.current?.focus();
                    }}
                    className={`min-h-9 rounded-md border border-slate-600 bg-slate-950 px-3 text-sm text-slate-100 hover:border-neon-green hover:text-white max-sm:min-h-11 ${FOCUS}`}
                  >
                    {t.label}
                  </button>
                ))}
                <NeverMind onClick={() => closeChooser(true)} />
              </div>
            </div>
          )}

          {moving && moveTo && (
            <div
              ref={chooserRef}
              role="group"
              aria-label={`Which ${shortName(moving)} moves to ${moveTo.name}?`}
              onKeyDown={onChooserKey}
              className="mb-2 rounded-lg border border-slate-600 bg-slate-900 p-2"
            >
              <p className="mb-2 px-1 text-sm text-slate-200">
                Which <strong className="text-white">{shortName(moving)}</strong> moves to {moveTo.name}?
              </p>
              <div className="flex flex-wrap gap-2">
                {movingCopies.map((copy, i) => (
                  <button
                    key={copy.id}
                    type="button"
                    aria-label={`Move ${movingNames[i]} to ${moveTo.name}`}
                    onClick={() => {
                      onMove(moving, copy.id);
                      inputRef.current?.focus();
                    }}
                    className={`min-h-9 rounded-md border border-slate-600 bg-slate-950 px-3 text-sm text-slate-100 hover:border-neon-green hover:text-white max-sm:min-h-11 ${FOCUS}`}
                  >
                    {movingNames[i]}
                  </button>
                ))}
                <NeverMind onClick={() => closeChooser(true)} />
              </div>
            </div>
          )}

          {trimmed && (
            <div className="nb-hunt-results mb-2">
              <p className="mb-1 text-xs text-slate-300">{summary}</p>
              {mine.length > 0 && (
                <>
                  <h3 id={ownedHeadingId} className="mt-1 text-sm font-bold text-white">
                    In your binders
                  </h3>
                  <ul className="nb-owned-results" aria-labelledby={ownedHeadingId}>
                    {mine.slice(0, TRAY_LIMIT).map(({ card }) => (
                      <OwnedCard
                        key={card.id}
                        card={card}
                        places={placesOf(card.id, copies, binders)}
                        quantity={copies.filter((c) => c.cardId === card.id).reduce((n, c) => n + c.quantity, 0)}
                        wantMode={wantMode}
                        wanted={wantMode && props.isWanted(card.id)}
                        moveTo={wantMode ? null : moveTo}
                        canMove={!!moveTo && movableCopies(card.id, copies, moveTo.id).length > 0}
                        lifted={props.draggingId === card.id}
                        onFind={(place) => onFind(card, place)}
                        onMove={() => move(card)}
                        onAdd={() => add(card)}
                        buttonRef={registerAct(card)}
                      />
                    ))}
                  </ul>
                </>
              )}
              {others.length > 0 && (
                <>
                  <h3 id={catalogHeadingId} className="mt-2 text-sm font-bold text-white">
                    Not in your binders yet
                  </h3>
                  <ul className="p2-results" aria-labelledby={catalogHeadingId}>
                    {others.slice(0, TRAY_LIMIT).map(({ card }) => (
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
            <MagnifyingGlassIcon aria-hidden="true" className="h-5 w-5 shrink-0 text-neon-blue" />
            <Input
              bare
              ref={inputRef}
              type="search"
              surface="dark"
              aria-label={wantMode ? "Hunt for a card you want" : "Hunt for one of your cards"}
              placeholder={wantMode ? "Chasing one? Try 24 chrome ohtani" : "Hunt your cards: try 96 contenders white"}
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
                className={`min-h-10 rounded-md px-2 text-sm text-slate-300 hover:text-white max-sm:min-h-11 ${FOCUS}`}
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
      className={`min-h-9 rounded-md px-3 text-sm text-slate-300 underline underline-offset-4 hover:text-white max-sm:min-h-11 ${FOCUS}`}
    >
      Never mind
    </button>
  );
}

/** The card face as a drag handle: drag it onto a pocket. */
function DragFace({ card, name, lifted }: { card: Card; name: string; lifted: boolean }) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners } = useDraggable({
    id: `card:${card.id}`,
    data: { card },
    attributes: { roleDescription: "card you can drag" },
  });
  return (
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
      <CardFace card={card} size="sm" />
    </div>
  );
}

const ACT =
  "min-h-7 rounded-md px-2 text-xs font-bold max-sm:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950";

/** An owned card: where every copy lives, and Move here / Add another. */
function OwnedCard({
  card,
  places,
  quantity,
  wantMode,
  wanted,
  moveTo,
  canMove,
  lifted,
  onFind,
  onMove,
  onAdd,
  buttonRef,
}: {
  card: Card;
  places: Place[];
  quantity: number;
  wantMode: boolean;
  wanted: boolean;
  moveTo: MoveTarget | null;
  canMove: boolean;
  lifted: boolean;
  onFind: (place: Place) => void;
  onMove: () => void;
  onAdd: () => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  const label = cardLabel(card);
  const short = shortName(card);
  const shown = places.slice(0, PLACE_LIMIT);
  const more = places.length - shown.length;
  return (
    <li className="nb-owned flex gap-2.5">
      <div className="w-[88px] flex-none">
        <DragFace
          card={card}
          name={`${label}, have ${quantity}${moveTo && canMove ? `. Drag to move it to ${moveTo.name}` : ""}`}
          lifted={lifted}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-xs font-bold leading-tight text-white">{short}</p>
        <p aria-hidden="true" className="line-clamp-2 text-[11px] leading-tight text-slate-300">
          {cardCaption(card)}
        </p>
        <ul aria-label={`Where ${short} lives`} className="flex flex-col items-start gap-1">
          {shown.map((place) => {
            const where = placeWords(place);
            return (
              <li key={`${place.binderId}:${place.pocket?.page ?? "-"}:${place.pocket?.slot ?? "-"}`}>
                <button
                  type="button"
                  aria-label={`Find ${short} in ${where}`}
                  onClick={() => onFind(place)}
                  className={`rounded-sm text-left text-xs leading-snug text-neon-blue underline decoration-neon-blue/50 underline-offset-2 hover:text-white max-sm:min-h-8 ${FOCUS}`}
                >
                  In {where}
                </button>
              </li>
            );
          })}
          {more > 0 && <li className="text-xs text-slate-300">and {more} more</li>}
        </ul>
        <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
          {wantMode ? (
            <button
              ref={buttonRef}
              type="button"
              onClick={onAdd}
              disabled={wanted}
              aria-label={wanted ? `${label} is on your Want List` : `Want ${label}`}
              className={`${ACT} bg-neon-green text-black hover:bg-[#33e07c] disabled:cursor-default disabled:bg-slate-700 disabled:text-slate-200`}
            >
              {wanted ? "Wanted" : "Want it"}
            </button>
          ) : (
            <>
              {moveTo && canMove && (
                <button
                  ref={buttonRef}
                  type="button"
                  onClick={onMove}
                  aria-label={`Move here: ${label}, to ${moveTo.name}`}
                  className={`${ACT} bg-neon-blue text-black hover:bg-[#4dd5ff]`}
                >
                  Move here
                </button>
              )}
              <button
                ref={moveTo && canMove ? undefined : buttonRef}
                type="button"
                onClick={onAdd}
                aria-label={`Add another ${label}`}
                className={`${ACT} border border-neon-green text-neon-green hover:bg-neon-green hover:text-black`}
              >
                Add another
              </button>
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
  const name =
    verb === "Want it" ? `Want ${label}` : verb === "Put here" ? `Put here: ${label}` : `Slot in ${label}`;
  return (
    <li className="flex w-[88px] flex-none flex-col items-center gap-1">
      <DragFace card={card} name={`${label}, need`} lifted={lifted} />
      <p aria-hidden="true" title={cardCaption(card)} className="line-clamp-3 h-[3.75em] w-full text-center text-[11px] leading-tight text-slate-300">
        {cardCaption(card)}
      </p>
      <p className="text-center text-[11px] leading-tight text-slate-300">Need</p>
      <button
        ref={buttonRef}
        type="button"
        onClick={onAct}
        disabled={wanted}
        aria-label={wanted ? `${label} is on your Want List` : name}
        className="min-h-7 w-full rounded-md bg-neon-green px-1 text-xs font-bold text-black hover:bg-[#33e07c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 disabled:cursor-default disabled:bg-slate-700 disabled:text-slate-200 max-sm:min-h-11"
      >
        {wanted ? "Wanted" : verb}
      </button>
    </li>
  );
}

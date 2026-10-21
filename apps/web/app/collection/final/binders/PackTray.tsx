import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useDraggable } from "@dnd-kit/core";
import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { Input } from "@/components/primitives/Input";
import CardFace from "../../prototypes/_shared/CardFace";
import { cardLabel, type Card, type SearchHit } from "../../prototypes/_shared/data";
import type { Notice } from "../../prototypes/p1/notice";
import { shortName } from "../../prototypes/p2/model";
import { resolveTyped } from "./model";

/**
 * The pack (p2's PackTray, on the consolidated page): a tray pinned to the
 * bottom of the screen. Type a card the way you'd say it ("96 contenders
 * white") and every match lands in the tray. Drag one into a pocket, or press
 * "Slot in" and pick where it goes: the drag always has a button that does
 * the same job.
 *
 * Its status line is the page's shared one (with its Undo), so what the
 * drawer said and what the pack said read in one place.
 *
 * Search never auto-picks: a card number is not unique, so every match shows.
 * Enter acts only when exactly one card fits every word; two or more and it
 * asks the collector to pick.
 *
 * While the Want List is open (`mode: "want"`) the pack adds wants, not
 * copies: nothing is ever filed in the Want List.
 */

export interface SlotTarget {
  id: string;
  label: string;
}

interface PackTrayProps {
  mode: "file" | "want";
  query: string;
  onQuery: (q: string) => void;
  /** Every match, best first (the tray shows the first few). */
  hits: SearchHit[];
  ownedCount: (cardId: string) => number;
  isWanted: (cardId: string) => boolean;
  targets: SlotTarget[];
  onSlot: (card: Card, targetId: string) => void;
  onWant: (card: Card) => void;
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

/** Cards shown in the tray at once; the count above still says how many fit. */
const TRAY_LIMIT = 24;

export default function PackTray(props: PackTrayProps) {
  const {
    mode,
    query,
    onQuery,
    hits,
    targets,
    onSlot,
    onWant,
    aimedAt,
    onCancelAim,
    notice,
    onUndo,
    onDismissNotice,
    onSay,
    inputRef,
  } = props;
  const [choosing, setChoosing] = useState<Card | null>(null);
  const slotButtons = useRef(new Map<string, HTMLButtonElement>());
  const chooserRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (choosing) chooserRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [choosing]);

  const closeChooser = (refocus: boolean) => {
    const card = choosing;
    setChoosing(null);
    if (refocus && card) slotButtons.current.get(card.id)?.focus();
  };

  const onChooserKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeChooser(true);
    }
  };

  const wantMode = mode === "want";
  const act = (card: Card) => {
    if (wantMode) return onWant(card);
    if (aimedAt) return onSlot(card, AIMED_TARGET);
    setChoosing(card);
  };

  const onEnter = () => {
    const typed = resolveTyped(hits);
    if (typed.kind === "one") return act(typed.card);
    if (typed.kind === "many") {
      onSay(`${typed.count} cards fit "${query.trim()}". Pick yours, we won't guess.`);
      return;
    }
    if (query.trim()) onSay(`Nothing fits every word of "${query.trim()}". Pick from the closest calls.`);
  };

  const matchedAll = hits.length > 0 && hits[0].matchedAll;
  const trimmed = query.trim();
  const verb = wantMode ? "Want it" : aimedAt ? "Put here" : "Slot in";

  return (
    <section
      aria-label="Pack"
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
                className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-md text-slate-300 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] max-sm:min-h-11 max-sm:min-w-11"
              >
                <XMarkIcon aria-hidden="true" className="h-4 w-4" />
              </button>
            )}
          </div>

          {aimedAt && !choosing && !wantMode && (
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-neon-blue/60 bg-neon-blue/10 px-3 py-1.5">
              <p className="min-w-0 flex-1 basis-56 text-sm text-slate-100">
                Filling {aimedAt}. Search, then press Put here.
              </p>
              <button
                type="button"
                onClick={onCancelAim}
                className="min-h-8 rounded-md border border-slate-500 px-3 text-sm text-slate-100 hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] max-sm:min-h-11"
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
                    className="min-h-9 rounded-md border border-slate-600 bg-slate-950 px-3 text-sm text-slate-100 hover:border-neon-green hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] max-sm:min-h-11"
                  >
                    {t.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => closeChooser(true)}
                  className="min-h-9 rounded-md px-3 text-sm text-slate-300 underline underline-offset-4 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] max-sm:min-h-11"
                >
                  Never mind
                </button>
              </div>
            </div>
          )}

          {trimmed && (
            <div className="mb-2">
              <p className="mb-1 text-xs text-slate-300">
                {hits.length === 0
                  ? `Nothing matches "${trimmed}". Try a year, a set and a last name.`
                  : !matchedAll
                    ? "Nothing matches every word. Closest calls:"
                    : wantMode
                      ? `${hits.length} ${hits.length === 1 ? "card matches" : "cards match"}. Press Want it to put one on your Want List.`
                      : `${hits.length} ${hits.length === 1 ? "card matches" : "cards match"}. Drag one into a pocket, or press Slot in.`}
              </p>
              {hits.length > 0 && (
                <ul className="p2-results" aria-label="Cards in the pack">
                  {hits.slice(0, TRAY_LIMIT).map(({ card }) => (
                    <TrayCard
                      key={card.id}
                      card={card}
                      owned={props.ownedCount(card.id)}
                      wanted={wantMode && props.isWanted(card.id)}
                      verb={verb}
                      lifted={props.draggingId === card.id}
                      onAct={() => act(card)}
                      buttonRef={(el) => {
                        if (el) slotButtons.current.set(card.id, el);
                        else slotButtons.current.delete(card.id);
                      }}
                    />
                  ))}
                </ul>
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
              aria-label={
                wantMode
                  ? "Rip a pack: search for a card you want"
                  : "Rip a pack: search for a card to add"
              }
              placeholder={
                wantMode ? "Chasing one? Try 24 chrome ohtani" : "Rip a pack: try 96 contenders white"
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
                className="min-h-10 rounded-md px-2 text-sm text-slate-300 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] max-sm:min-h-11"
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

function TrayCard({
  card,
  owned,
  wanted,
  verb,
  lifted,
  onAct,
  buttonRef,
}: {
  card: Card;
  owned: number;
  wanted: boolean;
  verb: "Want it" | "Put here" | "Slot in";
  lifted: boolean;
  onAct: () => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners } = useDraggable({
    id: `card:${card.id}`,
    data: { card },
    attributes: { roleDescription: "card you can drag" },
  });
  const label = cardLabel(card);
  const name =
    verb === "Want it" ? `Want ${label}` : verb === "Put here" ? `Put here: ${label}` : `Slot in ${label}`;
  return (
    <li ref={setNodeRef} className="flex w-[88px] flex-none flex-col items-center gap-1">
      <div
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`${label}, ${owned ? `have ${owned}` : "need"}`}
        className={`p2-handle${lifted ? " p2-handle--lifted" : ""}`}
      >
        <CardFace card={card} size="sm" />
      </div>
      <p className="text-center text-[11px] leading-tight text-slate-300">
        {owned ? <span className="font-bold text-white">Have {owned}</span> : "Need"}
      </p>
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

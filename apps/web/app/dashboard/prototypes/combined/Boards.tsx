import { useRef, useState } from "react";
import { Link } from "react-router";
import CardFace from "@/app/collection/prototypes/_shared/CardFace";
import NeonButton from "@/components/modules/NeonButton";
import type { BuildingSet, CompletedSet, DashCard } from "../_shared/data";
import { checklistOf, type ShelfBinder } from "./shelf-model";
import "@/app/collection/final/cards/cards.css";

/**
 * NEO-464 combined dashboard, block 3 (from prototype 2) — the scoreboard
 * wall: one LED board per thing being completed, ranked by fewest cards
 * needed. Sets on the board (base set) and smart binders whose rule names a
 * checklist rank together (Jason, review item 4); a player or team binder has
 * no "need", so it never ranks. The top 5 show and the rest stay off (each
 * is still on the binder shelf or the collection wall).
 *
 * Compact tiles (round 2): the leader spans the width and the rest share rows
 * evenly, so no cell is ever empty (see `restSpan`). A set just finished is
 * cheered once at the top. Every needed card is named by its full listing
 * title, so a number never stands alone (review item 3).
 *
 * Only the sets on the board and the binders' own checklists are read:
 * nothing here loads every set's checklist.
 */

/** The brand's Neon face, as the scoreboard's percent uses it: rank numerals. */
const NEON_NUMERALS = "font-['Neon',_'Lexend',_sans-serif] leading-[0.9] tracking-[0.02em]";

/** Boards shown: the top 5. */
export const BOARD_CAP = 5;

/** One board: a set's base checklist, or a smart binder's checklist. */
export interface BoardItem {
  id: string;
  label: string;
  /** What the percent is of: "of the base set", "of the checklist". */
  scope: string;
  have: number;
  total: number;
  need: number;
  percent: number;
  /** The cards still needed, in checklist order. */
  needed: DashCard[];
  /** One bulb per card of the checklist, in order. `cardId` only where it is known for sure. */
  bulbs: { key: string; cardNumber: string; owned: boolean; cardId: string | null }[];
  /** The bulb strip's name: "Base", "Checklist". */
  bulbName: string;
  /** Where the board goes: the set's wall, or the binder on the shelf. */
  to: { setId: string } | { binderId: string };
}

function setItem(set: BuildingSet): BoardItem {
  // Needed base cards by number, kept only where the number names exactly one card.
  const byNumber = new Map<string, string | null>();
  for (const c of set.neededCards) byNumber.set(c.cardNumber, byNumber.has(c.cardNumber) ? null : c.id);
  return {
    id: `set-${set.setId}`,
    label: set.setLabel,
    scope: "of the base set",
    have: set.have,
    total: set.total,
    need: set.need,
    percent: set.percent,
    needed: set.neededCards,
    bulbs: set.baseBulbs.map((b, i) => ({
      key: `${b.cardNumber}-${i}`,
      cardNumber: b.cardNumber,
      owned: b.owned,
      cardId: b.owned ? null : (byNumber.get(b.cardNumber) ?? null),
    })),
    bulbName: "Base",
    to: { setId: set.setId },
  };
}

function binderItem(binder: ShelfBinder): BoardItem | null {
  const list = checklistOf(binder);
  if (!list || list.length === 0) return null;
  const have = list.filter((x) => x.filed).length;
  const total = list.length;
  return {
    id: `binder-${binder.id}`,
    label: binder.name,
    scope: "of the checklist",
    have,
    total,
    need: total - have,
    percent: Math.floor((have / total) * 100),
    needed: list.filter((x) => !x.filed).map((x) => x.card),
    bulbs: list.map((x) => ({ key: x.card.id, cardNumber: x.card.cardNumber, owned: x.filed, cardId: x.card.id })),
    bulbName: "Checklist",
    to: { binderId: binder.id },
  };
}

/** Sets and checklist binders together, fewest needed first (ties: higher percent first). */
export function boardItems(building: BuildingSet[], binders: ShelfBinder[]): BoardItem[] {
  const items = [
    ...building.map(setItem),
    ...binders.flatMap((b) => {
      const item = binderItem(b);
      return item ? [item] : [];
    }),
  ];
  return items.filter((i) => i.need > 0).sort((a, b) => a.need - b.need || b.percent - a.percent);
}

/**
 * How the shown boards lay out with no empty cell, on a six-column grid sized
 * by the board's own width (a container query, so it holds beside the hopper
 * too): the leader spans the width, the rest share rows evenly. 5 → 1 + 2 + 2,
 * 4 → 1 + 3, 3 → 1 + 2, 2 → 1 + 1. Where a row of them would be too narrow,
 * each takes a full row instead: still no hole.
 */
function restSpan(rest: number): string {
  if (rest === 3) return "col-span-6 @4xl:col-span-2";
  if (rest === 2 || rest === 4) return "col-span-6 @xl:col-span-3";
  return "col-span-6";
}

export default function Boards({
  items,
  wanted,
  justCompleted,
  onOpenBinder,
}: {
  items: BoardItem[];
  /** Want List card ids, so a board can star them. */
  wanted: Set<string>;
  justCompleted: CompletedSet | null;
  onOpenBinder: (id: string) => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shown = items.slice(0, BOARD_CAP);
  const [leader, ...rest] = shown;
  if (!leader) return null;

  return (
    <section aria-labelledby="cb-board-heading" className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        {/* Focus lands here when "Nice!" waves the cheer (and its button) away. */}
        <h2 ref={headingRef} id="cb-board-heading" tabIndex={-1} className="text-2xl font-bold text-ink focus:outline-none">
          On the Bubble
        </h2>
        <p className="text-sm text-ink-3">
          {items.length > BOARD_CAP ? `Top ${BOARD_CAP}, fewest cards to go first.` : "Fewest cards to go first."}
        </p>
      </div>

      {justCompleted && <Cheer done={justCompleted} onDismissed={() => headingRef.current?.focus()} />}

      <ol className="@container grid grid-cols-6 gap-3">
        <li className="col-span-6">
          <Board item={leader} rank={1} leader wanted={wanted} onOpenBinder={onOpenBinder} />
        </li>
        {rest.map((item, i) => (
          <li key={item.id} className={restSpan(rest.length)}>
            <Board item={item} rank={i + 2} leader={false} wanted={wanted} onOpenBinder={onOpenBinder} />
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The set's wall in the collection demo: a real page, so a click pushes. */
function wallLink(setId: string): string {
  return `/binder-tracking?${new URLSearchParams({ demo: "on", tab: "cards", set: setId })}`;
}

/** The board's title: the whole board is its hit area (the `after:` inset). */
const TITLE_HIT =
  "text-left after:absolute after:inset-0 after:rounded-xl hover:text-neon-blue-text focus-visible:outline-none";

/** How many needed cards the Need line names (on one line, clamped) before "+N more". */
const NEED_NAMED = 5;

/**
 * One compact board: rank, name, percent; Have and Need; one bar of
 * segments, one per card, lit where you have it; and the Need line, one line
 * of full card titles (Want List cards first, starred), clamped on screen,
 * all of it for a reader.
 */
function Board({
  item,
  rank,
  leader,
  wanted,
  onOpenBinder,
}: {
  item: BoardItem;
  rank: number;
  leader: boolean;
  wanted: Set<string>;
  onOpenBinder: (id: string) => void;
}) {
  const to = item.to;
  const ordered = [...item.needed.filter((c) => wanted.has(c.id)), ...item.needed.filter((c) => !wanted.has(c.id))];
  const named = ordered.slice(0, NEED_NAMED);
  const more = item.needed.length - named.length;
  const wantedCount = item.needed.filter((c) => wanted.has(c.id)).length;
  const needText = named.map((c) => `${wanted.has(c.id) ? "★ " : ""}${c.title}`).join("; ");

  return (
    <article
      className={`mc-led shadow-offset relative flex h-full flex-col gap-2.5 rounded-xl border border-rule transition-colors hover:border-selection has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-focus ${
        leader ? "p-4" : "p-3"
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`${NEON_NUMERALS} grid size-8 shrink-0 place-items-center rounded-md border border-rule-strong text-xl text-neon-yellow-text`}
        >
          {rank}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className={`font-bold leading-tight text-ink ${leader ? "text-lg" : "text-base"}`}>
            {"setId" in to ? (
              <Link to={wallLink(to.setId)} className={TITLE_HIT}>
                {item.label}
              </Link>
            ) : (
              <button type="button" onClick={() => onOpenBinder(to.binderId)} className={TITLE_HIT}>
                {item.label}
              </button>
            )}
          </h3>
          <p className="text-xs text-ink-3">
            {"binderId" in to && "Smart binder. "}
            {item.need === 1 ? "One card to go." : `${item.need} cards to go.`}
          </p>
        </div>
        <p className="shrink-0 text-right leading-none">
          <span className={`mc-percent block text-neon-blue-text ${leader ? "text-5xl" : "text-4xl"}`}>{item.percent}%</span>
          <span className="sr-only"> {item.scope}</span>
        </p>
      </div>

      <div className="flex items-center gap-3 text-xs">
        <span className="shrink-0 tabular-nums text-ink-2">
          Have <strong className="text-ink">{item.have}</strong>
        </span>
        <span className="shrink-0 tabular-nums text-ink-2">
          Need <strong className="text-neon-orange-text">{item.need}</strong>
        </span>
        <span
          className="flex h-2 min-w-0 flex-1 gap-px overflow-hidden"
          aria-hidden="true"
          title={`${item.bulbName}: ${item.have} of ${item.total}`}
        >
          {item.bulbs.map((b) => (
            <span
              key={b.key}
              className={`min-w-0 flex-1 rounded-[1px] ${
                b.owned
                  ? "bg-pip-owned shadow-[var(--pip-owned-glow)]"
                  : b.cardId && wanted.has(b.cardId)
                    ? "bg-neon-yellow-text"
                    : "bg-rule-strong"
              }`}
            />
          ))}
        </span>
        <span className="sr-only">
          {`${item.have} of ${item.total} lit up${wantedCount > 0 ? `, ${wantedCount} needed on your Want List` : ""}.`}
        </span>
      </div>

      {/* Divs, not a p: globals.css gives p `text-wrap: pretty` unlayered, which beats `truncate`'s nowrap. */}
      <div className="flex min-w-0 items-baseline gap-1 text-xs text-ink-2">
        <span className="shrink-0 font-bold text-ink">Need:</span>
        <div className="min-w-0 flex-1 truncate" title={needText}>
          {named.map((c, i) => (
            <span key={c.id}>
              {wanted.has(c.id) && (
                <>
                  <span aria-hidden="true" className="mc-star text-neon-yellow-text">
                    ★{" "}
                  </span>
                  <span className="sr-only">On your Want List: </span>
                </>
              )}
              {c.title}
              {i < named.length - 1 ? "; " : ""}
            </span>
          ))}
        </div>
        {more > 0 && <span className="shrink-0 text-ink-3">+{more} more</span>}
      </div>
    </article>
  );
}

const CHEERED_KEY = "nb-dashboard-combined-cheered";

function readCheered(): string | null {
  try {
    return window.localStorage.getItem(CHEERED_KEY);
  } catch {
    return null;
  }
}

/**
 * The checklist just finished: said once, at the top of the wall. "Nice!"
 * waves it off for good (this browser remembers the set's id; a private
 * window just shows it again next time).
 */
function Cheer({ done, onDismissed }: { done: CompletedSet; onDismissed: () => void }) {
  const [gone, setGone] = useState(() => readCheered() === done.id);
  if (gone) return null;
  const dismiss = () => {
    try {
      window.localStorage.setItem(CHEERED_KEY, done.id);
    } catch {
      // Storage blocked: it shows again next time.
    }
    setGone(true);
    onDismissed();
  };
  const when = done.whenLabel.toLowerCase();
  return (
    <div
      data-complete="true"
      className="shadow-offset flex flex-col gap-4 rounded-2xl border border-notice-success-rule bg-notice-success-bg p-4 sm:flex-row sm:items-center"
    >
      <ul aria-label={`${done.label}, every card`} className="flex shrink-0 gap-2">
        {done.cards.map((c) => (
          <li key={c.id} className="w-14">
            <CardFace model={c.card} size="fill" />
          </li>
        ))}
      </ul>
      <div className="min-w-0 flex-1">
        <h3 className="text-lg font-bold text-notice-success-ink">Every bulb lit! {done.label} is done.</h3>
        <p className="text-sm text-ink-2">
          All {done.total} in the binder. <span className="font-semibold text-ink">{done.lastCard.title}</span> closed it
          out {when}.
        </p>
      </div>
      <NeonButton
        type="button"
        variant="primary"
        outline
        onClick={dismiss}
        aria-label={`Nice! Hide the ${done.label} cheer`}
        className="shrink-0 self-start sm:self-center"
      >
        Nice!
      </NeonButton>
    </div>
  );
}

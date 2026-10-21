import type { MouseEvent, ReactNode, Ref } from "react";
import { ArrowsRightLeftIcon, CheckIcon, PlusIcon, StarIcon as StarSolid } from "@heroicons/react/20/solid";
import { StarIcon as StarOutline } from "@heroicons/react/24/outline";
import {
  cardLabel,
  getTeam,
  playerNames,
  teamNames,
  type Card,
  type Copy,
  type CopyId,
} from "../prototypes/_shared/data";
import { FeatureBadges } from "../prototypes/p1/ChecklistRow";
import {
  FOCUS,
  QUIET_BUTTON,
  liveryOn,
  printRunText,
  setAndVariant,
  shortCardName,
} from "../prototypes/p1/ui";
import { lineNames, lineSummary } from "./lineItems";
import type { CollectionStore } from "./store";

/** What a row's controls do; built once by the list that shows the rows. */
export interface RowActions {
  /** Have on a card you don't own yet: add a copy to the target binder. */
  have: (card: Card) => void;
  /** Un-Have one line item: remove just that line, with Undo. */
  removeLine: (card: Card, copy: Copy) => void;
  /** "+ Add": open the drawer on its Add a copy form. */
  addAnother: (card: Card) => void;
  toggleWant: (card: Card) => void;
  toggleTrade: (card: Card, copy: Copy) => void;
  /**
   * Details: open the drawer, on this line item when there is one. `list`
   * is what the drawer's ↑ ↓ step through.
   */
  open: (card: Card, copyId?: CopyId, list?: Card[]) => void;
}

const SLOT_HAVE = "w-[4.5rem]";
const SLOT_ADD = "w-9 sm:w-[4.25rem]";
const SLOT_ICON = "w-9 sm:w-[4.5rem]";

function stop(fn: () => void) {
  return (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };
}

/** The Have toggle: a filled neon box with a check when pressed; "Have" either way. */
function HaveToggle({ pressed, label, onToggle }: { pressed: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      onClick={stop(onToggle)}
      className={`${SLOT_HAVE} inline-flex min-h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold transition-colors ${FOCUS} ${
        pressed
          ? "border-neon-blue bg-neon-blue text-black"
          : "border-slate-500 text-slate-200 hover:border-neon-blue hover:text-neon-blue"
      }`}
    >
      <span
        aria-hidden="true"
        className={`flex h-4 w-4 items-center justify-center rounded-sm border ${
          pressed ? "border-black bg-black text-neon-blue" : "border-current"
        }`}
      >
        {pressed && <CheckIcon className="h-3.5 w-3.5" />}
      </span>
      Have
    </button>
  );
}

function AddButton({ label, onAdd }: { label: string; onAdd: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title="Add another copy"
      onClick={stop(onAdd)}
      className={`${SLOT_ADD} inline-flex min-h-8 shrink-0 items-center justify-center gap-1 rounded-md border border-neon-blue/60 px-2 py-1 text-xs font-semibold text-neon-blue hover:border-neon-blue hover:bg-neon-blue/10 ${FOCUS}`}
    >
      <PlusIcon aria-hidden="true" className="h-3.5 w-3.5" />
      <span className="max-sm:hidden">Add</span>
    </button>
  );
}

/** A compact on/off chip: icon always, its word from `sm` up (the name carries it on a phone). */
function SmallToggle({
  pressed,
  label,
  word,
  icon,
  tone,
  onToggle,
}: {
  pressed: boolean;
  label: string;
  word: string;
  icon: ReactNode;
  tone: "want" | "trade";
  onToggle: () => void;
}) {
  const on =
    tone === "want"
      ? "border-neon-yellow text-neon-yellow bg-neon-yellow/10"
      : "border-neon-green text-neon-green bg-neon-green/10";
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      onClick={stop(onToggle)}
      className={`${SLOT_ICON} inline-flex min-h-8 shrink-0 items-center justify-center gap-1 rounded-md border px-1.5 py-1 text-xs font-medium transition-colors ${FOCUS} ${
        pressed ? on : "border-slate-700 text-slate-400 hover:border-slate-400 hover:text-slate-100"
      }`}
    >
      {icon}
      <span className="max-sm:hidden">{word}</span>
    </button>
  );
}

const slot = (cls: string) => <span aria-hidden="true" className={`${cls} shrink-0`} />;

/**
 * One checklist card, as one row or as a stack of rows: a card you own in
 * several line items (five raw Mint, one PSA 10) shows each line as its own
 * row under the same number, joined by a neon rail so the stack reads as one
 * card. Card-wide controls (+ Add, Want) sit on the stack's top row; each
 * line carries its own Have, Trade and Details.
 *
 * Every control's name is distinct: the line's grade and binder are in it.
 */
export default function CardRowGroup({
  card,
  store,
  actions,
  showSet = false,
  isSelected = false,
  highlighted = false,
  onRowClick,
  onOpenChecklist,
  groupRef,
}: {
  card: Card;
  store: CollectionStore;
  actions: RowActions;
  /** Search results span sets: show which set and variant on the subline. */
  showSet?: boolean;
  isSelected?: boolean;
  /** Just jumped to from search: ring it until something else is picked. */
  highlighted?: boolean;
  /** A click on the row's body. Default: open the drawer. */
  onRowClick?: (copyId?: CopyId) => void;
  /** Search results: the keyboard opener for the card's checklist. */
  onOpenChecklist?: () => void;
  groupRef?: Ref<HTMLLIElement>;
}) {
  const copies = store.copiesInScope(card.id);
  const binders = store.state.binders;
  const name = showSet ? cardLabel(card) : shortCardName(card);
  const wanted = store.isWanted(card.id);
  const lines = lineNames(copies, binders);
  const team = getTeam(card.teamIds[0]);
  const run = printRunText(card);
  const sub: string[] = [];
  if (showSet) sub.push(setAndVariant(card));
  if (run) sub.push(run);
  if (card.variation) sub.push(`${card.variation} variation`);
  const stacked = copies.length > 1;
  const rowClick = onRowClick ?? ((copyId?: CopyId) => actions.open(card, copyId));

  const want = (
    <SmallToggle
      pressed={wanted}
      label={`Want ${name}`}
      word="Want"
      tone="want"
      icon={
        wanted ? (
          <StarSolid aria-hidden="true" className="h-4 w-4" />
        ) : (
          <StarOutline aria-hidden="true" className="h-4 w-4" />
        )
      }
      onToggle={() => actions.toggleWant(card)}
    />
  );

  const trailing = (copyId: CopyId | undefined, line: string | null, top: boolean) => (
    <span className="flex shrink-0 gap-1">
      {top && onOpenChecklist && (
        <button
          type="button"
          onClick={stop(onOpenChecklist)}
          aria-label={`Open the checklist for ${cardLabel(card)}`}
          className={QUIET_BUTTON}
        >
          Checklist
        </button>
      )}
      <button
        type="button"
        onClick={stop(() => actions.open(card, copyId))}
        aria-label={line && stacked ? `Details for ${name}, ${line}` : `Details for ${name}`}
        className={QUIET_BUTTON}
      >
        Details
      </button>
    </span>
  );

  const body = (summary: string | null, top: boolean) => (
    <>
      <span className="w-12 shrink-0 text-right font-mono text-sm text-slate-400">#{card.cardNumber}</span>
      <div className="min-w-0 flex-1 max-sm:basis-[calc(100%-4rem)]">
        <div className="text-sm sm:truncate">
          <span className="font-medium text-slate-100">{playerNames(card)}</span>
          {summary && <span className="text-neon-blue"> · {summary}</span>}
        </div>
        <div className="min-h-[1rem] truncate text-xs text-slate-400">
          <span style={{ color: liveryOn(card) }} title={`${team.location} ${team.name}`}>
            {teamNames(card)}
          </span>
          {sub.length > 0 && <span> · {sub.join(" · ")}</span>}
        </div>
      </div>
      {top ? <FeatureBadges card={card} /> : null}
    </>
  );

  const rowCls =
    "flex cursor-pointer items-center gap-x-2 gap-y-1 p-2.5 hover:bg-gray-700/50 max-sm:flex-wrap max-sm:justify-end sm:gap-3";

  return (
    <li
      ref={groupRef}
      className={`overflow-hidden rounded-md border border-gray-600 ${
        card.variation ? "ml-8 border-l-2 border-l-gray-500" : ""
      } ${stacked ? "border-l-2 border-l-neon-blue/70" : ""} ${
        isSelected || highlighted ? "border-[#00C2FF] bg-blue-900/10 ring-2 ring-[#00C2FF]" : ""
      }`}
    >
      {copies.length === 0 ? (
        <div className={rowCls} onClick={() => rowClick()}>
          {body(null, true)}
          <HaveToggle pressed={false} label={`Have ${name}`} onToggle={() => actions.have(card)} />
          {slot(SLOT_ADD)}
          {slot(SLOT_ICON)}
          {want}
          {trailing(undefined, null, true)}
        </div>
      ) : (
        <div className={stacked ? "divide-y divide-gray-700" : ""}>
          {copies.map((copy, i) => {
            const top = i === 0;
            const line = lines[i];
            const trade = store.isUpForTrade(copy);
            return (
              <div key={copy.id} className={rowCls} onClick={() => rowClick(copy.id)}>
                {body(lineSummary(copy, binders), top)}
                <HaveToggle
                  pressed
                  label={`Have ${name}, ${line}`}
                  onToggle={() => actions.removeLine(card, copy)}
                />
                {top ? (
                  <AddButton label={`Add another ${name}`} onAdd={() => actions.addAnother(card)} />
                ) : (
                  slot(SLOT_ADD)
                )}
                <SmallToggle
                  pressed={trade}
                  label={`Trade ${name}, ${line}`}
                  word="Trade"
                  tone="trade"
                  icon={<ArrowsRightLeftIcon aria-hidden="true" className="h-4 w-4" />}
                  onToggle={() => actions.toggleTrade(card, copy)}
                />
                {top ? want : slot(SLOT_ICON)}
                {trailing(copy.id, line, top)}
              </div>
            );
          })}
        </div>
      )}
    </li>
  );
}

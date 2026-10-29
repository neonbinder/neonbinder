import type { MouseEvent, ReactNode, Ref } from "react";
import { ArrowsRightLeftIcon, CheckIcon, PlusIcon, StarIcon as StarSolid } from "@heroicons/react/20/solid";
import { StarIcon as StarOutline } from "@heroicons/react/24/outline";
import NeonButton from "@/components/modules/NeonButton";
import { FOCUS, QUIET_BUTTON, useLiverySurface } from "../prototypes/p1/ui";
import {
  cardLabel,
  playerNames,
  printRunLabel,
  setAndVariant,
  shortCardName,
  teamNames,
  teamTextColor,
} from "./data/labels";
import {
  collectionCopiesIn,
  isWantedIn,
  PICK_A_BINDER,
  useCapabilities,
  useContainers,
  useCopiesOf,
  useReadOnlyAll,
  useScope,
  useSide,
  useWants,
} from "./data/store";
import type { Card, Copy, CopyId } from "./data/types";
import { FeatureBadges } from "./inventory/badges";
import { InventorySearchHitRow } from "./inventory/QuantityRow";
import { lineNames, lineSummary } from "./lineItems";

/** What a row's controls do; built once by the page. */
export interface RowActions {
  /**
   * Have on a card you don't own yet: add a copy to the scoped home. Under
   * All (a view, NEO-374) only a call naming its `homeId` adds anything.
   */
  have: (card: Card, homeId?: string) => void;
  /** Un-Have one line item: remove just that line, with Undo. */
  removeLine: (card: Card, copy: Copy) => void;
  /** "+ Add": open the drawer on its Add a copy form. */
  addAnother: (card: Card) => void;
  /** Want on, or off, under the page's scope (the `wants` capability). */
  toggleWant: (card: Card) => void;
  /** Up for trade on, or off, for one line item (the `trade` capability). */
  toggleTrade: (card: Card, copy: Copy) => void;
  /**
   * Details: open the drawer, on this line item when there is one. `list`
   * is what the drawer's ↑ ↓ step through.
   */
  /** `edit`: a row click on an owned line, which opens that line's Edit form when it is the card's one line. */
  open: (card: Card, copyId?: CopyId, list?: Card[], edit?: boolean) => void;
}

const SLOT_HAVE = "w-[4.5rem]";
// Add is 44px square on a phone (the house touch target), so its column is too.
const SLOT_ADD = "w-11 sm:w-[4.25rem]";
const SLOT_ICON = "w-9 sm:w-[4.5rem]";

function stop(fn: () => void) {
  return (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };
}

/**
 * The Have toggle: a filled neon box with a check when pressed; "Have" either
 * way. While the copies load it stays focusable and says it is busy and
 * unavailable (`aria-disabled`, `aria-busy`), and a press does nothing: a
 * native `disabled` would drop the keyboard out from under it.
 */
function HaveToggle({
  pressed,
  label,
  onToggle,
  busy = false,
  locked = false,
}: {
  pressed: boolean;
  label: string;
  onToggle: () => void;
  busy?: boolean;
  /** NEO-374 — All is a view: an add is locked until a binder is picked. */
  locked?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      aria-busy={busy || undefined}
      aria-disabled={busy || locked || undefined}
      title={locked ? PICK_A_BINDER : undefined}
      onClick={stop(() => {
        if (!busy && !locked) onToggle();
      })}
      className={`${SLOT_HAVE} inline-flex min-h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold transition-colors aria-disabled:opacity-60 ${
        locked ? "aria-disabled:cursor-not-allowed" : "aria-disabled:cursor-wait"
      } ${FOCUS} ${
        pressed
          ? "border-selection bg-neon-blue text-on-neon-blue"
          : locked
            ? "border-control text-ink-2"
            : "border-control text-ink-2 hover:border-neon-blue hover:text-neon-blue-text"
      }`}
    >
      <span
        aria-hidden="true"
        className={`flex h-4 w-4 items-center justify-center rounded-sm border ${
          pressed ? "border-on-neon-blue bg-on-neon-blue text-neon-blue" : "border-current"
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
    <NeonButton
      type="button"
      variant="secondary"
      outline
      size="1"
      aria-label={label}
      title="Add another copy"
      onClick={stop(onAdd)}
      // The widths are SLOT_ADD's, so the column lines up with the empty slots.
      className="w-11 min-h-11 sm:w-[4.25rem] sm:min-h-8"
    >
      <PlusIcon aria-hidden="true" className="h-3.5 w-3.5" />
      <span className="max-sm:hidden">Add</span>
    </NeonButton>
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
      ? "border-neon-yellow-text text-neon-yellow-text bg-neon-yellow/10"
      : "border-neon-green-text text-neon-green-text bg-neon-green/10";
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      onClick={stop(onToggle)}
      className={`${SLOT_ICON} inline-flex min-h-8 shrink-0 items-center justify-center gap-1 rounded-md border px-1.5 py-1 text-xs font-medium transition-colors ${FOCUS} ${
        pressed ? on : "border-field-rule text-ink-3 hover:border-ink-3 hover:text-ink"
      }`}
    >
      {icon}
      <span className="max-sm:hidden">{word}</span>
    </button>
  );
}

/** RC, AU, RELIC, SP and #'d badges: shared with the inventory's quantity rows. */
export { FeatureBadges };

/** The green tag a copy flagged Up for trade wears. */
export function TradeBadge() {
  return (
    <span className="ml-2 rounded border border-neon-green-text px-1 text-xs text-neon-green-text">Up for trade</span>
  );
}

const slot = (cls: string) => <span aria-hidden="true" className={`${cls} shrink-0`} />;

/**
 * One checklist card, as one row or as a stack of rows: a card you own in
 * several line items (five raw Mint, one PSA 10) shows each line as its own
 * row under the same number, joined by a neon rail so the stack reads as one
 * card. Card-wide controls (+ Add, and Want in the demo) sit on the stack's
 * top row; each line carries its own Have and Details (and Trade). Each line
 * says which binder it lives in. A copy in a box is for sale, Inventory's,
 * and never reaches a row (NEO-359: `collectionCopiesIn`); the card's drawer
 * still lists it.
 *
 * Every control's name is distinct: the line's grade is in it, and its home
 * too when two lines would otherwise read the same.
 * `copies` is `undefined` while they load: the row shows, its Have waits.
 */
export default function CardRowGroup({
  card,
  copies,
  actions,
  showSet = false,
  isSelected = false,
  highlighted = false,
  onRowClick,
  onOpenChecklist,
  groupRef,
}: {
  card: Card;
  /** The collector's copies of this card in the collection (never one in a box), in the page's scope. */
  copies: Copy[] | undefined;
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
  const capabilities = useCapabilities();
  const binders = useContainers();
  const scope = useScope();
  const readOnly = useReadOnlyAll();
  const allWants = useWants();
  const lines = copies ?? [];
  const name = showSet ? cardLabel(card) : shortCardName(card);
  const wants = capabilities.wants;
  const trades = capabilities.trade;
  const wanted = wants && isWantedIn(allWants, card.id, scope);
  const names = lineNames(lines, binders);
  const team = card.teams[0];
  const panel = useLiverySurface("raised");
  const run = printRunLabel(card);
  const sub: string[] = [];
  if (showSet) sub.push(setAndVariant(card));
  if (run) sub.push(run);
  if (card.cardVariation) sub.push(`${card.cardVariation} variation`);
  const stacked = lines.length > 1;
  const rowClick =
    onRowClick ?? ((copyId?: CopyId) => actions.open(card, copyId, undefined, copyId !== undefined));

  const want = wants ? (
    <SmallToggle
      pressed={wanted}
      label={`Want ${name}`}
      word="Want"
      tone="want"
      icon={
        wanted ? <StarSolid aria-hidden="true" className="h-4 w-4" /> : <StarOutline aria-hidden="true" className="h-4 w-4" />
      }
      onToggle={() => actions.toggleWant(card)}
    />
  ) : null;

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
      <span className="w-12 shrink-0 text-right font-mono text-sm text-ink-3">#{card.cardNumber}</span>
      <div className="min-w-0 flex-1 max-sm:basis-[calc(100%-4rem)]">
        <div className="flex min-w-0 items-baseline text-sm">
          <span className="min-w-0 sm:truncate">
            <span className="font-medium text-ink">{playerNames(card) || "Player unknown"}</span>
            {summary && <span className="text-neon-blue-text"> · {summary}</span>}
          </span>
        </div>
        <div className="min-h-[1rem] truncate text-xs text-ink-3">
          {team && (
            <span
              style={{ color: teamTextColor(team, panel) }}
              title={team.location ? `${team.location} ${team.name}` : team.name}
            >
              {teamNames(card)}
            </span>
          )}
          {sub.length > 0 && (
            <span>
              {team ? " · " : ""}
              {sub.join(" · ")}
            </span>
          )}
        </div>
      </div>
      {top ? <FeatureBadges card={card} /> : null}
    </>
  );

  const rowCls =
    "flex cursor-pointer items-center gap-x-2 gap-y-1 p-2.5 hover:bg-list-hover-raised max-sm:flex-wrap max-sm:justify-end sm:gap-3";

  return (
    <li
      ref={groupRef}
      className={`overflow-hidden rounded-md border border-rule-strong ${
        card.cardVariation ? "ml-8 border-l-2 border-l-control" : ""
      } ${stacked ? "border-l-2 border-l-neon-blue/70" : ""} ${
        isSelected || highlighted ? "border-selection bg-pick-blue/10 ring-2 ring-selection" : ""
      }`}
    >
      {lines.length === 0 ? (
        <div className={rowCls} onClick={() => rowClick()}>
          {body(null, true)}
          <HaveToggle
            pressed={false}
            label={`Have ${name}`}
            busy={copies === undefined}
            locked={readOnly}
            onToggle={() => actions.have(card)}
          />
          {slot(SLOT_ADD)}
          {trades && slot(SLOT_ICON)}
          {want}
          {trailing(undefined, null, true)}
        </div>
      ) : (
        <div className={stacked ? "divide-y divide-rule-strong" : ""}>
          {lines.map((copy, i) => {
            const top = i === 0;
            const line = names[i];
            return (
              <div key={copy.id} className={rowCls} onClick={() => rowClick(copy.id)}>
                {body(lineSummary(copy, binders), top)}
                <HaveToggle pressed label={`Have ${name}, ${line}`} onToggle={() => actions.removeLine(card, copy)} />
                {top && !readOnly ? <AddButton label={`Add another ${name}`} onAdd={() => actions.addAnother(card)} /> : slot(SLOT_ADD)}
                {trades && (
                  <SmallToggle
                    pressed={copy.upForTrade}
                    label={`Trade ${name}, ${line}`}
                    word="Trade"
                    tone="trade"
                    icon={<ArrowsRightLeftIcon aria-hidden="true" className="h-4 w-4" />}
                    onToggle={() => actions.toggleTrade(card, copy)}
                  />
                )}
                {wants && (top ? want : slot(SLOT_ICON))}
                {trailing(copy.id, line, top)}
              </div>
            );
          })}
        </div>
      )}
    </li>
  );
}

/**
 * A search hit's row: reads its own copies, since a result list spans
 * checklists. On the inventory side (NEO-364) it is a quantity row for the
 * target box instead, counting box copies only.
 */
export function SearchHitRow(props: Omit<Parameters<typeof CardRowGroup>[0], "copies">) {
  const side = useSide();
  if (side === "inventory") return <InventorySearchHitRow {...props} />;
  return <CollectionSearchHitRow {...props} />;
}

function CollectionSearchHitRow(props: Omit<Parameters<typeof CardRowGroup>[0], "copies">) {
  const all = useCopiesOf(props.card.id);
  const scope = useScope();
  // The collection's copies only, narrowed by the page's scope, as the checklist's rows are.
  const copies = collectionCopiesIn(all, scope);
  return <CardRowGroup {...props} copies={copies} />;
}

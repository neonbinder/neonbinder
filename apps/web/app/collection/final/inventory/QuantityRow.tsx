import { useId, useRef, useState, type KeyboardEvent, type MouseEvent, type Ref } from "react";
import { CheckIcon, ExclamationTriangleIcon, PlusIcon } from "@heroicons/react/20/solid";
import { InformationCircleIcon, QueueListIcon } from "@heroicons/react/24/outline";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import { QUIET_BUTTON, useLiverySurface } from "../../prototypes/p1/ui";
import type { RowActions } from "../CardRows";
import { cardLabel, playerNames, printRunLabel, setAndVariant, shortCardName, teamNames, teamTextColor } from "../data/labels";
import { inventoryCopies, useCollectionActions, useCopiesOf, useDefaultCondition, writeErrorMessage } from "../data/store";
import type { Card, Container, Copy, CopyId, QuantityResult } from "../data/types";
import { usePageApi } from "../pageApi";
import { FeatureBadges } from "./badges";
import { useQuickEntry } from "./QuickEntry";
import {
  linesInBox,
  otherLines,
  parseQuantity,
  plainQuantity,
  QUANTITY_FIELD_DIGITS,
  QUANTITY_RANGE_MESSAGE,
  quantityInRange,
} from "./targetBox";

/** Marks a row's quantity field, so Enter can find the next row's. */
const FIELD_ATTR = "data-qty-field";
/** Marks a row's other controls (Checklist, Details), reached with ← →. */
const ROW_CONTROL_ATTR = "data-qty-control";

/** Checklist / Details: a 44px icon square on a phone, a quiet word from sm up. */
const ROW_ICON_BUTTON = "inline-flex items-center justify-center max-sm:min-h-11 max-sm:min-w-11 max-sm:px-0";

/** What the status line says when a field is left blank: the number went back. */
export const BLANK_MESSAGE = "Nothing changed. Type 0 to clear it.";

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

/** What the status line says once a quantity lands. */
export function quantityMessage(name: string, box: Pick<Container, "name">, r: Pick<QuantityResult, "before" | "after">): string {
  if (r.after > r.before) return `Boxed ${r.after - r.before} more of ${name}. ${r.after} in ${box.name}.`;
  if (r.after < r.before) return `Pulled ${r.before - r.after} of ${name} from ${box.name}. ${r.after} left.`;
  return `${name} stays at ${r.after} in ${box.name}.`;
}

function stop(fn: () => void) {
  return (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };
}

/** The field `step` rows away from this one in the same list, if any. */
function fieldBeside(from: HTMLElement, step: 1 | -1): HTMLInputElement | null {
  const list = from.closest("[data-qty-list], ul");
  if (!list) return null;
  const fields = [...list.querySelectorAll<HTMLInputElement>(`input[${FIELD_ATTR}]`)];
  const i = fields.indexOf(from as HTMLInputElement);
  return i < 0 ? null : (fields[i + step] ?? null);
}

/** The row's controls in order: the field, then Checklist / Details. */
function rowControls(from: HTMLElement): HTMLElement[] {
  const row = from.closest("li");
  if (!row) return [];
  return [...row.querySelectorAll<HTMLElement>(`input[${FIELD_ATTR}], [${ROW_CONTROL_ATTR}]`)];
}

/**
 * NEO-364 (D9–D11) — one checklist card on the inventory side: a quantity
 * field instead of Have / Want / Trade.
 *
 * The field is how many PLAIN copies of the card sit in the target box (raw,
 * nothing noted, not up for trade). Leaving it writes the new number in one
 * go (`setBoxQuantity`), through the page's commit queue, so Tab never waits
 * on a write. After it: the card's other lines in that box, read-only
 * ("also here: PSA 9, Raw Mint"), and Details for everything else. They sit
 * after the number so a 0 beside a graded copy reads as "no plain copies",
 * not as a contradiction.
 *
 * Keyboard: the field is the row's only Tab stop, so Tab walks field to
 * field. → at the end of the field reaches Details (and Checklist on a search
 * hit), ← comes back. Enter commits and moves to the next row's field,
 * Shift+Enter to the one above; Escape puts back what was there, in place.
 * Ctrl/⌘+Z with nothing typed takes back the page's last change (the status
 * line's Undo); once something is typed it is the field's own text undo.
 * Left blank, the field puts its number back and the status line says so
 * (unless it is still offering an Undo: that stays). A count past 999 is
 * refused on the spot, in the server's words, and never cut down to fit.
 *
 * The + right after the field boxes one more plain copy, through the same
 * write, status line and Undo as a typed number. It is for the pointer and
 * the screen reader only (no Tab stop, not on the arrows), so quick entry's
 * keyboard is exactly the field's.
 *
 * Saving shows on the row: a dot while the write is on its way, a check
 * when it lands, or the server's reason and the old number back when it is
 * refused. The page's status line says what changed, with one Undo.
 */
export default function QuantityRow({
  card,
  copies,
  showSet = false,
  isSelected = false,
  highlighted = false,
  onOpen,
  onRowClick,
  onOpenChecklist,
  groupRef,
}: {
  card: Card;
  /** The card's box copies (any box; never a binder copy). `undefined` while they load. */
  copies: Copy[] | undefined;
  /** Search results span sets: say which set and variant on the subline. */
  showSet?: boolean;
  isSelected?: boolean;
  highlighted?: boolean;
  /** Details: the card drawer, on this line item when there is one. */
  onOpen: (copyId?: CopyId) => void;
  /** A click on the row's body. Default: put the caret in the field. */
  onRowClick?: () => void;
  /** Search results: the opener for the card's checklist. */
  onOpenChecklist?: () => void;
  groupRef?: Ref<HTMLLIElement>;
}) {
  const api = usePageApi();
  const writes = useCollectionActions();
  const { box, queue } = useQuickEntry();
  const panel = useLiverySurface("raised");
  const field = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const othersId = useId();

  const lines = linesInBox(copies, box?.id);
  const defaultCondition = useDefaultCondition();
  const count = plainQuantity(lines, defaultCondition);
  const others = otherLines(lines, defaultCondition);
  const ready = copies !== undefined && box !== undefined;

  /** What is typed and not yet settled, for the box it was typed for. */
  const [draft, setDraft] = useState<{ text: string; boxId: string } | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const seq = useRef(0);
  const pending = useRef(0);
  const lastSent = useRef<number | null>(null);
  const shownDraft = draft && box && draft.boxId === box.id ? draft.text : null;
  const value = shownDraft ?? (ready ? String(count) : "");

  const name = showSet ? cardLabel(card) : shortCardName(card);
  const label = box ? `Quantity of ${name} in ${box.name}` : `Quantity of ${name}`;
  const addLabel = box ? `Add one ${name} to ${box.name}` : `Add one ${name}`;

  /** The number the next write builds on: the one still on its way, else the box's. */
  const latest = () => (pending.current > 0 && lastSent.current !== null ? lastSent.current : count);

  /** Past the cap: refused here, as the server would, with nothing written. */
  const refuseOverCap = (base: number, boxId: string) => {
    setDraft(pending.current > 0 ? { text: String(base), boxId } : null);
    setStatus({ kind: "error", message: QUANTITY_RANGE_MESSAGE });
    api.notify(`${shortCardName(card)} didn't change. ${QUANTITY_RANGE_MESSAGE}`);
  };

  /** Writes what is typed, if it changed. False only when it was refused. */
  const commit = (): boolean => {
    if (shownDraft === null || !box || copies === undefined) return true;
    const base = latest();
    const quantity = parseQuantity(shownDraft);
    if (quantity === null || quantity === base) {
      // Blank, unreadable or unchanged: nothing to write. The number goes
      // back, and a blank one says so on the status line (the row's own
      // text stays quiet, so it is announced once), unless the line still
      // offers the last count's Undo, which an aside never replaces.
      setDraft(pending.current > 0 ? { text: String(base), boxId: box.id } : null);
      if (quantity === null) api.inform(BLANK_MESSAGE);
      return true;
    }
    if (!quantityInRange(quantity)) {
      refuseOverCap(base, box.id);
      return false;
    }
    send(quantity, box);
    return true;
  };

  /**
   * The + beside the field: one more plain copy, written exactly as a typed
   * number is. It builds on the newest number, the one still on its way
   * included, so rapid clicks never lose a count. Anything typed and not yet
   * left (the field keeps the focus, see `onMouseDown` below) goes first.
   */
  const addOne = () => {
    if (!box || copies === undefined) return;
    // A typed number the cap refused stays refused: the + adds nothing to it.
    if (!commit()) return;
    const base = latest();
    if (!quantityInRange(base + 1)) {
      refuseOverCap(base, box.id);
      return;
    }
    send(base + 1, box);
  };

  /** Writes `quantity` through the page's commit queue and reports how it went. */
  const send = (quantity: number, target: Container) => {
    const mine = ++seq.current;
    pending.current += 1;
    lastSent.current = quantity;
    setDraft({ text: String(quantity), boxId: target.id });
    setStatus({ kind: "saving" });
    const settle = () => {
      pending.current -= 1;
      if (mine !== seq.current) return false;
      lastSent.current = null;
      setDraft(null);
      return true;
    };
    void queue
      .enqueue(() => writes.setBoxQuantity(card, target, quantity))
      .then(
        (result) => {
          if (settle()) setStatus({ kind: "saved" });
          api.notify(quantityMessage(shortCardName(card), target, result), result.undo);
        },
        (error: unknown) => {
          const message = writeErrorMessage(error);
          if (settle()) setStatus({ kind: "error", message });
          api.notify(`${shortCardName(card)} didn't change. ${message}`);
        },
      );
  };

  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    if (e.key === "Enter") {
      e.preventDefault();
      const next = fieldBeside(el, e.shiftKey ? -1 : 1);
      // Leaving the field commits it; with nowhere to go, commit in place.
      if (next) next.focus();
      else commit();
    } else if (e.key === "Escape" && shownDraft !== null) {
      e.preventDefault();
      setDraft(null);
    } else if (
      shownDraft === null &&
      (e.ctrlKey || e.metaKey) &&
      !e.shiftKey &&
      !e.altKey &&
      e.key.toLowerCase() === "z"
    ) {
      // Nothing typed here yet: Ctrl/⌘+Z takes back the last count, as the
      // status line's Undo does. While typing it stays the field's own undo.
      e.preventDefault();
      api.undoLast();
    } else if (e.key === "ArrowRight" && !e.shiftKey && el.selectionEnd === el.value.length) {
      // At the end of the field, or with all of it selected (as it is on arrival).
      const controls = rowControls(el);
      const next = controls[controls.indexOf(el) + 1];
      if (next) {
        e.preventDefault();
        next.focus();
      }
    }
  };

  const onControlKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const controls = rowControls(e.currentTarget);
    const next = controls[controls.indexOf(e.currentTarget) + (e.key === "ArrowRight" ? 1 : -1)];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  const team = card.teams[0];
  const run = printRunLabel(card);
  const sub: string[] = [];
  if (showSet) sub.push(setAndVariant(card));
  if (run) sub.push(run);
  if (card.cardVariation) sub.push(`${card.cardVariation} variation`);
  const describedBy = [status.kind === "error" ? errorId : null, others ? othersId : null].filter(Boolean).join(" ");

  return (
    <li
      ref={groupRef}
      className={`overflow-hidden rounded-md border border-rule-strong ${
        card.cardVariation ? "ml-8 border-l-2 border-l-control max-sm:ml-4" : ""
      } ${isSelected || highlighted ? "border-selection bg-pick-blue/10 ring-2 ring-selection" : ""}`}
    >
      {/* One line on a phone too: number and player, the field and its +,
          Details as an icon. Only "also here" takes a line of its own there,
          and a search hit's name (it carries its set, and Checklist joins
          Details), which puts the controls on the line under it. */}
      <div
        className={`flex cursor-pointer items-center gap-x-1 gap-y-1 px-2 py-1.5 hover:bg-list-hover-raised max-sm:flex-wrap sm:gap-3 sm:p-2.5 ${
          showSet ? "max-sm:justify-end" : ""
        }`}
        onClick={() => (onRowClick ? onRowClick() : field.current?.focus())}
      >
        <span className="w-12 shrink-0 text-right font-mono text-sm text-ink-3 max-sm:hidden">#{card.cardNumber}</span>
        <div className={`min-w-0 flex-1 ${showSet ? "max-sm:basis-full" : ""}`}>
          <div className="min-w-0 truncate text-sm font-medium text-ink">
            <span className="font-mono font-normal text-ink-3 sm:hidden">#{card.cardNumber} </span>
            {playerNames(card) || "Player unknown"}
          </div>
          <div className="flex min-h-[1rem] min-w-0 items-center gap-1.5 text-xs text-ink-3">
            <span className="min-w-0 truncate">
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
            </span>
            <span className="contents sm:hidden">
              <FeatureBadges card={card} />
            </span>
          </div>
        </div>
        <span className="contents max-sm:hidden">
          <FeatureBadges card={card} />
        </span>
        <span className="relative flex shrink-0 items-center gap-1 sm:gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Input
            ref={field}
            bare
            surface="panel"
            data-qty-field=""
            aria-label={label}
            aria-describedby={describedBy || undefined}
            aria-invalid={status.kind === "error" || undefined}
            aria-keyshortcuts="Control+Z Meta+Z ArrowRight"
            inputMode="numeric"
            pattern="[0-9]*"
            enterKeyHint="next"
            autoComplete="off"
            spellCheck={false}
            readOnly={!ready}
            value={value}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              if (!box) return;
              setDraft({ text: e.target.value.replace(/\D/g, "").slice(0, QUANTITY_FIELD_DIGITS), boxId: box.id });
              if (status.kind !== "saving") setStatus({ kind: "idle" });
            }}
            onBlur={commit}
            onKeyDown={onFieldKey}
            className={`min-h-11 w-12 px-2 py-1 text-right text-sm font-semibold tabular-nums sm:min-h-9 sm:w-14 ${
              shownDraft !== null ? "ring-1 ring-neon-yellow-text" : ""
            }`}
          />
          {/* Pointer-only on purpose: never a Tab stop and not in the ← → ring,
              so the keyboard still walks field to field. A mousedown keeps the
              focus where it was (no ring left on the +, a typed number stays
              in its field until the click writes it). */}
          <NeonButton
            type="button"
            variant="secondary"
            outline
            size="1"
            tabIndex={-1}
            aria-label={addLabel}
            disabled={!ready}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              addOne();
            }}
            // Square, and the field's height: 44px on a phone, 36px from sm up.
            className="min-h-11 min-w-11 shrink-0 sm:min-h-9 sm:min-w-9"
          >
            <PlusIcon aria-hidden="true" className="h-4 w-4" />
          </NeonButton>
          <SaveMark status={status} />
        </span>
        {/* After the number, never before it: "0 · also here: PSA 9" reads as
            "no plain copies, and a graded one", where "PSA 9 · 0" read as a
            contradiction. From sm up the slot is on every row, so the fields
            and Details stay in one column down the list. */}
        <span
          id={others ? othersId : undefined}
          className={`text-xs text-ink-2 max-sm:order-last max-sm:basis-full max-sm:text-right sm:w-40 sm:shrink-0 ${
            others ? "" : "max-sm:hidden"
          }`}
        >
          {others?.text}
        </span>
        {/* A word from sm up, an icon on a phone; the name says it either way. */}
        <span className="flex shrink-0 gap-1">
          {onOpenChecklist && (
            <button
              type="button"
              tabIndex={-1}
              data-qty-control=""
              onKeyDown={onControlKey}
              onClick={stop(onOpenChecklist)}
              aria-label={`Open the checklist for ${cardLabel(card)}`}
              className={`${QUIET_BUTTON} ${ROW_ICON_BUTTON}`}
            >
              <QueueListIcon aria-hidden="true" className="h-5 w-5 sm:hidden" />
              <span className="max-sm:hidden">Checklist</span>
            </button>
          )}
          <button
            type="button"
            tabIndex={-1}
            data-qty-control=""
            onKeyDown={onControlKey}
            onClick={stop(() => onOpen(lines[0]?.id))}
            aria-label={`Details for ${name}`}
            className={`${QUIET_BUTTON} ${ROW_ICON_BUTTON}`}
          >
            <InformationCircleIcon aria-hidden="true" className="h-5 w-5 sm:hidden" />
            <span className="max-sm:hidden">Details</span>
          </button>
        </span>
      </div>
      {status.kind === "error" && (
        <p id={errorId} className="flex items-start gap-1.5 px-2.5 pb-2 text-xs text-notice-danger-ink">
          <ExclamationTriangleIcon aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            Didn&apos;t save: {status.message} Back to {count}.
          </span>
        </p>
      )}
    </li>
  );
}

/**
 * Beside the field: a dot while its write is on the way, a check once it
 * lands. On a phone it rides the +'s top corner as a badge instead of taking
 * a slot of its own, so the player's name keeps that width.
 */
function SaveMark({ status }: { status: Status }) {
  return (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center max-sm:pointer-events-none max-sm:absolute max-sm:-right-1.5 max-sm:-top-1.5 max-sm:rounded-full ${
        status.kind === "idle" ? "" : "max-sm:bg-raised"
      }`}
      title={markTitle(status)}
    >
      {status.kind === "saving" && (
        <>
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-neon-yellow" />
          <span className="sr-only">Saving</span>
        </>
      )}
      {status.kind === "saved" && (
        <>
          <CheckIcon aria-hidden="true" className="h-4 w-4 text-neon-green-text" />
          <span className="sr-only">Saved</span>
        </>
      )}
      {status.kind === "error" && <ExclamationTriangleIcon aria-hidden="true" className="h-4 w-4 text-notice-danger-ink" />}
    </span>
  );
}

function markTitle(status: Status): string | undefined {
  if (status.kind === "saving") return "Saving";
  if (status.kind === "saved") return "Saved";
  if (status.kind === "error") return "Didn't save";
  return undefined;
}

/**
 * A search hit on the inventory side: reads its own copies (a result list
 * spans checklists) and keeps only the box ones (the hard line).
 */
export function InventorySearchHitRow({
  card,
  actions,
  showSet,
  isSelected,
  highlighted,
  onRowClick,
  onOpenChecklist,
  groupRef,
}: {
  card: Card;
  actions: Pick<RowActions, "open">;
  showSet?: boolean;
  isSelected?: boolean;
  highlighted?: boolean;
  onRowClick?: (copyId?: CopyId) => void;
  onOpenChecklist?: () => void;
  groupRef?: Ref<HTMLLIElement>;
}) {
  const copies = inventoryCopies(useCopiesOf(card.id));
  return (
    <QuantityRow
      card={card}
      copies={copies}
      showSet={showSet}
      isSelected={isSelected}
      highlighted={highlighted}
      onOpen={(copyId) => actions.open(card, copyId)}
      onRowClick={onRowClick ? () => onRowClick() : undefined}
      onOpenChecklist={onOpenChecklist}
      groupRef={groupRef}
    />
  );
}

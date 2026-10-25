import { useId, useRef, useState, type KeyboardEvent, type MouseEvent, type Ref } from "react";
import { CheckIcon, ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { Input } from "@/components/primitives/Input";
import { QUIET_BUTTON, useLiverySurface } from "../../prototypes/p1/ui";
import type { RowActions } from "../CardRows";
import { cardLabel, playerNames, printRunLabel, setAndVariant, shortCardName, teamNames, teamTextColor } from "../data/labels";
import { inventoryCopies, useCollectionActions, useCopiesOf, writeErrorMessage } from "../data/store";
import type { Card, Container, Copy, CopyId, QuantityResult } from "../data/types";
import { usePageApi } from "../pageApi";
import { FeatureBadges } from "./badges";
import { useQuickEntry } from "./QuickEntry";
import { linesInBox, otherLines, parseQuantity, plainQuantity } from "./targetBox";

/** Marks a row's quantity field, so Enter can find the next row's. */
const FIELD_ATTR = "data-qty-field";
/** Marks a row's other controls (Checklist, Details), reached with ← →. */
const ROW_CONTROL_ATTR = "data-qty-control";

/** What the status line says when a field is left blank: the number went back. */
export const BLANK_MESSAGE = "Nothing changed. Type 0 to clear it.";

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

/** What the status line says once a quantity lands. */
export function quantityMessage(name: string, box: Pick<Container, "name">, r: Pick<QuantityResult, "before" | "after">): string {
  if (r.after > r.before) return `Boxed ${r.after - r.before} more ${name}. ${r.after} in ${box.name}.`;
  if (r.after < r.before) return `Pulled ${r.before - r.after} ${name} from ${box.name}. ${r.after} left.`;
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
 * on a write. Beside it: the card's other lines in that box, read-only
 * ("+2 more: PSA 9, Raw Mint"), and Details for everything else.
 *
 * Keyboard: the field is the row's only Tab stop, so Tab walks field to
 * field. → at the end of the field reaches Details (and Checklist on a search
 * hit), ← comes back. Enter commits and moves to the next row's field,
 * Shift+Enter to the one above; Escape puts back what was there, in place.
 * Ctrl/⌘+Z with nothing typed takes back the page's last change (the status
 * line's Undo); once something is typed it is the field's own text undo.
 * Left blank, the field puts its number back and the status line says so
 * (unless it is still offering an Undo: that stays).
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
  const count = plainQuantity(lines);
  const others = otherLines(lines);
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

  const commit = () => {
    if (shownDraft === null || !box || copies === undefined) return;
    const base = pending.current > 0 && lastSent.current !== null ? lastSent.current : count;
    const quantity = parseQuantity(shownDraft);
    if (quantity === null || quantity === base) {
      // Blank, unreadable or unchanged: nothing to write. The number goes
      // back, and a blank one says so on the status line (the row's own
      // text stays quiet, so it is announced once), unless the line still
      // offers the last count's Undo, which an aside never replaces.
      setDraft(pending.current > 0 ? { text: String(base), boxId: box.id } : null);
      if (quantity === null) api.inform(BLANK_MESSAGE);
      return;
    }
    const mine = ++seq.current;
    pending.current += 1;
    lastSent.current = quantity;
    setDraft({ text: String(quantity), boxId: box.id });
    setStatus({ kind: "saving" });
    const target = box;
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
        card.cardVariation ? "ml-8 border-l-2 border-l-control" : ""
      } ${isSelected || highlighted ? "border-selection bg-pick-blue/10 ring-2 ring-selection" : ""}`}
    >
      <div
        className="flex cursor-pointer items-center gap-x-2 gap-y-1 p-2.5 hover:bg-list-hover-raised max-sm:flex-wrap max-sm:justify-end sm:gap-3"
        onClick={() => (onRowClick ? onRowClick() : field.current?.focus())}
      >
        <span className="w-12 shrink-0 text-right font-mono text-sm text-ink-3">#{card.cardNumber}</span>
        <div className="min-w-0 flex-1 max-sm:basis-[calc(100%-4rem)]">
          <div className="min-w-0 truncate text-sm font-medium text-ink">{playerNames(card) || "Player unknown"}</div>
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
        <FeatureBadges card={card} />
        {others && (
          <span id={othersId} className="max-w-[14rem] text-right text-xs text-ink-2 max-sm:order-last max-sm:basis-full">
            {others.text}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
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
              setDraft({ text: e.target.value.replace(/\D/g, "").slice(0, 3), boxId: box.id });
              if (status.kind !== "saving") setStatus({ kind: "idle" });
            }}
            onBlur={commit}
            onKeyDown={onFieldKey}
            className={`min-h-9 w-14 px-2 py-1 text-right text-sm font-semibold tabular-nums ${
              shownDraft !== null ? "ring-1 ring-neon-yellow-text" : ""
            }`}
          />
          <SaveMark status={status} />
        </span>
        <span className="flex shrink-0 gap-1">
          {onOpenChecklist && (
            <button
              type="button"
              tabIndex={-1}
              data-qty-control=""
              onKeyDown={onControlKey}
              onClick={stop(onOpenChecklist)}
              aria-label={`Open the checklist for ${cardLabel(card)}`}
              className={`${QUIET_BUTTON} max-sm:min-h-11`}
            >
              Checklist
            </button>
          )}
          <button
            type="button"
            tabIndex={-1}
            data-qty-control=""
            onKeyDown={onControlKey}
            onClick={stop(() => onOpen(lines[0]?.id))}
            aria-label={`Details for ${name}`}
            className={`${QUIET_BUTTON} max-sm:min-h-11`}
          >
            Details
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

/** Beside the field: a dot while its write is on the way, a check once it lands. */
function SaveMark({ status }: { status: Status }) {
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center" title={markTitle(status)}>
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

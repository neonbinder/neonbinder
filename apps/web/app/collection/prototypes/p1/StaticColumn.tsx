import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/solid";
import { Input } from "@/components/primitives/Input";
import { activateOnEnter } from "@/lib/dom/activate-on-enter";
import { useComboboxHighlight } from "@/src/hooks/useComboboxHighlight";
import { scrollRowIntoList } from "@/components/SetSelector/list-scroll";
import type { ColumnItem } from "./drill";
import {
  COLUMN_CARD,
  DESCRIPTION_TONE,
  HIGHLIGHT_STROKE,
  HIGHLIGHT_TINT,
  ROW_IDLE,
  compareOptionNames,
} from "./ui";

/**
 * A static copy of the admin cascade's EntitySelector: same card, same
 * combobox + aria-activedescendant listbox, same collapse-to-a-summary-card
 * once a row is picked, same Left/Right hop between columns from an empty
 * box. It takes its rows as a prop instead of a Convex query.
 */

export const SHOWING_ALL = "Showing all";
export function filterMatchText(count: number): string {
  if (count === 0) return "No matches";
  return count === 1 ? "1 match" : `${count} matches`;
}
const FILTER_ANNOUNCE_DELAY_MS = 400;

/** The row the columns live in; Left/Right moves between its comboboxes. */
export const DRILL_ROW_ATTR = "data-drill-row";

function focusAdjacentColumn(input: HTMLInputElement | null, delta: 1 | -1): boolean {
  if (!input) return false;
  const row = input.closest<HTMLElement>(`[${DRILL_ROW_ATTR}]`);
  if (!row) return false;
  const boxes = Array.from(row.querySelectorAll<HTMLElement>('[role="combobox"]'));
  const here = boxes.indexOf(input);
  const target = boxes[here + delta];
  if (here < 0 || !target) return false;
  target.focus();
  return true;
}

export interface StaticColumnProps {
  title: string;
  items: ColumnItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  selectedColor: string;
  /** Keep the given order (a parallel ladder reads low → high) instead of A–Z. */
  keepOrder?: boolean;
}

export default function StaticColumn({
  title,
  items,
  selectedId,
  onSelect,
  expanded,
  setExpanded,
  selectedColor,
  keepOrder = false,
}: StaticColumnProps) {
  const [searchFilter, setSearchFilter] = useState("");
  const baseId = useId();
  const popupId = `${baseId}-popup`;
  const optionDomId = (key: string) => `${popupId}-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const collapsedCardRef = useRef<HTMLButtonElement | null>(null);

  const selected = items.find((i) => i.id === selectedId);
  const sorted = useMemo(
    () => (keepOrder ? items : [...items].sort((a, b) => compareOptionNames(a.name, b.name))),
    [items, keepOrder],
  );
  const showsCollapsedCard = !!(selectedId && selected && !expanded);
  const needle = searchFilter.toLowerCase();
  const rows = searchFilter ? sorted.filter((i) => i.name.toLowerCase().includes(needle)) : sorted;
  const rowKeys = rows.map((r) => r.id);

  const listVisible = !showsCollapsedCard;
  const [shownCount, setShownCount] = useState(0);
  const [wasListVisible, setWasListVisible] = useState(listVisible);
  if (wasListVisible !== listVisible) {
    setWasListVisible(listVisible);
    if (listVisible) setShownCount((n) => n + 1);
  }

  const seed: string | null = searchFilter
    ? (rows[0]?.id ?? null)
    : rowKeys.includes(selectedId ?? "")
      ? selectedId
      : (rowKeys[0] ?? null);
  const { highlighted, move } = useComboboxHighlight({
    keys: rowKeys,
    seed,
    seedOn: `${shownCount}\u0000${searchFilter}`,
  });

  const [filterCleared, setFilterCleared] = useState(false);
  const [announced, setAnnounced] = useState("");
  const pending = searchFilter ? filterMatchText(rows.length) : filterCleared ? SHOWING_ALL : "";
  useEffect(() => {
    if (pending === announced) return;
    const timer = setTimeout(() => setAnnounced(pending), FILTER_ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [pending, announced]);

  // Keep the keyboard highlight in view, as the admin column does.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || highlighted === null) return;
    const row = list.querySelector<HTMLElement>(`#${CSS.escape(optionDomId(highlighted))}`);
    if (row) scrollRowIntoList(list, row, "nearest");
  });

  // Re-opening a column puts the caret back in its box; a re-pick of the same
  // row parks focus on the summary card it collapses to.
  const wasExpandedRef = useRef(expanded);
  const focusChipNextRef = useRef(false);
  useLayoutEffect(() => {
    const wasExpanded = wasExpandedRef.current;
    wasExpandedRef.current = expanded;
    if (!wasExpanded && expanded && selectedId && !showsCollapsedCard) {
      inputRef.current?.focus({ preventScroll: true });
    }
    if (focusChipNextRef.current && showsCollapsedCard) {
      focusChipNextRef.current = false;
      collapsedCardRef.current?.focus({ preventScroll: true });
    }
  });

  const collapseToCard = () => {
    focusChipNextRef.current = true;
    setExpanded(false);
  };

  const select = (id: string) => {
    const repick = id === selectedId;
    onSelect(id);
    if (repick) collapseToCard();
    else setExpanded(false);
    setSearchFilter("");
    setFilterCleared(false);
    setAnnounced("");
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const consume = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    switch (event.key) {
      case "ArrowDown":
        consume();
        move(1);
        return;
      case "ArrowUp":
        consume();
        move(-1);
        return;
      case "Enter":
        if (highlighted === null) return;
        consume();
        select(highlighted);
        return;
      case "Escape":
        if (searchFilter) {
          consume();
          setSearchFilter("");
          setFilterCleared(true);
          setAnnounced(SHOWING_ALL);
          return;
        }
        if (selectedId && selected && expanded) {
          consume();
          collapseToCard();
        }
        return;
      case "ArrowLeft":
      case "ArrowRight":
        if (searchFilter) return;
        if (focusAdjacentColumn(inputRef.current, event.key === "ArrowRight" ? 1 : -1)) consume();
        return;
      default:
        return;
    }
  };

  if (showsCollapsedCard && selected) {
    return (
      <button
        ref={collapsedCardRef}
        type="button"
        className={`w-full text-left ${COLUMN_CARD} flex items-center justify-between gap-3 cursor-pointer text-ink hover:bg-hover-raised focus-outline`}
        aria-label={`${title}: ${selected.name}, change`}
        aria-expanded={false}
        onClick={() => setExpanded(true)}
        onKeyDown={(e) => activateOnEnter(e, () => setExpanded(true))}
      >
        <span className="min-w-0">
          <span className="block text-xs text-ink-3">{title}</span>
          <span className="block font-semibold truncate">{selected.name}</span>
        </span>
        <ChevronDownIcon className="w-5 h-5 shrink-0 text-ink-3" aria-hidden="true" />
      </button>
    );
  }

  return (
    <div className={`${COLUMN_CARD} text-ink`}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-semibold">{title}</h3>
        {selectedId && expanded && (
          <button
            type="button"
            onClick={collapseToCard}
            onKeyDown={(e) => activateOnEnter(e, collapseToCard)}
            aria-label={`Collapse ${title.toLowerCase()}`}
            aria-expanded={true}
            className="p-2 -m-2 rounded focus-outline"
          >
            <ChevronUpIcon className="w-5 h-5 text-ink-3" aria-hidden="true" />
          </button>
        )}
      </div>
      <Input
        bare
        ref={inputRef}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={rows.length > 0}
        aria-controls={rows.length > 0 ? popupId : undefined}
        aria-activedescendant={highlighted !== null ? optionDomId(highlighted) : undefined}
        autoComplete="off"
        spellCheck={false}
        value={searchFilter}
        onChange={(e) => {
          const next = e.target.value;
          setFilterCleared(next === "" && searchFilter !== "");
          setSearchFilter(next);
        }}
        onKeyDown={onSearchKeyDown}
        className="w-full p-2 mb-3 text-sm"
        placeholder={`Search ${title.toLowerCase()}...`}
        aria-label={`Search ${title.toLowerCase()}`}
      />
      <p className="sr-only" role="status">
        {announced}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-3 py-2">
          {searchFilter ? "No matches found" : `No ${title.toLowerCase()} here yet.`}
        </p>
      ) : (
        <div
          ref={listRef}
          id={popupId}
          role="listbox"
          aria-label={title}
          className="space-y-2 max-h-[400px] overflow-y-auto"
        >
          {rows.map((item) => {
            const isSelected = selectedId === item.id;
            const isHighlighted = highlighted === item.id;
            return (
              <button
                key={item.id}
                id={optionDomId(item.id)}
                type="button"
                role="option"
                aria-selected={isSelected}
                tabIndex={-1}
                onClick={() => select(item.id)}
                onKeyDown={(e) => activateOnEnter(e, () => select(item.id))}
                className={`w-full text-left p-3 rounded-md border transition-colors focus-outline ${
                  isSelected ? selectedColor : isHighlighted ? HIGHLIGHT_TINT : ROW_IDLE
                }${isHighlighted ? ` ${HIGHLIGHT_STROKE}` : ""}`}
              >
                <span className="block font-semibold">{item.name}</span>
                {item.description && (
                  <span className={`block ${DESCRIPTION_TONE}`}>{item.description}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

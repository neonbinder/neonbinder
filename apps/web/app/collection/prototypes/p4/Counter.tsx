import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  AdjustmentsHorizontalIcon,
  BookOpenIcon,
  MagnifyingGlassIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { Input } from "@/components/primitives/Input";
import { LiveLine } from "@/components/modules/RunLedger";
import CardFace from "../_shared/CardFace";
import CopyDetailsForm from "../_shared/CopyDetailsForm";
import {
  cardLabel,
  emptyCopyDetails,
  getCard,
  getSet,
  leadTeam,
  playerNames,
  printRunLabel,
  setLabel,
  teamNames,
  teamTextColor,
  variantLabel,
  type Card,
  type Condition,
  type CopyDetails,
  type VariantPath,
} from "../_shared/data";
import type { PrototypeStore } from "../_shared/usePrototypeStore";
import BrowseChecklistDialog from "./BrowseChecklistDialog";
import Ledger, { ledgerTally, type LedgerEntry } from "./Ledger";
import {
  counterSearch,
  scopeLabel,
  scopeOf,
  sharedNumber,
  unambiguousHits,
  type Scope,
} from "./counterSearch";
import {
  GO_BTN,
  ICON_BTN,
  PANEL,
  QUIET_BTN,
  RING,
  SELECT,
  chipClass,
  money,
} from "./ui";

/**
 * NEO-350 prototype 4 — the Counter: one big box for a dealer working
 * through a stack of cards in hand.
 *
 * - Type what's on the card; matches stream underneath. ↑/↓ moves, Enter
 *   adds one copy, Shift+Enter opens the details form for it. The box clears
 *   and refocuses for the next card.
 * - Several cards sharing a number are all shown and none is pre-highlighted:
 *   the dealer picks.
 * - The first add pins a sticky SCOPE (set + variant), so the next card out
 *   of the same box is just its number. "1-5, 9" keys a run; Ctrl+Enter adds
 *   every unambiguous one. Escape on an empty box drops the scope.
 * - Sticky DETAILS (location, binder, condition, pile, cost each) ride along
 *   on every add until cleared.
 */

const MAX_SHOWN = 40;
const CONDITIONS: Condition[] = [
  "Mint",
  "Near Mint",
  "Excellent",
  "Very Good",
  "Good",
  "Poor",
];

export interface StickyDetails {
  location?: string;
  binderId?: string;
  condition?: Condition;
  forSale: boolean;
  costEach?: number;
}

function stickyPatch(sticky: StickyDetails): Partial<CopyDetails> {
  return {
    location: sticky.location,
    binderIds: sticky.binderId ? [sticky.binderId] : [],
    condition: sticky.condition,
    forSale: sticky.forSale,
    costBasis: sticky.costEach,
  };
}

function variantKey(path: VariantPath): string {
  return `${path.type}|${path.name ?? ""}`;
}

export default function Counter({ store }: { store: PrototypeStore }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const hintId = useId();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope | null>(null);
  const [nav, setNav] = useState<{ key: string; index: number | null }>({
    key: "",
    index: null,
  });
  const [sticky, setSticky] = useState<StickyDetails>({ forSale: false });
  const [stickyOpen, setStickyOpen] = useState(false);
  const [details, setDetails] = useState<{
    card: Card;
    value: CopyDetails;
  } | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [live, setLive] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const timers = useRef<number[]>([]);
  const detailsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => window.clearTimeout(t));
  }, []);

  const result = counterSearch(query, scope);
  const hits = result.hits;
  const shown = hits.slice(0, MAX_SHOWN);
  const resultKey = `${query}|${scope ? `${scope.setId}|${variantKey(scope.variant)}` : ""}`;
  const defaultIndex =
    shown.length > 0 && !sharedNumber(shown[0], hits) ? 0 : null;
  const active = nav.key === resultKey ? nav.index : defaultIndex;
  const activeCard = active !== null ? (shown[active] ?? null) : null;
  const tied = shown.length > 1 && defaultIndex === null;
  const bulk = result.multiple ? unambiguousHits(hits) : null;
  const manualBinders = store.state.binders.filter((b) => b.kind === "manual");

  function focusBox() {
    inputRef.current?.focus();
  }

  function moveActive(delta: number) {
    if (shown.length === 0) return;
    const from = active ?? (delta > 0 ? -1 : shown.length);
    const next = Math.min(shown.length - 1, Math.max(0, from + delta));
    setNav({ key: resultKey, index: next });
    document
      .getElementById(`${listboxId}-${next}`)
      ?.scrollIntoView({ block: "nearest" });
  }

  function addCards(cards: Card[], details?: Partial<CopyDetails>) {
    const added: LedgerEntry[] = [];
    for (const card of cards) {
      const copy = store.addCopy(card.id, {
        ...stickyPatch(sticky),
        quantity: result.quantity,
        ...details,
      });
      added.push({
        key: copy.id,
        copy,
        state: "adding",
        haveAfter: store.ownedCount(card.id) + copy.quantity,
      });
    }
    if (added.length === 0) return;
    const keys = new Set(added.map((a) => a.key));
    setEntries((prev) => [...prev, ...added]);
    // The run-ledger beat: spinner, then the check.
    timers.current.push(
      window.setTimeout(() => {
        setEntries((prev) =>
          prev.map((e) =>
            keys.has(e.key) && e.state === "adding"
              ? { ...e, state: "added" }
              : e,
          ),
        );
      }, 450),
    );

    const last = cards[cards.length - 1];
    if (result.mode !== "numbers" && result.mode !== "scoped")
      setScope(scopeOf(last));
    const tally = ledgerTally([...entries, ...added]).cards;
    const first = added[0];
    setLive(
      cards.length === 1
        ? `Added ${cardLabel(last)}${first.copy.quantity > 1 ? `, ${first.copy.quantity} copies` : ""}. ${
            first.haveAfter > first.copy.quantity
              ? `You have ${first.haveAfter} now. `
              : ""
          }${tally} this session.`
        : `Added ${cards.length} cards from ${scopeLabel(scopeOf(last))}. ${tally} this session.`,
    );
    setQuery("");
    setDetails(null);
    setNote(null);
    focusBox();
  }

  function openDetails(card: Card) {
    setDetails({
      card,
      value: {
        ...emptyCopyDetails(),
        ...stickyPatch(sticky),
        quantity: result.quantity,
      },
    });
    // Straight into the form: Quantity is its first field.
    window.setTimeout(
      () =>
        detailsRef.current?.querySelector<HTMLInputElement>("input")?.focus(),
      0,
    );
  }

  function addAll() {
    if (!bulk) return;
    if (bulk.sure.length === 0) {
      setNote("Every number here has more than one card. Pick each with ↑ ↓.");
      return;
    }
    addCards(bulk.sure);
    if (bulk.ambiguous.length > 0) {
      setNote(
        `${bulk.ambiguous.join(", ")} ${bulk.ambiguous.length === 1 ? "has" : "have"} more than one card, so ${
          bulk.ambiguous.length === 1 ? "it was" : "they were"
        } left out. Type ${bulk.ambiguous.length === 1 ? "it" : "each"} and pick.`,
      );
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && bulk) {
        addAll();
        return;
      }
      if (!activeCard) {
        if (shown.length > 0) {
          setLive(
            tied
              ? `More than one card is #${shown[0].cardNumber}. Pick one with the arrow keys.`
              : "Pick a card with the arrow keys first.",
          );
          setNote(
            tied
              ? `More than one card is #${shown[0].cardNumber}. Pick one with ↓, then Enter.`
              : "Pick a card with ↓, then Enter.",
          );
        }
        return;
      }
      if (e.shiftKey) openDetails(activeCard);
      else addCards([activeCard]);
    } else if (e.key === "Escape") {
      if (details) {
        setDetails(null);
      } else if (query) {
        setQuery("");
        setNote(null);
      } else if (scope) {
        setScope(null);
        setLive("Scope cleared. Searching every set.");
      }
    }
  }

  function undo(key: string) {
    const entry = entries.find((e) => e.key === key);
    if (!entry) return;
    const removed = store.removeCopy(entry.copy.id);
    setEntries((prev) =>
      prev.map((e) =>
        e.key === key ? { ...e, copy: removed ?? e.copy, state: "undone" } : e,
      ),
    );
    setLive(`Undid ${cardLabel(card(entry))}.`);
  }

  function putBack(key: string) {
    const entry = entries.find((e) => e.key === key);
    if (!entry) return;
    store.restoreCopy(entry.copy);
    setEntries((prev) =>
      prev.map((e) => (e.key === key ? { ...e, state: "added" } : e)),
    );
    setLive(`Put back ${cardLabel(card(entry))}.`);
  }

  const stickySummary = [
    sticky.location,
    sticky.binderId ? store.getBinder(sticky.binderId)?.name : undefined,
    sticky.condition,
    sticky.forSale ? "For Sale" : undefined,
    sticky.costEach !== undefined
      ? `${money(sticky.costEach)} each`
      : undefined,
  ].filter(Boolean) as string[];

  const scopeSet = scope ? getSet(scope.setId) : null;

  return (
    <div className="grid gap-x-4 gap-y-3 md:grid-cols-[minmax(0,1fr)_15rem]">
      {/* The box. Sticky on a phone so it never scrolls away mid-stack. */}
      <div className="z-10 -mx-4 min-w-0 bg-black px-4 pb-2 pt-2 max-sm:sticky max-sm:top-0 sm:mx-0 sm:px-0 sm:pt-0 md:col-start-1 md:row-start-1 sm:pb-0">
        <div className="rounded-lg border-2 border-neon-blue/70 bg-black p-2 transition-shadow focus-within:shadow-[0_0_0_1px_#00C2FF,0_0_28px_rgba(0,194,255,0.3)] sm:p-3">
          {scope && scopeSet && (
            <div className="mb-2 flex">
              <div className="flex min-w-0 max-w-full items-center gap-1 rounded-md border border-neon-blue bg-neon-blue/10 py-0.5 pl-2 pr-0.5 text-sm text-white">
                <span className="shrink-0 text-neon-blue">In:</span>
                <span className="min-w-0 truncate font-semibold">{setLabel(scopeSet)}</span>
                <select
                  aria-label="Base, insert or parallel to key from"
                  className={`ml-1 max-w-[11rem] rounded border border-slate-600 bg-slate-900 px-1 py-0.5 text-sm text-slate-100 min-h-9 sm:min-h-7 ${RING}`}
                  value={variantKey(scope.variant)}
                  onChange={(e) => {
                    const v = scopeSet.variants.find((x) => variantKey(x.path) === e.target.value);
                    if (v) setScope({ setId: scope.setId, variant: v.path });
                  }}
                >
                  {scopeSet.variants.map((v) => (
                    <option key={variantKey(v.path)} value={variantKey(v.path)}>
                      {variantLabel(v.path)}
                      {v.printRun ? ` /${v.printRun}` : ""}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label="Clear scope and search every set"
                  title="Clear scope (Esc on an empty box)"
                  onClick={() => {
                    setScope(null);
                    focusBox();
                  }}
                  className={ICON_BTN}
                >
                  <XMarkIcon aria-hidden="true" className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          <div className="relative">
            <MagnifyingGlassIcon
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-6 w-6 -translate-y-1/2 text-neon-blue"
            />
            <Input
              bare
              ref={inputRef}
              role="combobox"
              aria-label="Card search"
              aria-autocomplete="list"
              aria-expanded={shown.length > 0}
              aria-controls={listboxId}
              aria-activedescendant={active !== null ? `${listboxId}-${active}` : undefined}
              aria-describedby={hintId}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                scope
                  ? "Card number, a run like 1-9, or a name"
                  : "Type what's on the card — 96 contenders white"
              }
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setNote(null);
                if (details) setDetails(null);
              }}
              onKeyDown={onKeyDown}
              className="h-14 w-full pl-12 pr-3 text-lg font-semibold tracking-tight sm:h-16 sm:text-2xl"
            />
          </div>

          <p
            id={hintId}
            className="mt-2 hidden flex-wrap gap-x-3 gap-y-1 text-xs text-slate-400 sm:flex"
          >
            <span>
              <Key>↑</Key>
              <Key>↓</Key> pick
            </span>
            <span>
              <Key>Enter</Key> add 1
            </span>
            <span>
              <Key>Shift</Key>
              <Key>Enter</Key> details
            </span>
            {result.multiple && (
              <span>
                <Key>Ctrl</Key>
                <Key>Enter</Key> the whole run
              </span>
            )}
            <span>
              <Key>Esc</Key> {query ? "clear" : scope ? "drop scope" : "clear"}
            </span>
            <span>
              <Key>x3</Key> three copies
            </span>
          </p>
        </div>
      </div>

      {/* Counter tools: beside the box on a desktop, under it on a phone. */}
      <div className="flex flex-wrap content-start gap-2 md:col-start-2 md:row-start-1 md:flex-col md:flex-nowrap">
        <button
          type="button"
          aria-expanded={stickyOpen}
          onClick={() => setStickyOpen((v) => !v)}
          className={`${QUIET_BTN} md:w-full md:justify-start`}
        >
          <AdjustmentsHorizontalIcon aria-hidden="true" className="h-4 w-4" />
          Sticky details
          {stickySummary.length > 0 && (
            <span className="rounded-full bg-neon-blue px-1.5 text-xs font-bold text-black">
              {stickySummary.length}
              <span className="sr-only"> set</span>
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setBrowseOpen(true)}
          className={`${QUIET_BTN} md:w-full md:justify-start`}
        >
          <BookOpenIcon aria-hidden="true" className="h-4 w-4" />
          Browse checklists
        </button>
        {stickySummary.length > 0 && !stickyOpen && (
          <p className="w-full text-xs text-slate-300">
            Every add gets:{" "}
            <span className="font-medium text-white">{stickySummary.join(", ")}</span>
          </p>
        )}
      </div>

      <div className="min-w-0 space-y-3 md:col-start-1 md:row-start-2">
        {stickyOpen && (
          <StickyPanel
            sticky={sticky}
            onChange={setSticky}
            binders={manualBinders.map((b) => ({ id: b.id, name: b.name }))}
            onDone={() => {
              setStickyOpen(false);
              focusBox();
            }}
          />
        )}

        {/* What the box found. */}
        {details ? (
          <div ref={detailsRef}>
            <p className="mb-2 text-sm text-slate-300">
              {setLabel(getSet(details.card.setId))}, {variantLabel(details.card.variantPath)}.
              {stickySummary.length > 0 ? " Your sticky details are already in." : ""}
            </p>
            <CopyDetailsForm
              card={details.card}
              value={details.value}
              onChange={(value) => setDetails({ card: details.card, value })}
              onSave={(value) => addCards([details.card], value)}
              onCancel={() => {
                setDetails(null);
                focusBox();
              }}
              binders={store.state.binders}
              heading={`Details for #${details.card.cardNumber} ${playerNames(details.card)}`}
              saveLabel="Add to collection"
            />
          </div>
        ) : (
          <Results
            query={query}
            mode={result.mode}
            scope={scope}
            shown={shown}
            total={hits.length}
            notOnChecklist={result.notOnChecklist}
            active={active}
            tied={tied}
            listboxId={listboxId}
            store={store}
            quantity={result.quantity}
            bulkCount={bulk?.sure.length ?? 0}
            note={note}
            onHover={(i) => setNav({ key: resultKey, index: i })}
            onPick={(c) => addCards([c])}
            onAddActive={() => activeCard && addCards([activeCard])}
            onDetailsActive={() => activeCard && openDetails(activeCard)}
            onAddAll={addAll}
            onExample={(q) => {
              setQuery(q);
              focusBox();
            }}
            activeCard={activeCard}
          />
        )}
      </div>

      <div className="md:sticky md:top-24 md:col-start-2 md:row-start-2 md:flex md:max-h-[calc(100vh-7rem)] md:flex-col md:self-start">
        <Ledger
          entries={entries}
          onUndo={undo}
          onPutBack={putBack}
          onClear={() => {
            setEntries((prev) => prev.filter((e) => e.state === "adding"));
            setLive("New stack. The ledger is clear; your cards stay put.");
            focusBox();
          }}
        />
      </div>

      <LiveLine text={live} />

      {browseOpen && (
        <BrowseChecklistDialog
          store={store}
          initial={scope}
          onClose={() => setBrowseOpen(false)}
          onWork={(s) => {
            setScope(s);
            setBrowseOpen(false);
            setQuery("");
            setLive(`Scope set: ${scopeLabel(s)}. Type card numbers.`);
            // The dialog restores focus to its opener on unmount; the box
            // wants it instead, after that.
            window.setTimeout(focusBox, 0);
          }}
        />
      )}
    </div>
  );
}

function card(entry: LedgerEntry): Card {
  return getCard(entry.copy.cardId);
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mr-0.5 rounded border border-slate-600 bg-slate-900 px-1 font-sans text-[11px] text-slate-200">
      {children}
    </kbd>
  );
}

function Results({
  query,
  mode,
  scope,
  shown,
  total,
  notOnChecklist,
  active,
  tied,
  listboxId,
  store,
  quantity,
  bulkCount,
  note,
  activeCard,
  onHover,
  onPick,
  onAddActive,
  onDetailsActive,
  onAddAll,
  onExample,
}: {
  query: string;
  mode: ReturnType<typeof counterSearch>["mode"];
  scope: Scope | null;
  shown: Card[];
  total: number;
  notOnChecklist: string[];
  active: number | null;
  tied: boolean;
  listboxId: string;
  store: PrototypeStore;
  quantity: number;
  bulkCount: number;
  note: string | null;
  activeCard: Card | null;
  onHover: (i: number) => void;
  onPick: (c: Card) => void;
  onAddActive: () => void;
  onDetailsActive: () => void;
  onAddAll: () => void;
  onExample: (q: string) => void;
}) {
  // The listbox is always in the tree so aria-controls always resolves.
  const listbox = (
    <ul
      id={listboxId}
      role="listbox"
      aria-label="Matching cards"
      className={shown.length ? "divide-y divide-slate-800" : "hidden"}
    >
      {shown.map((c, i) => (
        <ResultRow
          key={c.id}
          id={`${listboxId}-${i}`}
          card={c}
          active={i === active}
          have={store.ownedCount(c.id)}
          onHover={() => onHover(i)}
          onPick={() => onPick(c)}
        />
      ))}
    </ul>
  );

  if (!query.trim()) {
    return (
      <div className={`${PANEL} p-4`}>
        {listbox}
        <h2 className="text-base font-bold text-white">
          Next card off the stack
        </h2>
        <p className="mt-1 text-sm text-slate-300">
          {scope
            ? `You're in ${scopeLabel(scope)}. Just the number does it: 27. A run: 1-9. A handful: 3 6 13.`
            : "Year, set and last name, in any order. Numbers, teams and parallels work too."}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {(scope
            ? ["27", "1-9", "3 6 13"]
            : [
                "96 contenders white",
                "griffey refractor",
                "13",
                "red wings howe",
              ]
          ).map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => onExample(q)}
              className={chipClass(false)}
            >
              Try “{q}”
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`${PANEL} overflow-hidden`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-2">
        <p className="mr-auto text-sm text-slate-300" aria-live="polite">
          {total === 0
            ? mode === "numbers"
              ? `No #${notOnChecklist.join(", #")} on the ${scope ? scopeLabel(scope) : ""} checklist.`
              : `Nothing matches “${query.trim()}”. Check the year, or try just the last name.`
            : `${total} ${total === 1 ? "match" : "matches"}${
                total > shown.length
                  ? `, showing the first ${shown.length}. Keep typing to narrow it`
                  : ""
              }${quantity > 1 ? `. Adding ×${quantity} each` : ""}.`}
        </p>
        {shown.length > 0 && (
          <>
            {bulkCount > 1 && (
              <button type="button" onClick={onAddAll} className={GO_BTN}>
                Add all {bulkCount}
              </button>
            )}
            <button
              type="button"
              onClick={onAddActive}
              disabled={!activeCard}
              className={bulkCount > 1 ? QUIET_BTN : GO_BTN}
              aria-label={
                activeCard
                  ? `Add 1 ${cardLabel(activeCard)}`
                  : "Add 1, pick a card first"
              }
            >
              Add {quantity > 1 ? quantity : 1}
            </button>
            <button
              type="button"
              onClick={onDetailsActive}
              disabled={!activeCard}
              className={QUIET_BTN}
              aria-label={
                activeCard
                  ? `Add ${cardLabel(activeCard)} with details`
                  : "Add with details, pick a card first"
              }
            >
              + details
            </button>
          </>
        )}
      </div>
      {mode === "fallback" && scope && (
        <p className="border-b border-slate-800 bg-slate-900/60 px-3 py-2 text-sm text-slate-300">
          Nothing like that in {scopeLabel(scope)}, so here is every set. Adding
          one moves your scope there.
        </p>
      )}
      {mode === "numbers" && notOnChecklist.length > 0 && total > 0 && (
        <p className="border-b border-slate-800 bg-slate-900/60 px-3 py-2 text-sm text-slate-300">
          Not on this checklist: #{notOnChecklist.join(", #")}.
        </p>
      )}
      {(tied || note) && (
        <p className="border-b border-slate-800 bg-neon-yellow/10 px-3 py-2 text-sm text-neon-yellow">
          {note ??
            `More than one card is #${shown[0].cardNumber}. Pick yours with ↓, then Enter.`}
        </p>
      )}
      <div className="max-h-[60vh] overflow-y-auto">{listbox}</div>
    </div>
  );
}

function ResultRow({
  id,
  card,
  active,
  have,
  onHover,
  onPick,
}: {
  id: string;
  card: Card;
  active: boolean;
  have: number;
  onHover: () => void;
  onPick: () => void;
}) {
  const team = leadTeam(card);
  const run = printRunLabel(card);
  const set = getSet(card.setId);
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      aria-label={`${cardLabel(card)}, ${have > 0 ? `have ${have}` : "need"}`}
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={() => {
        if (!active) onHover();
      }}
      onClick={onPick}
      className={`flex cursor-pointer items-center gap-3 border-l-4 px-3 py-2 ${
        active
          ? "border-neon-blue bg-slate-800"
          : "border-transparent hover:bg-slate-900"
      }`}
    >
      <div aria-hidden="true" className="w-9 shrink-0">
        <CardFace card={card} size="fill" state={have > 0 ? "owned" : "need"} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-base text-white">
          <span className="font-bold tabular-nums">#{card.cardNumber}</span>{" "}
          <span className="font-medium">{playerNames(card)}</span>{" "}
          <span
            className="text-sm"
            style={{
              color: teamTextColor(team, active ? "#1E293B" : "#020617"),
            }}
          >
            {teamNames(card)}
          </span>
        </p>
        <p className="truncate text-xs text-slate-400">
          {setLabel(set)}, {variantLabel(card.variantPath)}
          {run ? ` ${run}` : ""}
          {card.variation ? `, ${card.variation} variation` : ""}
          {card.features.length ? `, ${card.features.join(" ")}` : ""}
        </p>
      </div>
      <span
        aria-hidden="true"
        className={`shrink-0 rounded-md border px-2 py-0.5 text-xs font-semibold ${
          have > 0
            ? "border-neon-green text-white"
            : "border-slate-600 text-slate-300"
        }`}
      >
        {have > 0 ? `Have ${have}` : "Need"}
      </span>
    </li>
  );
}

function StickyPanel({
  sticky,
  onChange,
  binders,
  onDone,
}: {
  sticky: StickyDetails;
  onChange: (s: StickyDetails) => void;
  binders: { id: string; name: string }[];
  onDone: () => void;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={`${PANEL} p-3`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onDone();
        }
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-base font-bold text-white">
          Sticky details
        </h2>
        <p className="text-xs text-slate-400">
          Set once. Every add this session gets them.
        </p>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Input
          label="Location"
          placeholder="Box 3"
          inputSize="small"
          value={sticky.location ?? ""}
          onChange={(e) =>
            onChange({ ...sticky, location: e.target.value || undefined })
          }
        />
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-300">
            Binder
          </span>
          <select
            className={`${SELECT} w-full`}
            value={sticky.binderId ?? ""}
            onChange={(e) =>
              onChange({ ...sticky, binderId: e.target.value || undefined })
            }
          >
            <option value="">None</option>
            {binders.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-300">
            Condition
          </span>
          <select
            className={`${SELECT} w-full`}
            value={sticky.condition ?? ""}
            onChange={(e) =>
              onChange({
                ...sticky,
                condition: (e.target.value || undefined) as
                  Condition | undefined,
              })
            }
          >
            <option value="">Not set</option>
            {CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <Input
          label="Cost each"
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          placeholder="0.25"
          inputSize="small"
          value={sticky.costEach ?? ""}
          onChange={(e) => {
            const n =
              e.target.value === "" ? undefined : Number(e.target.value);
            onChange({
              ...sticky,
              costEach:
                n !== undefined && Number.isFinite(n) && n >= 0 ? n : undefined,
            });
          }}
        />
        <fieldset className="sm:col-span-2">
          <legend className="mb-1 block text-sm font-medium text-slate-300">
            Which pile
          </legend>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={!sticky.forSale}
              onClick={() => onChange({ ...sticky, forSale: false })}
              className={chipClass(!sticky.forSale)}
            >
              {!sticky.forSale && <span aria-hidden="true">✓</span>}
              My PC
            </button>
            <button
              type="button"
              aria-pressed={sticky.forSale}
              onClick={() => onChange({ ...sticky, forSale: true })}
              className={chipClass(sticky.forSale)}
            >
              {sticky.forSale && <span aria-hidden="true">✓</span>}
              For Sale
            </button>
          </div>
        </fieldset>
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={() => onChange({ forSale: false })}
          className={QUIET_BTN}
        >
          Clear sticky details
        </button>
        <button type="button" onClick={onDone} className={GO_BTN}>
          Done, back to the box
        </button>
      </div>
    </section>
  );
}

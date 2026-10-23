import { forwardRef, useMemo, useState } from "react";
import { Input } from "@/components/primitives/Input";
import NeonButton from "@/components/modules/NeonButton";
import {
  cardsInSet,
  getSet,
  normalizeSearchText,
  playerNames,
  setLabel,
  teamNames,
  variantLabel,
  type Card,
  type VariantFilter,
} from "../_shared/data";
import type { PrototypeStore } from "../_shared/usePrototypeStore";
import ChecklistRow from "./ChecklistRow";
import type { Notify } from "./notice";
import { parseRange } from "./range";
import SleeveStrip from "./SleeveStrip";
import { CHIP, CHIP_OFF, CHIP_ON, FOCUS, shortCardName } from "./ui";

type Show = "all" | "have" | "need";

/**
 * The checklist under the cascade: the admin CardChecklist's panel and rows,
 * turned toward the collector. Have toggles on every row, a show-only
 * Have/Need filter, an in-list search, and "Mark a range" for ticking off a
 * stack of cards at once.
 */
const Checklist = forwardRef<
  HTMLHeadingElement,
  {
    setId: string;
    filter: VariantFilter;
    store: PrototypeStore;
    notify: Notify;
    selectedCardId: string | null;
    onOpen: (card: Card, list: Card[]) => void;
    onToggleHave: (card: Card) => void;
  }
>(function Checklist({ setId, filter, store, notify, selectedCardId, onOpen, onToggleHave }, headingRef) {
  const set = getSet(setId);
  const cards = useMemo(() => cardsInSet(setId, filter), [setId, filter]);
  const ownedIds = new Set(cards.filter((c) => store.ownedCount(c.id) > 0).map((c) => c.id));
  const completion = store.completion(setId, filter);
  const building = store.isBuilding(setId);
  const title = `${setLabel(set)} ${variantLabel(filter.type === "Base" ? { type: "Base", name: null } : { type: filter.type, name: filter.name ?? null })}`;

  const [show, setShow] = useState<Show>("all");
  const [query, setQuery] = useState("");
  const [rangeText, setRangeText] = useState("");
  /** For numbers two cards share: which of them the collector means. */
  const [sharedPicks, setSharedPicks] = useState<Set<string>>(new Set());

  const needle = normalizeSearchText(query).replace(/^#/, "");
  const visible = cards.filter((c) => {
    const have = ownedIds.has(c.id);
    if (show === "have" && !have) return false;
    if (show === "need" && have) return false;
    if (!needle) return true;
    const hay = normalizeSearchText(
      `${c.cardNumber} ${playerNames(c)} ${teamNames(c)} ${c.variation ?? ""} ${c.features.join(" ")}`,
    );
    return needle.split(/\s+/).every((t) => hay.includes(t));
  });

  const range = rangeText.trim() ? parseRange(rangeText, cards) : null;
  const rangeCards = range
    ? [
        ...range.single,
        ...range.shared.flatMap((s) => s.cards.filter((c) => sharedPicks.has(c.id))),
      ]
    : [];
  const toAdd = rangeCards.filter((c) => !ownedIds.has(c.id));
  const alreadyHave = rangeCards.length - toAdd.length;

  const markRange = () => {
    if (toAdd.length === 0) return;
    const added = toAdd.map((c) => store.addCopy(c.id));
    notify(
      `Marked ${added.length} ${added.length === 1 ? "card" : "cards"} as Have`,
      () => added.forEach((copy) => store.removeCopy(copy.id)),
    );
    setRangeText("");
    setSharedPicks(new Set());
  };

  const showButton = (value: Show, label: string) => (
    <button
      type="button"
      aria-pressed={show === value}
      onClick={() => setShow(value)}
      className={`${CHIP} ${show === value ? CHIP_ON : CHIP_OFF}`}
    >
      {label}
    </button>
  );

  return (
    <section aria-labelledby={`checklist-${setId}`} className="bg-gray-800 p-4 sm:p-6 rounded-lg text-slate-100 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <h3
            id={`checklist-${setId}`}
            ref={headingRef}
            tabIndex={-1}
            className="text-xl font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] rounded-sm"
          >
            {title}
          </h3>
          <p className="text-sm text-slate-300">
            Have <span className="font-semibold text-slate-100 tabular-nums">{completion.owned}</span> of{" "}
            <span className="tabular-nums">{completion.total}</span>
            {completion.total > 0 && completion.owned === completion.total
              ? " · Complete. Totally rad."
              : ` · Need ${completion.total - completion.owned}`}
          </p>
          <SleeveStrip cards={cards} ownedIds={ownedIds} />
        </div>
        <button
          type="button"
          aria-pressed={building}
          onClick={() => {
            store.toggleBuilding(setId);
            notify(building ? `Stopped building ${setLabel(set)}` : `Building ${setLabel(set)}: its needs are on your Want List`);
          }}
          className={`${CHIP} ${building ? CHIP_ON : CHIP_OFF}`}
        >
          {building ? "✓ " : ""}Building this set
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div role="search" className="flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1">
            <Input
              surface="dark"
              type="search"
              label="Search this checklist"
              placeholder="Number, player, team"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  setQuery("");
                }
              }}
              autoComplete="off"
            />
          </div>
          <div role="group" aria-label="Show" className="flex gap-1.5 pb-1">
            {showButton("all", "All")}
            {showButton("have", "Haves")}
            {showButton("need", "Needs")}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[12rem] flex-1">
              <Input
                surface="dark"
                label="Mark a range as Have"
                placeholder="1-20, -12"
                value={rangeText}
                onChange={(e) => setRangeText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    markRange();
                  }
                  if (e.key === "Escape" && rangeText) {
                    e.preventDefault();
                    setRangeText("");
                  }
                }}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <NeonButton
              type="button"
              variant="primary"
              disabled={toAdd.length === 0}
              onClick={markRange}
              className={FOCUS}
            >
              {toAdd.length > 0 ? `Mark ${toAdd.length} as Have` : "Mark as Have"}
            </NeonButton>
          </div>
          {range && (
            <div className="space-y-2 text-sm text-slate-300">
              <p>
                {toAdd.length === 0 && rangeCards.length === 0
                  ? "No cards picked yet."
                  : `${toAdd.length} to add`}
                {alreadyHave > 0 && `, ${alreadyHave} already in your collection`}
                {range.unknown.length > 0 && `. Not on this checklist: ${range.unknown.join(", ")}`}
              </p>
              {range.shared.map((s) => (
                <div key={s.number} role="group" aria-label={`Cards numbered ${s.number}`} className="flex flex-wrap items-center gap-1.5">
                  <span className="text-slate-300">#{s.number} is on {s.cards.length} cards. Tick yours:</span>
                  {s.cards.map((c) => {
                    const on = sharedPicks.has(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setSharedPicks((prev) => {
                            const next = new Set(prev);
                            if (on) next.delete(c.id);
                            else next.add(c.id);
                            return next;
                          })
                        }
                        className={`${CHIP} ${on ? CHIP_ON : CHIP_OFF}`}
                      >
                        {shortCardName(c)}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <p role="status" className="text-xs text-slate-400 tabular-nums">
        {visible.length === cards.length ? `${cards.length} cards` : `${visible.length} of ${cards.length} cards`}
      </p>
      {visible.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-700 px-3 py-2 text-sm text-slate-400">
          {show === "need" && !query ? "Nothing left to chase here. Set complete!" : "No cards match."}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {visible.map((card) => (
            <ChecklistRow
              key={card.id}
              card={card}
              owned={store.ownedCount(card.id)}
              isSelected={card.id === selectedCardId}
              onToggleHave={() => onToggleHave(card)}
              onOpen={() => onOpen(card, visible)}
            />
          ))}
        </ul>
      )}
    </section>
  );
});

export default Checklist;

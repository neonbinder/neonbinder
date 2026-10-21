import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/primitives/Button";
import { Input } from "@/components/primitives/Input";
import {
  cardsInSet,
  getSet,
  normalizeSearchText,
  playerNames,
  setLabel,
  teamNames,
  variantLabel,
  type Card,
  type CardId,
  type VariantFilter,
} from "../prototypes/_shared/data";
import { parseRange } from "../prototypes/p1/range";
import SleeveStrip from "../prototypes/p1/SleeveStrip";
import { CHIP, CHIP_OFF, CHIP_ON, FOCUS, shortCardName } from "../prototypes/p1/ui";
import CardRowGroup, { type RowActions } from "./CardRows";
import type { CollectionStore, Notify } from "./store";
import BinderPicker from "./BinderPicker";
import { blockedMessage, pickFirstLabel, runPlan } from "./cards/model";

type Show = "all" | "have" | "need";

/**
 * The checklist under the cascade (prototype 1's, consolidated): progress
 * strip, "Building this set", the "Adding to" binder, an in-list search with
 * All / Haves / Needs, "Mark a range as Have", and the rows. A card owned in
 * several line items shows one row per line.
 */
const Checklist = forwardRef<
  HTMLHeadingElement,
  {
    setId: string;
    filter: VariantFilter;
    store: CollectionStore;
    actions: RowActions;
    notify: Notify;
    selectedCardId: string | null;
    /** Jumped here from search: scroll to this card's row and ring it. */
    highlightCardId: CardId | null;
  }
>(function Checklist(
  { setId, filter, store, actions, notify, selectedCardId, highlightCardId },
  headingRef,
) {
  const set = getSet(setId);
  const cards = useMemo(() => cardsInSet(setId, filter), [setId, filter]);
  const ownedIds = new Set(cards.filter((c) => store.ownedInScope(c.id) > 0).map((c) => c.id));
  const completion = store.completionInScope(setId, filter);
  const building = store.isBuilding(setId);
  const title = `${setLabel(set)} ${variantLabel(filter.type === "Base" ? { type: "Base", name: null } : { type: filter.type, name: filter.name ?? null })}`;
  const target = store.getBinder(store.targetBinderId);
  /** The binder the counts and rows are narrowed to, when one is picked. */
  const scoped = store.fileableBinders.find((b) => b.id === store.selectedBinderId);

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

  // A card number is never unique: `parseRange` hands back every number two
  // cards share in `shared`. Stop and ask: until each one is picked (or taken
  // out with -N) the whole run is held, the same rule as My Cards' Quick add.
  const range = rangeText.trim() ? parseRange(rangeText, cards) : null;
  const plan = runPlan(range, sharedPicks, (id) => ownedIds.has(id));
  const { cards: rangeCards, toAdd, already: alreadyHave, blocked } = plan;

  const markRange = () => {
    if (blocked || toAdd.length === 0) return;
    const added = toAdd.map((c) => store.addHave(c.id));
    notify(
      `Marked ${added.length} ${added.length === 1 ? "card" : "cards"} as Have, into ${target?.name ?? "Main"}`,
      () => added.forEach((copy) => store.removeCopy(copy.id)),
    );
    setRangeText("");
    setSharedPicks(new Set());
  };

  // --- Jump from search: bring the row into view and put the caret on it ---
  const rowEls = useRef(new Map<CardId, HTMLLIElement>());
  useEffect(() => {
    if (!highlightCardId) return;
    const frame = requestAnimationFrame(() => {
      const el = rowEls.current.get(highlightCardId);
      if (!el) return;
      el.scrollIntoView({ block: "center" });
      el.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [highlightCardId]);

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
    <section aria-labelledby={`checklist-${setId}`} className="space-y-4 rounded-lg bg-gray-800 p-4 text-slate-100 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <h3
            id={`checklist-${setId}`}
            ref={headingRef}
            tabIndex={-1}
            className="rounded-sm text-xl font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
          >
            {title}
          </h3>
          <p className="text-sm text-slate-300">
            {scoped && <span className="text-neon-blue">In {scoped.name}: </span>}
            Have <span className="font-semibold tabular-nums text-slate-100">{completion.owned}</span> of{" "}
            <span className="tabular-nums">{completion.total}</span>
            {completion.total > 0 && completion.owned === completion.total
              ? " · Complete. Totally rad."
              : ` · Need ${completion.total - completion.owned}`}
          </p>
          <SleeveStrip cards={cards} ownedIds={ownedIds} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <BinderPicker store={store} />
          <button
            type="button"
            aria-pressed={building}
            onClick={() => {
              store.toggleBuilding(setId);
              notify(building ? `Stopped building ${setLabel(set)}` : `Building ${setLabel(set)}. Go get 'em.`);
            }}
            className={`${CHIP} ${building ? CHIP_ON : CHIP_OFF}`}
          >
            {building ? "✓ " : ""}Building this set
          </button>
        </div>
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
            <Button
              type="button"
              variant="primary"
              disabled={blocked || toAdd.length === 0}
              onClick={markRange}
              className={FOCUS}
            >
              {pickFirstLabel(plan) ?? (toAdd.length > 0 ? `Mark ${toAdd.length} as Have` : "Mark as Have")}
            </Button>
          </div>
          {range && (
            <div className="space-y-2 text-sm text-slate-300">
              <p>
                {toAdd.length === 0 && rangeCards.length === 0
                  ? "No cards picked yet."
                  : `${toAdd.length} to add to ${target?.name ?? "Main"}`}
                {alreadyHave > 0 && `, ${alreadyHave} already in your collection`}
                {range.unknown.length > 0 && `. Not on this checklist: ${range.unknown.join(", ")}`}
              </p>
              {blocked && <p className="text-neon-yellow">{blockedMessage(plan)}</p>}
              {range.shared.map((s) => (
                <div
                  key={s.number}
                  role="group"
                  aria-label={`Cards numbered ${s.number}`}
                  className="flex flex-wrap items-center gap-1.5 rounded-md border border-neon-yellow/50 bg-neon-yellow/5 px-2 py-1.5"
                >
                  <span className="text-slate-200">#{s.number} is on {s.cards.length} cards. Which one's yours?</span>
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

      <p role="status" className="text-xs tabular-nums text-slate-400">
        {visible.length === cards.length ? `${cards.length} cards` : `${visible.length} of ${cards.length} cards`}
      </p>
      {visible.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-700 px-3 py-2 text-sm text-slate-400">
          {show === "need" && !query ? "Nothing left to chase here. Set complete!" : "No cards match."}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {visible.map((card: Card) => (
            <CardRowGroup
              key={card.id}
              card={card}
              store={store}
              actions={{
                ...actions,
                open: (c, copyId) => actions.open(c, copyId, visible),
              }}
              isSelected={card.id === selectedCardId}
              highlighted={card.id === highlightCardId}
              groupRef={(el) => {
                if (el) rowEls.current.set(card.id, el);
                else rowEls.current.delete(card.id);
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
});

export default Checklist;

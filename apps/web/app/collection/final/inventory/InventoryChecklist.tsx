import { forwardRef, useEffect, useId, useMemo, useRef, useState } from "react";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import { CHIP, CHIP_OFF, CHIP_ON, FOCUS, LABEL, SELECT, compareNumbers } from "../../prototypes/p1/ui";
import type { ChecklistProps } from "../Checklist";
import ChipGroup from "../ChipGroup";
import { checklistCount, isComplete, totalKnown } from "../catalog/format";
import { copiesByCard, fold } from "../catalog/home";
import { SkeletonBars, SkeletonPips } from "../catalog/Skeleton";
import { blockedMessage, pickFirstLabel, runPlan } from "../cards/model";
import { parseRange } from "../cards/range";
import { playerNames, shortCardName, teamNames } from "../data/labels";
import { useCollectionActions, useCopiesInVariant, useVariantCards, useVariantCompletion } from "../data/store";
import type { Card, CardId } from "../data/types";
import { usePageApi } from "../pageApi";
import QuantityRow from "./QuantityRow";
import { useQuickEntry } from "./QuickEntry";

type Show = "all" | "in" | "out";
type Sort = "checklist" | "number" | "player" | "team";

/**
 * NEO-364 (D9–D12) — a checklist on the inventory side: quick quantity
 * entry into the target box ("Adding to", above the Checklists).
 *
 * Every row is a quantity field: how many plain copies of the card sit in
 * that box. Type, Tab, type, Tab: each field writes as it is left, through
 * the page's commit queue. No Have, Want or Trade here; Details opens the
 * card for everything else.
 *
 * The controls: the in-list search (as the collection's), All / In <box> /
 * Not in <box>, Sort by (checklist order, number, player, team), and
 * "Add a range to <box>", one copy of each card the range names.
 *
 * Box copies only (the hard line): the rows, the "in stock" line and the
 * sleeve strip read `useCopiesInVariant` / `useVariantCompletion` on the
 * inventory side, never a binder copy.
 */
const InventoryChecklist = forwardRef<HTMLHeadingElement, ChecklistProps>(function InventoryChecklist(
  { variantId, title, actions, selectedCardId, highlightCardId },
  headingRef,
) {
  const api = usePageApi();
  const writes = useCollectionActions();
  const { box } = useQuickEntry();
  const cards = useVariantCards(variantId);
  const copies = useCopiesInVariant(variantId, "inventory");
  const completion = useVariantCompletion(variantId, "inventory");
  const boxName = box?.name ?? "the box";

  const byCard = useMemo(() => copiesByCard(copies), [copies]);
  const stockedIds = useMemo(() => new Set(byCard.keys()), [byCard]);
  const inBoxIds = useMemo(() => {
    const out = new Set<CardId>();
    if (!box) return out;
    for (const copy of copies ?? []) if (copy.homeId === box.id && copy.quantity > 0) out.add(copy.cardId);
    return out;
  }, [copies, box]);
  const list = useMemo(() => cards ?? [], [cards]);

  const [show, setShow] = useState<Show>("all");
  const [sort, setSort] = useState<Sort>("checklist");
  const [query, setQuery] = useState("");
  const [rangeText, setRangeText] = useState("");
  const [sharedPicks, setSharedPicks] = useState<Set<string>>(new Set());
  const rangeRef = useRef<HTMLInputElement>(null);
  const rangePreviewId = useId();
  const rangeErrorId = useId();

  const needle = fold(query).replace(/^#/, "");
  const filtered = list.filter((c) => {
    const here = inBoxIds.has(c.id);
    if (show === "in" && !here) return false;
    if (show === "out" && here) return false;
    if (!needle) return true;
    const hay = fold(`${c.cardNumber} ${playerNames(c)} ${teamNames(c)} ${c.cardVariation ?? ""} ${c.features.join(" ")}`);
    return needle.split(" ").every((t) => hay.includes(t));
  });
  const visible =
    sort === "checklist"
      ? filtered
      : [...filtered].sort((a, b) => {
          const byNumber = compareNumbers(a.cardNumber, b.cardNumber);
          if (sort === "number") return byNumber;
          const key = (c: Card) => (sort === "player" ? playerNames(c) : teamNames(c));
          const ka = key(a);
          const kb = key(b);
          // Cards with no name known go last, in number order.
          if (!ka !== !kb) return ka ? -1 : 1;
          return ka.localeCompare(kb) || byNumber;
        });
  const count =
    cards && copies
      ? checklistCount({
          shownBase: visible.filter((c) => !c.isVariation).length,
          shownAll: visible.length,
          base: list.filter((c) => !c.isVariation).length,
          all: list.length,
        })
      : null;

  // "Add a range": one copy of every card it names, whether or not the box
  // already holds some. A shared number still stops and asks.
  const range = rangeText.trim() ? parseRange(rangeText, list) : null;
  const plan = runPlan(range, sharedPicks, () => false);
  const { cards: rangeCards, toAdd, blocked } = plan;
  const alreadyHere = toAdd.filter((c) => inBoxIds.has(c.id)).length;

  const addRange = () => {
    if (blocked || toAdd.length === 0 || !box) return;
    const n = toAdd.length;
    const into = box;
    void api.run(
      () => writes.addMany(toAdd, into.id),
      () => `Added ${n} ${n === 1 ? "card" : "cards"} to ${into.name}, one each.`,
    );
    setRangeText("");
    setSharedPicks(new Set());
    rangeRef.current?.focus();
  };

  // --- Jump from search: bring the row into view and put the caret in its field ---
  const rowEls = useRef(new Map<CardId, HTMLLIElement>());
  const ready = cards !== undefined;
  const ringed = highlightCardId && list.some((c) => c.id === highlightCardId) ? highlightCardId : null;
  useEffect(() => {
    if (!ringed || !ready) return;
    const frame = requestAnimationFrame(() => {
      const el = rowEls.current.get(ringed);
      if (!el) return;
      el.scrollIntoView({ block: "center" });
      el.querySelector<HTMLElement>("input")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [ringed, ready]);

  const headingId = `checklist-${variantId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  return (
    <section aria-labelledby={headingId} className="space-y-4 rounded-lg bg-raised p-4 text-ink shadow-offset sm:p-6">
      <div className="min-w-0 space-y-2">
        <h3 id={headingId} ref={headingRef} tabIndex={-1} className="rounded-sm text-xl font-semibold focus-outline">
          {title}
        </h3>
        {completion ? (
          <p className="text-sm text-ink-2">
            {totalKnown(completion) ? (
              <>
                <span className="font-semibold tabular-nums text-ink">{completion.owned}</span> of{" "}
                <span className="tabular-nums">{completion.total}</span> in your boxes
                {isComplete(completion) ? " · Every card stocked. Radical." : ` · ${completion.total - completion.owned} not stocked`}
              </>
            ) : (
              `${completion.owned} in your boxes`
            )}
          </p>
        ) : (
          <SkeletonBars rows={1} className="w-48" />
        )}
        {cards ? <StockStrip cards={cards} stockedIds={stockedIds} /> : <SkeletonPips />}
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
          <label className="block">
            <span className={LABEL}>Sort by</span>
            <select className={`${SELECT} w-full`} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="checklist">Checklist order</option>
              <option value="number">Card number</option>
              <option value="player">Player</option>
              <option value="team">Team</option>
            </select>
          </label>
          <ChipGroup
            label="Show"
            value={show}
            options={[
              { value: "all", label: "All" },
              { value: "in", label: `In ${boxName}` },
              { value: "out", label: `Not in ${boxName}` },
            ]}
            onChange={setShow}
            className="flex basis-full flex-wrap gap-1.5 pb-1"
            chipClass={(on) => `${CHIP} ${on ? CHIP_ON : CHIP_OFF}`}
          />
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[12rem] flex-1">
              <Input
                ref={rangeRef}
                surface="dark"
                label={`Add a range to ${boxName}`}
                placeholder="1-20, -12"
                value={rangeText}
                onChange={(e) => {
                  setRangeText(e.target.value);
                  setSharedPicks(new Set());
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addRange();
                  }
                  if (e.key === "Escape" && rangeText) {
                    e.preventDefault();
                    setRangeText("");
                  }
                }}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={range?.invalid || undefined}
                aria-describedby={range?.invalid ? rangeErrorId : rangePreviewId}
              />
            </div>
            <NeonButton
              type="button"
              variant="primary"
              disabled={blocked || toAdd.length === 0 || !box}
              onClick={addRange}
              className={FOCUS}
            >
              {pickFirstLabel(plan) ?? (toAdd.length > 0 ? `Add ${toAdd.length} to ${boxName}` : `Add to ${boxName}`)}
            </NeonButton>
          </div>
          <div className="space-y-2 text-sm text-ink-2">
            {range?.invalid && (
              <p id={rangeErrorId} role="alert" className="text-neon-yellow-text">
                Can&apos;t read that. Try numbers and runs like 1-20, -12.
              </p>
            )}
            <div id={rangePreviewId} role="status" className={range && !range.invalid ? "space-y-2" : "sr-only"}>
              {range && !range.invalid && (
                <>
                  <p>
                    {toAdd.length === 0 && rangeCards.length === 0
                      ? "No cards picked yet."
                      : `One each of ${toAdd.length} ${toAdd.length === 1 ? "card" : "cards"} into ${boxName}`}
                    {alreadyHere > 0 && `. ${alreadyHere} already in there get one more`}
                    {range.unknown.length > 0 && `. Not on this checklist: ${range.unknown.join(", ")}`}
                  </p>
                  {blocked && <p className="text-neon-yellow-text">{blockedMessage(plan)}</p>}
                </>
              )}
            </div>
            {range &&
              !range.invalid &&
              range.shared.map((s) => (
                <div
                  key={s.number}
                  role="group"
                  aria-label={`Cards numbered ${s.number}`}
                  className="flex flex-wrap items-center gap-1.5 rounded-md border border-neon-yellow/50 bg-neon-yellow/5 px-2 py-1.5"
                >
                  <span className="text-ink-2">#{s.number} is on {s.cards.length} cards. Which one&apos;s yours?</span>
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
        </div>
      </div>

      <p role="status" className={!count ? "sr-only" : "text-xs tabular-nums text-ink-3"}>
        {!count ? (
          "Dealing out the checklist…"
        ) : (
          <>
            <span className="block">{count.base}</span>
            {count.withVariations && (
              <>
                <span className="sr-only">, </span>
                <span className="block">{count.withVariations}</span>
              </>
            )}
          </>
        )}
      </p>
      {!cards || !copies ? (
        <div aria-busy="true" className="space-y-2">
          <SkeletonBars rows={6} />
        </div>
      ) : visible.length === 0 ? (
        <p className="rounded-md border border-dashed border-rule-strong px-3 py-2 text-sm text-ink-3">
          {cards.length === 0
            ? "No cards on this checklist yet."
            : show === "in" && !query
              ? `Nothing from this checklist in ${boxName} yet. Type a number on any row to stock it.`
              : show === "out" && !query
                ? `Every card here is already in ${boxName}. Stacked.`
                : "No cards match."}
        </p>
      ) : (
        <ul data-qty-list="" aria-label={`Quantities in ${boxName}`} className="space-y-1.5">
          {visible.map((card) => (
            <QuantityRow
              key={card.id}
              card={card}
              copies={byCard.get(card.id) ?? []}
              onOpen={(copyId) => actions.open(card, copyId, visible)}
              isSelected={card.id === selectedCardId}
              highlighted={card.id === ringed}
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

export default InventoryChecklist;

/**
 * The checklist's stock as a row of sleeves, one per card, in checklist
 * order: lit in the inventory's yellow for a card in any box, an empty
 * pocket for one that is not. Decorative: the "12 of 300 in your boxes"
 * above it is the readable version.
 */
function StockStrip({ cards, stockedIds }: { cards: Card[]; stockedIds: Set<string> }) {
  return (
    <div aria-hidden="true" className="flex flex-wrap gap-1">
      {cards.map((c) => (
        <span
          key={c.id}
          className={`h-3.5 w-2.5 rounded-[2px] border ${
            stockedIds.has(c.id) ? "border-neon-yellow-text bg-neon-yellow" : "border-control bg-transparent"
          }`}
        />
      ))}
    </div>
  );
}

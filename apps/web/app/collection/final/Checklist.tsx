import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import { CHIP, CHIP_OFF, CHIP_ON, FOCUS } from "../prototypes/p1/ui";
import BinderPicker from "./BinderPicker";
import CardRowGroup, { type RowActions } from "./CardRows";
import { cardsCount, haveLine, isComplete, totalKnown } from "./catalog/format";
import { copiesByCard, fold, useHomeName, useScopedName } from "./catalog/home";
import { LoadingNote, SkeletonBars, SkeletonPips } from "./catalog/Skeleton";
import { blockedMessage, pickFirstLabel, runPlan } from "./cards/model";
import { parseRange } from "./cards/range";
import { playerNames, setLabel, shortCardName, teamNames } from "./data/labels";
import {
  useBuildingSets,
  useCapabilities,
  useCollectionActions,
  useCopiesInVariant,
  useDemoExtension,
  useSetSummary,
  useVariantCards,
  useVariantCompletion,
} from "./data/store";
import type { Card, CardId } from "./data/types";
import { usePageApi } from "./pageApi";

type Show = "all" | "have" | "need";

/**
 * The checklist under the cascade: progress strip, "Building this set", an
 * in-list search with All / Haves / Needs, "Mark a range as Have", and the
 * rows. A card owned in several line items shows one row per line.
 *
 * One checklist's cards and copies (`useVariantCards`, `useCopiesInVariant`),
 * never the whole set. Its heading shows at once; the rows show a skeleton
 * until both reads are in.
 */
const Checklist = forwardRef<
  HTMLHeadingElement,
  {
    setId: string;
    variantId: string;
    title: string;
    actions: RowActions;
    selectedCardId: string | null;
    /** Jumped here from search: scroll to this card's row and ring it. */
    highlightCardId: CardId | null;
  }
>(function Checklist({ setId, variantId, title, actions, selectedCardId, highlightCardId }, headingRef) {
  const api = usePageApi();
  const writes = useCollectionActions();
  const capabilities = useCapabilities();
  const demo = useDemoExtension();
  const cards = useVariantCards(variantId);
  const copies = useCopiesInVariant(variantId);
  const completion = useVariantCompletion(variantId);
  const building = useBuildingSets();
  const summary = useSetSummary(setId);
  const setRef = summary?.set ?? cards?.[0]?.set ?? null;
  const isBuilding = building?.some((s) => s.id === setId) ?? false;
  const into = useHomeName();
  const scopedName = useScopedName();

  const byCard = useMemo(() => copiesByCard(copies), [copies]);
  const ownedIds = useMemo(() => new Set(byCard.keys()), [byCard]);
  const list = useMemo(() => cards ?? [], [cards]);

  const [show, setShow] = useState<Show>("all");
  const [query, setQuery] = useState("");
  const [rangeText, setRangeText] = useState("");
  /** For numbers two cards share: which of them the collector means. */
  const [sharedPicks, setSharedPicks] = useState<Set<string>>(new Set());

  const needle = fold(query).replace(/^#/, "");
  const visible = list.filter((c) => {
    const have = ownedIds.has(c.id);
    if (show === "have" && !have) return false;
    if (show === "need" && have) return false;
    if (!needle) return true;
    const hay = fold(`${c.cardNumber} ${playerNames(c)} ${teamNames(c)} ${c.cardVariation ?? ""} ${c.features.join(" ")}`);
    return needle.split(" ").every((t) => hay.includes(t));
  });

  // A card number is never unique: `parseRange` hands back every number two
  // cards share in `shared`. Stop and ask: until each one is picked (or taken
  // out with -N) the whole run is held, the same rule as My Cards' Quick add.
  const range = rangeText.trim() ? parseRange(rangeText, list) : null;
  const plan = runPlan(range, sharedPicks, (id) => ownedIds.has(id));
  const { cards: rangeCards, toAdd, already: alreadyHave, blocked } = plan;

  const markRange = () => {
    if (blocked || toAdd.length === 0) return;
    const n = toAdd.length;
    void api.run(
      () => writes.addMany(toAdd),
      () => `Marked ${n} ${n === 1 ? "card" : "cards"} as Have, into ${into}`,
    );
    setRangeText("");
    setSharedPicks(new Set());
  };

  const toggleBuilding = () => {
    if (!setRef) return;
    const label = setLabel(setRef);
    void api.run(
      () => writes.setBuilding(setRef, !isBuilding),
      (r) => (r.building ? `Building ${label}. Go get 'em.` : `Stopped building ${label}`),
    );
  };

  // --- Jump from search: bring the row into view and put the caret on it ---
  const rowEls = useRef(new Map<CardId, HTMLLIElement>());
  const ready = cards !== undefined;
  const ringed = highlightCardId && list.some((c) => c.id === highlightCardId) ? highlightCardId : null;
  useEffect(() => {
    if (!ringed || !ready) return;
    const frame = requestAnimationFrame(() => {
      const el = rowEls.current.get(ringed);
      if (!el) return;
      el.scrollIntoView({ block: "center" });
      el.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [ringed, ready]);

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

  const headingId = `checklist-${variantId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  return (
    <section aria-labelledby={headingId} className="space-y-4 rounded-lg bg-raised p-4 text-ink shadow-offset sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <h3 id={headingId} ref={headingRef} tabIndex={-1} className="rounded-sm text-xl font-semibold focus-outline">
            {title}
          </h3>
          {completion ? (
            <p className="text-sm text-ink-2">
              {scopedName && <span className="text-neon-blue-text">In {scopedName}: </span>}
              {totalKnown(completion) ? (
                <>
                  Have <span className="font-semibold tabular-nums text-ink">{completion.owned}</span> of{" "}
                  <span className="tabular-nums">{completion.total}</span>
                  {isComplete(completion)
                    ? " · Complete. Totally rad."
                    : ` · Need ${completion.total - completion.owned}`}
                </>
              ) : (
                haveLine(completion)
              )}
            </p>
          ) : (
            <SkeletonBars rows={1} className="w-48" />
          )}
          {cards ? <SleeveStrip cards={cards} ownedIds={ownedIds} /> : <SkeletonPips />}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {capabilities.scope && demo && <BinderPicker store={demo.state} />}
          <button
            type="button"
            aria-pressed={isBuilding}
            disabled={!setRef || building === undefined}
            onClick={toggleBuilding}
            className={`${CHIP} ${isBuilding ? CHIP_ON : CHIP_OFF} disabled:cursor-wait disabled:opacity-60`}
          >
            {isBuilding ? "✓ " : ""}Building this set
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
                onChange={(e) => {
                  setRangeText(e.target.value);
                  setSharedPicks(new Set());
                }}
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
              disabled={blocked || toAdd.length === 0}
              onClick={markRange}
              className={FOCUS}
            >
              {pickFirstLabel(plan) ?? (toAdd.length > 0 ? `Mark ${toAdd.length} as Have` : "Mark as Have")}
            </NeonButton>
          </div>
          {range && (
            <div className="space-y-2 text-sm text-ink-2">
              <p>
                {toAdd.length === 0 && rangeCards.length === 0
                  ? "No cards picked yet."
                  : `${toAdd.length} to add to ${into}`}
                {alreadyHave > 0 && `, ${alreadyHave} already in your collection`}
                {range.unknown.length > 0 && `. Not on this checklist: ${range.unknown.join(", ")}`}
              </p>
              {blocked && <p className="text-neon-yellow-text">{blockedMessage(plan)}</p>}
              {range.shared.map((s) => (
                <div
                  key={s.number}
                  role="group"
                  aria-label={`Cards numbered ${s.number}`}
                  className="flex flex-wrap items-center gap-1.5 rounded-md border border-neon-yellow/50 bg-neon-yellow/5 px-2 py-1.5"
                >
                  <span className="text-ink-2">#{s.number} is on {s.cards.length} cards. Which one's yours?</span>
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

      {!cards || !copies ? (
        <div aria-busy="true" className="space-y-2">
          <SkeletonBars rows={6} />
          <LoadingNote>Dealing out the checklist…</LoadingNote>
        </div>
      ) : (
        <>
          <p role="status" className="text-xs tabular-nums text-ink-3">
            {visible.length === cards.length ? cardsCount(cards.length) : `${visible.length} of ${cardsCount(cards.length)}`}
          </p>
          {visible.length === 0 ? (
            <p className="rounded-md border border-dashed border-rule-strong px-3 py-2 text-sm text-ink-3">
              {cards.length === 0
                ? "No cards on this checklist yet."
                : show === "need" && !query
                  ? "Nothing left to chase here. Set complete!"
                  : "No cards match."}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {visible.map((card: Card) => (
                <CardRowGroup
                  key={card.id}
                  card={card}
                  copies={byCard.get(card.id) ?? []}
                  actions={{ ...actions, open: (c, copyId) => actions.open(c, copyId, visible) }}
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
        </>
      )}
    </section>
  );
});

export default Checklist;

/**
 * A checklist's progress as a row of sleeves, one per card, in checklist
 * order: filled neon for a card you have, an empty pocket for one you need.
 * Decorative: the "Have 12 of 51" beside it is the readable version.
 */
function SleeveStrip({ cards, ownedIds }: { cards: Card[]; ownedIds: Set<string> }) {
  return (
    <div aria-hidden="true" className="flex flex-wrap gap-1">
      {cards.map((c) => (
        <span
          key={c.id}
          className={`h-3.5 w-2.5 rounded-[2px] border ${
            ownedIds.has(c.id) ? "border-neon-blue bg-neon-blue" : "border-control bg-transparent"
          }`}
        />
      ))}
    </div>
  );
}

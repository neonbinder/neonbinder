import { useMemo, useRef, useState } from "react";
import { Input } from "@/components/primitives/Input";
import NeonButton from "@/components/modules/NeonButton";
import {
  compareCards,
  getCard,
  getSet,
  playerNames,
  searchCards,
  teamNames,
  type Card,
  type Copy,
} from "../_shared/data";
import type { PrototypeStore } from "../_shared/usePrototypeStore";
import CardDetail from "./CardDetail";
import type { Notify } from "./notice";
import {
  CHIP,
  CHIP_OFF,
  CHIP_ON,
  LABEL,
  SELECT,
  liveryOn,
  setAndVariant,
  shortCardName,
} from "./ui";

type SortKey = "set" | "player" | "team" | "year" | "added" | "grade" | "cost";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "set", label: "Set and number" },
  { key: "player", label: "Player" },
  { key: "team", label: "Team" },
  { key: "year", label: "Year, newest first" },
  { key: "added", label: "Date added, newest first" },
  { key: "grade", label: "Grade, highest first" },
  { key: "cost", label: "Cost, highest first" },
];

type ChipKey = "rc" | "au" | "numbered" | "graded" | "dupes" | "forSale";
const CHIPS: { key: ChipKey; label: string; test: (card: Card, copies: Copy[]) => boolean }[] = [
  { key: "rc", label: "Rookies", test: (c) => c.features.includes("RC") },
  { key: "au", label: "Autos", test: (c) => c.features.includes("AU") },
  { key: "numbered", label: "Numbered", test: (c) => c.printRun !== null },
  { key: "graded", label: "Graded", test: (_, cs) => cs.some((x) => x.graded) },
  { key: "dupes", label: "Dupes", test: (_, cs) => cs.reduce((n, x) => n + x.quantity, 0) > 1 },
  { key: "forSale", label: "For sale", test: (_, cs) => cs.some((x) => x.forSale) },
];

const ROW_SURFACE = "#020617";

function bestGrade(copies: Copy[]): number {
  let best = -1;
  for (const c of copies) {
    const n = Number(c.graded?.grade);
    if (Number.isFinite(n) && n > best) best = n;
  }
  return best;
}

/**
 * My Cards: the admin Players screen's list/detail, holding the collection.
 * One row per card (copies stack under it), a filter that reads like the
 * search ("96 contenders white"), a sort, and show-only chips. The detail
 * column is the same card detail the Find Cards drawer uses.
 *
 * Inventory is the same pile: a copy flagged For sale is still in the
 * collection, and the For sale chip is the dealer's view of it.
 */
export default function MyCards({
  store,
  notify,
  onFindCards,
}: {
  store: PrototypeStore;
  notify: Notify;
  onFindCards: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("set");
  const [chips, setChips] = useState<Set<ChipKey>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const select = (id: string) => {
    setSelectedId(id);
    // On a phone the detail stacks under the list: bring it up.
    if (window.matchMedia("(max-width: 767px)").matches) {
      requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: "start" }));
    }
  };

  const copiesByCard = useMemo(() => {
    const map = new Map<string, Copy[]>();
    for (const c of store.state.copies) {
      const list = map.get(c.cardId) ?? [];
      list.push(c);
      map.set(c.cardId, list);
    }
    return map;
  }, [store.state.copies]);

  const rows = useMemo(() => {
    let cards = [...copiesByCard.keys()].map(getCard);
    if (filter.trim()) {
      const hit = new Set(searchCards(filter).filter((h) => h.matchedAll).map((h) => h.card.id));
      cards = cards.filter((c) => hit.has(c.id));
    }
    for (const chip of CHIPS) {
      if (chips.has(chip.key)) cards = cards.filter((c) => chip.test(c, copiesByCard.get(c.id) ?? []));
    }
    const copies = (c: Card) => copiesByCard.get(c.id) ?? [];
    const by: Record<SortKey, (a: Card, b: Card) => number> = {
      set: compareCards,
      player: (a, b) => playerNames(a).localeCompare(playerNames(b)) || compareCards(a, b),
      team: (a, b) => teamNames(a).localeCompare(teamNames(b)) || compareCards(a, b),
      year: (a, b) => getSet(b.setId).year - getSet(a.setId).year || compareCards(a, b),
      added: (a, b) => {
        const la = copies(a).map((c) => c.acquiredAt).sort().at(-1) ?? "";
        const lb = copies(b).map((c) => c.acquiredAt).sort().at(-1) ?? "";
        return lb.localeCompare(la) || compareCards(a, b);
      },
      grade: (a, b) => bestGrade(copies(b)) - bestGrade(copies(a)) || compareCards(a, b),
      cost: (a, b) => {
        const sum = (c: Card) => copies(c).reduce((n, x) => n + (x.costBasis ?? 0) * x.quantity, 0);
        return sum(b) - sum(a) || compareCards(a, b);
      },
    };
    return cards.sort(by[sort]);
  }, [copiesByCard, filter, chips, sort]);

  const totalCards = store.state.copies.reduce((n, c) => n + c.quantity, 0);
  const selected = selectedId && copiesByCard.has(selectedId) ? getCard(selectedId) : null;

  const toggleChip = (key: ChipKey) =>
    setChips((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="space-y-4">
      <h2 className="sr-only">My cards</h2>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-64">
          <Input
            surface="dark"
            type="search"
            label="Filter my cards"
            placeholder="Player, team, set or #"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="w-full sm:w-56">
          <label className="block">
            <span className={LABEL}>Sort by</span>
            <select className={SELECT} value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p role="status" className="flex min-h-[42px] min-w-[12rem] items-center text-xs text-slate-400">
          {rows.length === copiesByCard.size
            ? `${copiesByCard.size} cards, ${totalCards} with dupes`
            : `${rows.length} of ${copiesByCard.size} cards`}
        </p>
        <NeonButton type="button" onClick={onFindCards}>
          Add cards
        </NeonButton>
      </div>

      <div role="group" aria-label="Show only" className="flex flex-wrap items-center gap-2">
        <span aria-hidden="true" className="text-sm text-slate-400">Show only</span>
        {CHIPS.map((chip) => {
          const on = chips.has(chip.key);
          return (
            <button
              key={chip.key}
              type="button"
              aria-pressed={on}
              onClick={() => toggleChip(chip.key)}
              className={`${CHIP} ${on ? CHIP_ON : CHIP_OFF}`}
            >
              {chip.label}
            </button>
          );
        })}
      </div>
      {chips.has("forSale") && (
        <p className="rounded-md border border-neon-blue/40 bg-neon-blue/5 px-3 py-2 text-sm text-slate-200">
          One pile, two views: these copies stay in your collection, and they are exactly
          what would show up in Inventory when it lands.
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,18rem)_1fr] gap-4">
        <div className="rounded-lg border border-slate-800 max-h-[32rem] overflow-y-auto">
          {rows.length === 0 ? (
            <p className="p-3 text-sm text-slate-400">
              {copiesByCard.size === 0 ? "No cards yet. Hit Add cards to start your stack." : "No cards match those filters."}
            </p>
          ) : (
            <ul>
              {rows.map((card) => {
                const isSelected = card.id === selectedId;
                const cs = copiesByCard.get(card.id) ?? [];
                const qty = cs.reduce((n, x) => n + x.quantity, 0);
                const graded = cs.find((x) => x.graded)?.graded;
                return (
                  <li key={card.id}>
                    <button
                      type="button"
                      onClick={() => select(card.id)}
                      aria-current={isSelected ? "true" : undefined}
                      className={`flex w-full flex-col gap-y-0.5 px-3 py-2 text-left text-sm border-l-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#00C2FF] ${
                        isSelected
                          ? "border-neon-blue bg-neon-blue/10 text-neon-blue"
                          : "border-transparent text-slate-200 hover:bg-slate-900"
                      }`}
                    >
                      <span className="flex w-full items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate">{shortCardName(card)}</span>
                        {qty > 1 && <span className="shrink-0 text-xs tabular-nums text-slate-300">×{qty}</span>}
                      </span>
                      <span className="flex w-full items-baseline gap-x-2 text-xs">
                        <span className="min-w-0 truncate text-slate-400">{setAndVariant(card)}</span>
                        <span
                          className="shrink-0 border-l border-slate-700 pl-2 text-slate-300"
                          style={{ color: liveryOn(card, ROW_SURFACE) }}
                        >
                          {teamNames(card)}
                        </span>
                      </span>
                      {(graded || cs.some((x) => x.forSale)) && (
                        <span className="flex gap-1.5 text-xs">
                          {graded && (
                            <span className="rounded border border-slate-600 px-1 text-slate-200">
                              {graded.grader} {graded.grade}
                            </span>
                          )}
                          {cs.some((x) => x.forSale) && (
                            <span className="rounded border border-neon-green/60 px-1 text-neon-green">For sale</span>
                          )}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div ref={detailRef} className="scroll-mt-20 rounded-lg border border-slate-800 p-4">
          {selected ? (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold leading-tight text-slate-100">{shortCardName(selected)}</h3>
                <p className="text-sm text-slate-400">{setAndVariant(selected)}</p>
              </div>
              <CardDetail
                key={selected.id}
                card={selected}
                store={store}
                notify={notify}
                onCancelAdd={() => undefined}
                headingLevel={4}
              />
            </div>
          ) : (
            <p className="text-sm text-slate-400">
              Pick a card to see every copy you own, edit grades and costs, or add another.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

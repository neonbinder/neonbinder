import { useState } from "react";
import { Input } from "@/components/primitives/Input";
import {
  cardsInSet,
  getBrand,
  getSport,
  normalizeSearchText,
  setLabel,
  setsInOrder,
} from "../../prototypes/_shared/data";
import { FOCUS, PRIMARY_BUTTON } from "../../prototypes/p3/classes";
import P3Dialog from "../../prototypes/p3/Dialog";
import { useMyCards } from "./context";

/** NEO-350 — "Start building a set": every set, searchable, one toggle each. */
export default function SetPicker({ onClose }: { onClose: () => void }) {
  const { store } = useMyCards();
  const [query, setQuery] = useState("");
  const tokens = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  const shown = setsInOrder().filter((s) => {
    const hay = normalizeSearchText(
      `${s.season} ${s.year} ${String(s.year).slice(2)} ${s.name} ${getBrand(s.brandId).name} ${getSport(s.sportId).name}`,
    );
    return tokens.every((t) => hay.includes(t));
  });

  return (
    <P3Dialog
      shape="center"
      title="Start building a set"
      subtitle="Pick the checklists you're chasing. They go up on the board."
      onClose={onClose}
    >
      <Input
        label="Find a set"
        placeholder="96 contenders"
        autoComplete="off"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className="mt-4 flex flex-col gap-2">
        {shown.map((s) => {
          const on = store.isBuilding(s.id);
          const base = store.completionInScope(s.id, { type: "Base" });
          return (
            <li
              key={s.id}
              className="flex items-center gap-3 rounded-lg border border-rule bg-field/60 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="font-bold text-ink">{setLabel(s)}</p>
                <p className="text-sm text-ink-3">
                  {getSport(s.sportId).name}, {getBrand(s.brandId).name}.{" "}
                  {cardsInSet(s.id, { type: "Base" }).length} base cards, you have {base.owned}.
                </p>
              </div>
              <button
                type="button"
                aria-pressed={on}
                aria-label={`Building ${setLabel(s)}`}
                onClick={() => store.toggleBuilding(s.id)}
                className={`min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium sm:min-h-9 ${FOCUS} ${
                  on
                    ? "border-selection bg-neon-blue text-on-neon-blue"
                    : "border-control text-ink-2 hover:border-neon-blue"
                }`}
              >
                {on ? "On the board" : "Build it"}
              </button>
            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="text-sm text-ink-2">No set matches “{query}”. Try a year or a brand.</li>
        )}
      </ul>
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={onClose} className={PRIMARY_BUTTON}>
          Done
        </button>
      </div>
    </P3Dialog>
  );
}

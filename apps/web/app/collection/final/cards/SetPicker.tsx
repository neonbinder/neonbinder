import { useState } from "react";
import { Input } from "@/components/primitives/Input";
import { FOCUS, LABEL, PRIMARY_BUTTON, SELECT } from "../../prototypes/p3/classes";
import P3Dialog from "../../prototypes/p3/Dialog";
import { useSearchText } from "../catalog/search";
import { LoadingNote, SkeletonBars } from "../catalog/Skeleton";
import { setLabel } from "../data/labels";
import { searchable, useBuildingSets, useCollectionActions, useDrill, useSuggestions } from "../data/store";
import type { DrillItem, NamedRef, SetRef } from "../data/types";
import { useMyCards } from "./context";

/**
 * NEO-350 / NEO-358 — "Start building a set": find a set by name, or walk
 * sport, year and brand down to it, and put it on the board (or take it off)
 * with one toggle each. "Sets I'm building" is only ever what the collector
 * picks here or on a set's wall.
 */
export default function SetPicker({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const text = useSearchText(query);
  const suggestions = useSuggestions(text);
  const found: SetRef[] =
    suggestions
      ?.filter((s): s is Extract<typeof s, { kind: "set" }> => s.kind === "set")
      .map((s) => toRef(s.id, s.label, s.sport)) ?? [];

  const [sport, setSport] = useState<string>("");
  const [year, setYear] = useState<string>("");
  const [brand, setBrand] = useState<string>("");
  const sports = useDrill("sport", {});
  const years = useDrill(sport ? "year" : null, sport ? { sport } : {});
  const brands = useDrill(sport && year ? "brand" : null, sport && year ? { sport, year } : {});
  const sets = useDrill(sport && year && brand ? "set" : null, sport && year && brand ? { sport, year, brand } : {});
  const named = (items: DrillItem[] | undefined, id: string): NamedRef => ({
    id,
    name: items?.find((i) => i.id === id)?.name ?? "",
  });
  const browsed: SetRef[] =
    sets?.map((s) => {
      const y = named(years, year).name;
      return {
        id: s.id,
        name: s.name,
        season: y,
        year: Number.parseInt(y, 10) || 0,
        brand: named(brands, brand),
        sport: named(sports, sport),
      };
    }) ?? [];

  const searching = searchable(query.trim());

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

      {searching ? (
        suggestions === undefined || text !== query.trim() ? (
          <div className="mt-4" aria-busy="true">
            <SkeletonBars rows={3} />
            <LoadingNote>Looking for sets…</LoadingNote>
          </div>
        ) : found.length === 0 ? (
          <p className="mt-4 text-sm text-ink-2">No set matches “{query.trim()}”. Try a year or a brand, or browse below.</p>
        ) : (
          <SetRows sets={found} />
        )
      ) : null}

      <fieldset className="mt-5">
        <legend className="mb-2 text-sm font-semibold text-ink">Or browse</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <Pick label="Sport" value={sport} items={sports} onChange={(v) => {
              setSport(v);
              setYear("");
              setBrand("");
            }} />
          <Pick label="Year" value={year} items={sport ? years : []} onChange={(v) => {
              setYear(v);
              setBrand("");
            }} />
          <Pick label="Brand" value={brand} items={sport && year ? brands : []} onChange={setBrand} />
        </div>
      </fieldset>
      {sport && year && brand && (sets === undefined ? <SkeletonBars rows={3} className="mt-4" /> : <SetRows sets={browsed} />)}

      <div className="mt-4 flex justify-end">
        <button type="button" onClick={onClose} className={PRIMARY_BUTTON}>
          Done
        </button>
      </div>
    </P3Dialog>
  );
}

/** A set ref from a search suggestion ("2024 Topps Chrome", "Baseball"). */
function toRef(id: string, label: string, sport: string): SetRef {
  const [season = "", ...rest] = label.split(" ");
  return {
    id,
    name: rest.join(" "),
    season,
    year: Number.parseInt(season, 10) || 0,
    brand: { id: "", name: "" },
    sport: { id: "", name: sport },
  };
}

function Pick({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: string;
  items: DrillItem[] | undefined;
  onChange: (id: string) => void;
}) {
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      <select
        className={`${SELECT} w-full`}
        value={value}
        disabled={!items || items.length === 0}
        aria-busy={items === undefined || undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{items === undefined ? "Loading…" : `Any ${label.toLowerCase()}`}</option>
        {items?.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function SetRows({ sets }: { sets: SetRef[] }) {
  const api = useMyCards();
  const writes = useCollectionActions();
  const building = useBuildingSets();
  if (sets.length === 0) return <p className="mt-4 text-sm text-ink-2">No sets here yet.</p>;
  return (
    <ul className="mt-4 flex flex-col gap-2">
      {sets.map((s) => {
        const on = building?.some((b) => b.id === s.id) ?? false;
        const label = setLabel(s);
        const where = [s.sport.name, s.brand.name].filter(Boolean).join(", ");
        return (
          <li key={s.id} className="flex items-center gap-3 rounded-lg border border-rule bg-field/60 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="font-bold text-ink">{label}</p>
              {where && <p className="text-sm text-ink-3">{where}</p>}
            </div>
            <button
              type="button"
              aria-pressed={on}
              aria-label={`Building ${label}`}
              disabled={building === undefined}
              onClick={() =>
                void api.run(
                  () => writes.setBuilding(s, !on),
                  (r) => (r.building ? `${label} is on the board.` : `Took ${label} off the board. Your cards stay put.`),
                )
              }
              className={`min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium sm:min-h-9 ${FOCUS} ${
                on ? "border-selection bg-neon-blue text-on-neon-blue" : "border-control text-ink-2 hover:border-neon-blue"
              }`}
            >
              {/* Stable words, like Checklists' "Building this set": the name starts
                  with them and never flips; on or off is aria-pressed (and the tick). */}
              {on && <span aria-hidden="true">✓ </span>}
              Building
            </button>
          </li>
        );
      })}
    </ul>
  );
}

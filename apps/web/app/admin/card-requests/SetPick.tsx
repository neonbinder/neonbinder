import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { LABEL, SELECT_PANEL } from "@/app/collection/prototypes/p1/ui";

type SelectorId = Id<"selectorOptions">;
type Level = "sport" | "year" | "manufacturer" | "setName";

/** Sport, year, brand, set: the catalog set a set request is approved as. */
export default function SetPick({
  sportId,
  value,
  onChange,
}: {
  /** The sport the collector named, picked to start. */
  sportId: SelectorId | null;
  value: SelectorId | null;
  onChange: (setId: SelectorId | null) => void;
}) {
  const [sport, setSport] = useState<string>(sportId ?? "");
  const [year, setYear] = useState("");
  const [brand, setBrand] = useState("");
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Column label="Sport" level="sport" parentId={null} value={sport} onChange={(v) => {
          setSport(v);
          setYear("");
          setBrand("");
          onChange(null);
        }} />
      <Column label="Year" level="year" parentId={sport || undefined} value={year} onChange={(v) => {
          setYear(v);
          setBrand("");
          onChange(null);
        }} />
      <Column label="Brand" level="manufacturer" parentId={year || undefined} value={brand} onChange={(v) => {
          setBrand(v);
          onChange(null);
        }} />
      <Column
        label="Set"
        level="setName"
        parentId={brand || undefined}
        value={value ?? ""}
        onChange={(v) => onChange(v ? (v as SelectorId) : null)}
      />
    </div>
  );
}

function Column({
  label,
  level,
  parentId,
  value,
  onChange,
}: {
  label: string;
  level: Level;
  /** null: the top (sports); undefined: the column above isn't picked yet. */
  parentId: string | null | undefined;
  value: string;
  onChange: (id: string) => void;
}) {
  const ready = parentId !== undefined;
  const raw = useQuery(api.collectionCatalog.drill, ready ? { level, ...(parentId ? { parentId } : {}) } : "skip");
  const items = ready ? raw?.items : [];
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      <select
        className={SELECT_PANEL}
        value={value}
        disabled={!items || items.length === 0}
        aria-busy={items === undefined || undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{items === undefined ? "Loading…" : "Pick one"}</option>
        {items?.map((i) => (
          <option key={i._id} value={i._id}>
            {i.name}
          </option>
        ))}
      </select>
    </label>
  );
}

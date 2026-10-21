import { useId, useState } from "react";
import { PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { Autocomplete } from "@/components/primitives/Autocomplete";
import { Input } from "@/components/primitives/Input";
import CardFace from "../_shared/CardFace";
import {
  brands,
  cards,
  compareCards,
  describeRule,
  evaluateRule,
  normalizeSearchText,
  players,
  setLabel,
  setsInOrder,
  sports,
  teams,
  type BinderRule,
  type CardFeature,
  type Player,
  type Team,
  type VariantType,
} from "../_shared/data";
import type { PrototypeStore } from "../_shared/usePrototypeStore";
import { GO_BTN, ICON_BTN, PANEL, QUIET_BTN, SELECT, chipClass } from "./ui";

/**
 * NEO-350 prototype 4 — the smart-binder rule builder.
 *
 * Each row reads as a sentence: [Field] [is / is not] [Value]. Rows join with
 * "all" (AND) or "any" (OR). "Team on card" and "Played for (career or
 * college)" are separate fields on purpose: a Badgers alumni binder wants
 * every card of anyone who played at Wisconsin, in whatever uniform the card
 * shows. Every value is an id, never a display name, so a rename never
 * changes what the binder holds. The preview runs the real rule over the
 * whole catalog as you edit.
 */

type Field =
  | "player"
  | "teamOnCard"
  | "playedFor"
  | "brand"
  | "set"
  | "sport"
  | "year"
  | "feature"
  | "variantType"
  | "printRun"
  | "hallOfFame";

const FIELDS: { key: Field; label: string }[] = [
  { key: "player", label: "Player" },
  { key: "teamOnCard", label: "Team on card" },
  { key: "playedFor", label: "Played for (career or college)" },
  { key: "brand", label: "Brand" },
  { key: "set", label: "Set" },
  { key: "sport", label: "Sport" },
  { key: "year", label: "Year" },
  { key: "feature", label: "Card has" },
  { key: "variantType", label: "Base, insert or parallel" },
  { key: "printRun", label: "Print run" },
  { key: "hallOfFame", label: "Hall of Famer" },
];

const FEATURES: { key: CardFeature; label: string }[] = [
  { key: "RC", label: "Rookie card" },
  { key: "AU", label: "Autograph" },
  { key: "Relic", label: "Relic" },
  { key: "SP", label: "Short print" },
];
const VARIANT_TYPES: VariantType[] = ["Base", "Inserts", "Parallels"];

interface RuleRow {
  id: number;
  field: Field;
  negate: boolean;
  value: string;
  to: string;
}

function defaultValue(field: Field): Pick<RuleRow, "value" | "to"> {
  switch (field) {
    case "brand":
      return { value: brands[0].id, to: "" };
    case "set":
      return { value: setsInOrder()[0].id, to: "" };
    case "sport":
      return { value: sports[0].id, to: "" };
    case "feature":
      return { value: "RC", to: "" };
    case "variantType":
      return { value: "Parallels", to: "" };
    case "printRun":
      return { value: "50", to: "" };
    case "year":
      return { value: "1990", to: "1999" };
    default:
      return { value: "", to: "" };
  }
}

function toRule(row: RuleRow): BinderRule | null {
  let rule: BinderRule | null = null;
  switch (row.field) {
    case "player":
      rule = row.value ? { kind: "player", playerId: row.value } : null;
      break;
    case "teamOnCard":
      rule = row.value ? { kind: "teamOnCard", teamId: row.value } : null;
      break;
    case "playedFor":
      rule = row.value ? { kind: "playedFor", teamId: row.value } : null;
      break;
    case "brand":
      rule = { kind: "brand", brandId: row.value };
      break;
    case "set":
      rule = { kind: "set", setId: row.value };
      break;
    case "sport":
      rule = { kind: "sport", sportId: row.value as "baseball" };
      break;
    case "feature":
      rule = { kind: "feature", feature: row.value as CardFeature };
      break;
    case "variantType":
      rule = { kind: "variantType", type: row.value as VariantType };
      break;
    case "printRun": {
      const n = Number(row.value);
      rule = Number.isInteger(n) && n > 0 ? { kind: "printRunBelow", max: n } : null;
      break;
    }
    case "year": {
      const a = Number(row.value);
      const b = Number(row.to || row.value);
      rule =
        Number.isInteger(a) && Number.isInteger(b) && a > 1800 && b > 1800
          ? { kind: "yearRange", from: Math.min(a, b), to: Math.max(a, b) }
          : null;
      break;
    }
    case "hallOfFame":
      rule = { kind: "hallOfFame" };
      break;
  }
  if (!rule) return null;
  return row.negate ? { kind: "not", rule } : rule;
}

let rowSeq = 0;
function newRow(field: Field, value = ""): RuleRow {
  rowSeq += 1;
  return { id: rowSeq, field, negate: false, ...defaultValue(field), ...(value ? { value } : {}) };
}

export default function RuleBuilder({
  store,
  onSaved,
  onCancel,
}: {
  store: PrototypeStore;
  onSaved: (binderId: string, name: string, matches: number) => void;
  onCancel: () => void;
}) {
  const headingId = useId();
  const [rows, setRows] = useState<RuleRow[]>(() => [newRow("player", "reggie-white")]);
  const [combine, setCombine] = useState<"and" | "or">("and");
  const [name, setName] = useState("");

  const leaves = rows.map(toRule).filter((r): r is BinderRule => r !== null);
  const rule: BinderRule | null =
    leaves.length === 0 ? null : leaves.length === 1 ? leaves[0] : { kind: combine, rules: leaves };
  const matches = rule ? cards.filter((c) => evaluateRule(rule, c)).sort(compareCards) : [];
  const have = matches.filter((c) => store.ownedCount(c.id) > 0).length;
  const incomplete = rows.length - leaves.length;
  const fallbackName = rule ? describeRule(rule) : "";

  function patch(id: number, p: Partial<RuleRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...p } : r)));
  }

  function save() {
    if (!rule) return;
    const finalName = name.trim() || fallbackName;
    const binder = store.createBinder({
      kind: "smart",
      name: finalName,
      description: describeRule(rule),
      rule,
    });
    onSaved(binder.id, finalName, matches.length);
  }

  return (
    <section aria-labelledby={headingId} className={`${PANEL} space-y-4 p-4`}>
      <div>
        <h3 id={headingId} className="text-lg font-bold text-white">
          New smart binder
        </h3>
        <p className="text-sm text-slate-400">
          It fills itself from the checklist: owned cards and the ones you still need.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-300">
        Match
        <button
          type="button"
          aria-pressed={combine === "and"}
          onClick={() => setCombine("and")}
          className={chipClass(combine === "and")}
        >
          {combine === "and" && <span aria-hidden="true">✓</span>}
          all rules
        </button>
        <button
          type="button"
          aria-pressed={combine === "or"}
          onClick={() => setCombine("or")}
          className={chipClass(combine === "or")}
        >
          {combine === "or" && <span aria-hidden="true">✓</span>}
          any rule
        </button>
      </div>

      <ol className="space-y-2">
        {rows.map((row, i) => (
          <li key={row.id} className="flex flex-wrap items-center gap-2 rounded-md border border-slate-800 bg-slate-900/50 p-2">
            <span className="w-10 shrink-0 text-xs font-semibold text-slate-400">
              {i === 0 ? "Where" : combine === "and" ? "and" : "or"}
            </span>
            <select
              aria-label={`Field, rule ${i + 1}`}
              className={SELECT}
              value={row.field}
              onChange={(e) => {
                const field = e.target.value as Field;
                patch(row.id, { field, ...defaultValue(field) });
              }}
            >
              {FIELDS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
            <select
              aria-label={`Comparison, rule ${i + 1}`}
              className={SELECT}
              value={row.negate ? "not" : "is"}
              onChange={(e) => patch(row.id, { negate: e.target.value === "not" })}
            >
              <option value="is">{row.field === "printRun" ? "is under" : row.field === "year" ? "is from" : "is"}</option>
              <option value="not">
                {row.field === "printRun" ? "is not under" : row.field === "year" ? "is not from" : "is not"}
              </option>
            </select>
            <div className="min-w-0 flex-1 basis-48">
              <ValueControl row={row} index={i} onChange={(p) => patch(row.id, p)} />
            </div>
            <button
              type="button"
              aria-label={`Remove rule ${i + 1}`}
              disabled={rows.length === 1}
              onClick={() => setRows((prev) => prev.filter((r) => r.id !== row.id))}
              className={`${ICON_BTN} disabled:opacity-40`}
            >
              <TrashIcon aria-hidden="true" className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={() => setRows((prev) => [...prev, newRow("brand")])}
        className={QUIET_BTN}
      >
        <PlusIcon aria-hidden="true" className="h-4 w-4" />
        Add a rule
      </button>

      {/* Live preview */}
      <div className="rounded-md border border-neon-blue/50 bg-neon-blue/5 p-3">
        <p className="text-base font-semibold text-white" aria-live="polite">
          {rule
            ? `Matches ${matches.length} card${matches.length === 1 ? "" : "s"} · you have ${have}`
            : "Finish a rule to see what it catches."}
        </p>
        {rule && <p className="mt-0.5 text-sm text-slate-300">{describeRule(rule)}</p>}
        {incomplete > 0 && rule && (
          <p className="mt-0.5 text-xs text-neon-yellow">
            {incomplete} unfinished rule{incomplete === 1 ? " is" : "s are"} left out until you pick a value.
          </p>
        )}
        {matches.length > 0 && (
          <ul className="mt-2 flex gap-1.5 overflow-x-auto pb-1" aria-label="First matches">
            {matches.slice(0, 14).map((c) => (
              <li key={c.id} className="w-12 shrink-0">
                <CardFace card={c} size="fill" state={store.ownedCount(c.id) > 0 ? "owned" : "need"} />
              </li>
            ))}
            {matches.length > 14 && (
              <li className="self-center px-1 text-xs text-slate-400">+{matches.length - 14} more</li>
            )}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <Input
            label="Binder name"
            placeholder={fallbackName || "All Reggie White"}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
        </div>
        <button type="button" onClick={onCancel} className={QUIET_BTN}>
          Cancel
        </button>
        <button type="button" onClick={save} disabled={!rule} className={GO_BTN}>
          Save smart binder
        </button>
      </div>
    </section>
  );
}

function ValueControl({
  row,
  index,
  onChange,
}: {
  row: RuleRow;
  index: number;
  onChange: (p: Partial<RuleRow>) => void;
}) {
  const label = `Value, rule ${index + 1}`;
  switch (row.field) {
    case "player":
      return (
        <EntityPicker<Player>
          label={`Player, rule ${index + 1}`}
          items={players}
          getKey={(p) => p.id}
          getLabel={(p) => p.name}
          getDescription={(p) => `${p.sport[0].toUpperCase()}${p.sport.slice(1)}${p.hallOfFame ? ", Hall of Famer" : ""}`}
          valueKey={row.value}
          onChange={(value) => onChange({ value })}
          placeholder="Type a player"
        />
      );
    case "teamOnCard":
    case "playedFor":
      return (
        <EntityPicker<Team>
          label={`Team, rule ${index + 1}`}
          items={teams}
          getKey={(t) => t.id}
          getLabel={(t) => `${t.location} ${t.name}`}
          getDescription={(t) => t.league}
          valueKey={row.value}
          onChange={(value) => onChange({ value })}
          placeholder={row.field === "playedFor" ? "Wisconsin Badgers" : "Detroit Red Wings"}
        />
      );
    case "brand":
      return (
        <Picker label={label} value={row.value} onChange={(value) => onChange({ value })}
          options={brands.map((b) => [b.id, b.name])} />
      );
    case "set":
      return (
        <Picker label={label} value={row.value} onChange={(value) => onChange({ value })}
          options={setsInOrder().map((s) => [s.id, setLabel(s)])} />
      );
    case "sport":
      return (
        <Picker label={label} value={row.value} onChange={(value) => onChange({ value })}
          options={sports.map((s) => [s.id, s.name])} />
      );
    case "feature":
      return (
        <Picker label={label} value={row.value} onChange={(value) => onChange({ value })}
          options={FEATURES.map((f) => [f.key, f.label])} />
      );
    case "variantType":
      return (
        <Picker label={label} value={row.value} onChange={(value) => onChange({ value })}
          options={VARIANT_TYPES.map((v) => [v, v])} />
      );
    case "printRun":
      return (
        <span className="inline-flex items-center gap-1 text-sm text-slate-300">
          /
          <Input
            bare
            type="number"
            min={1}
            aria-label={`Print run, rule ${index + 1}`}
            value={row.value}
            onChange={(e) => onChange({ value: e.target.value })}
            className="w-24 px-2 py-1.5 text-sm"
          />
        </span>
      );
    case "year":
      return (
        <span className="inline-flex flex-wrap items-center gap-1 text-sm text-slate-300">
          <Input
            bare
            type="number"
            aria-label={`First year, rule ${index + 1}`}
            value={row.value}
            onChange={(e) => onChange({ value: e.target.value })}
            className="w-24 px-2 py-1.5 text-sm"
          />
          to
          <Input
            bare
            type="number"
            aria-label={`Last year, rule ${index + 1}`}
            value={row.to}
            onChange={(e) => onChange({ to: e.target.value })}
            className="w-24 px-2 py-1.5 text-sm"
          />
        </span>
      );
    case "hallOfFame":
      return <span className="text-sm text-slate-300">in the Hall of Fame</span>;
  }
}

function Picker({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <select aria-label={label} className={`${SELECT} w-full`} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map(([k, l]) => (
        <option key={k} value={k}>
          {l}
        </option>
      ))}
    </select>
  );
}

/** A type-ahead over players or teams; shows the chosen one's name when idle. */
function EntityPicker<T>({
  label,
  items,
  getKey,
  getLabel,
  getDescription,
  valueKey,
  onChange,
  placeholder,
}: {
  label: string;
  items: T[];
  getKey: (t: T) => string;
  getLabel: (t: T) => string;
  getDescription: (t: T) => string;
  valueKey: string;
  onChange: (key: string) => void;
  placeholder: string;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const current = items.find((i) => getKey(i) === valueKey);
  const shown = query ?? (current ? getLabel(current) : "");
  const needle = normalizeSearchText(query ?? "");
  const filtered = needle
    ? items
        .filter((i) =>
          needle.split(/\s+/).every((t) => normalizeSearchText(`${getLabel(i)} ${getDescription(i)}`).includes(t)),
        )
        .slice(0, 30)
    : items.slice(0, 30);
  return (
    <Autocomplete<T>
      label={label}
      query={shown}
      onQueryChange={setQuery}
      items={filtered}
      getKey={getKey}
      getLabel={getLabel}
      getDescription={getDescription}
      onSelect={(i) => {
        onChange(getKey(i));
        setQuery(null);
      }}
      onDismiss={() => setQuery(null)}
      selectedKey={valueKey || undefined}
      selectOnFocus
      placeholder={placeholder}
      emptyMessage="Nobody by that name in the checklists."
      inputGeometryClassName="px-2 py-1.5 text-sm"
      className="w-full"
    />
  );
}

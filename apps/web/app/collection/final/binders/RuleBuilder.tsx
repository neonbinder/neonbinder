import { useId, useState } from "react";
import { Autocomplete } from "@/components/primitives/Autocomplete";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import {
  MAX_RULE_TERMS,
  RULE_FEATURES,
  ruleProblem,
  type RuleFeature,
} from "@/lib/collection/binder-rule";
import { useSearchText } from "../catalog/search";
import { searchable, useDrill, useRuleBrands, useSuggestions } from "../data/store";
import type { SmartRule, SmartRuleLeaf, SmartRuleTerm, Suggestion } from "../data/types";

/**
 * NEO-362 — a smart binder's rule, built line by line: "every line fits" or
 * "any line fits", each line naming players, teams, a sport, a brand, sets,
 * years, a feature, a print run or the Hall of Fame, and each one turned
 * around with "Leave these out". Every pick is an NB id from the catalog's
 * own type-ahead or lists; a name is only ever shown (`names`), never kept
 * as the rule (product invariant 4).
 *
 * The builder only edits a draft. Its owner saves it, after `ruleProblem`
 * (the same check the server makes) says it is whole.
 */

export type RuleKind = SmartRuleLeaf["kind"];

export const RULE_KIND_WORDS: Record<RuleKind, string> = {
  player: "Player",
  team: "Team on the card",
  playedFor: "Anyone who played for a team",
  sport: "Sport",
  brand: "Brand",
  set: "Set",
  year: "Years",
  feature: "Rookie, auto, relic or short print",
  printRun: "Numbered",
  hallOfFame: "Hall of Famers",
};

const KIND_ORDER: RuleKind[] = [
  "player",
  "team",
  "playedFor",
  "set",
  "brand",
  "sport",
  "year",
  "feature",
  "printRun",
  "hallOfFame",
];

export const FEATURE_WORDS: Record<RuleFeature, string> = {
  RC: "Rookie cards",
  AU: "Autographs",
  Relic: "Relics",
  SP: "Short prints",
};

/** A rule with nothing in it yet: one player line. */
export function blankRule(): SmartRule {
  return { version: 1, match: "all", terms: [{ test: blankLeaf("player") }] };
}

export function blankLeaf(kind: RuleKind): SmartRuleLeaf {
  switch (kind) {
    case "player":
      return { kind, playerIds: [] };
    case "team":
    case "playedFor":
      return { kind, teamIds: [] };
    case "sport":
      return { kind, sportIds: [] };
    case "brand":
      return { kind, brandIds: [] };
    case "set":
      return { kind, setIds: [] };
    case "year":
      return { kind };
    case "feature":
      return { kind, feature: "RC" };
    case "printRun":
      return { kind };
    case "hallOfFame":
      return { kind };
  }
}

/** The rule in words: "Dwight Gooden, and not Mets", for the cover and the settings. */
export function describeSmartRule(rule: SmartRule, names: Readonly<Record<string, string>> = {}): string {
  const name = (ids: readonly string[]) => {
    const words = [...new Set(ids.map((id) => names[id] ?? "a pick"))];
    return words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}` : (words[0] ?? "");
  };
  const say = (leaf: SmartRuleLeaf): string => {
    switch (leaf.kind) {
      case "player":
        return name(leaf.playerIds);
      case "team":
        return `${name(leaf.teamIds)} on the card`;
      case "playedFor":
        return `anyone who played for ${name(leaf.teamIds)}`;
      case "sport":
        return name(leaf.sportIds);
      case "brand":
        return name(leaf.brandIds);
      case "set":
        return name(leaf.setIds);
      case "year":
        if (leaf.from !== undefined && leaf.to !== undefined) {
          return leaf.from === leaf.to ? `${leaf.from}` : `${leaf.from} to ${leaf.to}`;
        }
        return leaf.from !== undefined ? `${leaf.from} on` : `up to ${leaf.to}`;
      case "feature":
        return FEATURE_WORDS[leaf.feature].toLowerCase();
      case "printRun":
        if (leaf.max !== undefined && leaf.min === undefined) return `numbered /${leaf.max} or lower`;
        if (leaf.min !== undefined && leaf.max === undefined) return `numbered /${leaf.min} or higher`;
        return `numbered /${leaf.min} to /${leaf.max}`;
      case "hallOfFame":
        return "Hall of Famers";
    }
  };
  const lines = rule.terms.map((t: SmartRuleTerm) => (t.negate ? `not ${say(t.test)}` : say(t.test)));
  return lines.join(rule.match === "all" ? ", and " : ", or ");
}

const SELECT = "w-full rounded-md border border-field-rule bg-field px-3 py-2 text-base text-ink focus-outline";
const LABEL = "mb-1 block text-sm font-medium text-ink-2";
const CHOICE =
  "flex cursor-pointer items-center gap-2 rounded-md border border-field-rule bg-field px-3 py-2 text-sm text-ink-2 has-[:checked]:border-selection has-[:checked]:text-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus";
const NUMBER = "w-24 rounded-md px-3 py-2 text-base";

export default function RuleBuilder({
  rule,
  names,
  onChange,
  showProblems,
}: {
  rule: SmartRule;
  /** What each picked id reads as. */
  names: Readonly<Record<string, string>>;
  onChange: (rule: SmartRule, names: Record<string, string>) => void;
  /** After a save that missed something: say what. */
  showProblems: boolean;
}) {
  const id = useId();
  const problem = ruleProblem(rule);
  const setTerm = (i: number, term: SmartRuleTerm, more: Record<string, string> = {}) =>
    onChange({ ...rule, terms: rule.terms.map((t, j) => (j === i ? term : t)) }, { ...names, ...more });
  const removeTerm = (i: number) => onChange({ ...rule, terms: rule.terms.filter((_, j) => j !== i) }, { ...names });
  const addTerm = () => onChange({ ...rule, terms: [...rule.terms, { test: blankLeaf("player") }] }, { ...names });

  return (
    <div className="space-y-3">
      <fieldset>
        <legend className={LABEL}>Which cards it takes</legend>
        <div className="flex flex-wrap gap-2">
          {(["all", "any"] as const).map((m) => (
            <label key={m} className={CHOICE}>
              <input
                type="radio"
                name={`${id}-match`}
                className="h-4 w-4 accent-selection"
                checked={rule.match === m}
                onChange={() => onChange({ ...rule, match: m }, { ...names })}
              />
              {m === "all" ? "Cards that fit every line" : "Cards that fit any line"}
            </label>
          ))}
        </div>
      </fieldset>

      <ol className="space-y-3" aria-label="Rule lines">
        {rule.terms.map((term, i) => (
          <li key={i} className="rounded-lg border border-rule bg-raised p-3">
            <RuleLine
              index={i}
              term={term}
              names={names}
              onChange={(next, more) => setTerm(i, next, more)}
              onRemove={rule.terms.length > 1 ? () => removeTerm(i) : undefined}
            />
          </li>
        ))}
      </ol>

      {rule.terms.length < MAX_RULE_TERMS && (
        <NeonButton type="button" variant="secondary" outline onClick={addTerm} className="min-h-10">
          Add a line
        </NeonButton>
      )}
      <p role="alert" className="text-sm text-notice-warn-ink empty:hidden">
        {showProblems && problem ? problem : ""}
      </p>
    </div>
  );
}

function RuleLine({
  index,
  term,
  names,
  onChange,
  onRemove,
}: {
  index: number;
  term: SmartRuleTerm;
  names: Readonly<Record<string, string>>;
  onChange: (term: SmartRuleTerm, names?: Record<string, string>) => void;
  onRemove?: () => void;
}) {
  const id = useId();
  const leaf = term.test;
  const setLeaf = (next: SmartRuleLeaf, more?: Record<string, string>) =>
    onChange(term.negate ? { negate: true, test: next } : { test: next }, more);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[12rem] flex-1">
          <span className={LABEL}>Line {index + 1}</span>
          <select
            className={SELECT}
            value={leaf.kind}
            onChange={(e) => setLeaf(blankLeaf(e.target.value as RuleKind))}
          >
            {KIND_ORDER.map((k) => (
              <option key={k} value={k}>
                {RULE_KIND_WORDS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className={CHOICE}>
          <input
            type="checkbox"
            className="h-4 w-4 accent-selection"
            checked={!!term.negate}
            onChange={(e) => onChange(e.target.checked ? { negate: true, test: leaf } : { test: leaf })}
          />
          Leave these out
        </label>
        {onRemove && (
          <NeonButton
            type="button"
            variant="negative"
            outline
            onClick={onRemove}
            className="min-h-10"
            aria-label={`Remove line ${index + 1}`}
          >
            Remove
          </NeonButton>
        )}
      </div>
      <LeafEditor id={id} leaf={leaf} names={names} onChange={setLeaf} />
    </div>
  );
}

function LeafEditor({
  id,
  leaf,
  names,
  onChange,
}: {
  id: string;
  leaf: SmartRuleLeaf;
  names: Readonly<Record<string, string>>;
  onChange: (leaf: SmartRuleLeaf, names?: Record<string, string>) => void;
}) {
  switch (leaf.kind) {
    case "player":
      return (
        <ChipPicker
          kind="player"
          label="Players"
          placeholder="Type a player"
          ids={leaf.playerIds}
          names={names}
          onChange={(ids, more) => onChange({ kind: "player", playerIds: ids }, more)}
        />
      );
    case "team":
    case "playedFor":
      return (
        <ChipPicker
          kind="team"
          label="Teams"
          placeholder="Type a team"
          ids={leaf.teamIds}
          names={names}
          onChange={(ids, more) => onChange({ kind: leaf.kind, teamIds: ids }, more)}
        />
      );
    case "set":
      return (
        <ChipPicker
          kind="set"
          label="Sets"
          placeholder="Type a set: 2024 topps chrome"
          ids={leaf.setIds}
          names={names}
          onChange={(ids, more) => onChange({ kind: "set", setIds: ids }, more)}
        />
      );
    case "sport":
      return (
        <SportSelect
          label="Sport"
          value={leaf.sportIds[0] ?? ""}
          onChange={(sportId, name) =>
            onChange({ kind: "sport", sportIds: sportId ? [sportId] : [] }, sportId ? { [sportId]: name } : {})
          }
        />
      );
    case "brand":
      return <BrandPicker leaf={leaf} names={names} onChange={onChange} />;
    case "year":
      return (
        <div className="flex flex-wrap gap-3">
          <YearInput label="From" value={leaf.from} onChange={(from) => onChange(withNumber(leaf, "from", from))} />
          <YearInput label="To" value={leaf.to} onChange={(to) => onChange(withNumber(leaf, "to", to))} />
        </div>
      );
    case "feature":
      return (
        <label className="block">
          <span className={LABEL}>Which</span>
          <select
            className={SELECT}
            value={leaf.feature}
            onChange={(e) => onChange({ kind: "feature", feature: e.target.value as RuleFeature })}
          >
            {RULE_FEATURES.map((f) => (
              <option key={f} value={f}>
                {FEATURE_WORDS[f]}
              </option>
            ))}
          </select>
        </label>
      );
    case "printRun":
      return (
        <label className="flex items-center gap-2 text-sm text-ink-2" htmlFor={`${id}-max`}>
          Numbered to /
          <Input
            bare
            id={`${id}-max`}
            type="number"
            inputMode="numeric"
            min={1}
            className={NUMBER}
            value={leaf.max ?? ""}
            onChange={(e) => onChange(withNumber(leaf, "max", e.target.value))}
          />
          or lower
        </label>
      );
    case "hallOfFame":
      return <p className="text-sm text-ink-2">Cards of players in their sport&apos;s Hall of Fame.</p>;
  }
}

function withNumber<T extends SmartRuleLeaf & { kind: "year" | "printRun" }>(leaf: T, key: string, raw: string): T {
  const next = { ...leaf } as Record<string, unknown>;
  const n = raw.trim() === "" ? undefined : Number(raw);
  if (n === undefined || Number.isNaN(n)) delete next[key];
  else next[key] = Math.floor(n);
  return next as T;
}

function YearInput({ label, value, onChange }: { label: string; value: number | undefined; onChange: (raw: string) => void }) {
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      <Input
        bare
        type="number"
        inputMode="numeric"
        min={1850}
        max={2100}
        placeholder="Any"
        className={NUMBER}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function SportSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (sportId: string, name: string) => void;
}) {
  const sports = useDrill("sport", {});
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      <select
        className={SELECT}
        value={value}
        onChange={(e) => onChange(e.target.value, sports?.find((s) => s.id === e.target.value)?.name ?? "")}
      >
        <option value="">{sports ? "Pick a sport" : "Loading sports…"}</option>
        {(sports ?? []).map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A brand is one NB row per year: pick the sport, then the brand, and the line names every year's row. */
function BrandPicker({
  leaf,
  names,
  onChange,
}: {
  leaf: Extract<SmartRuleLeaf, { kind: "brand" }>;
  names: Readonly<Record<string, string>>;
  onChange: (leaf: SmartRuleLeaf, names?: Record<string, string>) => void;
}) {
  const [sportId, setSportId] = useState("");
  const brands = useRuleBrands(sportId || null);
  const picked = leaf.brandIds.length ? names[leaf.brandIds[0]] : undefined;
  return (
    <div className="space-y-2">
      {picked && (
        <p className="text-sm text-ink">
          Brand: <span className="font-medium">{picked}</span>
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <SportSelect label={picked ? "Change it: sport" : "Sport"} value={sportId} onChange={(id) => setSportId(id)} />
        <label className="block">
          <span className={LABEL}>Brand</span>
          <select
            className={SELECT}
            disabled={!sportId}
            value=""
            onChange={(e) => {
              const brand = brands?.find((b) => b.name === e.target.value);
              if (!brand) return;
              onChange(
                { kind: "brand", brandIds: brand.ids },
                Object.fromEntries(brand.ids.map((id) => [id, brand.name])),
              );
            }}
          >
            <option value="">{!sportId ? "Pick a sport first" : brands ? "Pick a brand" : "Loading brands…"}</option>
            {(brands ?? []).map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

type Pickable = Extract<Suggestion, { kind: "player" | "team" | "set" }>;

function suggestionName(s: Pickable): string {
  if (s.kind === "set") return s.label;
  if (s.kind === "team") return s.location ? `${s.location} ${s.name}` : s.name;
  return s.name;
}

/** Players, teams or sets, typed and picked from the catalog, shown as chips. */
function ChipPicker({
  kind,
  label,
  placeholder,
  ids,
  names,
  onChange,
}: {
  kind: Pickable["kind"];
  label: string;
  placeholder: string;
  ids: readonly string[];
  names: Readonly<Record<string, string>>;
  onChange: (ids: string[], names?: Record<string, string>) => void;
}) {
  const [q, setQ] = useState("");
  const settled = useSearchText(q);
  const suggestions = useSuggestions(settled);
  const items = (suggestions ?? []).filter((s): s is Pickable => s.kind === kind && !ids.includes(s.id));
  return (
    <div>
      {ids.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2" aria-label={`${label} picked`}>
          {ids.map((pid) => (
            <li key={pid}>
              <button
                type="button"
                onClick={() => onChange(ids.filter((x) => x !== pid))}
                className="focus-outline min-h-10 rounded-full border border-selection px-3 text-sm text-ink hover:bg-hover-raised"
                aria-label={`Remove ${names[pid] ?? "this pick"}`}
              >
                {names[pid] ?? "Picked"} <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Autocomplete<Pickable>
        label={label}
        placeholder={placeholder}
        query={q}
        onQueryChange={setQ}
        items={items}
        getKey={(s) => s.id}
        getLabel={suggestionName}
        onSelect={(s) => {
          onChange([...ids, s.id], { [s.id]: suggestionName(s) });
          setQ("");
        }}
        loading={searchable(settled) && suggestions === undefined}
        emptyMessage={kind === "player" ? "No player by that name" : kind === "team" ? "No team by that name" : "No set by that name"}
        hideWhenEmpty={!searchable(q)}
        inputGeometryClassName="px-3 py-2 text-base"
      />
    </div>
  );
}

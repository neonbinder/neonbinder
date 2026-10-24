import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Autocomplete } from "@/components/primitives/Autocomplete";
import { Input } from "@/components/primitives/Input";
import { spineFontById, spineFontFamilyCss } from "@/lib/print/spine-fonts";
import Modal from "../../prototypes/p2/Modal";
import { useSearchText } from "../catalog/search";
import { searchable, useCapabilities, useSuggestions } from "../data/store";
import type { ContainerKind, ContainerLabel, ContainerRule, NewContainer, Suggestion } from "../data/types";
import { useDraftRuleHints } from "./hooks";
import { defaultLabel, sameLabel, shelfColors, teamPicks, validLabel } from "./label";
import LabelDesigner from "./LabelDesigner";
import { teamRule } from "./model";
import NeonButton from "@/components/modules/NeonButton";

/**
 * NEO-359 — something new for the shelf: a binder you fill yourself, a box
 * (everything in a box is for sale), or, where the store can do it
 * (capability `smartBinders`, the demo for now), a smart binder that fills
 * itself from a rule.
 *
 * A rule names an NB id, never a name: the player or team is picked from a
 * type-ahead over the catalog. A team rule means cards SHOWING the team, in
 * that jersey; "Also count anyone who played for them" widens it to the
 * team's alumni on any card.
 *
 * The label follows what it is (black vinyl for a binder, masking tape for a
 * box, the rule's team for a smart binder) until the collector styles it.
 *
 * A submit that misses something puts the keyboard on the first field to
 * fix. The create waits in the dialog: while it is out, "Put it on the
 * shelf" says busy and ignores presses (`aria-disabled`, focus stays), and a
 * refusal is said here, tied to that button. On success the caller closes it.
 */

type Kind = "binder" | "box" | "smart";
type RuleKind = "player" | "team";
type PlayerSuggestion = Extract<Suggestion, { kind: "player" }>;
type TeamSuggestion = Extract<Suggestion, { kind: "team" }>;

const CHOICE =
  "flex cursor-pointer items-start gap-2 rounded-md border border-field-rule bg-field px-3 py-2 text-sm text-ink-2 has-[:checked]:border-selection has-[:checked]:text-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus";
const SELECT = "w-full rounded-md border border-field-rule bg-field px-3 py-2 text-base text-ink focus-outline";
const LABEL = "mb-1 block text-sm font-medium text-ink-2";

const KINDS: { kind: Kind; title: string; line: string }[] = [
  { kind: "binder", title: "A binder", line: "You slot the cards in. Nine-pocket pages, like the real one." },
  { kind: "box", title: "A box", line: "Everything in it is for sale. Five rows, like a long box." },
  { kind: "smart", title: "Smart: it fills itself", line: "Every card that fits the rule, the ones you have and the ones you need." },
];

export default function NewBinderDialog({
  onCreate,
  onClose,
}: {
  /** Resolves with null when it is on the shelf (the caller closes the dialog), or why it was refused. */
  onCreate: (input: NewContainer) => Promise<string | null>;
  onClose: () => void;
}) {
  const titleId = useId();
  const errorId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by a submit that missed something: focus goes to the first field to fix. */
  const [missed, setMissed] = useState(0);
  const { smartBinders } = useCapabilities();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("binder");
  const [ruleKind, setRuleKind] = useState<RuleKind>("player");
  const [player, setPlayer] = useState<PlayerSuggestion | null>(null);
  const [team, setTeam] = useState<TeamSuggestion | null>(null);
  const [alumni, setAlumni] = useState(false);
  const [tried, setTried] = useState(false);
  const [styling, setStyling] = useState(false);
  /** The collector's own label, once they touch it; until then the default. */
  const [custom, setCustom] = useState<ContainerLabel | null>(null);
  const [labelError, setLabelError] = useState(false);

  const trimmed = name.trim();
  const smart = kind === "smart" && smartBinders;
  const rule: ContainerRule | null = !smart
    ? null
    : ruleKind === "player"
      ? player
        ? { kind: "player", playerId: player.id }
        : null
      : team
        ? teamRule(team.id, alumni)
        : null;
  const hints = useDraftRuleHints(rule);
  const containerKind: ContainerKind = kind === "box" ? "box" : "binder";
  const fallback = defaultLabel({ kind: containerKind, rule: rule ?? undefined }, hints);
  const draft = custom ?? fallback;
  const picks = smart ? teamPicks(hints.teams ?? [], hints.ruleTeam ?? null) : [];
  const noun = kind === "box" ? "box" : "binder";
  const ruleMissing = smart && !rule;

  useEffect(() => {
    if (missed === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [missed]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setTried(true);
    if (!trimmed || ruleMissing) {
      setMissed((n) => n + 1);
      return;
    }
    const valid = custom ? validLabel(custom) : undefined;
    if (valid === null) {
      setStyling(true);
      setLabelError(true);
      setMissed((n) => n + 1);
      return;
    }
    // A pick that IS the default stores nothing, so the label keeps
    // following what it is (as "Edit label" does).
    const label = valid && !sameLabel(valid, fallback) ? valid : undefined;
    const input: NewContainer = { kind: containerKind, name: trimmed };
    if (label) input.label = label;
    if (rule) input.rule = rule;
    setError(null);
    setBusy(true);
    const refused = await onCreate(input);
    setBusy(false);
    if (refused) setError(refused);
  }

  return (
    <Modal labelledBy={titleId} onClose={onClose} className="max-w-lg">
      <form ref={formRef} onSubmit={(e) => void submit(e)} className="p-5" noValidate>
        <h2 id={titleId} className="text-xl font-bold text-ink">
          New binder or box
        </h2>
        <p className="mt-1 text-sm text-ink-2">Name it, then pick what it is.</p>

        <div className="mt-4">
          <Input
            label={kind === "box" ? "Box name" : "Binder name"}
            placeholder={kind === "box" ? "Show box" : "Packers PC"}
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={tried && !trimmed ? `Give the ${noun} a name.` : undefined}
            data-autofocus
          />
        </div>

        <fieldset className="mt-4">
          <legend className={LABEL}>What is it?</legend>
          <div className="grid gap-2">
            {KINDS.filter((k) => k.kind !== "smart" || smartBinders).map((k) => (
              <label key={k.kind} className={CHOICE}>
                <input
                  type="radio"
                  name={`${titleId}-kind`}
                  className="mt-0.5 h-4 w-4 accent-selection"
                  checked={kind === k.kind}
                  onChange={() => {
                    setKind(k.kind);
                    // A label styled for a binder is not a box's tape: start over.
                    setCustom(null);
                  }}
                />
                <span>
                  <span className="block font-medium">{k.title}</span>
                  <span className="block text-ink-3">{k.line}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {smart && (
          <div className="mt-4 space-y-3">
            <label className="block">
              <span className={LABEL}>Rule</span>
              <select className={SELECT} value={ruleKind} onChange={(e) => setRuleKind(e.target.value as RuleKind)}>
                <option value="player">Every card of a player</option>
                <option value="team">A team</option>
              </select>
            </label>
            {ruleKind === "player" ? (
              <EntityPicker<PlayerSuggestion>
                kind="player"
                label="Player"
                placeholder="Type a player: try reggie white"
                picked={player}
                onPick={setPlayer}
                nameOf={(p) => p.name}
                error={tried && !player ? "Pick a player from the list." : undefined}
              />
            ) : (
              <>
                <EntityPicker<TeamSuggestion>
                  kind="team"
                  label="Team"
                  placeholder="Type a team: try packers"
                  picked={team}
                  onPick={setTeam}
                  nameOf={(t) => (t.location ? `${t.location} ${t.name}` : t.name)}
                  error={tried && !team ? "Pick a team from the list." : undefined}
                />
                <p className="text-sm text-ink-2">
                  Cards showing the {team?.name ?? "team"} on the card, in that jersey.
                </p>
                <label className={CHOICE}>
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-selection"
                    checked={alumni}
                    onChange={(e) => setAlumni(e.target.checked)}
                  />
                  <span>
                    <span className="block font-medium">Also count anyone who played for them</span>
                    <span className="block text-ink-3">Their alumni too, on any team&apos;s card. College days count.</span>
                  </span>
                </label>
              </>
            )}
          </div>
        )}

        <section aria-labelledby={`${titleId}-spine`} className="mt-5 border-t border-rule-strong pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <h3 id={`${titleId}-spine`} className="text-sm font-medium text-ink-2">
              {kind === "box" ? "Box label" : "Spine label"}
            </h3>
            {!styling && <LabelChip name={trimmed || (kind === "box" ? "Your box" : "Your binder")} label={draft} />}
            <NeonButton
              type="button"
              variant="secondary"
              outline
              aria-expanded={styling}
              onClick={() => setStyling((v) => !v)}
              className="ml-auto min-h-10"
            >
              {styling ? "Done styling" : kind === "box" ? "Style the label" : "Style the spine"}
            </NeonButton>
          </div>
          {!styling && (
            <p className="mt-1 text-xs text-ink-3">
              {custom
                ? "Your colors and lettering."
                : kind === "box"
                  ? "A strip of masking tape, marker lettering. Change it any time."
                  : smart
                    ? ruleKind === "team"
                      ? "Wears the colors of the team its rule names. Change it any time."
                      : "Wears the colors of the team on most of the player's cards. Change it any time."
                    : "Black vinyl, white lettering. Change it any time."}
            </p>
          )}
          {styling && (
            <div className="mt-3">
              <LabelDesigner
                name={trimmed}
                draft={draft}
                teamPicks={picks}
                onChange={(next) => {
                  setCustom(next);
                  setLabelError(false);
                }}
              />
            </div>
          )}
          <p role="alert" className="mt-2 text-sm text-notice-warn-ink empty:hidden">
            {labelError ? "Both label colors need to be hex, like #203731." : ""}
          </p>
        </section>

        <p id={errorId} role="alert" className="mt-4 text-sm text-neon-pink-text empty:hidden">
          {error ?? ""}
        </p>
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <NeonButton type="button" variant="negative" outline onClick={onClose} className="min-h-10">
            Cancel
          </NeonButton>
          <NeonButton
            type="submit"
            aria-disabled={busy ? true : undefined}
            aria-busy={busy ? true : undefined}
            aria-describedby={error && !busy ? errorId : undefined}
            className="min-h-10"
          >
            Put it on the shelf
          </NeonButton>
        </div>
      </form>
    </Modal>
  );
}

/** A rule's player or team, typed and picked from the catalog (never a name kept as text). */
function EntityPicker<T extends PlayerSuggestion | TeamSuggestion>({
  kind,
  label,
  placeholder,
  picked,
  onPick,
  nameOf,
  error,
}: {
  kind: T["kind"];
  label: string;
  placeholder: string;
  picked: T | null;
  onPick: (s: T | null) => void;
  nameOf: (s: T) => string;
  error?: string;
}) {
  const errorId = useId();
  const [q, setQ] = useState(picked ? nameOf(picked) : "");
  const settled = useSearchText(q);
  const suggestions = useSuggestions(settled);
  const items = (suggestions ?? []).filter((s): s is T => s.kind === kind);
  return (
    <div>
      <p aria-hidden="true" className={LABEL}>
        {label}
      </p>
      <Autocomplete<T>
        label={label}
        placeholder={placeholder}
        query={q}
        onQueryChange={(next) => {
          setQ(next);
          // Typing past a pick un-picks it: the rule is only ever a picked id.
          if (picked && next !== nameOf(picked)) onPick(null);
        }}
        items={items}
        getKey={(s) => s.id}
        getLabel={nameOf}
        onSelect={(s) => {
          onPick(s);
          setQ(nameOf(s));
        }}
        loading={searchable(settled) && suggestions === undefined}
        emptyMessage={kind === "player" ? "No player by that name" : "No team by that name"}
        hideWhenEmpty={!searchable(q)}
        inputGeometryClassName="px-3 py-2 text-base"
        selectedKey={picked?.id}
        describedBy={error ? errorId : undefined}
        invalid={!!error}
      />
      <p id={errorId} role="alert" className="mt-1 text-sm text-notice-warn-ink empty:hidden">
        {error ?? ""}
      </p>
    </div>
  );
}

/** The label, lettered across: what the spine or tape will wear, at a glance. */
function LabelChip({ name, label }: { name: string; label: ContainerLabel }) {
  const valid = validLabel(label);
  if (!valid) return null;
  const colors = shelfColors(valid, 16);
  return (
    <span
      aria-hidden="true"
      className="max-w-[12rem] truncate rounded-sm px-2 py-0.5 text-base font-bold leading-6"
      style={{
        background: colors.background,
        color: colors.text,
        fontFamily: spineFontFamilyCss(spineFontById(valid.fontId)),
        boxShadow: "0 0 0 1px rgba(255,255,255,0.18)",
      }}
    >
      {name}
    </span>
  );
}

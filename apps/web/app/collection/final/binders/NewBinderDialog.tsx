import { useId, useState, type FormEvent } from "react";
import { Input } from "@/components/primitives/Input";
import { spineFontById, spineFontFamilyCss } from "@/lib/print/spine-fonts";
import { players, teams, type BinderRule } from "../../prototypes/_shared/data";
import type { NewBinder } from "../../prototypes/_shared/usePrototypeStore";
import Modal from "../../prototypes/p2/Modal";
import type { BinderLabel } from "../store";
import { binderTeamPicks, defaultLabelForNew, sameLabel, shelfColors, validLabel } from "./label";
import LabelDesigner from "./LabelDesigner";
import { teamRule } from "./model";
import NeonButton from "@/components/modules/NeonButton";

/**
 * A new binder off the shelf (p2's dialog): one you fill yourself (with real
 * nine-pocket pages, if you like), or a smart one that fills itself from a
 * rule.
 *
 * A team rule means cards SHOWING the team, in that jersey. "Also count
 * anyone who played for them" is an opt-in that widens it to the team's
 * alumni on any card.
 *
 * Its spine label follows the rule (the team it names, or the team on most of
 * the player's cards; black for a binder you fill yourself) until the
 * collector styles it under "Style the spine", where a smart binder's teams
 * are offered as quick picks.
 */

type RuleKind = "player" | "team";

const CHOICE =
  "flex cursor-pointer items-start gap-2 rounded-md border border-field-rule bg-field px-3 py-2 text-sm text-ink-2 has-[:checked]:border-selection has-[:checked]:text-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus";
const SELECT =
  "w-full rounded-md border border-field-rule bg-field px-3 py-2 text-base text-ink focus-outline";
const LABEL = "mb-1 block text-sm font-medium text-ink-2";

const sortedPlayers = [...players].sort((a, b) => a.name.localeCompare(b.name));
const sortedTeams = [...teams].sort(
  (a, b) => a.location.localeCompare(b.location) || a.name.localeCompare(b.name),
);

export default function NewBinderDialog({
  onCreate,
  onClose,
}: {
  onCreate: (input: NewBinder, label?: BinderLabel) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"manual" | "smart">("manual");
  const [pages, setPages] = useState(true);
  const [ruleKind, setRuleKind] = useState<RuleKind>("player");
  const [playerId, setPlayerId] = useState(sortedPlayers[0].id);
  const [teamId, setTeamId] = useState(sortedTeams[0].id);
  const [alumni, setAlumni] = useState(false);
  const [tried, setTried] = useState(false);
  const [styling, setStyling] = useState(false);
  /** The collector's own label, once they touch it; until then the rule's. */
  const [custom, setCustom] = useState<BinderLabel | null>(null);
  const [labelError, setLabelError] = useState(false);

  const trimmed = name.trim();
  const team = sortedTeams.find((t) => t.id === teamId);
  const rule: BinderRule = ruleKind === "player" ? { kind: "player", playerId } : teamRule(teamId, alumni);
  const ruleLabel = defaultLabelForNew(kind === "manual" ? { kind: "manual" } : { kind: "smart", rule });
  const draft = custom ?? ruleLabel;
  const teamPicks = kind === "smart" ? binderTeamPicks({ id: "new", kind: "smart", name: trimmed, rule }) : [];

  function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (!trimmed) return;
    const valid = custom ? validLabel(custom) : undefined;
    if (valid === null) {
      setStyling(true);
      setLabelError(true);
      return;
    }
    // A pick that IS the rule's default stores nothing, so the binder keeps
    // following its rule (as "Edit label" does).
    const label = valid && !sameLabel(valid, ruleLabel) ? valid : undefined;
    if (kind === "manual") {
      onCreate({ kind: "manual", name: trimmed, pages: pages ? 1 : undefined }, label);
      return;
    }
    onCreate({ kind: "smart", name: trimmed, rule }, label);
  }

  return (
    <Modal labelledBy={titleId} onClose={onClose} className="max-w-lg">
      <form onSubmit={submit} className="p-5">
        <h2 id={titleId} className="text-xl font-bold text-ink">
          New binder
        </h2>
        <p className="mt-1 text-sm text-ink-2">Name it, then pick how it fills up.</p>

        <div className="mt-4">
          <Input
            label="Binder name"
            placeholder="Packers PC"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={tried && !trimmed ? "Give it a name for the spine." : undefined}
            data-autofocus
          />
        </div>

        <fieldset className="mt-4">
          <legend className={LABEL}>How it fills</legend>
          <div className="grid gap-2">
            <label className={CHOICE}>
              <input
                type="radio"
                name={`${titleId}-kind`}
                className="mt-0.5 h-4 w-4 accent-selection"
                checked={kind === "manual"}
                onChange={() => setKind("manual")}
              />
              <span>
                <span className="block font-medium">I&apos;ll slot cards in myself</span>
                <span className="block text-ink-3">Drag from the pack, or file a copy from its details.</span>
              </span>
            </label>
            <label className={CHOICE}>
              <input
                type="radio"
                name={`${titleId}-kind`}
                className="mt-0.5 h-4 w-4 accent-selection"
                checked={kind === "smart"}
                onChange={() => setKind("smart")}
              />
              <span>
                <span className="block font-medium">Smart: it fills itself</span>
                <span className="block text-ink-3">
                  Every card that fits the rule, the ones you have and the ones you need.
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        {kind === "manual" ? (
          <label className={`${CHOICE} mt-4`}>
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-selection"
              checked={pages}
              onChange={(e) => setPages(e.target.checked)}
            />
            <span>
              <span className="block font-medium">Give it nine-pocket pages</span>
              <span className="block text-ink-3">
                So it can match the binder on your real shelf, pocket for pocket.
              </span>
            </span>
          </label>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={LABEL}>Rule</span>
                <select
                  className={SELECT}
                  value={ruleKind}
                  onChange={(e) => setRuleKind(e.target.value as RuleKind)}
                >
                  <option value="player">Every card of a player</option>
                  <option value="team">A team</option>
                </select>
              </label>
              {ruleKind === "player" ? (
                <label className="block">
                  <span className={LABEL}>Player</span>
                  <select className={SELECT} value={playerId} onChange={(e) => setPlayerId(e.target.value)}>
                    {sortedPlayers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className="block">
                  <span className={LABEL}>Team</span>
                  <select className={SELECT} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                    {sortedTeams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.location} {t.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {ruleKind === "team" && (
              <>
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
                    <span className="block text-ink-3">
                      Their alumni too, on any team&apos;s card. College days count.
                    </span>
                  </span>
                </label>
              </>
            )}
          </div>
        )}

        <section aria-labelledby={`${titleId}-spine`} className="mt-5 border-t border-rule-strong pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <h3 id={`${titleId}-spine`} className="text-sm font-medium text-ink-2">
              Spine label
            </h3>
            {!styling && <LabelChip name={trimmed || "Your binder"} label={draft} />}
            <NeonButton
              type="button"
              variant="secondary"
              outline
              aria-expanded={styling}
              onClick={() => setStyling((v) => !v)}
              className="ml-auto min-h-10"
            >
              {styling ? "Done styling" : "Style the spine"}
            </NeonButton>
          </div>
          {!styling && (
            <p className="mt-1 text-xs text-ink-3">
              {custom
                ? "Your colors and lettering."
                : kind === "smart"
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
                teamPicks={teamPicks}
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

        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <NeonButton type="button" variant="negative" outline onClick={onClose} className="min-h-10">
            Cancel
          </NeonButton>
          <NeonButton type="submit" className="min-h-10">
            Put it on the shelf
          </NeonButton>
        </div>
      </form>
    </Modal>
  );
}

/** The label, lettered across: what the spine will wear, at a glance. */
function LabelChip({ name, label }: { name: string; label: BinderLabel }) {
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

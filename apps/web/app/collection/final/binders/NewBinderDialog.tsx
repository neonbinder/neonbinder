import { useId, useState, type FormEvent } from "react";
import { Input } from "@/components/primitives/Input";
import { players, teams, type BinderRule } from "../../prototypes/_shared/data";
import type { NewBinder } from "../../prototypes/_shared/usePrototypeStore";
import Modal from "../../prototypes/p2/Modal";
import { teamRule } from "./model";

/**
 * A new binder off the shelf (p2's dialog): one you fill yourself (with real
 * nine-pocket pages, if you like), or a smart one that fills itself from a
 * rule.
 *
 * A team rule means cards SHOWING the team, in that jersey. "Also count
 * anyone who played for them" is an opt-in that widens it to the team's
 * alumni on any card.
 */

type RuleKind = "player" | "team";

const CHOICE =
  "flex cursor-pointer items-start gap-2 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 has-[:checked]:border-[#00C2FF] has-[:checked]:text-white has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[#00C2FF]";
const SELECT =
  "w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-base text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]";
const LABEL = "mb-1 block text-sm font-medium text-slate-300";

const sortedPlayers = [...players].sort((a, b) => a.name.localeCompare(b.name));
const sortedTeams = [...teams].sort(
  (a, b) => a.location.localeCompare(b.location) || a.name.localeCompare(b.name),
);

export default function NewBinderDialog({
  onCreate,
  onClose,
}: {
  onCreate: (input: NewBinder) => void;
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

  const trimmed = name.trim();
  const team = sortedTeams.find((t) => t.id === teamId);

  function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (!trimmed) return;
    if (kind === "manual") {
      onCreate({ kind: "manual", name: trimmed, pages: pages ? 1 : undefined });
      return;
    }
    const rule: BinderRule =
      ruleKind === "player" ? { kind: "player", playerId } : teamRule(teamId, alumni);
    onCreate({ kind: "smart", name: trimmed, rule });
  }

  return (
    <Modal labelledBy={titleId} onClose={onClose} className="max-w-lg">
      <form onSubmit={submit} className="p-5">
        <h2 id={titleId} className="text-xl font-bold text-white">
          New binder
        </h2>
        <p className="mt-1 text-sm text-slate-300">Name it, then pick how it fills up.</p>

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
                className="mt-0.5 h-4 w-4 accent-[#00C2FF]"
                checked={kind === "manual"}
                onChange={() => setKind("manual")}
              />
              <span>
                <span className="block font-medium">I&apos;ll slot cards in myself</span>
                <span className="block text-slate-400">Drag from the pack, or file a copy from its details.</span>
              </span>
            </label>
            <label className={CHOICE}>
              <input
                type="radio"
                name={`${titleId}-kind`}
                className="mt-0.5 h-4 w-4 accent-[#00C2FF]"
                checked={kind === "smart"}
                onChange={() => setKind("smart")}
              />
              <span>
                <span className="block font-medium">Smart: it fills itself</span>
                <span className="block text-slate-400">
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
              className="mt-0.5 h-4 w-4 accent-[#00C2FF]"
              checked={pages}
              onChange={(e) => setPages(e.target.checked)}
            />
            <span>
              <span className="block font-medium">Give it nine-pocket pages</span>
              <span className="block text-slate-400">
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
                <p className="text-sm text-slate-300">
                  Cards showing the {team?.name ?? "team"} on the card, in that jersey.
                </p>
                <label className={CHOICE}>
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-[#00C2FF]"
                    checked={alumni}
                    onChange={(e) => setAlumni(e.target.checked)}
                  />
                  <span>
                    <span className="block font-medium">Also count anyone who played for them</span>
                    <span className="block text-slate-400">
                      Their alumni too, on any team&apos;s card. College days count.
                    </span>
                  </span>
                </label>
              </>
            )}
          </div>
        )}

        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="min-h-10 rounded-md border border-slate-600 px-4 text-sm font-medium text-slate-200 hover:border-slate-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="min-h-10 rounded-md bg-neon-green px-4 text-sm font-bold text-black hover:bg-[#33e07c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
          >
            Put it on the shelf
          </button>
        </div>
      </form>
    </Modal>
  );
}

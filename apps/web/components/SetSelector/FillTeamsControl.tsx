import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ConfirmDialog } from "../modules/confirm-dialog";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
import type { SelectorLevel } from "./selector-sync-feedback";

/**
 * NEO-279 — fill the teams a set's cards are missing, from evidence the set
 * already holds.
 *
 * A checklist arrives with cards that name a player and no team. Most of those
 * teams are already knowable from NB's own rows: the same player appears on
 * another card in this set WITH a team; the player only ever played for one
 * team; the player had exactly one stint in the set's year. This control asks
 * the server what it can fill from those three rules, shows the answer as a
 * question, and fills only on "Yes". Nothing is silent: a fill that would
 * touch zero cards says so in a toast and never opens a dialog, and the dialog
 * lists who gets which team — every card that still cannot be filled stays in
 * the missing-team lane for the attention walker, which is where it was.
 *
 * Set level only. Teams borrowed from "the same player in this set" are a
 * whole-set fact, and the server refuses any other node with a `ConvexError`
 * whose text is shown as written.
 *
 * Four states, all stated in words on the trigger or in the dialog. The
 * trigger's text IS its accessible name — no `aria-label` — so a screen
 * reader hears the same state change a sighted operator sees:
 *   • idle       — "Fill teams"
 *   • checking   — "Checking…", `aria-busy` + `aria-disabled` (never native
 *                  `disabled`: the button that was just pressed would blur to
 *                  <body>)
 *   • asking     — the ConfirmDialog, Cancel-focused per the house contract
 *   • filling    — the dialog's confirm reads "Filling…"; a refusal from the
 *                  server lands INSIDE the dialog (`error`), where the
 *                  question was asked, rather than closing it. One refusal is
 *                  expected by design: the apply sends the preview's
 *                  `fillable` back as `expectedFillable`, and the server
 *                  declines to fill MORE cards than the operator said yes to
 *                  (a re-sync landed in between). They cancel and check again.
 *
 * The ledger lists groups riskiest first — the server orders them: teams
 * taken from the player's career, then teams borrowed from another node of
 * the set (those rows name the nodes they would write to), then teams found
 * under the card's own node. The top of the list is where a second look pays.
 *
 * Copy helpers are exported and pure so the pluralisation and the joined
 * sentence can be pinned in a test without a Convex client in the way — the
 * same split `SetAttributesPanel` makes for its Team confirm.
 */

export type TeamFillRule = "samePlayerInSet" | "oneTeamCareer" | "oneStintInYear";

/** `sameNode` / `acrossSet` are rule A's two reaches; `career` is rules B and C. */
export type TeamFillScope = "sameNode" | "acrossSet" | "career";

export type TeamFillGroup = {
  playerNames: string[];
  teamNames: string[];
  rule: TeamFillRule;
  scope: TeamFillScope;
  /** Display names of the nodes this group writes to, at most four. */
  nodeNames: string[];
  /** Distinct nodes in total; more than `nodeNames.length` means "+N more". */
  nodeCount: number;
  cardCount: number;
};

export type TeamFillPreview = {
  candidates: number;
  fillable: number;
  byRule: Record<TeamFillRule, number>;
  remaining: number;
  setYear: number | null;
  /** At most 200, riskiest first, then `cardCount` descending. */
  groups: TeamFillGroup[];
  groupsTotal: number;
};

export type TeamFillResult = {
  applied: number;
  skipped: number;
  byRule: Record<TeamFillRule, number>;
};

/** The trigger's idle text, which is also its accessible name — one string, so SC 2.5.3 holds. */
export const FILL_TEAMS_LABEL = "Fill teams";

/** The trigger's text while the preview is in flight. */
export const FILL_TEAMS_CHECKING_LABEL = "Checking…";

/** Accessible name of the dialog's scrollable list. */
export const FILL_TEAMS_LIST_LABEL = "Who gets which team";

/** The trigger's tooltip: what pressing it does, and that nothing changes unseen. */
export const FILL_TEAMS_TOOLTIP =
  "Cards with no team yet get one from what this set already knows. You see the list before anything changes.";

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * The clause at the end of each row — where the team came from:
 *
 *   "same player in this set"                        rule A, own node
 *   "same player in this set · Base, Stars +2 more"  rule A, borrowed from
 *                                                    other nodes, named
 *   "only team on file"                              rule B
 *   "only team in 1991" / "only team that year"      rule C, with the set's
 *                                                    year when it has one
 *
 * A set with no year still fills from a single stint, so C falls back to the
 * generic form rather than inventing a year. Node names are listed only for a
 * cross-node borrow: that is the reach worth a second look, and naming the
 * nodes is what makes it checkable.
 */
export function fillRuleLabel(
  group: Pick<TeamFillGroup, "rule" | "scope" | "nodeNames" | "nodeCount">,
  setYear: number | null,
): string {
  switch (group.rule) {
    case "samePlayerInSet": {
      const base = "same player in this set";
      if (group.scope !== "acrossSet" || group.nodeNames.length === 0) return base;
      const more = group.nodeCount - group.nodeNames.length;
      return `${base} · ${group.nodeNames.join(", ")}${more > 0 ? ` +${more} more` : ""}`;
    }
    case "oneTeamCareer":
      return "only team on file";
    case "oneStintInYear":
      return setYear === null ? "only team that year" : `only team in ${setYear}`;
  }
}

/**
 * One row of the ledger, as three pieces the markup sets in different
 * weights, plus the whole line for anything that wants it as text:
 *
 *   "Johnny Bench → Cincinnati Reds · 11 cards · same player in this set"
 *
 * Several players on one card are joined with " & " (a dual card), several
 * teams with " / " (a card carrying more than one team).
 */
export function fillGroupLine(
  group: TeamFillGroup,
  setYear: number | null,
): { players: string; teams: string; meta: string; line: string } {
  const players = group.playerNames.join(" & ");
  const teams = group.teamNames.join(" / ");
  const meta = `${plural(group.cardCount, "card", "cards")} · ${fillRuleLabel(group, setYear)}`;
  return { players, teams, meta, line: `${players} → ${teams} · ${meta}` };
}

/**
 * The confirm's title and body.
 *
 *   title: "Fill teams on 14 cards?"
 *   body:  "11 from the same player's other cards here, 2 from the only team
 *           on file, 1 from the only team that year. 3 still need your call."
 *
 * Only the non-zero rules are said, in the order the server applies them. The
 * last sentence is dropped when nothing is left: "0 still need your call" is
 * reassurance nobody asked for.
 */
export function fillConfirmCopy(preview: TeamFillPreview): {
  title: string;
  description: string;
} {
  const parts: string[] = [];
  if (preview.byRule.samePlayerInSet > 0) {
    parts.push(`${preview.byRule.samePlayerInSet} from the same player's other cards here`);
  }
  if (preview.byRule.oneTeamCareer > 0) {
    parts.push(`${preview.byRule.oneTeamCareer} from the only team on file`);
  }
  if (preview.byRule.oneStintInYear > 0) {
    parts.push(`${preview.byRule.oneStintInYear} from the only team that year`);
  }
  const sentences: string[] = [];
  if (parts.length > 0) sentences.push(`${parts.join(", ")}.`);
  if (preview.remaining > 0) sentences.push(stillNeedYourCall(preview.remaining));
  return {
    title: `Fill teams on ${plural(preview.fillable, "card", "cards")}?`,
    description: sentences.join(" "),
  };
}

/** "3 still need your call." / "1 still needs your call." */
function stillNeedYourCall(remaining: number): string {
  return `${remaining} still ${remaining === 1 ? "needs" : "need"} your call.`;
}

/**
 * Said when the preview finds nothing to do; no dialog follows it. Two
 * different facts, told apart: every card is teamed (nothing left at all), or
 * some are not and no rule can honestly answer them (they are the operator's).
 */
export function nothingToFillToast(remaining: number): string {
  if (remaining === 0) return "Nothing to fill — every card here has its team.";
  return `Nothing to fill — the ${remaining} still without a team ${
    remaining === 1 ? "needs" : "need"
  } your call.`;
}

/**
 * "Filled teams on 14 cards" — and, when a card was teamed between the
 * preview and the fill, " · 2 skipped, someone got there first". The skip
 * clause is only said when it is true.
 */
export function fillResultToast(result: TeamFillResult): string {
  const base = `Filled teams on ${plural(result.applied, "card", "cards")}`;
  if (result.skipped > 0) return `${base} · ${result.skipped} skipped, someone got there first`;
  return base;
}

/** Toast when the preview itself failed for a reason the server did not word. */
export const CHECK_FAILED_FALLBACK = "Could not check the cards. Nothing changed.";

/** In-dialog alert when the fill failed for a reason the server did not word. */
export const FILL_FAILED_FALLBACK = "Could not fill teams. Nothing changed.";

export default function FillTeamsControl({
  id,
  level,
  showToast,
}: {
  id: Id<"selectorOptions">;
  level: SelectorLevel;
  /** The panel's own toast, so this reads where every other confirmation does. */
  showToast: (message: string) => void;
}) {
  const previewTeamFill = useAction(api.teamFill.previewTeamFill);
  const applyTeamFill = useAction(api.teamFill.applyTeamFill);

  const [checking, setChecking] = useState(false);
  const [filling, setFilling] = useState(false);
  const [preview, setPreview] = useState<TeamFillPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Set level only — see the header comment. The panel gates this the same
  // way; the guard here is what keeps a direct mount honest.
  if (level !== "setName") return null;

  const check = async () => {
    if (checking || filling) return;
    setChecking(true);
    try {
      const result = await previewTeamFill({ selectorOptionId: id });
      if (result.fillable === 0) {
        showToast(nothingToFillToast(result.remaining));
        return;
      }
      setError(null);
      setPreview(result);
    } catch (e) {
      // Only a ConvexError's text was written for a person (the server's
      // "Fill teams from the set row…" is one); anything else is the fallback.
      showToast(`Failed: ${userFacingMessage(e, CHECK_FAILED_FALLBACK)}`);
    } finally {
      setChecking(false);
    }
  };

  const fill = async () => {
    if (filling) return;
    setFilling(true);
    setError(null);
    try {
      // The preview's count goes back with the request: the server refuses
      // to fill MORE cards than this, so the operator never confirms one
      // number and gets another.
      const result = await applyTeamFill({
        selectorOptionId: id,
        expectedFillable: preview?.fillable ?? 0,
      });
      setPreview(null);
      showToast(fillResultToast(result));
    } catch (e) {
      // The dialog is open and announced; a message appended to the
      // description would never be read. `error` renders as an alert inside
      // it, and the operator can try again or cancel from where they are.
      setError(userFacingMessage(e, FILL_FAILED_FALLBACK));
    } finally {
      setFilling(false);
    }
  };

  const copy = preview ? fillConfirmCopy(preview) : null;
  const overflow = preview ? preview.groupsTotal - preview.groups.length : 0;

  return (
    <>
      <button
        // A stable id so the E2E driver's `pressKey` can re-find this exact
        // control; the header shares one text-button idiom across levels.
        id="fill-teams"
        type="button"
        onClick={() => void check()}
        // aria-disabled, not `disabled`: this is the button the operator just
        // pressed, and native `disabled` would blur focus to <body> the moment
        // the request started. aria-busy says WHY it is inert. No aria-label:
        // the text content is the name, so it follows the state.
        aria-disabled={checking || undefined}
        aria-busy={checking || undefined}
        title={FILL_TEAMS_TOOLTIP}
        // Same weight, colour and ring as "Mark as base set": it stands in the
        // same header slot at a different level, so it wears the same clothes.
        className="shrink-0 text-xs py-1.5 text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus-visible:ring-2 focus-visible:ring-[#00D558] focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:hover:text-gray-400"
      >
        {checking ? FILL_TEAMS_CHECKING_LABEL : FILL_TEAMS_LABEL}
      </button>
      {preview && copy && (
        <ConfirmDialog
          title={copy.title}
          description={copy.description}
          confirmLabel="Yes, fill"
          busyLabel="Filling…"
          busy={filling}
          error={error}
          childrenLabel={FILL_TEAMS_LIST_LABEL}
          onConfirm={() => void fill()}
          onCancel={() => {
            if (filling) return;
            setError(null);
            setPreview(null);
          }}
        >
          {/* The ledger: who gets which team, riskiest first (the server
              orders career rules, then cross-node borrows, then same-node
              finds; most cards first within each). Player in the panel's
              text weight, team in the semibold the livery chip uses, the
              count, the rule and — for a cross-node borrow — the nodes it
              writes to as one muted trailing clause. Three weights, no
              colour, because two hundred rows of anything brighter is
              noise; the order does the pointing. Dividers at slate-600: the
              slate-800 they were on read 1.22:1 against the slate-900 panel,
              which is to say invisible. */}
          <ul className="divide-y divide-slate-600 px-3 text-xs">
            {preview.groups.map((group, i) => {
              const row = fillGroupLine(group, preview.setYear);
              return (
                <li
                  key={`${row.players}|${row.teams}|${group.rule}|${group.scope}|${i}`}
                  className="flex flex-wrap items-baseline gap-x-1.5 py-1.5"
                >
                  <span className="text-gray-100">{row.players}</span>
                  <span className="text-gray-400">→</span>
                  <span className="font-semibold text-gray-200">{row.teams}</span>
                  <span className="text-gray-400">· {row.meta}</span>
                </li>
              );
            })}
            {overflow > 0 && (
              <li className="py-1.5 text-gray-400 italic">…and {overflow} more</li>
            )}
          </ul>
        </ConfirmDialog>
      )}
    </>
  );
}

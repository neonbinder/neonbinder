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
 * Four states, all stated in words on the trigger or in the dialog:
 *   • idle       — "Fill teams"
 *   • checking   — "Checking…", `aria-disabled` (never native `disabled`: the
 *                  button that was just pressed would blur to <body>)
 *   • asking     — the ConfirmDialog, Cancel-focused per the house contract
 *   • filling    — the dialog's confirm reads "Filling…"; a refusal from the
 *                  server lands INSIDE the dialog (`error`), where the
 *                  question was asked, rather than closing it
 *
 * Copy helpers are exported and pure so the pluralisation and the joined
 * sentence can be pinned in a test without a Convex client in the way — the
 * same split `SetAttributesPanel` makes for its Team confirm.
 */

export type TeamFillRule = "samePlayerInSet" | "oneTeamCareer" | "oneStintInYear";

export type TeamFillGroup = {
  playerNames: string[];
  teamNames: string[];
  rule: TeamFillRule;
  cardCount: number;
};

export type TeamFillPreview = {
  candidates: number;
  fillable: number;
  byRule: Record<TeamFillRule, number>;
  remaining: number;
  setYear: number | null;
  /** At most 200, sorted by `cardCount` descending. */
  groups: TeamFillGroup[];
  groupsTotal: number;
};

export type TeamFillResult = {
  applied: number;
  skipped: number;
  byRule: Record<TeamFillRule, number>;
};

/** The trigger's visible text AND accessible name — one string, so SC 2.5.3 holds. */
export const FILL_TEAMS_LABEL = "Fill teams";

/** Accessible name of the dialog's scrollable list. */
export const FILL_TEAMS_LIST_LABEL = "Who gets which team";

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * "same player in this set" / "one-team career" / "only team in 1991" — the
 * clause at the end of each row. The year is named when the set has one; a
 * set with no year still fills from a single stint, so the clause falls back
 * to the generic form rather than inventing a year.
 */
export function fillRuleLabel(rule: TeamFillRule, setYear: number | null): string {
  switch (rule) {
    case "samePlayerInSet":
      return "same player in this set";
    case "oneTeamCareer":
      return "one-team career";
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
  const meta = `${plural(group.cardCount, "card", "cards")} · ${fillRuleLabel(group.rule, setYear)}`;
  return { players, teams, meta, line: `${players} → ${teams} · ${meta}` };
}

/**
 * The confirm's title and body.
 *
 *   title: "Fill teams on 14 cards?"
 *   body:  "11 from a teammate card in this set, 2 from a one-team career,
 *           1 from the only team that year. 3 stay in the missing-team lane."
 *
 * Only the non-zero rules are said, in the order the server applies them. The
 * last sentence is dropped when nothing stays: "0 stay" is reassurance nobody
 * asked for.
 */
export function fillConfirmCopy(preview: TeamFillPreview): {
  title: string;
  description: string;
} {
  const parts: string[] = [];
  if (preview.byRule.samePlayerInSet > 0) {
    parts.push(`${preview.byRule.samePlayerInSet} from a teammate card in this set`);
  }
  if (preview.byRule.oneTeamCareer > 0) {
    parts.push(`${preview.byRule.oneTeamCareer} from a one-team career`);
  }
  if (preview.byRule.oneStintInYear > 0) {
    parts.push(`${preview.byRule.oneStintInYear} from the only team that year`);
  }
  const sentences: string[] = [];
  if (parts.length > 0) sentences.push(`${parts.join(", ")}.`);
  if (preview.remaining > 0) {
    sentences.push(
      `${preview.remaining} ${preview.remaining === 1 ? "stays" : "stay"} in the missing-team lane.`,
    );
  }
  return {
    title: `Fill teams on ${plural(preview.fillable, "card", "cards")}?`,
    description: sentences.join(" "),
  };
}

/** Said when the preview finds nothing to do; no dialog follows it. */
export const NOTHING_TO_FILL =
  "Nothing to fill — every card that could borrow a team already has one.";

/**
 * "Filled teams on 14 cards" — and, when a card changed between the preview
 * and the fill, " · 2 changed under you and were skipped". The skip clause is
 * only said when it is true.
 */
export function fillResultToast(result: TeamFillResult): string {
  const base = `Filled teams on ${plural(result.applied, "card", "cards")}`;
  if (result.skipped > 0) {
    return `${base} · ${result.skipped} changed under you and ${
      result.skipped === 1 ? "was" : "were"
    } skipped`;
  }
  return base;
}

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
        showToast(NOTHING_TO_FILL);
        return;
      }
      setError(null);
      setPreview(result);
    } catch (e) {
      // Only a ConvexError's text was written for a person (the server's
      // "Fill teams from the set row…" is one); anything else is the fallback.
      showToast(
        `Failed: ${userFacingMessage(e, "Couldn't check the cards. Nothing changed.")}`,
      );
    } finally {
      setChecking(false);
    }
  };

  const fill = async () => {
    if (filling) return;
    setFilling(true);
    setError(null);
    try {
      const result = await applyTeamFill({ selectorOptionId: id });
      setPreview(null);
      showToast(fillResultToast(result));
    } catch (e) {
      // The dialog is open and announced; a message appended to the
      // description would never be read. `error` renders as an alert inside
      // it, and the operator can try again or cancel from where they are.
      setError(userFacingMessage(e, "Couldn't fill teams. Nothing changed."));
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
        // the request started.
        aria-disabled={checking || undefined}
        aria-label={FILL_TEAMS_LABEL}
        title="Cards missing a team borrow one from this set's own evidence. You see the list first."
        // Same weight, colour and ring as "Mark as base set": it stands in the
        // same header slot at a different level, so it wears the same clothes.
        className="shrink-0 text-xs py-1.5 text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus-visible:ring-2 focus-visible:ring-[#00D558] focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:hover:text-gray-400"
      >
        {checking ? "Checking…" : FILL_TEAMS_LABEL}
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
          {/* The ledger: who gets which team, biggest effect first (the
              server sorts by card count). Player in the panel's text weight,
              team in the semibold the livery chip uses, the count and the
              rule as one muted trailing clause — three weights, no colour,
              because two hundred rows of anything brighter is noise. */}
          <ul className="divide-y divide-slate-800 px-3 text-xs">
            {preview.groups.map((group, i) => {
              const row = fillGroupLine(group, preview.setYear);
              return (
                <li
                  key={`${row.players}|${row.teams}|${group.rule}|${i}`}
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

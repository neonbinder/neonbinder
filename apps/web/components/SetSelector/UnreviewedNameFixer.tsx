import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import NeonButton from "../modules/NeonButton";
import PlayerPicker from "./PlayerPicker";
import TeamPicker from "./TeamPicker";
import { MAX_CARD_TEAMS } from "./card-attention";
import { useAttentionSportId, type AttentionFixerProps } from "./cardAttentionRegistry";

/**
 * NEO-221 (D12) — the `unreviewedName` attention fixer: "this card carries a
 * typed name and no link; which player and team is it?"
 *
 * ## Why this question exists at all
 *
 * `pendingPlayerNames` / `pendingTeamNames` are names the card carries that
 * resolve to no `players`/`teams` row, and they arrive from two directions. A
 * commit writes them when an entity-review row was never decided — the
 * operator backed out of the wizard, or the session was swept. `addCustomCard`
 * writes them when an operator types a player the table does not have yet.
 *
 * Both are self-healing on the next sync (`resolveUnknownsAndStartBatch` folds
 * them into a fresh review batch), and both leave the card with NO player or
 * team link until that sync — which is what every listing, every player page
 * and every team filter actually reads. This fixer is the way to answer it
 * now.
 *
 * Nothing here says "unreviewed" to the operator, deliberately: it is true of
 * the commit origin and a lie about the hand-typed one, and the operator only
 * needs to know the link is missing. See `ATTENTION_LABELS.unreviewedName`.
 *
 * ## Design
 *
 * - **The unlinked names are shown, not hidden behind the pickers.** They are
 *   the whole reason this card is on screen, and an operator cannot link
 *   "Yordan Alvrez" to the right player without seeing that the name on the
 *   card is misspelled.
 * - **They are BLUE, and they are not buttons.** In this walker green means
 *   "chosen/linked" and blue means provenance — the sibling `MissingTeamFixer`
 *   uses exactly that vocabulary for its suggestion chips. These tokens are
 *   neither chosen nor clickable, so they are rendered as list items with a
 *   dotted blue border: the dotted edge says unresolved, and the absence of a
 *   hover state says there is nothing to press here.
 * - **The pickers are seeded from the row, not from empty.**
 *   `selectorOptions.updateCard` takes `playerIds`/`teamOnCardIds` as FULL
 *   REPLACEMENTS, so starting either list empty and saving would silently
 *   unlink whatever the card already had.
 * - **One write, one advance.** Both lists go in a single `updateCard` call so
 *   a card carrying an unlinked player AND an unlinked team is asked once.
 */
export default function UnreviewedNameFixer({ row, onSaved }: AttentionFixerProps) {
  // Out-of-band because the locked fixer contract passes only the row, and a
  // card row does not know its set's sport. See AttentionSportContext.
  const sportId = useAttentionSportId();
  const updateCard = useMutation(api.selectorOptions.updateCard);

  /**
   * Seeded from the row for the full-replacement reason above. Plain
   * `useState` initialisers rather than an effect: unlike `MissingTeamFixer`,
   * nothing here waits on a query, and the walker remounts this component per
   * card (`key={current._id}`), so the initialiser IS the per-card reset.
   */
  const [playerIds, setPlayerIds] = useState<Array<Id<"players">>>(
    () => row.playerIds ?? [],
  );
  const [teamIds, setTeamIds] = useState<Array<Id<"teams">>>(
    () => row.teamOnCardIds ?? [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstControlRef = useRef<HTMLDivElement>(null);

  /**
   * The names this card is flagged for, read off the ROW rather than off the
   * `items` payload.
   *
   * `deriveCardAttention` derives the item's `names` from exactly these two
   * fields, so the row is the original and the item is a projection of it —
   * and reading the original is what lets this component render the two
   * groups separately (a player name needs the player picker, a team name the
   * team picker; one merged list could not say which).
   *
   * The team clause mirrors the rule: a card that already has real
   * `teamOnCardIds` is linked, and a leftover typed name on it is not an open
   * question.
   */
  const unlinkedPlayerNames = useMemo(
    () => row.pendingPlayerNames ?? [],
    [row.pendingPlayerNames],
  );
  const unlinkedTeamNames = useMemo(
    () =>
      (row.teamOnCardIds?.length ?? 0) > 0 ? [] : (row.pendingTeamNames ?? []),
    [row.teamOnCardIds, row.pendingTeamNames],
  );

  // Focus the first picker's trigger on mount. The walker remounts per card,
  // so this IS "focus on every advance" — focus is never left on a control
  // belonging to the card just answered (the NEO-189 stranding finding).
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      firstControlRef.current?.querySelector("button")?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  /**
   * Enforced once, here, for the same reason `MissingTeamFixer` does it:
   * `MAX_CARD_TEAMS` is the SAME constant the server checks, so an addition
   * past the cap is refused rather than trimmed — trimming would drop
   * whichever team the operator just picked and the write would be rejected
   * anyway.
   */
  const applyTeams = (next: Array<Id<"teams">>) => {
    if (next.length > MAX_CARD_TEAMS) return;
    setTeamIds(next);
  };
  const atCap = teamIds.length >= MAX_CARD_TEAMS;

  /**
   * Nothing to write unless a list actually CHANGED. Saving the row back to
   * itself would report the card as answered while leaving it in exactly the
   * state that flagged it — the walker would advance and the badge would stay.
   */
  const sameIds = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((id, i) => id === b[i]);
  const changed =
    !sameIds(
      playerIds as unknown as string[],
      (row.playerIds ?? []) as unknown as string[],
    ) ||
    !sameIds(
      teamIds as unknown as string[],
      (row.teamOnCardIds ?? []) as unknown as string[],
    );
  const canSave = changed && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      // Both halves in ONE call, and each side's typed names are retired in
      // the same write that links it.
      //
      // A side's WHOLE pending list goes, not one name out of it. `playerIds`
      // and `teamOnCardIds` are full replacements — saving says "these are the
      // players/teams on this card", which is an answer to every typed name on
      // that side at once, not to one of them. There is no per-name mapping to
      // make anyway: the operator picks the real player for a MISSPELLING, so
      // the two strings need not resemble each other at all.
      //
      // Only a side that actually GAINED a link is cleared; the other is
      // written back unchanged. Linking a player says nothing about an
      // unlinked team name, and clearing it would drop the operator's own
      // typing on the floor. (The server applies the same rule to
      // `pendingTeamNames` on its own, from a non-empty `teamOnCardIds` write;
      // sending both explicitly is what makes the player half — which has no
      // such derivation — behave the same way, and what makes this call fail
      // to compile if the two args ever go away.)
      //
      // Read off the ROW, not off `unlinkedTeamNames`: that list is the
      // DISPLAY list and is empty for a card that already has a linked team,
      // which would turn "leave this side alone" into "clear it".
      await updateCard({
        id: row._id,
        playerIds,
        teamOnCardIds: teamIds,
        pendingPlayerNames: playerIds.length > 0 ? [] : (row.pendingPlayerNames ?? []),
        pendingTeamNames: teamIds.length > 0 ? [] : (row.pendingTeamNames ?? []),
      });
      onSaved();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Couldn't save those links. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const summary = (() => {
    if (!changed) return "Link a player or a team to clear this card.";
    const parts: string[] = [];
    if (playerIds.length > 0) {
      parts.push(`${playerIds.length} ${playerIds.length === 1 ? "player" : "players"}`);
    }
    if (teamIds.length > 0) {
      parts.push(`${teamIds.length} ${teamIds.length === 1 ? "team" : "teams"}`);
    }
    if (parts.length === 0) return "Saves this card with no player or team link.";
    return `Links ${parts.join(" and ")} to this card.`;
  })();

  return (
    <div
      className="space-y-3"
      onKeyDown={(e) => {
        // Enter saves from anywhere inside the fixer. INPUT is excluded
        // because the pickers' typeaheads own their own Enter (select, or
        // create an entity that matched nothing); BUTTON because Enter on a
        // focused button already activates it, and focus starts on the
        // picker's "+ Add" trigger — without this guard, opening the popover
        // with Enter would also save in the same keystroke.
        const tag = (e.target as HTMLElement)?.tagName;
        if (e.key !== "Enter" || tag === "INPUT" || tag === "BUTTON") return;
        e.preventDefault();
        void save();
      }}
    >
      {error && (
        <p role="alert" className="text-xs text-[#FF2EB3]">
          {error}
        </p>
      )}

      <div>
        <h3 className="text-sm font-semibold text-gray-200">
          <span className="text-[#00D558]">#{row.cardNumber}</span> {row.cardName}
        </h3>
        {/* a11y (1.4.3): gray-400 (6.82:1 on this dialog's gray-900), never
            gray-500 — see the note in MissingTeamFixer. */}
        <p className="mt-0.5 text-xs text-gray-400">
          These names are on the card, but nothing on it links to a player or a
          team yet.
        </p>
      </div>

      {(unlinkedPlayerNames.length > 0 || unlinkedTeamNames.length > 0) && (
        <div className="space-y-1">
          <p id="attention-unlinked-names" className="text-xs text-[#00B7FF]">
            Typed on this card, not linked yet
          </p>
          <ul
            className="flex flex-wrap gap-1.5"
            aria-labelledby="attention-unlinked-names"
          >
            {[
              ...unlinkedPlayerNames.map((name) => ({ name, kind: "player" as const })),
              ...unlinkedTeamNames.map((name) => ({ name, kind: "team" as const })),
            ].map(({ name, kind }) => (
              <li
                // Deliberately not a <button>: these are the problem, not an
                // option. Nothing here toggles, so nothing here is pressable.
                key={`${kind}:${name}`}
                className="rounded-full border border-dashed border-[#00B7FF]/60 px-2 py-0.5 text-xs text-[#00B7FF]"
              >
                {name}
                <span className="ml-1 text-gray-400">{kind}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-1" ref={firstControlRef}>
        <p className="text-xs text-gray-400">Players on this card</p>
        {/* The same picker the card detail panel uses, including its
            "+ Create" path through players.findOrCreate — so a rookie no
            marketplace has heard of is one keystroke away. */}
        <PlayerPicker
          value={playerIds}
          onChange={setPlayerIds}
          sportId={sportId}
          disabled={busy}
        />
      </div>

      <div className="space-y-1">
        <p className="text-xs text-gray-400">Teams on this card</p>
        <TeamPicker
          value={teamIds}
          onChange={applyTeams}
          sportId={sportId}
          disabled={busy}
        />
        {atCap && (
          <p
            id="attention-unreviewed-cap"
            role="status"
            className="text-xs text-[#00B7FF]"
          >
            That is the limit of {MAX_CARD_TEAMS} teams on one card. Remove one to
            add another.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <NeonButton
          // Not natively disabled: NEO-189's audit found a Confirm that left
          // the tab order the moment it went inert, stranding focus with no
          // route to the reason. aria-disabled keeps it reachable and
          // NeonButton dims it the same way.
          aria-disabled={canSave ? undefined : true}
          aria-describedby="attention-unreviewed-hint"
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save & Next (Enter)"}
        </NeonButton>
      </div>
      <p id="attention-unreviewed-hint" className="text-xs text-gray-400">
        {summary}
      </p>
    </div>
  );
}

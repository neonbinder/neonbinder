import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
import { teamFullName } from "../../lib/teams/team-name";
import NeonButton from "../modules/NeonButton";
import PlayerPicker from "./PlayerPicker";
import { MAX_CARD_PLAYERS } from "./card-attention";
import { saveShortcutLabel } from "./MissingTeamFixer";
import { useAttentionSportId, type AttentionFixerProps } from "./cardAttentionRegistry";

/**
 * NEO-339 — the `missingPlayer` attention fixer: "who is on this card, or
 * nobody?"
 *
 * ## Why this question exists
 *
 * Jason, 2026-10-19: a card that links to no player needs a person, in the web
 * walker and in the set-build tool alike. A listing can name nobody — a
 * one-word name the parser refuses, a row the marketplace never tagged — and a
 * card with no player link is invisible to every player page and filter, and
 * leaves its listing title and its team suggestions with nothing to go on.
 * The answer has two shapes: these players, or genuinely nobody (a checklist,
 * a team card, a logo or a relic card with no person on it). "Nobody" is a
 * recordable answer, never a dead end, exactly as "No team on this card" is.
 *
 * ## Design
 *
 * The `MissingTeamFixer` panel with its question swapped, so the walker reads
 * as one screen type changing its subject rather than a new screen:
 *
 * - **The card anchors the panel**: `#12` in neon green, then the name, as a
 *   checklist row reads. The team line under it is the clue for the "nobody"
 *   answer — a card whose only fact is "Seattle Mariners" is usually the team
 *   card — so it says which teams the card carries, or that it has none yet.
 *   All plain text; no marketplace ref anywhere.
 * - **No suggestion chips.** Nothing NB holds proposes a player for a card
 *   (the card's name is the operator's to read, never a lookup key —
 *   invariant 4), so the picker is the whole control and focus starts on its
 *   "+ Add player" trigger. Its "+ Create" makes the player through
 *   `players.findOrCreate`, as every other player picker does.
 * - **"No player on this card" is blue-secondary, never pink.** Recording
 *   nobody is an answer, not a cancel.
 * - **Keys are the team fixer's.** Enter on the panel's background saves;
 *   Ctrl/Cmd+Enter saves from anywhere, the picker's typeahead included,
 *   because once a player is picked focus is still in the picker.
 */
export default function MissingPlayerFixer({ row, onSaved }: AttentionFixerProps) {
  // Out-of-band because the locked fixer contract passes only the row. See
  // AttentionSportContext.
  const sportId = useAttentionSportId();
  const updateCard = useMutation(api.selectorOptions.updateCard);
  const confirmCardNoPlayer = useMutation(api.cardChecklist.confirmCardNoPlayer);
  const teamRows = useQuery(
    api.teams.getManyByIds,
    row.teamOnCardIds && row.teamOnCardIds.length > 0 ? { ids: row.teamOnCardIds } : "skip",
  );

  // The card has no player, which is why it is here, so the picker starts
  // empty. The walker remounts this per card (`key={current._id}`), so the
  // initialiser is the per-card reset.
  const [playerIds, setPlayerIds] = useState<Array<Id<"players">>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pickerRegionRef = useRef<HTMLDivElement>(null);

  // Focus the picker's trigger on mount: every advance lands on the question,
  // never on a control of the card just answered (the NEO-189 finding).
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      pickerRegionRef.current?.querySelector("button")?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  /**
   * The team line. A typed team name (legacy `pendingTeamNames`) is shown as
   * typed, so the line never claims "no team" for a card that names one.
   */
  const teamLine = useMemo(() => {
    if ((row.teamOnCardIds?.length ?? 0) > 0) {
      if (teamRows === undefined) return "Team: …";
      return `Team: ${teamRows.map((t) => teamFullName(t)).join(" · ")}`;
    }
    if ((row.pendingTeamNames?.length ?? 0) > 0) {
      return `Team: ${(row.pendingTeamNames ?? []).join(" · ")}`;
    }
    return "No team on this card yet.";
  }, [row.teamOnCardIds, row.pendingTeamNames, teamRows]);

  /**
   * `MAX_CARD_PLAYERS` is the SAME constant `updateCard` enforces, so an
   * addition past it is refused here rather than trimmed (trimming would drop
   * the player just picked, and the server would refuse the write anyway).
   */
  const applyPlayers = (next: Array<Id<"players">>) => {
    if (next.length > MAX_CARD_PLAYERS) return;
    setPlayerIds(next);
  };
  const atCap = playerIds.length >= MAX_CARD_PLAYERS;
  const canSave = playerIds.length > 0 && !busy;
  const shortcut = saveShortcutLabel();

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      // A non-empty `playerIds` write retires any "No player on this card"
      // stamp server-side, so the card leaves the walk because the ROW changed.
      await updateCard({ id: row._id, playerIds });
      onSaved();
    } catch (e) {
      setError(userFacingMessage(e, "Couldn't save those players. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const recordNoPlayer = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await confirmCardNoPlayer({ cardId: row._id });
      if (!result.confirmed) {
        // A refusal, not a throw: the row gained a player (another tab, a
        // sync) or is gone. Never counted as fixed — nothing was written.
        setError(
          "This card has a player now, or it is no longer on this checklist — nothing to confirm. Skip it, or close and re-open to see the current state.",
        );
        return;
      }
      onSaved();
    } catch (e) {
      setError(userFacingMessage(e, "Couldn't record that. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className="space-y-3"
      onKeyDownCapture={(e) => {
        // Ctrl/Cmd+Enter saves from ANYWHERE in the fixer, the picker's
        // typeahead included; capture phase and stopped here, so the
        // typeahead's own Enter does not also run. A nested dialog owns its
        // own keys. Same handling as MissingTeamFixer.
        if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
        const ownDialog = rootRef.current?.closest('[role="dialog"]') ?? null;
        const targetDialog = (e.target as HTMLElement).closest?.('[role="dialog"]') ?? null;
        if (targetDialog !== null && targetDialog !== ownDialog) return;
        e.preventDefault();
        e.stopPropagation();
        if (canSave) void save();
      }}
      onKeyDown={(e) => {
        // Plain Enter saves from the panel's background. INPUT is the
        // typeahead's (select, or create); BUTTON activates natively — focus
        // starts on the picker's "+ Add player" trigger, and without this
        // guard opening it with Enter would also save.
        const tag = (e.target as HTMLElement)?.tagName;
        if (e.key !== "Enter" || tag === "INPUT" || tag === "BUTTON") return;
        const ownDialog = rootRef.current?.closest('[role="dialog"]') ?? null;
        const targetDialog = (e.target as HTMLElement).closest?.('[role="dialog"]') ?? null;
        if (targetDialog !== null && targetDialog !== ownDialog) return;
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
        {/* a11y (1.4.3): gray-400 on this dialog's gray-900, never gray-500. */}
        <p className="mt-0.5 text-xs text-gray-400">{teamLine}</p>
      </div>

      <div className="space-y-1" ref={pickerRegionRef}>
        <p className="text-xs text-gray-300">
          No player is linked to this card yet. Add who’s on it, or say there’s
          nobody.
        </p>
        <p className="text-xs text-gray-400">Players on this card</p>
        <PlayerPicker value={playerIds} onChange={applyPlayers} sportId={sportId} disabled={busy} />
        {atCap && (
          <p id="attention-player-cap" role="status" className="text-xs text-[#00B7FF]">
            That is the limit of {MAX_CARD_PLAYERS} players on one card. Remove one to
            add another.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <NeonButton
          // aria-disabled, not disabled: an inert button leaves the tab order
          // and strands focus with no route to the reason (NEO-189).
          aria-disabled={canSave ? undefined : true}
          aria-describedby="attention-player-hint"
          aria-keyshortcuts="Control+Enter Meta+Enter"
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save & Next (Enter)"}
        </NeonButton>
        <NeonButton
          secondary
          // Not natively disabled either: this is the button just pressed, and
          // native `disabled` would blur focus to <body> mid-request.
          aria-disabled={busy || undefined}
          onClick={() => {
            if (busy) return;
            void recordNoPlayer();
          }}
        >
          No player on this card
        </NeonButton>
      </div>
      <p id="attention-player-hint" className="text-xs text-gray-400">
        {playerIds.length === 0
          ? "Pick at least one player, or record that this card has none."
          : `Saves ${playerIds.length} ${playerIds.length === 1 ? "player" : "players"} on this card. ${shortcut} saves from anywhere.`}
      </p>
    </div>
  );
}

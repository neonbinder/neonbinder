import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import NeonButton from "../modules/NeonButton";
import TeamPicker from "./TeamPicker";
import { useAttentionSportId, type AttentionFixerProps } from "./cardAttentionRegistry";

/**
 * NEO-102 — the `missingTeam` attention fixer: "which team is on this card,
 * or none?"
 *
 * ## Why this question exists at all
 *
 * Neither marketplace's checklist endpoint carries team data reliably. The
 * background BSC team pass stamps `teamCheckDoneAt` whether or not it found
 * something, so a card it found nothing for used to go quiet forever — 10
 * such cards in dev's 2026 Topps base, every one a League Leaders
 * multi-player card (three players, three teams, no team on the wire). The
 * answer is a real editorial decision and it has three shapes: these teams,
 * that one team, or genuinely none. eBay's Team aspect is recommended and
 * single-select, SportLots' is optional free text, and neither BLOCKS a
 * listing — so "none" has to be a recordable answer, not a dead end.
 *
 * ## Design
 *
 * - **The card number anchors the panel.** `#327` in neon green then the
 *   name, the way a checklist row reads, so the operator recognises the card
 *   before reading the question. Number, name and player names are plain
 *   TEXT — never anchors — and no marketplace ref appears anywhere, body or
 *   `title`: a SportLots ref *is* a seller-typed description, so it is
 *   untrusted content as well as noise.
 * - **Suggestions are preselected, and say whose career they came from.**
 *   The predecessor of this feature was a bare per-card text prompt, and an
 *   operator once typed "Unknonw" into it. A League Leaders card's three
 *   players hand us three teams; Enter should accept them, and toggling is
 *   for the exception. The provenance is on the chip because a suggestion
 *   from Mike Trout's career is only as good as Mike Trout being on the card.
 * - **Colour carries role, not decoration.** Green is a chosen/confirmed
 *   team, blue (#00B7FF) is provenance and the "no team" affirmative, and
 *   pink never appears here — that is Cancel's colour, and recording "no
 *   team" is an answer, not an abandonment.
 */

/** Server cap on teams per card. Mirrors MAX_CARD_TEAMS in the Convex layer. */
export const MAX_TEAMS_ON_CARD = 8;

export default function MissingTeamFixer({ row, onSaved }: AttentionFixerProps) {
  // Out-of-band because the locked fixer contract passes only the row, and a
  // card row does not know its set's sport. See AttentionSportContext.
  const sportId = useAttentionSportId();
  const suggestions = useQuery(api.cardChecklist.suggestedTeamsForCard, {
    cardId: row._id,
  });
  const playerRows = useQuery(
    api.players.getManyByIds,
    row.playerIds && row.playerIds.length > 0 ? { ids: row.playerIds } : "skip",
  );
  const updateCard = useMutation(api.selectorOptions.updateCard);
  const confirmCardNoTeam = useMutation(api.cardChecklist.confirmCardNoTeam);

  // `null` = the suggestion query has not resolved, so nothing is preselected
  // yet. Distinct from `[]`, which means the operator cleared it.
  const [teamIds, setTeamIds] = useState<Array<Id<"teams">> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstChipRef = useRef<HTMLButtonElement>(null);
  const pickerRegionRef = useRef<HTMLDivElement>(null);

  /**
   * One chip per TEAM, not per suggestion. Two players on a League Leaders
   * card can share a team, and two identical chips would look like a bug and
   * double-count against the cap.
   */
  const chips = useMemo(() => {
    const byTeam = new Map<
      string,
      { teamId: Id<"teams">; name: string; playerNames: string[] }
    >();
    for (const s of suggestions ?? []) {
      const existing = byTeam.get(s.teamId as string);
      if (existing) {
        if (!existing.playerNames.includes(s.playerName)) {
          existing.playerNames.push(s.playerName);
        }
      } else {
        byTeam.set(s.teamId as string, {
          teamId: s.teamId,
          name: s.name,
          playerNames: [s.playerName],
        });
      }
    }
    return [...byTeam.values()];
  }, [suggestions]);

  useEffect(() => {
    if (teamIds !== null || suggestions === undefined) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- preselects the suggested teams the moment the suggestion query resolves; the query is async, so this cannot be an initial-state value
    setTeamIds(chips.slice(0, MAX_TEAMS_ON_CARD).map((c) => c.teamId));
  }, [suggestions, teamIds, chips]);

  // Focus the first suggestion chip as soon as it exists, else the picker's
  // own trigger. The walker remounts this component per card, so this IS
  // "focus on every advance" — focus is never left on a control belonging to
  // the card just answered (the NEO-189 stranding finding).
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (firstChipRef.current) firstChipRef.current.focus();
      else pickerRegionRef.current?.querySelector("button")?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [chips.length]);

  // Memoized so the identity is stable per `teamIds` — `chosenSet` and
  // `playerLine` both depend on it, and a fresh [] every render would rebuild
  // them on every keystroke elsewhere in the dialog.
  const chosen = useMemo(() => teamIds ?? [], [teamIds]);
  const chosenSet = useMemo(() => new Set(chosen as unknown as string[]), [chosen]);
  const atCap = chosen.length >= MAX_TEAMS_ON_CARD;

  /**
   * Every change goes through here so the cap is enforced once, for the chips
   * and the picker alike. An addition past the cap is REFUSED rather than
   * trimmed — trimming would silently drop whichever team the operator just
   * picked, and the server would reject the whole write anyway.
   */
  const applyTeams = (next: Array<Id<"teams">>) => {
    if (next.length > MAX_TEAMS_ON_CARD) return;
    setTeamIds(next);
  };

  const toggleChip = (teamId: Id<"teams">) => {
    if (chosenSet.has(teamId as string)) {
      applyTeams(chosen.filter((id) => id !== teamId));
    } else {
      applyTeams([...chosen, teamId]);
    }
  };

  const playerLine = useMemo(() => {
    if (playerRows && playerRows.length > 0) {
      return playerRows.map((p) => p.name).join(" · ");
    }
    // Fall back to the names the suggestions carry: a blank line would read as
    // "no players on this card" rather than "player rows not loaded".
    return [...new Set((suggestions ?? []).map((s) => s.playerName))].join(" · ");
  }, [playerRows, suggestions]);

  const canSave = chosen.length > 0 && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      // Full replacement, and a non-empty list clears `teamNoneConfirmedAt`
      // server-side — so this card stops needing attention because the ROW
      // changed, not because anything here remembered to clear a flag.
      await updateCard({ id: row._id, teamOnCardIds: chosen });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save those teams. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const recordNoTeam = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await confirmCardNoTeam({ cardId: row._id });
      if (!result.confirmed) {
        // The mutation refuses rather than throws when the row has gained
        // teams or is gone — both are races against another tab or the
        // background BSC pass, not operator error. Say so and DON'T count it
        // as fixed: advancing on a refusal would report a card as answered
        // when nothing was written.
        setError(
          "This card has teams now, or it is no longer on this checklist — nothing to confirm. Skip it, or close and re-open to see the current state.",
        );
        return;
      }
      // `stamped: false` with `confirmed: true` means it was already confirmed
      // (a double-click, or another tab got there first). The card IS answered,
      // so this still advances.
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't record that. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="space-y-3"
      onKeyDown={(e) => {
        // Enter saves from anywhere inside the fixer. INPUT is excluded
        // because TeamPicker's typeahead owns its own Enter (select, or create
        // a team that matched nothing); BUTTON because Enter on a focused
        // button already activates it, and focus starts on a suggestion chip —
        // without this guard, toggling a chip with Enter would also save in
        // the same keystroke.
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
        <p className="mt-0.5 text-xs text-gray-400">
          {playerLine ? `Players: ${playerLine}` : "No players on this card."}
        </p>
      </div>

      {chips.length > 0 && (
        <div className="space-y-1">
          <p id="attention-team-suggestions" className="text-xs text-[#00B7FF]">
            Suggested from career history — Enter accepts these
          </p>
          <ul
            className="flex flex-wrap gap-1.5"
            aria-labelledby="attention-team-suggestions"
          >
            {chips.map((chip, idx) => {
              const on = chosenSet.has(chip.teamId as string);
              const blocked = !on && atCap;
              return (
                <li key={chip.teamId as string}>
                  <button
                    type="button"
                    ref={idx === 0 ? firstChipRef : undefined}
                    aria-pressed={on}
                    // aria-disabled, not disabled: at the cap the chip has to
                    // stay reachable, or the notice explaining why it is inert
                    // is unreachable by keyboard (the NEO-189 finding).
                    aria-disabled={blocked || undefined}
                    // a11y (audit fix): a screen-reader user landing directly
                    // on a blocked chip (Tab, not having heard the role=status
                    // cap notice announce) got no explanation at all — only a
                    // sighted user reading the paragraph below the picker knew
                    // why it wouldn't toggle. Ties the chip to that notice the
                    // same way `attention-team-hint` already ties to Save.
                    aria-describedby={blocked ? "attention-team-cap" : undefined}
                    aria-label={`${chip.name} (from ${chip.playerNames.join(" and ")}'s career)`}
                    onClick={() => {
                      if (blocked) return;
                      toggleChip(chip.teamId);
                    }}
                    className={`rounded-full border px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-[#00B7FF] ${
                      on
                        ? "border-[#00D558] bg-[#00D558]/20 text-[#00D558]"
                        : "border-gray-700 bg-gray-800 text-gray-200 hover:border-[#00B7FF] hover:text-[#00B7FF]"
                    } ${blocked ? "opacity-40" : ""}`}
                  >
                    {chip.name}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="space-y-1" ref={pickerRegionRef}>
        <p className="text-xs text-gray-400">Teams on this card</p>
        {/* The same picker the card detail panel uses, including its "+ Create"
            path through teams.findOrCreate — so a team no marketplace has ever
            heard of is one keystroke away and the operator is never blocked
            waiting for a sync to populate the table. */}
        <TeamPicker value={chosen} onChange={applyTeams} sportId={sportId} disabled={busy} />
        {atCap && (
          <p id="attention-team-cap" role="status" className="text-xs text-[#00B7FF]">
            That is the limit of {MAX_TEAMS_ON_CARD} teams on one card. Remove one to
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
          aria-describedby="attention-team-hint"
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save & Next (Enter)"}
        </NeonButton>
        <NeonButton
          secondary
          // Not natively disabled, for the same reason as Save above: this is
          // the button an operator most likely just pressed (it's the ONE
          // that sets `busy`), so native `disabled` would blur the browser's
          // focus straight to `<body>` the instant the request started —
          // exactly the focus-park-pattern failure mode, on the control that
          // had focus a moment ago rather than a neighbour.
          aria-disabled={busy || undefined}
          onClick={() => {
            if (busy) return;
            void recordNoTeam();
          }}
        >
          No team on this card
        </NeonButton>
      </div>
      {/* a11y (1.4.3): text-gray-500 measures 3.67:1 against this dialog's
          bg-gray-900 — fails 4.5:1 (the recurring gray-500-on-gray-900 bug,
          see accessibility-auditor/contrast-reference.md). This component
          carries no `dark:` variants anywhere (it only ever renders inside
          CardAttentionWalker's always-dark card), so the fix is the same
          swap used everywhere else that bug turns up: gray-400, 6.82:1. */}
      <p id="attention-team-hint" className="text-xs text-gray-400">
        {chosen.length === 0
          ? "Pick at least one team, or record that this card has none."
          : `Saves ${chosen.length} ${chosen.length === 1 ? "team" : "teams"} on this card.`}
      </p>
    </div>
  );
}

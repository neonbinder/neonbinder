import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import NeonButton from "../modules/NeonButton";
import TeamPicker from "./TeamPicker";
import { MAX_CARD_TEAMS } from "./card-attention";
import {
  useAttentionContextOptionId,
  useAttentionSportId,
  type AttentionFixerProps,
} from "./cardAttentionRegistry";

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
 * - **Set-year suggestions are preselected, and say whose career they came
 *   from.** The predecessor of this feature was a bare per-card text prompt,
 *   and an operator once typed "Unknonw" into it. A League Leaders card's
 *   three players hand us three teams; Enter should accept them, and toggling
 *   is for the exception. The provenance is on the chip because a suggestion
 *   from Mike Trout's career is only as good as Mike Trout being on the card.
 * - **A career fallback is never preselected (NEO-330).** When no stint
 *   covers the set year the server offers the whole career, and that is a
 *   list to choose from, not an answer: Jimmie Foxx on a 2025 retro card
 *   arrived with Athletics, Red Sox, Cubs and Phillies all preselected and
 *   focus on Save, so one Enter wrote four teams onto a one-team card. Only an
 *   `inSetYear` suggestion is preselected now, and focus lands on Save only
 *   when something is.
 * - **The listing's claim is offered as NB's rows, era by era (NEO-330).**
 *   When the marketplace listing named a team the background lookup could not
 *   settle — usually a name we hold in several eras, none covering the set
 *   year — the rows under that name are shown as chips, era-labelled and NOT
 *   preselected, under a line that says the listing is the one claiming it.
 *   The operator picks the era in one click. The listing's string only finds
 *   the candidates (`teams.erasByNameAndSport`, the same identity lookup every
 *   picker uses); the chip writes an NB row id. A set-year stint the listing
 *   contradicts is a disagreement (product invariants 7 and 8): nothing is
 *   preselected and the line says so, rather than either side winning
 *   silently. Operator copy never names the marketplace — "the listing".
 * - **Ctrl/Cmd+Enter saves from anywhere (NEO-330 a11y).** Plain Enter stays
 *   what it was (it saves from the panel's background, and activates the
 *   focused button — a chip toggles), so a chip or the picker is never a
 *   dead end for a keyboard user who has made their pick.
 * - **Colour carries role, not decoration.** Green is a chosen/confirmed
 *   team, blue (#00C2FF) is provenance and the "no team" affirmative, and
 *   pink never appears here — that is Cancel's colour, and recording "no
 *   team" is an answer, not an abandonment.
 */

/** One acceptable team chip — from a career, from the marketplace's claim, or both. */
type TeamChip = {
  teamId: Id<"teams">;
  /** The visible text: the full name, with the era where the name is shared. */
  label: string;
  /** Players on this card whose career names the team. Empty when none does. */
  playerNames: string[];
  /** A stint covering the set year produced it — the only kind ever preselected. */
  inSetYear: boolean;
};

/**
 * "Jimmie Foxx played here" / "Johnny Bench & Pete Rose played here" /
 * "A, B & C played here" — the provenance a chip carries. Full names, never a
 * derived surname: "Ken Griffey Jr." has no safe one.
 */
export function playedHere(playerNames: string[]): string {
  const names =
    playerNames.length <= 2
      ? playerNames.join(" & ")
      : `${playerNames.slice(0, -1).join(", ")} & ${playerNames[playerNames.length - 1]}`;
  return `${names} played here`;
}

/**
 * The line over the listing's chips. Exported for the copy test. Never names
 * the marketplace (Jason, 2026-10-11) — "the listing".
 *
 *   agreed   — a set-year stint is one of the listing's rows, so it is
 *              preselected and focus is on Save
 *   several  — the name is held in several eras: pick the one on the card
 *   one      — one row: offered, not assumed (the background lookup already
 *              links a lone row whose era fits, so reaching here means it
 *              did not)
 */
export function marketplaceHeading(listingName: string, rowCount: number, agreed: boolean): string {
  if (agreed) return `The listing names “${listingName}” and the career agrees — Enter accepts it.`;
  if (rowCount > 1) {
    return `The listing names “${listingName}” — ${rowCount} teams share that name. Pick the one on the card.`;
  }
  return `The listing names “${listingName}” — pick it if it matches the card.`;
}

/**
 * NEO-345 — which case the card is in, from the background team check's
 * recorded outcome. One line above "Teams on this card"; null when there is
 * nothing to add:
 *
 *   answered, no hint — the listing replied and named no team
 *   gaveUp            — the lookup ran out of retries; nobody knows yet
 *   answered + hint   — null: the listing's claim is already on screen
 *                       (its chips, or "Marketplace says")
 *   absent            — null: stamped before outcomes were recorded
 *
 * Never names the marketplace — "the listing". Exported for the copy test.
 */
export function outcomeHeading(
  outcome: "answered" | "gaveUp" | undefined,
  hasHint: boolean,
): string | null {
  if (outcome === "gaveUp") {
    return "We couldn’t get a team from the listing for this card. Pick the one on the card.";
  }
  if (outcome === "answered" && !hasHint) {
    return "The listing has no team for this card. Pick the one on the card, or say there isn’t one.";
  }
  return null;
}

/**
 * The line over the career chips. Exported for the copy test.
 *
 * `uncoveredSetYear` is the set's year when the server fell back to the whole
 * career because no stint covers it; undefined when the set has no year.
 */
export function careerHeading(
  inSetYear: boolean,
  listingDisagrees: boolean,
  uncoveredSetYear?: number,
): string {
  if (!inSetYear) {
    return uncoveredSetYear !== undefined
      ? `No ${uncoveredSetYear} team on file — here’s the whole career. Pick the one on the card.`
      : "No year on this set — here’s the whole career. Pick the one on the card.";
  }
  if (listingDisagrees) {
    return "From the career — the listing names a different team, so pick the one on the card.";
  }
  return "Suggested from career history — Enter accepts these.";
}

/**
 * "Ctrl+Enter", or "Cmd+Enter" on a Mac — the save-from-anywhere shortcut as
 * the hint says it. Exported for the test.
 */
export function saveShortcutLabel(): string {
  if (typeof navigator === "undefined") return "Ctrl+Enter";
  const uaPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData?.platform;
  const platform = uaPlatform ?? navigator.platform ?? "";
  return /mac|iphone|ipad/i.test(platform) ? "Cmd+Enter" : "Ctrl+Enter";
}

export default function MissingTeamFixer({ row, onSaved }: AttentionFixerProps) {
  // Out-of-band because the locked fixer contract passes only the row, and a
  // card row does not know its set's sport or its set. See
  // AttentionSportContext.
  const sportId = useAttentionSportId();
  const contextOptionId = useAttentionContextOptionId();
  const suggestions = useQuery(api.cardChecklist.suggestedTeamsForCard, {
    cardId: row._id,
  });
  const playerRows = useQuery(
    api.players.getManyByIds,
    row.playerIds && row.playerIds.length > 0 ? { ids: row.playerIds } : "skip",
  );
  /**
   * NEO-330 — the marketplace's claim, as the NB rows it could mean.
   *
   * `erasByNameAndSport` is the "what are my options" lookup the pickers and
   * the review wizard use: every row this sport holds under the name, oldest
   * era first, each already labelled "Name · 1901–1954". BSC's string does
   * the finding and nothing else. With no sport (the context is unset) there
   * is nothing to look up in, and the plain "Marketplace says" line below
   * stands in.
   */
  const bscName = row.bscTeamName?.trim() ?? "";
  const bscEras = useQuery(
    api.teams.erasByNameAndSport,
    bscName !== "" && sportId !== undefined ? { name: bscName, sportId } : "skip",
  );
  const bscLookedUp = bscName !== "" && sportId !== undefined;
  const caseLine = outcomeHeading(row.teamCheckOutcome, bscName !== "");
  const bscSettled = !bscLookedUp || bscEras !== undefined;
  const updateCard = useMutation(api.selectorOptions.updateCard);
  const confirmCardNoTeam = useMutation(api.cardChecklist.confirmCardNoTeam);

  // `null` = the suggestion queries have not resolved, so nothing is
  // preselected yet. Distinct from `[]`, which means nothing was preselected
  // or the operator cleared it.
  const [teamIds, setTeamIds] = useState<Array<Id<"teams">> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveBtnRef = useRef<HTMLButtonElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const pickerRegionRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /**
   * NEO-330 a11y — the operator has started working the picker (a key or a
   * press inside it, its portalled popover included: React events follow the
   * component tree). From then on the arrival of the suggestions never moves
   * focus: yanking it off a half-typed search to a chip loses their place.
   */
  const pickerEngagedRef = useRef(false);

  /**
   * One chip per TEAM, not per suggestion. Two players on a League Leaders
   * card can share a team, and two identical chips would look like a bug and
   * double-count against the cap. The label is the server's — the full name,
   * era-labelled when the sport holds that name more than once.
   */
  const careerByTeam = useMemo(() => {
    const byTeam = new Map<string, TeamChip>();
    for (const s of suggestions ?? []) {
      const existing = byTeam.get(s.teamId as string);
      if (existing) {
        if (!existing.playerNames.includes(s.playerName)) {
          existing.playerNames.push(s.playerName);
        }
        existing.inSetYear = existing.inSetYear || s.inSetYear;
      } else {
        byTeam.set(s.teamId as string, {
          teamId: s.teamId,
          label: s.label,
          playerNames: [s.playerName],
          inSetYear: s.inSetYear,
        });
      }
    }
    return byTeam;
  }, [suggestions]);

  /** The set year a whole-career fallback looked for, when the server says so. */
  const uncoveredSetYear = (suggestions ?? []).find(
    (s) => s.uncoveredSetYear !== undefined,
  )?.uncoveredSetYear;

  /**
   * The rows the listing's name could mean. A row that is ALSO in a player's career
   * carries that provenance here and is not repeated in the career list — one
   * chip per team, and the fact that Foxx played for the 1901–1954 Athletics
   * is exactly what tells the operator which of the four eras the card means.
   */
  const marketplaceChips = useMemo<TeamChip[]>(
    () =>
      (bscLookedUp ? (bscEras ?? []) : []).map((era) => {
        const career = careerByTeam.get(era._id as string);
        return {
          teamId: era._id,
          label: era.label,
          playerNames: career?.playerNames ?? [],
          inSetYear: career?.inSetYear ?? false,
        };
      }),
    [bscLookedUp, bscEras, careerByTeam],
  );
  const marketplaceIds = useMemo(
    () => new Set<string>(marketplaceChips.map((chip) => chip.teamId as string)),
    [marketplaceChips],
  );
  const careerChips = useMemo(
    () => [...careerByTeam.values()].filter((chip) => !marketplaceIds.has(chip.teamId as string)),
    [careerByTeam, marketplaceIds],
  );

  /**
   * What may be preselected: set-year stints only, and only when BSC does not
   * contradict them. A card with a BSC name and a set-year stint at a team
   * that is not among that name's rows has two sources saying two things —
   * product invariant 7: surface it, never settle it. Nothing is preselected
   * and the career line says BSC disagrees. A BSC name we could not look up
   * (no sport) cannot vouch for anything, so it counts as disagreeing: the
   * cost is one click, the alternative is a silent write.
   */
  const setYearTeamIds = useMemo(
    () => [...careerByTeam.values()].filter((chip) => chip.inSetYear).map((chip) => chip.teamId),
    [careerByTeam],
  );
  const bscDisagrees =
    bscName !== "" && setYearTeamIds.some((id) => !marketplaceIds.has(id as string));
  const preselect = useMemo(
    () => (bscDisagrees ? [] : setYearTeamIds.slice(0, MAX_CARD_TEAMS)),
    [bscDisagrees, setYearTeamIds],
  );
  const ready = suggestions !== undefined && bscSettled;

  useEffect(() => {
    if (teamIds !== null || !ready) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- preselects once the suggestion queries resolve; they are async, so this cannot be an initial-state value
    setTeamIds(preselect);
  }, [ready, teamIds, preselect]);

  // Initial focus follows what the copy promises (NEO-282, NEO-330). With a
  // set-year team preselected the panel says "Enter accepts", so focus lands
  // on "Save & Next (Enter)" and the first Enter saves. With chips on screen
  // and NOTHING preselected — a career fallback, or the listing's eras — Save
  // is aria-disabled and would write nothing anyway; focus goes to the first
  // chip, where Enter or Space picks it (the eras come first, so that is
  // usually the era the listing named). With no chips at all it goes to the
  // picker's trigger. And never once the operator has started in the picker
  // (`pickerEngagedRef`): the suggestions arriving late must not pull focus
  // off a half-typed search. The walker remounts this component per card, so
  // this IS "focus on every advance" — focus is never left on a control belonging to the
  // card just answered (the NEO-189 stranding finding). Keyed on the target,
  // not on live selection, so toggling a chip never moves focus.
  const chipCount = marketplaceChips.length + careerChips.length;
  const focusTarget: "save" | "chip" | "picker" = !ready
    ? "picker"
    : preselect.length > 0
      ? "save"
      : chipCount > 0
        ? "chip"
        : "picker";
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (pickerEngagedRef.current) return;
      if (focusTarget === "save" && saveBtnRef.current) saveBtnRef.current.focus();
      else if (focusTarget === "chip" && optionsRef.current?.querySelector("button")) {
        optionsRef.current.querySelector("button")?.focus();
      } else pickerRegionRef.current?.querySelector("button")?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [focusTarget]);

  // Memoized so the identity is stable per `teamIds` — `chosenSet` and
  // `playerLine` both depend on it, and a fresh [] every render would rebuild
  // them on every keystroke elsewhere in the dialog.
  const chosen = useMemo(() => teamIds ?? [], [teamIds]);
  const chosenSet = useMemo(() => new Set(chosen as unknown as string[]), [chosen]);
  const atCap = chosen.length >= MAX_CARD_TEAMS;

  /**
   * Every change goes through here so the cap is enforced once, for the chips
   * and the picker alike. An addition past the cap is REFUSED rather than
   * trimmed — trimming would silently drop whichever team the operator just
   * picked, and `selectorOptions.updateCard` would reject the whole write
   * anyway: `MAX_CARD_TEAMS` is the SAME constant on both sides (imported from
   * convex/features/cardAttention through the card-attention seam), so the cap
   * message below cannot claim a number the server disagrees with.
   */
  const applyTeams = (next: Array<Id<"teams">>) => {
    if (next.length > MAX_CARD_TEAMS) return;
    setTeamIds(next);
  };

  const toggleChip = (teamId: Id<"teams">) => {
    if (chosenSet.has(teamId as string)) {
      applyTeams(chosen.filter((id) => id !== teamId));
    } else {
      applyTeams([...chosen, teamId]);
    }
  };

  /**
   * One toggle chip, career or marketplace. `aria-pressed` carries the state;
   * aria-disabled, not disabled, at the cap — the chip has to stay reachable,
   * or the notice explaining why it is inert is unreachable by keyboard (the
   * NEO-189 finding). A screen-reader user landing on a blocked chip (Tab, not
   * having heard the role=status cap notice) is tied to that notice the same
   * way `attention-team-hint` ties to Save.
   */
  const renderChip = (chip: TeamChip, opts: { ariaLabel?: string; suffix?: string }) => {
    const on = chosenSet.has(chip.teamId as string);
    const blocked = !on && atCap;
    // Enter on a chip is a pure toggle — the button's native activation. The
    // panel's plain-Enter save skips BUTTON targets; Ctrl/Cmd+Enter is the
    // save from here.
    return (
      <li key={chip.teamId as string}>
        <button
          type="button"
          aria-pressed={on}
          aria-disabled={blocked || undefined}
          aria-describedby={blocked ? "attention-team-cap" : undefined}
          aria-label={opts.ariaLabel}
          onClick={() => {
            if (blocked) return;
            toggleChip(chip.teamId);
          }}
          className={`rounded-full border px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-[#00C2FF] ${
            on
              ? "border-[#00D558] bg-[#00D558]/20 text-[#00D558]"
              : "border-gray-700 bg-gray-800 text-gray-200 hover:border-[#00C2FF] hover:text-[#00C2FF]"
          } ${blocked ? "opacity-40" : ""}`}
        >
          {chip.label}
          {opts.suffix && <span className="text-[#00C2FF]">{opts.suffix}</span>}
        </button>
      </li>
    );
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
  const shortcut = saveShortcutLabel();

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
      ref={rootRef}
      className="space-y-3"
      onKeyDownCapture={(e) => {
        // NEO-330 a11y — Ctrl/Cmd+Enter saves from ANYWHERE in the fixer: a
        // chip, the picker's trigger, its typeahead. Capture phase, and the
        // event stops here, so the typeahead's own Enter (pick the
        // highlighted team) and a chip's native activation never also run:
        // one keystroke, one meaning. The picker's popover is portalled, but
        // React events follow the component tree, so it arrives here too.
        // A NESTED dialog (the picker's New Team form) owns its own keys.
        if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
        const ownDialog = rootRef.current?.closest('[role="dialog"]') ?? null;
        const targetDialog = (e.target as HTMLElement).closest?.('[role="dialog"]') ?? null;
        if (targetDialog !== null && targetDialog !== ownDialog) return;
        e.preventDefault();
        e.stopPropagation();
        if (canSave) void save();
      }}
      onKeyDown={(e) => {
        // Enter saves from anywhere inside the fixer. INPUT is excluded
        // because TeamPicker's typeahead owns its own Enter (select, or create
        // a team that matched nothing); BUTTON because Enter on a focused
        // button already activates it natively. Focus starts on "Save & Next"
        // itself whenever a set-year team is preselected (NEO-282, NEO-330),
        // and on the first chip when nothing is, so without this guard
        // one Enter would reach `save` twice — from here on keydown, then
        // from the button's own click (the `busy` gate would swallow the
        // second, but one keystroke should mean one path) — and Enter on a
        // chip the operator tabbed back to would toggle it AND save in the
        // same keystroke, which nothing else prevents.
        const tag = (e.target as HTMLElement)?.tagName;
        if (e.key !== "Enter" || tag === "INPUT" || tag === "BUTTON") return;
        // The picker's New Team form is a dialog of its own, and its Enter
        // is not this panel's.
        const ownDialog = rootRef.current?.closest('[role="dialog"]') ?? null;
        const targetDialog = (e.target as HTMLElement).closest?.('[role="dialog"]') ?? null;
        if (targetDialog !== null && targetDialog !== ownDialog) return;
        e.preventDefault();
        void save();
      }}
    >
      {error && (
        <p role="alert" className="text-xs text-[#FF2E9A]">
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

      {/* `empty:hidden` so a card with no chips at all does not leave a
          blank gap in the panel's vertical rhythm. */}
      <div className="space-y-3 empty:hidden" ref={optionsRef}>
        {marketplaceChips.length > 0 && (
          <div className="space-y-1">
            {/* NEO-330 — the listing's claim, as NB's rows. Blue is provenance
                in this panel, and the line says the listing is claiming it;
                the chips are never preselected unless a set-year stint
                agrees. The listing's string is plain text, never an anchor or
                a `title` (untrusted content on an admin screen, the same rule
                as the card name). */}
            <p id="attention-team-marketplace" className="text-xs text-[#00C2FF]">
              {marketplaceHeading(bscName, marketplaceChips.length, marketplaceChips.some((chip) => preselect.includes(chip.teamId)))}
            </p>
            <ul className="flex flex-wrap gap-1.5" aria-labelledby="attention-team-marketplace">
              {marketplaceChips.map((chip) =>
                renderChip(chip, {
                  // No aria-label: the visible text, era and provenance
                  // included, IS the name, and the list's label names the
                  // listing.
                  suffix: chip.playerNames.length > 0 ? ` · ${playedHere(chip.playerNames)}` : undefined,
                }),
              )}
            </ul>
          </div>
        )}

        {careerChips.length > 0 && (
          <div className="space-y-1">
            <p id="attention-team-suggestions" className="text-xs text-[#00C2FF]">
              {careerHeading(
                careerChips.some((chip) => chip.inSetYear),
                bscDisagrees,
                uncoveredSetYear,
              )}
            </p>
            <ul
              className="flex flex-wrap gap-1.5"
              aria-labelledby="attention-team-suggestions"
            >
              {careerChips.map((chip) =>
                renderChip(chip, {
                  // The same words the listing's chips show, so the two lists
                  // say provenance one way (NEO-330).
                  ariaLabel: `${chip.label} · ${playedHere(chip.playerNames)}`,
                }),
              )}
            </ul>
          </div>
        )}
      </div>

      <div
        className="space-y-1"
        ref={pickerRegionRef}
        onKeyDownCapture={(e) => {
          // Tab moves through; anything else is the operator working the
          // picker (see `pickerEngagedRef`).
          if (e.key !== "Tab" && e.key !== "Shift") pickerEngagedRef.current = true;
        }}
        onPointerDownCapture={() => {
          pickerEngagedRef.current = true;
        }}
      >
        {/*
          NEO-236 — the marketplace's own answer, above the picker, when it
          names no team we hold (NEO-330: when it names one or more, the chips
          above offer them instead).

          The BSC per-card lookup used to CREATE a team from whatever string it
          got back. It links-or-leaves now, because creation takes a reviewed
          Location + Name and a background queue has neither. Throwing the
          string away with it left the operator on a card with no team and no
          indication which team it was supposed to be — we had the answer and
          discarded it on the way to not trusting it.

          Framed as "Marketplace says", not "Team", and rendered muted rather
          than as a chip: there is no NB row behind it to accept. It is the
          marketplace's claim, presented for a human to read and split into
          Location + Name themselves — never something a click could turn into
          a team row, which is precisely the shortcut NEO-236 removed.

          Plain text, never an anchor and never a `title`: a marketplace string
          is untrusted content reaching an admin screen, the same rule the card
          number and name follow in this panel. Held back while the era lookup
          is in flight, so it does not flash up and then turn into chips.
        */}
        {bscName !== "" && bscSettled && marketplaceChips.length === 0 && (
          <p className="text-xs text-gray-400">
            Marketplace says:{" "}
            <span className="text-gray-300">{row.bscTeamName}</span>
          </p>
        )}
        {/* NEO-345 — the card's case, from the team check's recorded
            outcome. Plain text, like every line in this panel. */}
        {caseLine && <p className="text-xs text-gray-300">{caseLine}</p>}
        <p className="text-xs text-gray-400">Teams on this card</p>
        {/* The same picker the card detail panel uses, including its "+ Create"
            path through teams.findOrCreate — so a team no marketplace has ever
            heard of is one keystroke away and the operator is never blocked
            waiting for a sync to populate the table. */}
        <TeamPicker
          value={chosen}
          onChange={applyTeams}
          sportId={sportId}
          contextOptionId={contextOptionId}
          disabled={busy}
        />
        {atCap && (
          <p id="attention-team-cap" role="status" className="text-xs text-[#00C2FF]">
            That is the limit of {MAX_CARD_TEAMS} teams on one card. Remove one to
            add another.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <NeonButton
          ref={saveBtnRef}
          // Not natively disabled: NEO-189's audit found a Confirm that left
          // the tab order the moment it went inert, stranding focus with no
          // route to the reason. aria-disabled keeps it reachable and
          // NeonButton dims it the same way.
          aria-disabled={canSave ? undefined : true}
          aria-describedby="attention-team-hint"
          aria-keyshortcuts="Control+Enter Meta+Enter"
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
          : `Saves ${chosen.length} ${chosen.length === 1 ? "team" : "teams"} on this card. ${shortcut} saves from anywhere.`}
      </p>
    </div>
  );
}

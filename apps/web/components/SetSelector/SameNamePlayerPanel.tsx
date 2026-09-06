/**
 * NEO-254 — "Same name, different people."
 *
 * ## Why this is not `NearMatchPanel`
 *
 * `NearMatchPanel` answers a fuzzy question: is this checklist name a
 * MISSPELLING of somebody we already have? Its rows are guesses ranked by a
 * string comparison, and a bare name plus a "same name" tag is enough to
 * answer it, because the operator is really being asked "did you mean New York
 * Yankees?".
 *
 * This panel answers a different question that a bare name cannot settle at
 * all. Two players are on file under the SAME normalized name in the same
 * sport — a state `(nameNormalized, sportId)` has always permitted and that the
 * bulk preload (NEO-254 plan decision 3) makes ordinary — and nothing about
 * their names will ever tell them apart. So each row carries the two facts
 * that do: a birth year, and a line of career. Without those the operator is
 * choosing between two identical strings, which is not a choice.
 *
 * It sits ABOVE the Wikidata result in the wizard, and that order is the
 * argument: when the same name belongs to two people we already know, "which
 * of ours is this?" comes before "what does Wikidata think?".
 *
 * ## The visual grammar
 *
 * A solid neon-blue left rule and a blue tint — the app's reference/link
 * accent, the same one `NearMatchPanel` wears, and deliberately NOT green.
 * Green is the create action, and a panel of link buttons painted in the
 * create colour would compete with "Add as New Player" for the eye at exactly
 * the moment the operator is deciding between the two. The dashed-rule
 * counterpart in `UndatedCareerTeams` is the same grammar for something we do
 * NOT have — solid means "this is a row"; dashed means "this is a lead".
 */

/** One NB row already filed under this name — the server shape, verbatim. */
export interface SameNameCandidate {
  playerId: string;
  name: string;
  birthYear?: number;
  careerSummary: string;
}

/**
 * The row's identity, in one line, or null when nothing is on file.
 *
 * Exported for the accessible-name builder below and for its test. Null rather
 * than a placeholder string, because the caller renders the two cases
 * differently: a real line is data, and "nothing on file yet" is an admission.
 */
export function candidateDetail(candidate: SameNameCandidate): string | null {
  const parts = [
    candidate.birthYear !== undefined ? `b. ${candidate.birthYear}` : null,
    candidate.careerSummary || null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The accessible name for one candidate's button.
 *
 * ## Why it is not just `Link to {name}`
 *
 * Every row in this panel shares a name — that is the entire premise — so the
 * label `NearMatchPanel` uses would produce two controls with byte-identical
 * accessible names, on the one screen where telling them apart is the whole
 * task. A screen-reader user would hear the same option twice, and a Maestro
 * `tapOn` would match whichever came first. So the distinguishing fact goes
 * INTO the name.
 *
 * When a row has no distinguishing fact at all (a bare row created from a card
 * and never enriched, which is common), the position stands in. It is weak
 * information, but it is unique, and a unique weak name beats a duplicated
 * strong one: the operator can at least act on "the second one" after reading
 * the list.
 */
export function candidateLinkLabel(
  candidate: SameNameCandidate,
  index: number,
  total: number,
): string {
  const detail = candidateDetail(candidate);
  return detail
    ? `Link to ${candidate.name}, ${detail}`
    : `Link to ${candidate.name}, option ${index + 1} of ${total}`;
}

export default function SameNamePlayerPanel({
  candidates,
  scanCapped,
  disabled,
  onPick,
}: {
  /** Empty renders nothing — see the server builder: it returns [] below two. */
  candidates: ReadonlyArray<SameNameCandidate>;
  /**
   * The server stopped counting at its scan cap, so this list is "at least
   * this many" rather than "this many". See the note on the line it renders.
   */
  scanCapped?: boolean;
  /** True while another decision is in flight. See the wizard's `busy`. */
  disabled?: boolean;
  onPick: (playerId: string) => void;
}) {
  if (candidates.length === 0) return null;

  return (
    <div className="mt-2 rounded-md border border-[#00B7FF]/40 border-l-4 border-l-[#00B7FF] bg-[#00B7FF]/5 p-3 space-y-2">
      <div>
        <p className="text-sm font-semibold text-[#00B7FF]">
          Same name, different people
        </p>
        {/* States the situation and both ways out, in that order. The second
            way out is the button below this panel, so it is described rather
            than repeated as a control here. */}
        <p className="text-xs text-gray-400">
          {scanCapped
            ? `More than ${candidates.length} players are already filed under this name.`
            : `${candidates.length} players are already filed under this name.`}{" "}
          Pick the one on this card, or add a new player below.
        </p>
      </div>
      {/*
        NEO-254 — the list is not the whole list.

        A silently truncated candidate list is worse than no list: the operator
        reads eight names, concludes none of them is the man on the card, and
        creates a ninth — which is precisely the duplicate this panel exists to
        prevent, arriving with the panel's own blessing. So the truncation is
        stated, and the way out (the full search, one control below) is named.
      */}
      {scanCapped && (
        <p className="text-xs text-gray-400">
          Only the first {candidates.length} are shown — use Link to Existing to
          search them all.
        </p>
      )}
      <ul className="space-y-1" aria-label="Players already filed under this name">
        {candidates.map((candidate, index) => {
          const detail = candidateDetail(candidate);
          return (
            <li key={candidate.playerId}>
              <button
                type="button"
                // NEO-254 (a11y): `aria-disabled`, never native `disabled` —
                // the wizard's rule. A disabled control leaves the tab order,
                // so a keyboard operator who had tabbed here would be thrown
                // out of the list for the length of a round-trip.
                aria-disabled={disabled}
                aria-label={candidateLinkLabel(candidate, index, candidates.length)}
                onClick={() => {
                  if (disabled) return;
                  onPick(candidate.playerId);
                }}
                // min-h-6 keeps the row on the WCAG 2.2 SC 2.5.8 24px floor.
                className="flex min-h-6 w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-[#00B7FF]/10 focus:outline-none focus:ring-2 focus:ring-[#00B7FF] aria-disabled:opacity-40"
              >
                <span className="w-full truncate text-sm text-gray-100">
                  {candidate.name}
                </span>
                {detail ? (
                  <span className="w-full truncate text-xs text-gray-400">
                    {detail}
                  </span>
                ) : (
                  // gray-400, not gray-500: gray-500 is 3.67:1 on the
                  // dialog's gray-900, under SC 1.4.3's 4.5:1 floor. The
                  // italic carries the demotion instead of the colour.
                  <span className="w-full truncate text-xs italic text-gray-400">
                    Nothing on file yet
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

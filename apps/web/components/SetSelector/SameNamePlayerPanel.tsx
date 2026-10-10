/**
 * NEO-254 — the NB players already filed under one checklist name.
 * NEO-332 — and, since then, the body of the wizard's PICK step.
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
 * ## NEO-332 — a step of its own, not a panel above the create form
 *
 * It used to sit inside the New Player step, headed "Same name, different
 * people", with "Add as New Player" as the footer's primary. Jason,
 * 2026-10-10: a same-name row gets a PICK step — the candidates, "Create
 * new", and "Skip — not a person" — and "Create new" opens the New Player
 * step WITHOUT this list. So the panel no longer frames itself: the step's
 * heading ("Which {name} is this?", in the wizard) asks the question, and
 * this renders the one sentence under it and the rows to answer it with.
 *
 * ## The visual grammar
 *
 * A solid neon-blue left rule and a blue tint — the app's reference/link
 * accent, the same one `NearMatchPanel` wears, and deliberately NOT green.
 * Green is the create action. On the pick step there is no green at all:
 * "Create new" is the secondary button, because creating a third player under
 * a name two players already hold is the exception the step exists to make
 * deliberate. The dashed-rule counterpart in `UndatedCareerTeams` is the same
 * grammar for something we do NOT have — solid means "this is a row"; dashed
 * means "this is a lead".
 */

/** One NB row already filed under this name — the server shape, verbatim. */
export interface SameNameCandidate {
  playerId: string;
  name: string;
  birthYear?: number;
  careerSummary: string;
  /**
   * NEO-254 — this row has a stint covering the SET'S year.
   *
   * Absent means "we cannot say", never "no": a candidate with no stints on
   * file, and every candidate on a set with no year, arrives unflagged. See
   * the schema note on `entityReviewQueue.enrichment.existingCandidates`.
   */
  activeInSetYear?: boolean;
  /**
   * NEO-254 — the alias that answered, when the card's name is not this
   * player's primary one.
   *
   * Ron Artest became Metta World Peace, so a 2010 card and a 2011 card name
   * one man two ways. Without this the panel lists a row whose name is nothing
   * like the card's and the operator has to guess why it is here.
   */
  matchedAlias?: string;
}

/**
 * NEO-254 — what the marker says.
 *
 * "On a roster", not "played": the evidence is a career stint covering the
 * year, which is a contract, not an appearance. Claiming the stronger fact
 * would be the panel doing the one thing it exists to stop — stating something
 * about a player we have not established.
 *
 * The year itself is not repeated here. It is already on screen, in the set
 * the operator is reviewing, and a candidate row is not the place to restate
 * the header.
 */
export const ACTIVE_IN_SET_YEAR_LABEL = "On a roster that year";

/**
 * The row's identity, in one line, or null when nothing is on file.
 *
 * Exported for the accessible-name builder below and for its test. Null rather
 * than a placeholder string, because the caller renders the two cases
 * differently: a real line is data, and "nothing on file yet" is an admission.
 */
export function candidateDetail(candidate: SameNameCandidate): string | null {
  const parts = [
    // Leads: it is the answer to "why is this row on my list at all", and a
    // birth year means nothing until that is settled.
    candidate.matchedAlias ? `also known as ${candidate.matchedAlias}` : null,
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
  // NEO-254: the year marker rides INTO the accessible name — it is the single
  // most decisive thing on the row, and a screen-reader user must not have to
  // infer it from a colour. It is not a substitute for the ordinal fallback,
  // though: two contemporaries are both flagged, so the marker alone does not
  // make a name unique.
  const marker = candidate.activeInSetYear ? ACTIVE_IN_SET_YEAR_LABEL : null;
  const parts = [marker, detail].filter(Boolean).join(", ");
  return detail
    ? `Link to ${candidate.name}, ${parts}`
    : marker
      ? `Link to ${candidate.name}, ${marker}, option ${index + 1} of ${total}`
      : `Link to ${candidate.name}, option ${index + 1} of ${total}`;
}

/**
 * NEO-332 — the sentence under the pick step's heading. Exported for the test
 * and kept as ONE string, so the E2E driver (which matches a node's direct
 * text) reads the whole line. Copy approved by Jason, 2026-10-10.
 *
 * The capped variant names the way out — the full search, one link away in
 * the footer — because a silently truncated list is worse than no list: the
 * operator reads eight names, concludes none is the man on the card, and
 * creates a ninth.
 */
export function pickStepIntro(count: number, scanCapped: boolean): string {
  return scanCapped
    ? `More than ${count} answer to that name — here are the first ${count}. Can't see them? Link to Existing searches them all.`
    : `We've got ${count} on file under that name. Pick the one on this card.`;
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
   * this many" rather than "this many". See `pickStepIntro`.
   */
  scanCapped?: boolean;
  /** True while another decision is in flight. See the wizard's `busy`. */
  disabled?: boolean;
  onPick: (playerId: string) => void;
}) {
  if (candidates.length === 0) return null;

  return (
    <div className="mt-2 rounded-md border border-[#00B7FF]/40 border-l-4 border-l-[#00B7FF] bg-[#00B7FF]/5 p-3 space-y-2">
      {/* NEO-332 — the step's own heading asks the question; this is the one
          line that says how many and what to do. text-sm, not the old
          text-xs caption: it is the instruction for the whole step now. */}
      <p className="text-sm text-gray-300">
        {pickStepIntro(candidates.length, scanCapped ?? false)}
      </p>
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
                {/*
                  NEO-254 — the name and, beside it, the one fact that settles
                  the choice.

                  On the name's own line rather than folded into the detail
                  line below, because it is not the same KIND of fact: the
                  detail line is biography, and this is the answer to the
                  question being asked. It wears the panel's existing blue
                  accent — no new colour, no pill, no icon — so the eye lands
                  on it without the row acquiring a second personality.
                  Unflagged rows show nothing at all: absent means "we cannot
                  say", and a greyed-out "not that year" would read as a
                  verdict we have not earned.
                */}
                <span className="flex w-full items-baseline gap-2">
                  <span className="min-w-0 truncate text-sm text-gray-100">
                    {candidate.name}
                  </span>
                  {candidate.activeInSetYear && (
                    <span className="shrink-0 text-xs font-medium text-[#00B7FF]">
                      {ACTIVE_IN_SET_YEAR_LABEL}
                    </span>
                  )}
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

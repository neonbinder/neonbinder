import { useId, useRef, useState } from "react";
import { Input } from "../primitives/Input";
import { MIN_CAREER_YEAR } from "./CareerTeamEntry";
import type { CareerTeamDraft } from "./CareerTeamEntry";

/**
 * NEO-254 — the Wikidata teams with no years on them, and a way to put years
 * on one.
 *
 * ## What these are, and why they were invisible
 *
 * Wikidata links a player to a team with a P54 statement, and a great many of
 * those statements carry no start date at all — Tony Gwynn's San Diego State
 * membership among them. NEO-235 stopped the adapter INVENTING a date for
 * those (a work period is not a stint, and a fabricated stint is worse than a
 * missing one) and returned them by name as `undatedCareerTeams`. Nothing then
 * read that field, so the probe behind this ticket found the real gap: 1990-era
 * commons routinely have three to eight memberships and zero dated ones, and
 * every one of them was dropped on the floor in silence.
 *
 * This is where they surface. A name here is a LEAD, not a fact, and the whole
 * design follows from that:
 *
 *   - It sits UNDER the dated career teams, because those are what the player
 *     will actually be created with.
 *   - It has no checkbox. The dated list's checkboxes decide what gets
 *     created; there is nothing here to opt out of, because an undated name
 *     creates nothing on its own.
 *   - Dating one is the only thing that promotes it. `onAdd` hands the entry
 *     to the wizard's existing manual career-team mechanism, where it becomes
 *     an ordinary staged stint and lands in `players.teamYears` at commit.
 *   - A lead the operator does not date is NOT lost: commit stores the
 *     remainder on `players.undatedCareerTeams`, so the Players page can offer
 *     the same job later.
 *
 * ## The dashed rule
 *
 * A dashed left rule and muted text, against the solid rule the same-name
 * candidate panel wears. In this app dashed already means "nothing here yet"
 * (the Players page's empty career state), and that is exactly the claim: a
 * team line with the years blanked out. One glance separates what we know from
 * what we have only been told.
 *
 * ## Year bounds
 *
 * `MIN_CAREER_YEAR` (1869) rather than the Players page's 1850, and that is
 * deliberate: this form feeds `entityReviewQueue.recordDecision`, which
 * refuses anything under 1869. Validating against the looser bound would let
 * the operator type a year the very next round-trip rejects.
 */

/** Local per-name form state. Only ever one open at a time — see `openFor`. */
type Draft = { fromYear: string; toYear: string };

const EMPTY_DRAFT: Draft = { fromYear: "", toYear: "" };

export default function UndatedCareerTeams({
  names,
  disabled,
  onAdd,
}: {
  /**
   * `enrichment.undatedCareerTeams`, minus anything the operator has already
   * dated (the wizard filters, because a name that is now a staged chip is no
   * longer a lead and showing it in both places would read as two teams).
   */
  names: ReadonlyArray<string>;
  disabled?: boolean;
  /** Promote one lead into the wizard's staged manual career teams. */
  onAdd: (entry: CareerTeamDraft) => void;
}) {
  const headingId = useId();
  /**
   * The year error's id, so both fields can point at it.
   *
   * `role="alert"` announces the message once, when it appears. That is not
   * the same as the field CARRYING it: an operator who tabs back to the box
   * afterwards gets no indication anything is wrong with it, which is the
   * moment they most need to know. `aria-describedby` + `aria-invalid` is how
   * the Wikidata field on the Players page does the same job.
   */
  const errorId = useId();
  /** Which name's year form is open, or null. */
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  /**
   * Which name's "Add years" button should take focus as it comes back.
   *
   * Opening the form UNMOUNTS that button, so closing it — by Save, by Cancel,
   * or by Escape — would otherwise drop focus onto `<body>`: the operator's
   * place in the wizard is gone, and the next Tab restarts from the top of the
   * dialog (WCAG 2.2 SC 2.4.3, and 3.2.2 for the Escape case). Sending focus
   * back to the control they pressed is what makes the form feel like a step
   * rather than a detour.
   *
   * A ref, not state: this is a one-shot instruction consumed by the button's
   * own callback ref on the very next commit, and holding it in state would
   * cost a second render to clear it.
   */
  const refocusRef = useRef<string | null>(null);

  if (names.length === 0) return null;

  const maxYear = new Date().getFullYear() + 1;

  const open = (name: string) => {
    setOpenFor(name);
    setDraft(EMPTY_DRAFT);
    setError(null);
  };

  const close = () => {
    refocusRef.current = openFor;
    setOpenFor(null);
    setDraft(EMPTY_DRAFT);
    setError(null);
  };

  const save = (name: string) => {
    // The trigger is already aria-disabled while a decision is in flight, but
    // a form opened BEFORE that decision started is still on screen and still
    // typeable. Staging an entry into a row the wizard is about to move past
    // would put the chip on the wrong player.
    if (disabled) return;
    const from = Number(draft.fromYear);
    if (draft.fromYear.trim() === "" || !Number.isInteger(from)) {
      setError(`Start year must be a whole year between ${MIN_CAREER_YEAR} and ${maxYear}.`);
      return;
    }
    if (from < MIN_CAREER_YEAR || from > maxYear) {
      setError(`Start year must be a whole year between ${MIN_CAREER_YEAR} and ${maxYear}.`);
      return;
    }
    const hasTo = draft.toYear.trim() !== "";
    const to = hasTo ? Number(draft.toYear) : undefined;
    if (hasTo && (!Number.isInteger(to) || to! > maxYear)) {
      setError(`End year must be a whole year no later than ${maxYear}.`);
      return;
    }
    if (to !== undefined && to < from) {
      setError("End year can't come before the start year.");
      return;
    }
    onAdd({ name, fromYear: from, ...(to !== undefined ? { toYear: to } : {}) });
    close();
  };

  return (
    <div className="mt-2 border-l-2 border-dashed border-gray-700 pl-3">
      <p id={headingId} className="text-xs text-gray-400">
        Also on Wikidata, no years yet
      </p>
      {/* Says what each outcome means, so "leave it" is a real choice rather
          than the thing that happens when you ignore the list. */}
      {/* gray-400, not gray-500: gray-500 is 3.67:1 on the dialog's
          gray-900, under SC 1.4.3's 4.5:1 floor for normal text. */}
      <p className="text-xs text-gray-400">
        Add the years and it joins the career list. Leave it and we keep the
        name on file.
      </p>
      <ul className="mt-1 space-y-1" aria-labelledby={headingId}>
        {names.map((name) => (
          <li key={name} className="text-sm">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-gray-300">{name}</span>
              {openFor !== name && (
                <button
                  type="button"
                  // Takes focus back when its own form closes — see
                  // `refocusRef`. A no-op on every other render.
                  ref={(el) => {
                    if (el && refocusRef.current === name) {
                      refocusRef.current = null;
                      el.focus();
                    }
                  }}
                  aria-disabled={disabled}
                  // The visible text is "Add years", which is ambiguous across
                  // a list of them — the team goes into the accessible name so
                  // every control on this panel is uniquely addressable, by a
                  // screen reader and by Maestro alike.
                  aria-label={`Add years for ${name}`}
                  onClick={() => {
                    if (disabled) return;
                    open(name);
                  }}
                  // p-1 -m-1 grows the tap target to the WCAG 2.2 SC 2.5.8
                  // floor without shifting the text — the app's convention.
                  className="shrink-0 rounded p-1 -m-1 text-xs text-[#00B7FF] underline decoration-dotted transition-colors hover:text-[#00D558] focus:text-[#00D558] focus:outline-none focus:ring-2 focus:ring-[#00B7FF] aria-disabled:opacity-40"
                >
                  Add years
                </button>
              )}
            </div>

            {openFor === name && (
              // `role="group"` + the team's own name: the two year fields and
              // two buttons are one task, and a screen reader entering them
              // should hear which team they belong to.
              <div
                role="group"
                aria-label={`Years for ${name}`}
                className="mt-1 flex flex-wrap items-center gap-2"
              >
                <Input
                  bare
                  autoFocus
                  type="number"
                  value={draft.fromYear}
                  placeholder="From year"
                  aria-label={`From year for ${name}`}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  min={MIN_CAREER_YEAR}
                  max={maxYear}
                  onChange={(e) => {
                    setError(null);
                    setDraft((d) => ({ ...d, fromYear: e.target.value }));
                  }}
                  onKeyDown={(e) => {
                    // Enter must never reach the wizard's confirm shortcut —
                    // the same guarantee CareerTeamEntry makes, and for the
                    // same reason: a half-typed year is not a decision.
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.stopPropagation();
                      save(name);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      close();
                    }
                  }}
                  className="w-24 p-1.5 text-sm"
                />
                <Input
                  bare
                  type="number"
                  value={draft.toYear}
                  placeholder="To year (opt)"
                  aria-label={`To year for ${name} (optional)`}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  min={MIN_CAREER_YEAR}
                  max={maxYear}
                  onChange={(e) => {
                    setError(null);
                    setDraft((d) => ({ ...d, toYear: e.target.value }));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.stopPropagation();
                      save(name);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      close();
                    }
                  }}
                  className="w-28 p-1.5 text-sm"
                />
                <button
                  type="button"
                  aria-disabled={disabled}
                  aria-label={`Save years for ${name}`}
                  onClick={() => save(name)}
                  className="rounded border border-[#00D558] px-2 py-1.5 text-sm text-[#00D558] transition-colors hover:bg-[#00D558]/20 focus:bg-[#00D558]/20 focus:outline-none focus:ring-2 focus:ring-[#00D558] aria-disabled:opacity-40"
                >
                  Save years
                </button>
                {/* Deliberately NOT disabled while the wizard is busy: Cancel
                    only closes a local form and returns focus, so refusing it
                    would strand the operator in a form they cannot leave. The
                    rule is that a round-trip must not swallow an ESCAPE, not
                    that everything freezes. */}
                <button
                  type="button"
                  aria-label={`Cancel years for ${name}`}
                  onClick={close}
                  className="rounded p-1 -m-1 text-xs text-gray-400 underline decoration-dotted transition-colors hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none focus:ring-2 focus:ring-[#FF2EB3]"
                >
                  Cancel
                </button>
              </div>
            )}

            {openFor === name && error && (
              <p id={errorId} role="alert" className="mt-1 text-xs text-[#FF2EB3]">
                {error}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

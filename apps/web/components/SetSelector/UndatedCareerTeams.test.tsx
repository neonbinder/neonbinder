/**
 * NEO-254 — the Wikidata teams with no years, and dating one by hand.
 *
 * What is locked in here:
 *
 *  1. **Nothing renders when there is nothing to show.** An "Also on Wikidata"
 *     heading over an empty list is worse than no heading.
 *  2. **Dating a lead emits a career-team draft**, in the exact shape the
 *     wizard's manual mechanism (and therefore `recordDecision`) takes —
 *     `toYear` OMITTED rather than undefined when it was left blank, because
 *     that is the difference between "still there" and a malformed stint.
 *  3. **The one shared floor.** Both server validators that guard
 *     `players.teamYears` now read `MIN_CAREER_YEAR` from
 *     `lib/players/career-years`; this form validates against the same
 *     constant so it can never offer a year the round-trip then refuses.
 *  4. **Every control is uniquely addressable.** The visible text repeats down
 *     the list ("Add years", "Add years", …), so the team name is in the
 *     ACCESSIBLE NAME — for a screen reader, and for the Maestro `tapOn` that
 *     will drive this flow.
 *  5. **Escape never escapes the field.** NEO-220's lesson: Escape reaching
 *     the dialog root cancels the whole review batch, and an operator pressing
 *     a key that means "clear this" must not lose every decision they made.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// `./CareerTeamEntry` (imported for MIN_CAREER_YEAR) reaches convex/react at
// module load. Stubbed rather than exercised — it has its own test file.
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => vi.fn(),
}));
vi.mock("../../convex/_generated/api", () => ({ api: { teams: { search: "teams.search" } } }));

import UndatedCareerTeams from "./UndatedCareerTeams";
import { MIN_CAREER_YEAR } from "../../lib/players/career-years";

const NAMES = ["San Diego State Aztecs", "United States national team"];

const maxYear = new Date().getFullYear() + 1;

function openYearsFor(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `Add years for ${name}` }));
}

describe("UndatedCareerTeams", () => {
  it("renders nothing when there are no leads", () => {
    const { container } = render(
      <UndatedCareerTeams names={[]} onAdd={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("lists every lead under one named list", () => {
    render(<UndatedCareerTeams names={NAMES} onAdd={vi.fn()} />);
    expect(screen.getByText("Also on Wikidata, no years yet")).toBeTruthy();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    for (const name of NAMES) expect(screen.getByText(name)).toBeTruthy();
  });

  it("names the team in each button's accessible name, not just its text", () => {
    render(<UndatedCareerTeams names={NAMES} onAdd={vi.fn()} />);
    for (const name of NAMES) {
      expect(
        screen.getByRole("button", { name: `Add years for ${name}` }),
      ).toBeTruthy();
    }
    // The visible text is identical on both, which is exactly why the
    // accessible name has to differ.
    expect(screen.getAllByText("Add years")).toHaveLength(2);
  });

  it("opens one year form at a time", () => {
    render(<UndatedCareerTeams names={NAMES} onAdd={vi.fn()} />);
    openYearsFor(NAMES[0]);
    expect(screen.getByRole("group", { name: `Years for ${NAMES[0]}` })).toBeTruthy();

    openYearsFor(NAMES[1]);
    expect(screen.queryByRole("group", { name: `Years for ${NAMES[0]}` })).toBeNull();
    expect(screen.getByRole("group", { name: `Years for ${NAMES[1]}` })).toBeTruthy();
  });

  it("emits a draft with both years and closes the form", () => {
    const onAdd = vi.fn();
    render(<UndatedCareerTeams names={NAMES} onAdd={onAdd} />);
    openYearsFor(NAMES[0]);

    fireEvent.change(screen.getByLabelText(`From year for ${NAMES[0]}`), {
      target: { value: "1979" },
    });
    fireEvent.change(
      screen.getByLabelText(`To year for ${NAMES[0]} (optional)`),
      { target: { value: "1981" } },
    );
    fireEvent.click(screen.getByRole("button", { name: `Save years for ${NAMES[0]}` }));

    expect(onAdd).toHaveBeenCalledWith({
      name: NAMES[0],
      fromYear: 1979,
      toYear: 1981,
    });
    expect(screen.queryByRole("group", { name: `Years for ${NAMES[0]}` })).toBeNull();
  });

  it("OMITS toYear when the end year is left blank", () => {
    // Not `toYear: undefined`. An explicit undefined survives into the object
    // sent to `recordDecision`, and "still there" is a real answer that the
    // stored shape expresses by the key's absence.
    const onAdd = vi.fn();
    render(<UndatedCareerTeams names={NAMES} onAdd={onAdd} />);
    openYearsFor(NAMES[0]);
    fireEvent.change(screen.getByLabelText(`From year for ${NAMES[0]}`), {
      target: { value: "1979" },
    });
    fireEvent.click(screen.getByRole("button", { name: `Save years for ${NAMES[0]}` }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(Object.keys(onAdd.mock.calls[0][0])).toEqual(["name", "fromYear"]);
  });

  it("refuses a start year below the wizard's own floor", () => {
    const onAdd = vi.fn();
    render(<UndatedCareerTeams names={NAMES} onAdd={onAdd} />);
    openYearsFor(NAMES[0]);
    fireEvent.change(screen.getByLabelText(`From year for ${NAMES[0]}`), {
      target: { value: String(MIN_CAREER_YEAR - 1) },
    });
    fireEvent.click(screen.getByRole("button", { name: `Save years for ${NAMES[0]}` }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(
      `between ${MIN_CAREER_YEAR} and ${maxYear}`,
    );
  });

  it("refuses an end year before the start year", () => {
    const onAdd = vi.fn();
    render(<UndatedCareerTeams names={NAMES} onAdd={onAdd} />);
    openYearsFor(NAMES[0]);
    fireEvent.change(screen.getByLabelText(`From year for ${NAMES[0]}`), {
      target: { value: "1990" },
    });
    fireEvent.change(
      screen.getByLabelText(`To year for ${NAMES[0]} (optional)`),
      { target: { value: "1985" } },
    );
    fireEvent.click(screen.getByRole("button", { name: `Save years for ${NAMES[0]}` }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(
      "End year can't come before the start year.",
    );
  });

  it("refuses an empty start year rather than emitting NaN", () => {
    const onAdd = vi.fn();
    render(<UndatedCareerTeams names={NAMES} onAdd={onAdd} />);
    openYearsFor(NAMES[0]);
    fireEvent.click(screen.getByRole("button", { name: `Save years for ${NAMES[0]}` }));
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("Cancel closes the form without emitting anything", () => {
    const onAdd = vi.fn();
    render(<UndatedCareerTeams names={NAMES} onAdd={onAdd} />);
    openYearsFor(NAMES[0]);
    fireEvent.change(screen.getByLabelText(`From year for ${NAMES[0]}`), {
      target: { value: "1979" },
    });
    fireEvent.click(screen.getByRole("button", { name: `Cancel years for ${NAMES[0]}` }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: `Years for ${NAMES[0]}` })).toBeNull();
  });

  it("Enter in a year field saves, and never reaches the dialog", () => {
    const onAdd = vi.fn();
    render(<UndatedCareerTeams names={NAMES} onAdd={onAdd} />);
    openYearsFor(NAMES[0]);
    const from = screen.getByLabelText(`From year for ${NAMES[0]}`);
    fireEvent.change(from, { target: { value: "1979" } });

    // `bubbles: true` so a key that was NOT stopped would reach the container.
    const seen = vi.fn();
    document.addEventListener("keydown", seen);
    fireEvent.keyDown(from, { key: "Enter", bubbles: true });
    document.removeEventListener("keydown", seen);

    expect(onAdd).toHaveBeenCalledWith({ name: NAMES[0], fromYear: 1979 });
    expect(seen).not.toHaveBeenCalled();
  });

  it("Escape closes the form and never reaches the dialog", () => {
    // NEO-220: Escape at the dialog root cancels the whole batch.
    const onAdd = vi.fn();
    render(<UndatedCareerTeams names={NAMES} onAdd={onAdd} />);
    openYearsFor(NAMES[0]);
    const from = screen.getByLabelText(`From year for ${NAMES[0]}`);

    const seen = vi.fn();
    document.addEventListener("keydown", seen);
    fireEvent.keyDown(from, { key: "Escape", bubbles: true });
    document.removeEventListener("keydown", seen);

    expect(seen).not.toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: `Years for ${NAMES[0]}` })).toBeNull();
  });

  it("returns focus to Add years when the form closes", () => {
    // The trigger UNMOUNTS while the form is open, so without the refocus
    // focus lands on <body>: the operator's place in the wizard is gone and
    // the next Tab restarts from the top of the dialog (SC 2.4.3 / 3.2.2).
    render(<UndatedCareerTeams names={NAMES} onAdd={vi.fn()} />);

    // …after Cancel
    openYearsFor(NAMES[0]);
    fireEvent.click(screen.getByRole("button", { name: `Cancel years for ${NAMES[0]}` }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: `Add years for ${NAMES[0]}` }),
    );

    // …and after a successful Save
    openYearsFor(NAMES[1]);
    fireEvent.change(screen.getByLabelText(`From year for ${NAMES[1]}`), {
      target: { value: "1984" },
    });
    fireEvent.click(screen.getByRole("button", { name: `Save years for ${NAMES[1]}` }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: `Add years for ${NAMES[1]}` }),
    );
  });

  it("returns focus to Add years when Escape closes the form", () => {
    render(<UndatedCareerTeams names={NAMES} onAdd={vi.fn()} />);
    openYearsFor(NAMES[0]);
    fireEvent.keyDown(screen.getByLabelText(`From year for ${NAMES[0]}`), {
      key: "Escape",
      bubbles: true,
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: `Add years for ${NAMES[0]}` }),
    );
  });

  it("gives the open form's first year field focus", () => {
    render(<UndatedCareerTeams names={NAMES} onAdd={vi.fn()} />);
    openYearsFor(NAMES[0]);
    expect(document.activeElement).toBe(
      screen.getByLabelText(`From year for ${NAMES[0]}`),
    );
  });

  it("points both year fields at the error, so tabbing back still reports it", () => {
    // role="alert" announces once. An operator who tabs back to the box
    // afterwards needs the field itself to carry the problem.
    render(<UndatedCareerTeams names={NAMES} onAdd={vi.fn()} />);
    openYearsFor(NAMES[0]);
    fireEvent.click(screen.getByRole("button", { name: `Save years for ${NAMES[0]}` }));

    const errorId = screen.getByRole("alert").getAttribute("id");
    expect(errorId).toBeTruthy();
    for (const label of [
      `From year for ${NAMES[0]}`,
      `To year for ${NAMES[0]} (optional)`,
    ]) {
      const field = screen.getByLabelText(label);
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(field.getAttribute("aria-describedby")).toBe(errorId);
    }
  });

  it("refuses to save from a form that was already open when the wizard went busy", () => {
    // The trigger is aria-disabled, but a form opened BEFORE the decision
    // started is still on screen. Staging into a row the wizard is about to
    // move past would put the chip on the wrong player.
    const onAdd = vi.fn();
    const { rerender } = render(
      <UndatedCareerTeams names={NAMES} onAdd={onAdd} />,
    );
    openYearsFor(NAMES[0]);
    fireEvent.change(screen.getByLabelText(`From year for ${NAMES[0]}`), {
      target: { value: "1979" },
    });

    rerender(<UndatedCareerTeams names={NAMES} disabled onAdd={onAdd} />);
    fireEvent.click(screen.getByRole("button", { name: `Save years for ${NAMES[0]}` }));
    expect(onAdd).not.toHaveBeenCalled();

    // Cancel stays live: it only closes a local form, and refusing it would
    // strand the operator in something they cannot leave.
    fireEvent.click(screen.getByRole("button", { name: `Cancel years for ${NAMES[0]}` }));
    expect(screen.queryByRole("group", { name: `Years for ${NAMES[0]}` })).toBeNull();
  });

  it("marks Add years aria-disabled while a decision is in flight, and keeps it focusable", () => {
    // `aria-disabled`, never native `disabled` — the wizard's rule: a disabled
    // control leaves the tab order, throwing a keyboard operator out of the
    // list for the length of a round-trip.
    const onAdd = vi.fn();
    render(<UndatedCareerTeams names={NAMES} disabled onAdd={onAdd} />);
    const button = screen.getByRole("button", { name: `Add years for ${NAMES[0]}` });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);

    fireEvent.click(button);
    expect(screen.queryByRole("group", { name: `Years for ${NAMES[0]}` })).toBeNull();
  });
});

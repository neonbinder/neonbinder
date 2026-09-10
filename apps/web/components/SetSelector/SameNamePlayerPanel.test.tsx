/**
 * NEO-254 — "Same name, different people."
 *
 * The one thing this panel must never do is offer two controls the operator
 * cannot tell apart. Every row shares a name — that is the premise — so the
 * accessible name has to carry the fact that distinguishes them, and it has to
 * carry SOMETHING even when the row itself has nothing to say. A screen-reader
 * user hearing "Link to Bob Allen" twice, or a Maestro `tapOn` matching the
 * first of two, is the same failure the panel was built to prevent, arriving
 * through the panel instead of through the index.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SameNamePlayerPanel, {
  ACTIVE_IN_SET_YEAR_LABEL,
  candidateDetail,
  candidateLinkLabel,
  type SameNameCandidate,
} from "./SameNamePlayerPanel";

const older: SameNameCandidate = {
  playerId: "p1",
  name: "Bob Allen",
  birthYear: 1867,
  careerSummary: "Phillies 1890–1894",
};
const younger: SameNameCandidate = {
  playerId: "p2",
  name: "Bob Allen",
  birthYear: 1937,
  careerSummary: "Padres 1961–present",
};
const bare: SameNameCandidate = {
  playerId: "p3",
  name: "Bob Allen",
  careerSummary: "",
};

describe("candidateDetail", () => {
  it("joins the birth year and the career line", () => {
    expect(candidateDetail(older)).toBe("b. 1867 · Phillies 1890–1894");
  });

  it("uses whichever half exists", () => {
    expect(candidateDetail({ ...bare, birthYear: 1937 })).toBe("b. 1937");
    expect(candidateDetail({ ...bare, careerSummary: "Padres 1961–present" })).toBe(
      "Padres 1961–present",
    );
  });

  it("is null when the row can say nothing about itself", () => {
    // Null rather than a placeholder: the caller renders that case
    // differently, because "nothing on file" is an admission, not data.
    expect(candidateDetail(bare)).toBeNull();
  });
});

describe("candidateLinkLabel", () => {
  it("puts the distinguishing fact into the accessible name", () => {
    expect(candidateLinkLabel(older, 0, 2)).toBe(
      "Link to Bob Allen, b. 1867 · Phillies 1890–1894",
    );
    expect(candidateLinkLabel(younger, 1, 2)).toBe(
      "Link to Bob Allen, b. 1937 · Padres 1961–present",
    );
  });

  it("falls back to the position when there is no fact to use", () => {
    // Weak information, but unique — and a unique weak name beats a duplicated
    // strong one on the one screen where telling two rows apart IS the task.
    expect(candidateLinkLabel(bare, 0, 2)).toBe(
      "Link to Bob Allen, option 1 of 2",
    );
  });
});

describe("SameNamePlayerPanel", () => {
  it("renders nothing when there are no candidates", () => {
    const { container } = render(
      <SameNamePlayerPanel candidates={[]} onPick={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("states the situation and the count", () => {
    render(
      <SameNamePlayerPanel candidates={[older, younger]} onPick={vi.fn()} />,
    );
    expect(screen.getByText("Same name, different people")).toBeTruthy();
    expect(
      screen.getByText(/2 players are already filed under this name/),
    ).toBeTruthy();
  });

  it("gives every row a UNIQUE accessible name", () => {
    render(
      <SameNamePlayerPanel candidates={[older, younger, bare]} onPick={vi.fn()} />,
    );
    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
  });

  it("shows the birth year and career line on each row", () => {
    render(
      <SameNamePlayerPanel candidates={[older, younger]} onPick={vi.fn()} />,
    );
    expect(screen.getByText("b. 1867 · Phillies 1890–1894")).toBeTruthy();
    expect(screen.getByText("b. 1937 · Padres 1961–present")).toBeTruthy();
  });

  it("says so when a row has nothing on file", () => {
    render(<SameNamePlayerPanel candidates={[older, bare]} onPick={vi.fn()} />);
    expect(screen.getByText("Nothing on file yet")).toBeTruthy();
  });

  it("hands the picked player's id back", () => {
    const onPick = vi.fn();
    render(
      <SameNamePlayerPanel candidates={[older, younger]} onPick={onPick} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: candidateLinkLabel(younger, 1, 2) }),
    );
    expect(onPick).toHaveBeenCalledWith("p2");
  });

  it("is aria-disabled, not natively disabled, while a decision is in flight", () => {
    // A disabled control leaves the tab order, throwing a keyboard operator
    // out of the list for the length of a round-trip. The wizard's rule.
    const onPick = vi.fn();
    render(
      <SameNamePlayerPanel candidates={[older, younger]} disabled onPick={onPick} />,
    );
    const button = screen.getByRole("button", {
      name: candidateLinkLabel(older, 0, 2),
    });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);

    fireEvent.click(button);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("names the list, so a screen reader entering it knows what it is", () => {
    render(
      <SameNamePlayerPanel candidates={[older, younger]} onPick={vi.fn()} />,
    );
    expect(
      screen.getByRole("list", { name: "Players already filed under this name" }),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// NEO-254 — the year marker
// ---------------------------------------------------------------------------

describe("the on-a-roster-that-year marker", () => {
  it("shows only on the flagged candidate", () => {
    render(
      <SameNamePlayerPanel
        candidates={[{ ...younger, activeInSetYear: true }, older]}
        onPick={vi.fn()}
      />,
    );
    expect(screen.getAllByText(ACTIVE_IN_SET_YEAR_LABEL)).toHaveLength(1);
  });

  it("renders nothing when no candidate is flagged", () => {
    // Absent means "we cannot say" — a set with no year flags nobody, and a
    // greyed-out "not that year" would be a verdict the data cannot support.
    render(
      <SameNamePlayerPanel candidates={[older, younger]} onPick={vi.fn()} />,
    );
    expect(screen.queryByText(ACTIVE_IN_SET_YEAR_LABEL)).toBeNull();
  });

  it("rides into the accessible name, ahead of the biography", () => {
    // A screen-reader user must not have to infer the decisive fact from a
    // colour, and it leads because it is what settles the choice.
    const label = candidateLinkLabel({ ...younger, activeInSetYear: true }, 1, 2);
    expect(label).toBe(
      `Link to Bob Allen, ${ACTIVE_IN_SET_YEAR_LABEL}, b. 1937 · Padres 1961–present`,
    );
  });

  it("does not replace the ordinal fallback on a row with nothing else", () => {
    // Two contemporaries are BOTH flagged, so the marker alone does not make a
    // name unique — the position still has to.
    const label = candidateLinkLabel({ ...bare, activeInSetYear: true }, 0, 2);
    expect(label).toBe(
      `Link to Bob Allen, ${ACTIVE_IN_SET_YEAR_LABEL}, option 1 of 2`,
    );
  });

  it("is not part of candidateDetail — that line stays biography", () => {
    expect(candidateDetail({ ...younger, activeInSetYear: true })).toBe(
      "b. 1937 · Padres 1961–present",
    );
  });
});

describe("a candidate matched by a former name says so", () => {
  it("leads the detail line with 'also known as'", () => {
    // Ron Artest became Metta World Peace. A 2010 card names a row whose own
    // name is nothing like it, and without this the operator has to guess why
    // that row is on the list at all — so it leads, ahead of the birth year.
    expect(
      candidateDetail({ ...younger, matchedAlias: "Ron Artest" }),
    ).toBe("also known as Ron Artest · b. 1937 · Padres 1961–present");
  });

  it("says nothing when the primary name matched", () => {
    expect(candidateDetail(younger)).toBe("b. 1937 · Padres 1961–present");
  });

  it("carries into the accessible name, so it is announced too", () => {
    const label = candidateLinkLabel(
      { ...bare, matchedAlias: "Ron Artest" },
      0,
      2,
    );
    expect(label).toBe("Link to Bob Allen, also known as Ron Artest");
  });
});

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

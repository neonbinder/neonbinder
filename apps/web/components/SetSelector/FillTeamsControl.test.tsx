/**
 * NEO-279 — FillTeamsControl: the pure copy helpers pinned directly, and the
 * component's states driven through mocked `useAction`s.
 *
 * Mocking strategy mirrors SetAttributesPanel.test.tsx: `convex/react`'s
 * `useAction` is routed by the (string-mocked) action reference so
 * `previewTeamFill` and `applyTeamFill` can be independently controlled.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConvexError } from "convex/values";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    teamFill: {
      previewTeamFill: "teamFill.previewTeamFill",
      applyTeamFill: "teamFill.applyTeamFill",
    },
  },
}));

const mockPreview = vi.fn();
const mockApply = vi.fn();

vi.mock("convex/react", () => ({
  useAction: (action: string) => {
    if (action === "teamFill.previewTeamFill") return mockPreview;
    if (action === "teamFill.applyTeamFill") return mockApply;
    return vi.fn();
  },
}));

import FillTeamsControl, {
  fillConfirmCopy,
  fillGroupLine,
  fillResultToast,
  fillRuleLabel,
  FILL_TEAMS_LABEL,
  FILL_TEAMS_LIST_LABEL,
  NOTHING_TO_FILL,
  type TeamFillGroup,
  type TeamFillPreview,
  type TeamFillResult,
} from "./FillTeamsControl";

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePreview(overrides: Partial<TeamFillPreview> = {}): TeamFillPreview {
  return {
    candidates: 14,
    fillable: 14,
    byRule: { samePlayerInSet: 11, oneTeamCareer: 2, oneStintInYear: 1 },
    remaining: 0,
    setYear: 2024,
    groups: [
      {
        playerNames: ["Johnny Bench"],
        teamNames: ["Cincinnati Reds"],
        rule: "samePlayerInSet",
        cardCount: 11,
      },
    ],
    groupsTotal: 1,
    ...overrides,
  };
}

const SELECTOR_OPTION_ID = "selector-option-1" as unknown as Parameters<
  typeof FillTeamsControl
>[0]["id"];

function renderControl(showToast: (message: string) => void = vi.fn()) {
  return render(
    <FillTeamsControl id={SELECTOR_OPTION_ID} level="setName" showToast={showToast} />,
  );
}

// ===========================================================================
// Copy helpers — pure
// ===========================================================================

describe("fillRuleLabel", () => {
  it("names each rule, with the set year in oneStintInYear when known", () => {
    expect(fillRuleLabel("samePlayerInSet", 2024)).toBe("same player in this set");
    expect(fillRuleLabel("oneTeamCareer", 2024)).toBe("one-team career");
    expect(fillRuleLabel("oneStintInYear", 2024)).toBe("only team in 2024");
  });

  it("falls back to a generic clause for oneStintInYear when the set has no year", () => {
    expect(fillRuleLabel("oneStintInYear", null)).toBe("only team that year");
  });
});

describe("fillGroupLine", () => {
  it("joins multiple players with & and multiple teams with /, singular card count", () => {
    const group: TeamFillGroup = {
      playerNames: ["Ohtani", "Trout"],
      teamNames: ["Angels", "Dodgers"],
      rule: "oneStintInYear",
      cardCount: 1,
    };
    const row = fillGroupLine(group, 2024);
    expect(row.players).toBe("Ohtani & Trout");
    expect(row.teams).toBe("Angels / Dodgers");
    expect(row.meta).toBe("1 card · only team in 2024");
    expect(row.line).toBe("Ohtani & Trout → Angels / Dodgers · 1 card · only team in 2024");
  });

  it("pluralises cards", () => {
    const group: TeamFillGroup = {
      playerNames: ["Bench"],
      teamNames: ["Reds"],
      rule: "samePlayerInSet",
      cardCount: 11,
    };
    expect(fillGroupLine(group, null).meta).toBe("11 cards · same player in this set");
  });
});

describe("fillConfirmCopy", () => {
  it("omits a zero rule and joins the non-zero ones in server order", () => {
    const preview = makePreview({
      fillable: 3,
      byRule: { samePlayerInSet: 0, oneTeamCareer: 2, oneStintInYear: 1 },
      remaining: 0,
    });
    const copy = fillConfirmCopy(preview);
    expect(copy.title).toBe("Fill teams on 3 cards?");
    expect(copy.description).toBe(
      "2 from a one-team career, 1 from the only team that year.",
    );
  });

  it("says the singular card when fillable is 1", () => {
    const preview = makePreview({
      fillable: 1,
      byRule: { samePlayerInSet: 1, oneTeamCareer: 0, oneStintInYear: 0 },
      remaining: 0,
    });
    expect(fillConfirmCopy(preview).title).toBe("Fill teams on 1 card?");
  });

  it("appends the staying sentence, singular vs plural, only when remaining > 0", () => {
    const oneRemains = makePreview({
      fillable: 5,
      byRule: { samePlayerInSet: 5, oneTeamCareer: 0, oneStintInYear: 0 },
      remaining: 1,
    });
    expect(fillConfirmCopy(oneRemains).description).toBe(
      "5 from a teammate card in this set. 1 stays in the missing-team lane.",
    );

    const manyRemain = makePreview({
      fillable: 5,
      byRule: { samePlayerInSet: 5, oneTeamCareer: 0, oneStintInYear: 0 },
      remaining: 3,
    });
    expect(fillConfirmCopy(manyRemain).description).toBe(
      "5 from a teammate card in this set. 3 stay in the missing-team lane.",
    );

    const noneRemain = makePreview({
      fillable: 5,
      byRule: { samePlayerInSet: 5, oneTeamCareer: 0, oneStintInYear: 0 },
      remaining: 0,
    });
    expect(fillConfirmCopy(noneRemain).description).toBe(
      "5 from a teammate card in this set.",
    );
  });
});

describe("fillResultToast", () => {
  it("says only the applied count when nothing was skipped", () => {
    const result: TeamFillResult = {
      applied: 14,
      skipped: 0,
      byRule: { samePlayerInSet: 11, oneTeamCareer: 2, oneStintInYear: 1 },
    };
    expect(fillResultToast(result)).toBe("Filled teams on 14 cards");
  });

  it("appends the skipped clause, singular was vs plural were", () => {
    const oneSkipped: TeamFillResult = {
      applied: 13,
      skipped: 1,
      byRule: { samePlayerInSet: 13, oneTeamCareer: 0, oneStintInYear: 0 },
    };
    expect(fillResultToast(oneSkipped)).toBe(
      "Filled teams on 13 cards · 1 changed under you and was skipped",
    );

    const twoSkipped: TeamFillResult = {
      applied: 12,
      skipped: 2,
      byRule: { samePlayerInSet: 12, oneTeamCareer: 0, oneStintInYear: 0 },
    };
    expect(fillResultToast(twoSkipped)).toBe(
      "Filled teams on 12 cards · 2 changed under you and were skipped",
    );
  });

  it("says the singular applied card too", () => {
    const result: TeamFillResult = {
      applied: 1,
      skipped: 0,
      byRule: { samePlayerInSet: 1, oneTeamCareer: 0, oneStintInYear: 0 },
    };
    expect(fillResultToast(result)).toBe("Filled teams on 1 card");
  });
});

// ===========================================================================
// Component states
// ===========================================================================

describe("FillTeamsControl", () => {
  it("hides entirely when level is not setName", () => {
    const { container } = render(
      <FillTeamsControl
        id={SELECTOR_OPTION_ID}
        level="variantType"
        showToast={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("is idle at first, showing the Fill teams trigger", () => {
    renderControl();
    const button = screen.getByRole("button", { name: FILL_TEAMS_LABEL });
    expect(button).toBeTruthy();
    expect(button.getAttribute("aria-disabled")).toBeNull();
  });

  it("shows Checking… and aria-disabled while a preview is in flight, ignoring a second click", async () => {
    let resolvePreview!: (value: TeamFillPreview) => void;
    mockPreview.mockReturnValue(
      new Promise<TeamFillPreview>((resolve) => {
        resolvePreview = resolve;
      }),
    );
    renderControl();

    const button = screen.getByRole("button", { name: FILL_TEAMS_LABEL });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText("Checking…")).toBeTruthy());
    expect(button.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(button); // ignored — still checking
    expect(mockPreview).toHaveBeenCalledTimes(1);

    resolvePreview(makePreview({ fillable: 0, candidates: 0, remaining: 0 }));
    await waitFor(() => expect(screen.getByText(FILL_TEAMS_LABEL)).toBeTruthy());
  });

  it("zero fillable: toasts NOTHING_TO_FILL and opens no dialog", async () => {
    mockPreview.mockResolvedValue(
      makePreview({ fillable: 0, candidates: 3, remaining: 3, groups: [], groupsTotal: 0 }),
    );
    const showToast = vi.fn();
    renderControl(showToast);

    fireEvent.click(screen.getByRole("button", { name: FILL_TEAMS_LABEL }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(NOTHING_TO_FILL));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the dialog with the preview's title, body and ledger rows", async () => {
    mockPreview.mockResolvedValue(makePreview());
    renderControl();

    fireEvent.click(screen.getByRole("button", { name: FILL_TEAMS_LABEL }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Fill teams on 14 cards?");
    expect(dialog.textContent).toContain("Johnny Bench");
    expect(dialog.textContent).toContain("Cincinnati Reds");
    expect(screen.getByLabelText(FILL_TEAMS_LIST_LABEL)).toBeTruthy();
  });

  it("shows the overflow line when groupsTotal exceeds the returned groups", async () => {
    mockPreview.mockResolvedValue(makePreview({ groupsTotal: 205 }));
    renderControl();

    fireEvent.click(screen.getByRole("button", { name: FILL_TEAMS_LABEL }));
    await screen.findByRole("dialog");
    expect(screen.getByText("…and 204 more")).toBeTruthy();
  });

  it("confirming calls apply exactly once and toasts the result", async () => {
    mockPreview.mockResolvedValue(makePreview());
    mockApply.mockResolvedValue({
      applied: 14,
      skipped: 0,
      byRule: { samePlayerInSet: 11, oneTeamCareer: 2, oneStintInYear: 1 },
    });
    const showToast = vi.fn();
    renderControl(showToast);

    fireEvent.click(screen.getByRole("button", { name: FILL_TEAMS_LABEL }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Yes, fill" }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("Filled teams on 14 cards"),
    );
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockApply).toHaveBeenCalledWith({ selectorOptionId: SELECTOR_OPTION_ID });
    // The dialog closes on success.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an apply error stays inside the dialog rather than closing it", async () => {
    mockPreview.mockResolvedValue(makePreview());
    mockApply.mockRejectedValue(new ConvexError("Something changed underneath you."));
    renderControl();

    fireEvent.click(screen.getByRole("button", { name: FILL_TEAMS_LABEL }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Yes, fill" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Something changed underneath you.",
      ),
    );
    // Still open — the operator can retry or cancel from here.
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("Escape cancels the dialog without ever calling apply", async () => {
    mockPreview.mockResolvedValue(makePreview());
    renderControl();

    fireEvent.click(screen.getByRole("button", { name: FILL_TEAMS_LABEL }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("a ConvexError from preview toasts its own text under the Failed: prefix", async () => {
    mockPreview.mockRejectedValue(
      new ConvexError("Fill teams from the set row, not a variant or parallel."),
    );
    const showToast = vi.fn();
    renderControl(showToast);

    fireEvent.click(screen.getByRole("button", { name: FILL_TEAMS_LABEL }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "Failed: Fill teams from the set row, not a variant or parallel.",
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a non-ConvexError from preview toasts the generic fallback", async () => {
    mockPreview.mockRejectedValue(new Error("network blew up"));
    const showToast = vi.fn();
    renderControl(showToast);

    fireEvent.click(screen.getByRole("button", { name: FILL_TEAMS_LABEL }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "Failed: Couldn't check the cards. Nothing changed.",
      ),
    );
  });
});

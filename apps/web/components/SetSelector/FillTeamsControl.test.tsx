/**
 * NEO-279 — FillTeamsControl: the pure copy helpers pinned directly, and the
 * component's states driven through mocked `useAction`s.
 *
 * Mocking strategy mirrors SetAttributesPanel.test.tsx: `convex/react`'s
 * `useAction` is routed by the (string-mocked) action reference so
 * `previewTeamFill` and `applyTeamFill` can be independently controlled.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  CHECK_FAILED_FALLBACK,
  fillConfirmCopy,
  fillConflictLine,
  fillGroupLine,
  fillResultToast,
  fillRuleLabel,
  fillTeamsLabel,
  FILL_FAILED_FALLBACK,
  FILL_TEAMS_CHECKING_LABEL,
  FILL_TEAMS_CONFLICTS_HEADING,
  FILL_TEAMS_LIST_LABEL,
  FILL_TEAMS_LIST_LABEL_WITH_SKIPS,
  FILL_TEAMS_TOOLTIP,
  nothingToFillToast,
  type TeamFillConflictCard,
  type TeamFillGroup,
  type TeamFillPreview,
  type TeamFillResult,
} from "./FillTeamsControl";
import { SET_ROW_ACTION_TONE_CLASSES } from "./SetRowActionButton";

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
        scope: "sameNode",
        mixed: false,
        nodeNames: ["Base"],
        nodeCount: 1,
        cardCount: 11,
      },
    ],
    groupsTotal: 1,
    conflicts: 0,
    conflictCards: [],
    ...overrides,
  };
}

function makeGroup(overrides: Partial<TeamFillGroup> = {}): TeamFillGroup {
  return {
    playerNames: ["Bench"],
    teamNames: ["Reds"],
    rule: "samePlayerInSet",
    scope: "sameNode",
    mixed: false,
    nodeNames: ["Base"],
    nodeCount: 1,
    cardCount: 1,
    ...overrides,
  };
}

const SET_ID = "set-row-1" as unknown as Parameters<
  typeof FillTeamsControl
>[0]["setId"];

/** Cards on the open checklist with no team — the N on the trigger. */
const MISSING = 3;
const LABEL = fillTeamsLabel(MISSING);

function renderControl(
  showToast: (message: string, tone?: "status" | "error") => void = vi.fn(),
  missingCount = MISSING,
) {
  return render(
    <FillTeamsControl setId={SET_ID} missingCount={missingCount} showToast={showToast} />,
  );
}

// ===========================================================================
// Copy helpers — pure
// ===========================================================================

describe("fillRuleLabel", () => {
  it("names each scope, with the set year in oneStintInYear when known", () => {
    expect(fillRuleLabel(makeGroup({ rule: "samePlayerInSet", scope: "sameNode" }), 2024)).toBe(
      "same player in this set",
    );
    expect(fillRuleLabel(makeGroup({ rule: "samePlayerInSet", scope: "parallelOf" }), 2024)).toBe(
      "the card it parallels",
    );
    expect(
      fillRuleLabel(makeGroup({ rule: "samePlayerInSet", scope: "baseSet", nodeNames: [] }), 2024),
    ).toBe("the base card");
    expect(
      fillRuleLabel(makeGroup({ rule: "oneTeamCareer", scope: "career", nodeNames: [] }), 2024),
    ).toBe("only team on file");
    expect(
      fillRuleLabel(makeGroup({ rule: "oneStintInYear", scope: "career", nodeNames: [] }), 2024),
    ).toBe("only team in 2024");
  });

  it("keeps the E2E-matched same-node clause byte for byte", () => {
    // set-fill-teams-from-teammate-card.yaml full-matches this string.
    expect(fillRuleLabel(makeGroup({ scope: "sameNode", nodeNames: ["Base"] }), 2024)).toBe(
      "same player in this set",
    );
  });

  it("falls back to a generic clause for oneStintInYear when the set has no year", () => {
    expect(
      fillRuleLabel(makeGroup({ rule: "oneStintInYear", scope: "career", nodeNames: [] }), null),
    ).toBe("only team that year");
  });

  it("says each player's own team when the players resolved through different tiers", () => {
    expect(
      fillRuleLabel(
        makeGroup({ rule: "oneTeamCareer", scope: "career", mixed: true, nodeNames: [] }),
        2024,
      ),
    ).toBe("each player's own team");
    // The mixed clause replaces the rule clause, whichever rule won.
    expect(
      fillRuleLabel(
        makeGroup({ rule: "oneStintInYear", scope: "career", mixed: true, nodeNames: [] }),
        2024,
      ),
    ).toBe("each player's own team");
  });

  it("names the target nodes for a base-card or career fill, and only for those", () => {
    expect(
      fillRuleLabel(
        makeGroup({ scope: "baseSet", nodeNames: ["Stars", "Gold"], nodeCount: 2 }),
        2024,
      ),
    ).toBe("the base card · Stars, Gold");
    expect(
      fillRuleLabel(
        makeGroup({ rule: "oneTeamCareer", scope: "career", nodeNames: ["Legends"], nodeCount: 1 }),
        2024,
      ),
    ).toBe("only team on file · Legends");
    expect(
      fillRuleLabel(
        makeGroup({ rule: "oneStintInYear", scope: "career", nodeNames: ["Legends"], nodeCount: 1 }),
        1991,
      ),
    ).toBe("only team in 1991 · Legends");
    expect(
      fillRuleLabel(
        makeGroup({ rule: "oneTeamCareer", scope: "career", mixed: true, nodeNames: ["Leaders"], nodeCount: 1 }),
        2024,
      ),
    ).toBe("each player's own team · Leaders");
    // A same-node find or a parallel's original never lists its node — that
    // is where the card already is.
    expect(
      fillRuleLabel(makeGroup({ scope: "sameNode", nodeNames: ["Stars"], nodeCount: 1 }), 2024),
    ).toBe("same player in this set");
    expect(
      fillRuleLabel(makeGroup({ scope: "parallelOf", nodeNames: ["Gold"], nodeCount: 1 }), 2024),
    ).toBe("the card it parallels");
  });

  it("says +N more when the server capped the node names", () => {
    expect(
      fillRuleLabel(
        makeGroup({
          scope: "baseSet",
          nodeNames: ["Stars", "Gold", "Silver", "Bronze"],
          nodeCount: 6,
        }),
        2024,
      ),
    ).toBe("the base card · Stars, Gold, Silver, Bronze +2 more");
  });

  it("falls back to the bare clause when a cross-node fill arrives with no names", () => {
    expect(fillRuleLabel(makeGroup({ scope: "baseSet", nodeNames: [], nodeCount: 2 }), 2024)).toBe(
      "the base card",
    );
  });
});

describe("fillGroupLine", () => {
  it("joins multiple players with & and multiple teams with /, singular card count", () => {
    const group = makeGroup({
      playerNames: ["Ohtani", "Trout"],
      teamNames: ["Angels", "Dodgers"],
      rule: "oneStintInYear",
      scope: "career",
      nodeNames: [],
      cardCount: 1,
    });
    const row = fillGroupLine(group, 2024);
    expect(row.players).toBe("Ohtani & Trout");
    expect(row.teams).toBe("Angels / Dodgers");
    expect(row.meta).toBe("1 card · only team in 2024");
    expect(row.line).toBe("Ohtani & Trout → Angels / Dodgers · 1 card · only team in 2024");
  });

  it("pluralises cards", () => {
    expect(fillGroupLine(makeGroup({ cardCount: 11 }), null).meta).toBe(
      "11 cards · same player in this set",
    );
  });

  it("carries the node names through into a base-card row", () => {
    const row = fillGroupLine(
      makeGroup({ scope: "baseSet", nodeNames: ["Stars"], nodeCount: 1, cardCount: 2 }),
      null,
    );
    expect(row.line).toBe("Bench → Reds · 2 cards · the base card · Stars");
  });

  it("reads a combo card filled with each player's own team as one row", () => {
    const row = fillGroupLine(
      makeGroup({
        playerNames: ["Bench", "Rose"],
        teamNames: ["Reds", "Phillies"],
        rule: "oneTeamCareer",
        scope: "career",
        mixed: true,
        nodeNames: ["Leaders"],
        cardCount: 1,
      }),
      1983,
    );
    expect(row.line).toBe("Bench & Rose → Reds / Phillies · 1 card · each player's own team · Leaders");
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
      "2 from the only team on file, 1 from the only team that year.",
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

  it("says all three rules in server order when every one is non-zero", () => {
    expect(fillConfirmCopy(makePreview()).description).toBe(
      "11 from the same player's other cards here, 2 from the only team on file, 1 from the only team that year.",
    );
  });

  it("appends the your-call sentence, singular vs plural, only when remaining > 0", () => {
    const oneRemains = makePreview({
      fillable: 5,
      byRule: { samePlayerInSet: 5, oneTeamCareer: 0, oneStintInYear: 0 },
      remaining: 1,
    });
    expect(fillConfirmCopy(oneRemains).description).toBe(
      "5 from the same player's other cards here. 1 still needs your call.",
    );

    const manyRemain = makePreview({
      fillable: 5,
      byRule: { samePlayerInSet: 5, oneTeamCareer: 0, oneStintInYear: 0 },
      remaining: 3,
    });
    expect(fillConfirmCopy(manyRemain).description).toBe(
      "5 from the same player's other cards here. 3 still need your call.",
    );

    const noneRemain = makePreview({
      fillable: 5,
      byRule: { samePlayerInSet: 5, oneTeamCareer: 0, oneStintInYear: 0 },
      remaining: 0,
    });
    expect(fillConfirmCopy(noneRemain).description).toBe(
      "5 from the same player's other cards here.",
    );
  });
});

describe("nothingToFillToast", () => {
  it("tells a fully teamed set apart from one whose leftovers need the operator", () => {
    expect(nothingToFillToast(0)).toBe("Nothing to fill — every card here has its team.");
    // The a11y review asked for the destination: the walker's link.
    expect(nothingToFillToast(1)).toBe(
      "Nothing to fill — 1 card still needs a team, and it's your call. Use “Fix them one at a time” to choose.",
    );
    expect(nothingToFillToast(4)).toBe(
      "Nothing to fill — 4 cards still need a team, and they're your call. Use “Fix them one at a time” to choose.",
    );
  });
});

/**
 * NEO-330 — the Jimmie Foxx shape: #34/#35 carry no team and the listing's
 * "Philadelphia Athletics"; a rule would copy the Red Sox off #36. Fill skips
 * them and says so, per card — and never names the marketplace.
 */
const FOXX_34: TeamFillConflictCard = {
  cardNumber: "34",
  nodeName: "3X MVP",
  playerNames: ["Jimmie Foxx"],
  teamNames: ["Boston Red Sox"],
  bscTeamName: "Philadelphia Athletics",
  rule: "samePlayerInSet",
  scope: "sameNode",
  mixed: false,
  sourceCardNumber: "36",
};

const FOXX_34_LINE =
  "#34 Jimmie Foxx · 3X MVP · Listing: Philadelphia Athletics · Fill: Boston Red Sox (from #36)";

describe("NEO-330 — cards the listing disagrees on", () => {
  it("fillConflictLine names the card, where it is, the listing, and Fill's team with its source card", () => {
    expect(fillConflictLine(FOXX_34, 2025)).toEqual({
      card: "#34 Jimmie Foxx",
      where: "3X MVP",
      listing: "Listing: Philadelphia Athletics",
      fill: "Fill: Boston Red Sox (from #36)",
      line: FOXX_34_LINE,
    });
  });

  it("a source under another node is named by node and number", () => {
    expect(
      fillConflictLine(
        { ...FOXX_34, scope: "parallelOf", sourceCardNumber: "7", sourceNodeName: "Stars" },
        2025,
      ).fill,
    ).toBe("Fill: Boston Red Sox (from Stars #7)");
  });

  it("with no single source card, the rule's clause stands in — never “this set says”", () => {
    const noSource = { ...FOXX_34, sourceCardNumber: undefined };
    expect(fillConflictLine(noSource, 2025).fill).toBe(
      "Fill: Boston Red Sox (same player in this set)",
    );
    expect(
      fillConflictLine({ ...noSource, rule: "oneTeamCareer", scope: "career" }, 2025).fill,
    ).toBe("Fill: Boston Red Sox (only team on file)");
    expect(
      fillConflictLine({ ...noSource, rule: "oneStintInYear", scope: "career" }, 2025).fill,
    ).toBe("Fill: Boston Red Sox (only team in 2025)");
    expect(
      fillConflictLine({ ...noSource, rule: "oneStintInYear", scope: "career" }, null).fill,
    ).toBe("Fill: Boston Red Sox (only team that year)");
    expect(
      fillConflictLine(
        { ...noSource, teamNames: ["Cincinnati Reds", "Philadelphia Phillies"], mixed: true },
        2025,
      ).fill,
    ).toBe("Fill: Cincinnati Reds / Philadelphia Phillies (each player's own team)");
    for (const line of [fillConflictLine(FOXX_34, 2025).line, fillConflictLine(noSource, 2025).line]) {
      expect(line).not.toMatch(/this set says|BSC|SportLots/);
    }
  });

  it("fillConflictLine degrades without players, node or our side", () => {
    expect(
      fillConflictLine({ ...FOXX_34, playerNames: [], nodeName: "", teamNames: [] }, 2025).line,
    ).toBe("#34 · Listing: Philadelphia Athletics");
  });

  it("fillConfirmCopy says how many were skipped, before the your-call sentence", () => {
    expect(
      fillConfirmCopy(makePreview({ conflicts: 2, remaining: 1 })).description,
    ).toBe(
      "11 from the same player's other cards here, 2 from the only team on file, 1 from the only team that year. 2 cards skipped — the listing names a different team. Your call. 1 still needs your call.",
    );
    expect(fillConfirmCopy(makePreview({ conflicts: 1 })).description).toContain(
      "1 card skipped — the listing names a different team. Your call.",
    );
  });

  it("nothingToFillToast counts the listing's cards as the operator's, and says where to answer them", () => {
    expect(nothingToFillToast(0, 2)).toBe(
      "Nothing to fill — 2 cards still need a team, and they're your call (2 where the listing disagrees). Use “Fix them one at a time” to choose.",
    );
    expect(nothingToFillToast(1, 1)).toBe(
      "Nothing to fill — 2 cards still need a team, and they're your call (1 where the listing disagrees). Use “Fix them one at a time” to choose.",
    );
    expect(nothingToFillToast(0, 1)).toBe(
      "Nothing to fill — 1 card still needs a team, and it's your call (1 where the listing disagrees). Use “Fix them one at a time” to choose.",
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

  it("appends the skipped clause only when something was skipped", () => {
    const oneSkipped: TeamFillResult = {
      applied: 13,
      skipped: 1,
      byRule: { samePlayerInSet: 13, oneTeamCareer: 0, oneStintInYear: 0 },
    };
    expect(fillResultToast(oneSkipped)).toBe(
      "Filled teams on 13 cards · 1 skipped, someone got there first",
    );

    const twoSkipped: TeamFillResult = {
      applied: 12,
      skipped: 2,
      byRule: { samePlayerInSet: 12, oneTeamCareer: 0, oneStintInYear: 0 },
    };
    expect(fillResultToast(twoSkipped)).toBe(
      "Filled teams on 12 cards · 2 skipped, someone got there first",
    );
  });

  it("keeps the E2E-targeted prefix stable", () => {
    const result: TeamFillResult = {
      applied: 3,
      skipped: 2,
      byRule: { samePlayerInSet: 3, oneTeamCareer: 0, oneStintInYear: 0 },
    };
    expect(fillResultToast(result).startsWith("Filled teams on 3 cards")).toBe(true);
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
  it("renders nothing when no card on the open checklist is missing a team", () => {
    const { container } = renderControl(vi.fn(), 0);
    expect(container.innerHTML).toBe("");
  });

  it("says how many cards it is for, singular and plural (NEO-306)", () => {
    expect(fillTeamsLabel(1)).toBe("1 card needs a team");
    expect(fillTeamsLabel(3)).toBe("3 cards need a team");
    const { rerender } = renderControl(vi.fn(), 1);
    expect(screen.getByRole("button", { name: "1 card needs a team" })).toBeTruthy();
    // The count is live: the checklist's subscription moves it, the name follows.
    rerender(<FillTeamsControl setId={SET_ID} missingCount={4} showToast={vi.fn()} />);
    expect(screen.getByRole("button", { name: "4 cards need a team" })).toBeTruthy();
  });

  it("wears the attention tone: the amber pill with the exclamation icon, hidden from the name", () => {
    renderControl();
    const button = screen.getByRole("button", { name: LABEL });
    for (const cls of SET_ROW_ACTION_TONE_CLASSES.attention.split(" ")) {
      expect(button.classList.contains(cls)).toBe(true);
    }
    expect(button.classList.contains("border-slate-500")).toBe(false);
    const icon = button.querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  it("previews and fills the SET it was handed, whatever checklist it sits on", async () => {
    mockPreview.mockResolvedValue(makePreview());
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: LABEL }));
    await screen.findByRole("dialog");
    expect(mockPreview).toHaveBeenCalledWith({ selectorOptionId: SET_ID });
  });

  it("Enter on the focused trigger starts the check, as a click does (maestro pressKey)", async () => {
    mockPreview.mockResolvedValue(makePreview());
    renderControl();
    fireEvent.keyDown(screen.getByRole("button", { name: LABEL }), { key: "Enter" });
    await screen.findByRole("dialog");
    expect(mockPreview).toHaveBeenCalledTimes(1);
  });

  it("stays up, still naming what was pressed, while its dialog is open and the live count falls to 0", async () => {
    mockPreview.mockResolvedValue(makePreview());
    mockApply.mockResolvedValue({
      applied: 14,
      skipped: 0,
      byRule: { samePlayerInSet: 14, oneTeamCareer: 0, oneStintInYear: 0 },
    });
    const onActiveChange = vi.fn();
    const showToast = vi.fn();
    const { rerender, container } = render(
      <FillTeamsControl
        setId={SET_ID}
        missingCount={MISSING}
        showToast={showToast}
        onActiveChange={onActiveChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: LABEL }));
    await screen.findByRole("dialog");
    expect(onActiveChange).toHaveBeenLastCalledWith(true);

    // The fill (or a teammate's) empties the lane under the open dialog.
    rerender(
      <FillTeamsControl
        setId={SET_ID}
        missingCount={0}
        showToast={showToast}
        onActiveChange={onActiveChange}
      />,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    const trigger = container.querySelector("#fill-teams");
    expect(trigger?.textContent).toBe(LABEL);
    // Out of reach behind the aria-modal dialog.
    expect(trigger?.hasAttribute("inert")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Yes, fill" }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Filled teams on 14 cards"));
    // Done, and nothing left to fill: the window closes and the trigger goes.
    await waitFor(() => expect(onActiveChange).toHaveBeenLastCalledWith(false));
    expect(container.innerHTML).toBe("");
  });

  it("hands focus back to the trigger when the dialog is cancelled", async () => {
    mockPreview.mockResolvedValue(makePreview());
    renderControl();
    const trigger = screen.getByRole("button", { name: LABEL });
    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger.hasAttribute("inert")).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("is idle at first: the trigger is named by its text, not an aria-label, and carries the tooltip", () => {
    renderControl();
    const button = screen.getByRole("button", { name: LABEL });
    expect(button).toBeTruthy();
    expect(button.getAttribute("aria-label")).toBeNull();
    expect(button.textContent).toBe(LABEL);
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.getAttribute("title")).toBe(FILL_TEAMS_TOOLTIP);
  });

  it("while a preview is in flight the accessible name becomes Checking…, with aria-busy and aria-disabled, and a second click is ignored", async () => {
    let resolvePreview!: (value: TeamFillPreview) => void;
    mockPreview.mockReturnValue(
      new Promise<TeamFillPreview>((resolve) => {
        resolvePreview = resolve;
      }),
    );
    renderControl();

    const button = screen.getByRole("button", { name: LABEL });
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: FILL_TEAMS_CHECKING_LABEL })).toBe(button),
    );
    // The idle name is gone for the duration — the state IS the name.
    expect(screen.queryByRole("button", { name: LABEL })).toBeNull();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-busy")).toBe("true");

    fireEvent.click(button); // ignored — still checking
    expect(mockPreview).toHaveBeenCalledTimes(1);

    resolvePreview(makePreview({ fillable: 0, candidates: 0, remaining: 0 }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: LABEL })).toBe(button),
    );
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.getAttribute("aria-disabled")).toBeNull();
  });

  it("zero fillable with leftovers: toasts the your-call form and opens no dialog", async () => {
    mockPreview.mockResolvedValue(
      makePreview({ fillable: 0, candidates: 3, remaining: 3, groups: [], groupsTotal: 0 }),
    );
    const showToast = vi.fn();
    renderControl(showToast);

    fireEvent.click(screen.getByRole("button", { name: LABEL }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "Nothing to fill — 3 cards still need a team, and they're your call. Use “Fix them one at a time” to choose.",
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("zero fillable with nothing left at all: toasts the every-card form", async () => {
    mockPreview.mockResolvedValue(
      makePreview({ fillable: 0, candidates: 0, remaining: 0, groups: [], groupsTotal: 0 }),
    );
    const showToast = vi.fn();
    renderControl(showToast);

    fireEvent.click(screen.getByRole("button", { name: LABEL }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("Nothing to fill — every card here has its team."),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("NEO-330: zero fillable with only listing conflicts toasts the reason and opens no dialog", async () => {
    mockPreview.mockResolvedValue(
      makePreview({
        fillable: 0,
        candidates: 2,
        remaining: 0,
        groups: [],
        groupsTotal: 0,
        conflicts: 2,
        conflictCards: [FOXX_34, { ...FOXX_34, cardNumber: "35" }],
      }),
    );
    const showToast = vi.fn();
    renderControl(showToast);

    fireEvent.click(screen.getByRole("button", { name: LABEL }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "Nothing to fill — 2 cards still need a team, and they're your call (2 where the listing disagrees). Use “Fix them one at a time” to choose.",
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("NEO-330: lists the skipped cards FIRST, under their own labelled heading, in a group named for both", async () => {
    mockPreview.mockResolvedValue(
      makePreview({ conflicts: 3, conflictCards: [FOXX_34, { ...FOXX_34, cardNumber: "35" }] }),
    );
    renderControl();

    fireEvent.click(screen.getByRole("button", { name: LABEL }));
    const dialog = await screen.findByRole("dialog");
    // The count is the server's total, not the length of the capped list.
    expect(dialog.textContent).toContain(
      "3 cards skipped — the listing names a different team. Your call.",
    );
    expect(FILL_TEAMS_CONFLICTS_HEADING).toBe("Skipped — the listing names a different team");
    const list = screen.getByRole("list", { name: FILL_TEAMS_CONFLICTS_HEADING });
    expect(Array.from(list.querySelectorAll("li")).map((li) => li.textContent)).toEqual([
      "#34 Jimmie Foxx· 3X MVP· Listing: Philadelphia Athletics· Fill: Boston Red Sox (from #36)",
      "#35 Jimmie Foxx· 3X MVP· Listing: Philadelphia Athletics· Fill: Boston Red Sox (from #36)",
      "…and 1 more",
    ]);
    // a11y: the skipped block sits ABOVE the ledger, and the group's name is
    // true of both.
    const group = screen.getByRole("group", { name: FILL_TEAMS_LIST_LABEL_WITH_SKIPS });
    const ledgerRow = within(group).getByText("Johnny Bench");
    expect(
      list.compareDocumentPosition(ledgerRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByRole("group", { name: FILL_TEAMS_LIST_LABEL })).toBeNull();
    expect(dialog.textContent).not.toMatch(/BSC|this set says/);
    // The marketplace string is text, never a link or a tooltip.
    expect(list.querySelector("a")).toBeNull();
    expect(list.querySelector("[title]")).toBeNull();
  });

  it("NEO-330: no conflict section when the listing agrees with every fill, and the group keeps its E2E name", async () => {
    mockPreview.mockResolvedValue(makePreview());
    renderControl();

    fireEvent.click(screen.getByRole("button", { name: LABEL }));
    await screen.findByRole("dialog");
    expect(screen.queryByText(FILL_TEAMS_CONFLICTS_HEADING)).toBeNull();
    // set-fill-teams-from-teammate-card.yaml finds the group by this name.
    expect(screen.getByRole("group", { name: FILL_TEAMS_LIST_LABEL })).toBeTruthy();
  });

  it("opens the dialog with the preview's title, body and ledger rows", async () => {
    mockPreview.mockResolvedValue(makePreview());
    renderControl();

    fireEvent.click(screen.getByRole("button", { name: LABEL }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Fill teams on 14 cards?");
    expect(dialog.textContent).toContain("Johnny Bench");
    expect(dialog.textContent).toContain("Cincinnati Reds");
    expect(screen.getByLabelText(FILL_TEAMS_LIST_LABEL)).toBeTruthy();
  });

  it("renders the ledger in the server's order and names the nodes of a base-card or career fill", async () => {
    mockPreview.mockResolvedValue(
      makePreview({
        groups: [
          makeGroup({
            playerNames: ["Yogi Berra"],
            teamNames: ["New York Yankees"],
            rule: "oneTeamCareer",
            scope: "career",
            nodeNames: ["Legends"],
            cardCount: 1,
          }),
          makeGroup({
            playerNames: ["Bench", "Rose"],
            teamNames: ["Reds", "Phillies"],
            rule: "oneTeamCareer",
            scope: "career",
            mixed: true,
            nodeNames: ["Leaders"],
            cardCount: 1,
          }),
          makeGroup({
            playerNames: ["Johnny Bench"],
            teamNames: ["Cincinnati Reds"],
            scope: "baseSet",
            nodeNames: ["Stars", "Gold"],
            nodeCount: 5,
            cardCount: 4,
          }),
          makeGroup({ playerNames: ["Tony Gwynn"], teamNames: ["San Diego Padres"], cardCount: 9 }),
          makeGroup({
            playerNames: ["Tony Gwynn"],
            teamNames: ["San Diego Padres"],
            scope: "parallelOf",
            nodeNames: ["Gold"],
            cardCount: 2,
          }),
        ],
        groupsTotal: 5,
      }),
    );
    renderControl();

    fireEvent.click(screen.getByRole("button", { name: LABEL }));
    await screen.findByRole("dialog");
    const rows = screen
      .getByLabelText(FILL_TEAMS_LIST_LABEL)
      .querySelectorAll("li");
    expect(Array.from(rows).map((row) => row.textContent)).toEqual([
      "Yogi Berra→New York Yankees· 1 card · only team on file · Legends",
      "Bench & Rose→Reds / Phillies· 1 card · each player's own team · Leaders",
      "Johnny Bench→Cincinnati Reds· 4 cards · the base card · Stars, Gold +3 more",
      "Tony Gwynn→San Diego Padres· 9 cards · same player in this set",
      "Tony Gwynn→San Diego Padres· 2 cards · the card it parallels",
    ]);
  });

  it("shows the overflow line when groupsTotal exceeds the returned groups", async () => {
    mockPreview.mockResolvedValue(makePreview({ groupsTotal: 205 }));
    renderControl();

    fireEvent.click(screen.getByRole("button", { name: LABEL }));
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

    fireEvent.click(screen.getByRole("button", { name: LABEL }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Yes, fill" }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("Filled teams on 14 cards"),
    );
    expect(mockApply).toHaveBeenCalledTimes(1);
    // The preview's fillable goes back as the number the operator said yes to.
    expect(mockApply).toHaveBeenCalledWith({
      selectorOptionId: SET_ID,
      expectedFillable: 14,
    });
    // The dialog closes on success.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("toasts the skipped clause when the server reports skips", async () => {
    mockPreview.mockResolvedValue(makePreview());
    mockApply.mockResolvedValue({
      applied: 12,
      skipped: 2,
      byRule: { samePlayerInSet: 12, oneTeamCareer: 0, oneStintInYear: 0 },
    });
    const showToast = vi.fn();
    renderControl(showToast);

    fireEvent.click(screen.getByRole("button", { name: LABEL }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Yes, fill" }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "Filled teams on 12 cards · 2 skipped, someone got there first",
      ),
    );
  });

  it("the server's drift refusal lands inside the dialog, and nothing is toasted", async () => {
    mockPreview.mockResolvedValue(makePreview());
    mockApply.mockRejectedValue(
      new ConvexError("The set changed since the preview — check again."),
    );
    const showToast = vi.fn();
    renderControl(showToast);

    fireEvent.click(screen.getByRole("button", { name: LABEL }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Yes, fill" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "The set changed since the preview — check again.",
      ),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(showToast).not.toHaveBeenCalled();

    // Cancel is the way out; re-checking is a fresh preview.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: LABEL }));
    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(2));
  });

  it("a non-ConvexError from apply shows the fill fallback inside the dialog", async () => {
    mockPreview.mockResolvedValue(makePreview());
    mockApply.mockRejectedValue(new Error("network blew up"));
    renderControl();

    fireEvent.click(screen.getByRole("button", { name: LABEL }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Yes, fill" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(FILL_FAILED_FALLBACK),
    );
    expect(FILL_FAILED_FALLBACK).toBe("Could not fill teams. Nothing changed.");
  });

  it("an apply error stays inside the dialog rather than closing it", async () => {
    mockPreview.mockResolvedValue(makePreview());
    mockApply.mockRejectedValue(new ConvexError("Something changed underneath you."));
    renderControl();

    fireEvent.click(screen.getByRole("button", { name: LABEL }));
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

    fireEvent.click(screen.getByRole("button", { name: LABEL }));
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

    fireEvent.click(screen.getByRole("button", { name: LABEL }));
    await waitFor(() =>
      // Structurally an error — the owner's notice becomes role="alert".
      expect(showToast).toHaveBeenCalledWith(
        "Failed: Fill teams from the set row, not a variant or parallel.",
        "error",
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a non-ConvexError from preview toasts the generic fallback", async () => {
    mockPreview.mockRejectedValue(new Error("network blew up"));
    const showToast = vi.fn();
    renderControl(showToast);

    fireEvent.click(screen.getByRole("button", { name: LABEL }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(`Failed: ${CHECK_FAILED_FALLBACK}`, "error"),
    );
    expect(CHECK_FAILED_FALLBACK).toBe("Could not check the cards. Nothing changed.");
  });
});

/**
 * NEO-321 — the "Parallels of Base" section: copy helpers, the disabled
 * states (aria-disabled + the reason line as the button's description), the
 * D4 confirm, and the start through the hosted runner.
 *
 * The runner is a stub (`ParallelBuildRunner`), so what is asserted is the
 * section's own contract: which row it hands `start` (the Parallel variant
 * type, never the source), when it asks first, and when it holds. The runner
 * itself is covered by ParallelBuildPanel.test.tsx; visibility on the page is
 * covered by modules/SetSelector.baseParallels.test.tsx.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    parallelChecklistBuild: {
      getParallelsForBuild: "getParallelsForBuild",
      buildParallelChecklist: "buildParallelChecklist",
    },
  },
}));

const mockConvex = { query: vi.fn(), action: vi.fn() };
vi.mock("convex/react", () => ({
  useConvex: () => mockConvex,
  useQuery: vi.fn(),
  useAction: () => vi.fn(),
}));

import BaseParallelsBuildSection, {
  CONFIRM_LABEL,
  LOADING_TEXT,
  NO_PARALLELS_TEXT,
  BASE_PARALLELS_REASON_ID,
  NO_SOURCE_TEXT,
  OTHER_RUN_TEXT,
  attentionText,
  buildAllLabel,
  noSourceText,
  replaceConfirmCopy,
  sectionHeading,
  sourceEmptyText,
  summaryText,
  tallyParallels,
} from "./BaseParallelsBuildSection";
import {
  PARALLEL_BUILD_HEADING_ID,
  moreText,
  planFailedText,
  truncatedText,
  type ParallelBuildPlan,
  type ParallelBuildRunner,
  type ParallelPlanEntry,
  type ParallelRun,
} from "./ParallelBuildPanel";

const TYPE_ID = "vt-parallel" as unknown as Id<"selectorOptions">;
const SOURCE_ID = "vt-base" as unknown as Id<"selectorOptions">;

const entry = (
  n: number,
  over: Partial<ParallelPlanEntry> = {},
): ParallelPlanEntry => ({
  _id: `p-${n}` as unknown as Id<"selectorOptions">,
  value: `Parallel ${n}`,
  sides: { bsc: true, sportlots: false },
  hasCards: false,
  ...over,
});

const planOf = (
  parallels: ParallelPlanEntry[],
  over: Partial<ParallelBuildPlan> = {},
): ParallelBuildPlan => ({
  parallels,
  truncated: false,
  source: { id: SOURCE_ID, value: "Base", kind: "base", hasCards: true },
  ...over,
});

function runnerStub(over: Partial<ParallelBuildRunner> = {}): ParallelBuildRunner {
  return {
    run: null,
    active: false,
    inFlight: new Set(),
    start: vi.fn().mockResolvedValue(null),
    stop: vi.fn(),
    buildOne: vi.fn(),
    ...over,
  };
}

function renderSection(
  plan: ParallelBuildPlan | undefined,
  runner = runnerStub(),
  showsRun = false,
) {
  const view = render(
    <BaseParallelsBuildSection
      variantTypeId={TYPE_ID}
      plan={plan}
      runner={runner}
      showsRun={showsRun}
    />,
  );
  return { runner, ...view };
}

const button = () => screen.getByRole("button", { name: /^Build / });

/** The element the button's aria-describedby points at. */
function description(el: HTMLElement) {
  const id = el.getAttribute("aria-describedby");
  return id ? document.getElementById(id) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BaseParallelsBuildSection — copy helpers", () => {
  it("names the source in the heading, with a neutral fallback before it is known", () => {
    expect(sectionHeading("Base")).toBe("Parallels of Base");
    expect(sectionHeading(undefined)).toBe("Parallels of the base set");
  });

  it("button label counts parallels, singular for one", () => {
    expect(buildAllLabel("Base", 12)).toBe("Build 12 parallels from Base");
    expect(buildAllLabel("Base", 1)).toBe("Build 1 parallel from Base");
  });

  it("button label carries no count until the list is in", () => {
    expect(buildAllLabel("Base", undefined)).toBe("Build parallels from Base");
    expect(buildAllLabel(undefined, undefined)).toBe(
      "Build parallels from the base set",
    );
  });

  it("noSourceText uses the server's reason when it gave one, a fixed sentence otherwise", () => {
    expect(noSourceText("two variant types are marked as the base")).toBe(
      "Nothing to copy from — two variant types are marked as the base.",
    );
    expect(noSourceText()).toBe(NO_SOURCE_TEXT);
  });

  it("sourceEmptyText names the source", () => {
    expect(sourceEmptyText("Base")).toBe(
      "Base has no cards yet — save its checklist first.",
    );
  });

  describe("tallyParallels", () => {
    it("counts only buildable (linked, not blocked) parallels toward replaced and filled", () => {
      const tally = tallyParallels([
        entry(1, { hasCards: true }), // replaced
        entry(2), // filled
        entry(3, { hasCards: true, sides: { bsc: false, sportlots: false } }), // unlinked, has cards
        entry(4, { hasCards: true, blocked: "scans" }), // blocked, has cards
        entry(5, { sides: { bsc: false, sportlots: true } }), // filled via SportLots only
      ]);
      expect(tally).toEqual({
        total: 5,
        withCards: 3,
        replaced: 1,
        filled: 2,
        unlinked: 1,
        blocked: 1,
      });
    });
  });

  describe("summaryText", () => {
    const tally = (over = {}) => ({
      total: 1,
      withCards: 0,
      replaced: 0,
      filled: 0,
      unlinked: 0,
      blocked: 0,
      ...over,
    });

    it("says all empty, singular for one", () => {
      expect(summaryText(tally())).toBe("1 parallel, all empty.");
      expect(summaryText(tally({ total: 3 }))).toBe("3 parallels, all empty.");
    });

    it("says all with cards", () => {
      expect(summaryText(tally({ total: 2, withCards: 2 }))).toBe(
        "2 parallels, all with cards.",
      );
      expect(summaryText(tally({ total: 1, withCards: 1 }))).toBe(
        "1 parallel, all with cards.",
      );
    });

    it("splits a mixed list into empty and with-cards", () => {
      expect(summaryText(tally({ total: 12, withCards: 3 }))).toBe(
        "12 parallels: 9 empty, 3 with cards.",
      );
    });

    it("adds the unlinked and blocked sentences only when true, singular and plural", () => {
      expect(summaryText(tally({ total: 4, unlinked: 1, blocked: 1 }))).toBe(
        "4 parallels, all empty. 1 isn't linked to a marketplace yet and gets skipped. 1 is blocked.",
      );
      expect(summaryText(tally({ total: 5, unlinked: 2, blocked: 3 }))).toBe(
        "5 parallels, all empty. 2 aren't linked to a marketplace yet and get skipped. 3 are blocked.",
      );
    });
  });

  describe("replaceConfirmCopy", () => {
    const tally = (over = {}) => ({
      total: 4,
      withCards: 2,
      replaced: 2,
      filled: 2,
      unlinked: 0,
      blocked: 0,
      ...over,
    });

    it("names K of N in the title and says 'those parallels' for several", () => {
      const { title, description } = replaceConfirmCopy("Base", tally());
      expect(title).toContain("Replace the cards on 2 of 4 parallels");
      expect(description).toContain("Every card on those parallels");
      expect(description).toContain("The 2 empty ones just get filled.");
    });

    it("uses singular forms for one replaced and one empty", () => {
      const { title, description } = replaceConfirmCopy(
        "Base",
        tally({ total: 2, replaced: 1, filled: 1 }),
      );
      expect(title).toContain("Replace the cards on 1 of 2 parallels");
      expect(description).toContain("Every card on that parallel");
      expect(description).toContain("The empty one just gets filled.");
    });

    it("omits the filled sentence when nothing is empty, and says 1 parallel for a single-parallel list", () => {
      const { title, description } = replaceConfirmCopy(
        "Base",
        tally({ total: 1, replaced: 1, filled: 0 }),
      );
      expect(title).toContain("1 of 1 parallel with");
      expect(description).not.toContain("empty");
    });
  });
});

describe("BaseParallelsBuildSection — what the operator sees", () => {
  it("shows the heading, the summary and the explainer once the plan is in", () => {
    renderSection(planOf([entry(1, { hasCards: true }), entry(2)]));
    expect(
      screen.getByRole("heading", { name: "Parallels of Base" }),
    ).toBeTruthy();
    expect(screen.getByText(/2 parallels: 1 empty, 1 with cards\./)).toBeTruthy();
    expect(screen.getByText(/Each one gets a fresh copy of Base/)).toBeTruthy();
    expect(button().textContent).toBe("Build 2 parallels from Base");
  });

  it("the heading and button follow the server's source name, so a renamed Base reads the same way", () => {
    renderSection(
      planOf([entry(1)], {
        source: {
          id: SOURCE_ID,
          value: "Flagship",
          kind: "base",
          hasCards: true,
        },
      }),
    );
    expect(
      screen.getByRole("heading", { name: "Parallels of Flagship" }),
    ).toBeTruthy();
    expect(button().textContent).toBe("Build 1 parallel from Flagship");
  });
});

describe("BaseParallelsBuildSection — disabled states", () => {
  /**
   * Every held state: aria-disabled, never native `disabled` (so the reason
   * stays reachable and focus stays put), the reason line is the button's
   * description, and neither a click nor Enter starts anything.
   */
  function expectHeld(reasonText: string, runner: ParallelBuildRunner) {
    const b = button();
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect((b as HTMLButtonElement).disabled).toBe(false);
    expect(description(b)?.textContent).toBe(reasonText);

    fireEvent.click(b);
    fireEvent.keyDown(b, { key: "Enter" });
    expect(runner.start).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  }

  it("while the plan is loading: held, described by the counting line", () => {
    const { runner } = renderSection(undefined);
    expectHeld(LOADING_TEXT, runner);
  });

  it("when the server found no single source: held, with the server's reason", () => {
    const { runner } = renderSection(
      planOf([], {
        source: null,
        sourceBlocked: "two variant types are marked as the base",
      }),
    );
    expectHeld(
      "Nothing to copy from — two variant types are marked as the base.",
      runner,
    );
  });

  it("when there is no source and no reason: held, with the fixed sentence", () => {
    const { runner } = renderSection(planOf([entry(1)], { source: null }));
    expectHeld(NO_SOURCE_TEXT, runner);
  });

  it("when the source has no cards: held, even though parallels exist", () => {
    const { runner } = renderSection(
      planOf([entry(1)], {
        source: { id: SOURCE_ID, value: "Base", kind: "base", hasCards: false },
      }),
    );
    expectHeld("Base has no cards yet — save its checklist first.", runner);
  });

  it("when the list is empty: held, pointing at sync or add", () => {
    const { runner } = renderSection(planOf([]));
    expectHeld(NO_PARALLELS_TEXT, runner);
  });

  it("while another run is live: held, described by the other-run line", () => {
    const { runner } = renderSection(
      planOf([entry(1)]),
      runnerStub({ active: true }),
      false,
    );
    expectHeld(OTHER_RUN_TEXT, runner);
  });

  it("while its own run is live: held and described by the ledger heading, with no reason line", () => {
    const run: ParallelRun = {
      startedFrom: TYPE_ID,
      sourceId: SOURCE_ID,
      sourceValue: "Base",
      sourceKind: "base",
      entries: [
        { id: entry(1)._id, value: "Parallel 1", line: { kind: "building" } },
      ],
      truncated: false,
      phase: "running",
      atIndex: 0,
      announcement: "",
    };
    const runner = runnerStub({ run, active: true });
    renderSection(planOf([entry(1)]), runner, true);

    const b = button();
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect(b.getAttribute("aria-describedby")).toBe(PARALLEL_BUILD_HEADING_ID);
    expect(document.getElementById(PARALLEL_BUILD_HEADING_ID)).toBeTruthy();
    expect(screen.queryByText(OTHER_RUN_TEXT)).toBeNull();

    fireEvent.click(b);
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("is not held when everything is in place", () => {
    renderSection(planOf([entry(1)]));
    const b = button();
    expect(b.getAttribute("aria-disabled")).toBeNull();
    expect(b.getAttribute("aria-describedby")).toBeNull();
  });
});

describe("BaseParallelsBuildSection — starting the run", () => {
  it("starts through the runner with the Parallel variant type as the start row, over empty parallels, with no confirm", () => {
    const { runner } = renderSection(planOf([entry(1), entry(2)]));
    fireEvent.click(button());

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(runner.start).toHaveBeenCalledTimes(1);
    // The row it stands on (the variant type), carrying the SOURCE's name —
    // not the source's id, which the server resolves itself.
    expect(runner.start).toHaveBeenCalledWith(
      { id: TYPE_ID, value: "Base" },
      mockConvex,
    );
  });

  it("Enter on the focused button starts it too", () => {
    const { runner } = renderSection(planOf([entry(1)]));
    fireEvent.keyDown(button(), { key: "Enter" });
    expect(runner.start).toHaveBeenCalledTimes(1);
  });

  it("says so in an alert when the list could not be read", async () => {
    const runner = runnerStub({
      start: vi.fn().mockResolvedValue("network down"),
    });
    renderSection(planOf([entry(1)]), runner);
    fireEvent.click(button());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(planFailedText("network down"));
  });

  it("shows no alert when the run starts cleanly", async () => {
    const { runner } = renderSection(planOf([entry(1)]));
    fireEvent.click(button());
    await waitFor(() => expect(runner.start).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("BaseParallelsBuildSection — D4 confirm", () => {
  it("asks first when K > 0 buildable parallels already have cards, and starts nothing yet", () => {
    const { runner } = renderSection(
      planOf([entry(1, { hasCards: true }), entry(2, { hasCards: true }), entry(3)]),
    );
    expect(button().getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(button());

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Replace the cards on 2 of 3 parallels");
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("does not ask when every parallel is empty", () => {
    const { runner } = renderSection(planOf([entry(1), entry(2)]));
    expect(button().getAttribute("aria-haspopup")).toBeNull();
    fireEvent.click(button());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(runner.start).toHaveBeenCalledTimes(1);
  });

  it("does not ask when the only parallels with cards are ones the run would skip or refuse", () => {
    // K counts what a run would REPLACE: an unlinked parallel is skipped and a
    // blocked one is refused, so neither loses anything.
    const { runner } = renderSection(
      planOf([
        entry(1),
        entry(2, { hasCards: true, sides: { bsc: false, sportlots: false } }),
        entry(3, { hasCards: true, blocked: "scans" }),
      ]),
    );
    fireEvent.click(button());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(runner.start).toHaveBeenCalledTimes(1);
  });

  it("Cancel closes it without starting, and puts focus back on the button", async () => {
    const { runner } = renderSection(planOf([entry(1, { hasCards: true })]));
    const trigger = button();
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(runner.start).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(button()));
  });

  it("Escape cancels without starting", () => {
    const { runner } = renderSection(planOf([entry(1, { hasCards: true })]));
    fireEvent.click(button());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("Confirm starts the run through the runner with the variant type as the start row", async () => {
    const { runner } = renderSection(planOf([entry(1, { hasCards: true })]));
    fireEvent.click(button());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: CONFIRM_LABEL }));
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(runner.start).toHaveBeenCalledTimes(1);
    expect(runner.start).toHaveBeenCalledWith(
      { id: TYPE_ID, value: "Base" },
      mockConvex,
    );
  });
});

const UNLINKED = { bsc: false, sportlots: false };

describe("BaseParallelsBuildSection — the attention list", () => {
  const items = () => screen.queryAllByRole("listitem").map((li) => li.textContent);

  it("attentionText names a blocked parallel with the server's reason", () => {
    expect(attentionText(entry(1, { blocked: "some cards have scans" }))).toBe(
      "Parallel 1 — blocked: some cards have scans",
    );
  });

  it("attentionText names an unlinked parallel as skipped", () => {
    expect(attentionText(entry(2, { sides: UNLINKED }))).toBe(
      "Parallel 2 — skipped: not linked to a marketplace yet",
    );
  });

  it("attentionText is null for a parallel the run will build, and blocked wins over unlinked", () => {
    expect(attentionText(entry(3))).toBeNull();
    expect(attentionText(entry(4, { sides: UNLINKED, blocked: "scans" }))).toBe(
      "Parallel 4 — blocked: scans",
    );
  });

  it("lists one line per blocked or unlinked parallel, with the reason, and none for the rest", () => {
    renderSection(
      planOf([
        entry(1),
        entry(2, { blocked: "scans" }),
        entry(3, { sides: UNLINKED }),
        entry(4, { hasCards: true }),
      ]),
    );
    expect(items()).toEqual([
      "Parallel 2 — blocked: scans",
      "Parallel 3 — skipped: not linked to a marketplace yet",
    ]);
  });

  it("is absent when nothing is blocked or unlinked", () => {
    renderSection(planOf([entry(1), entry(2, { hasCards: true })]));
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("shows all of them at exactly 10, with no overflow line", () => {
    renderSection(planOf(Array.from({ length: 10 }, (_, i) => entry(i + 1, { sides: UNLINKED }))));
    expect(items()).toHaveLength(10);
    expect(screen.queryByText(/…and \d+ more/)).toBeNull();
  });

  it("caps at 10 lines and says how many more", () => {
    renderSection(planOf(Array.from({ length: 13 }, (_, i) => entry(i + 1, { sides: UNLINKED }))));
    const lines = items();
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe("Parallel 1 — skipped: not linked to a marketplace yet");
    expect(lines[9]).toBe("Parallel 10 — skipped: not linked to a marketplace yet");
    expect(lines[10]).toBe(moreText(3));
  });
});

describe("BaseParallelsBuildSection — truncated list", () => {
  it("appends the truncated sentence to the summary when the plan is truncated", () => {
    renderSection(planOf([entry(1), entry(2)], { truncated: true }));
    expect(screen.getByText(new RegExp(truncatedText(2).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeTruthy();
  });

  it("says nothing about truncation otherwise", () => {
    renderSection(planOf([entry(1), entry(2)]));
    expect(screen.queryByText(/Only the first/)).toBeNull();
  });
});

describe("BaseParallelsBuildSection — outline and reason id", () => {
  it("nests the run's heading one level under the section's own h3", () => {
    const run: ParallelRun = {
      startedFrom: TYPE_ID,
      sourceId: SOURCE_ID,
      sourceValue: "Base",
      sourceKind: "base",
      entries: [{ id: entry(1)._id, value: "Parallel 1", line: { kind: "building" } }],
      truncated: false,
      phase: "running",
      atIndex: 0,
      announcement: "",
    };
    renderSection(planOf([entry(1)]), runnerStub({ run, active: true }), true);
    expect(screen.getByRole("heading", { level: 3, name: "Parallels of Base" })).toBeTruthy();
    const nested = document.getElementById(PARALLEL_BUILD_HEADING_ID)!;
    expect(nested.tagName).toBe("H4");
  });

  it("the reason line carries the exported id the base-parallel rows point at", () => {
    renderSection(planOf([], { source: null, sourceBlocked: "no base" }));
    expect(document.getElementById(BASE_PARALLELS_REASON_ID)?.textContent).toBe(
      noSourceText("no base"),
    );
  });
});

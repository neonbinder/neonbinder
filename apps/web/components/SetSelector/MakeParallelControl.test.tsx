/**
 * NEO-305 — "Make parallel of…": when the row action shows, what the dialog
 * preselects, what it sends, where it sends the operator after, and that a
 * refusal lands inside the dialog.
 *
 * `convex/react` is module-mocked and routed by the (string) query reference,
 * the house pattern for these components (`MoveSetToBrandControl.test.tsx`).
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    setParallelConversion: {
      getSetToParallelEligibility: "eligibility",
      getSetToParallelTargets: "targets",
      getSetToParallelTargetDetail: "detail",
      convertSetToParallel: "convert",
    },
  },
}));

let eligibility: unknown;
let targets: unknown;
let details: Record<string, unknown>;
const mockConvert = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (ref === "eligibility") return eligibility;
    if (ref === "targets") return targets;
    if (ref === "detail") {
      return details[(args as { targetSetId: string }).targetSetId];
    }
    return undefined;
  },
  useMutation: (ref: string) => (ref === "convert" ? mockConvert : vi.fn()),
}));

import MakeParallelControl, { MAKE_PARALLEL_LABEL, makeParallelCopy } from "./MakeParallelControl";

const SET_ID = "set-bowman-blue" as never;

function bowmanDetail(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    targetSetValue: "Bowman",
    parallelTypeId: "pt-bowman",
    parallelTypeValue: "Parallel",
    parallels: [
      { _id: "p-blue", value: "Blue", holdsLink: false },
      { _id: "p-gold", value: "Gold", holdsLink: false },
    ],
    newName: "Fuchsia",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  eligibility = { eligible: true };
  targets = {
    ok: true,
    setValue: "Bowman Fuchsia",
    brandValue: "Bowman",
    cardCount: 3,
    targets: [
      { setId: "s-bowman", value: "Bowman", parallelTypeId: "pt-bowman", parallelTypeValue: "Parallel" },
      { setId: "s-chrome", value: "Bowman Chrome", parallelTypeId: "pt-chrome", parallelTypeValue: "Parallel" },
      { setId: "s-sapphire", value: "Bowman Sapphire Edition" },
    ],
    suggestedSetId: "s-bowman",
    truncated: false,
  };
  details = {
    "s-bowman": bowmanDetail(),
    "s-chrome": {
      ...bowmanDetail({ targetSetValue: "Bowman Chrome", parallelTypeId: "pt-chrome" }),
      parallels: [],
      newName: "Fuchsia",
    },
  };
  mockConvert.mockResolvedValue({
    targetSetId: "s-bowman",
    parallelTypeId: "pt-bowman",
    parallelId: "p-new",
    parallelValue: "Fuchsia",
    targetSetValue: "Bowman",
    created: true,
  });
});

function renderControl() {
  const showToast = vi.fn();
  const onReshaped = vi.fn();
  render(
    <MakeParallelControl
      setId={SET_ID}
      setValue="Bowman Fuchsia"
      showToast={showToast}
      onReshaped={onReshaped}
    />,
  );
  return { showToast, onReshaped };
}

describe("MakeParallelControl — when it shows", () => {
  it("shows when the server says the set could become a parallel", () => {
    renderControl();
    expect(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL })).toBeTruthy();
  });

  it.each([
    ["the server says no", { eligible: false }],
    ["the answer has not arrived", undefined],
  ])("renders nothing when %s", (_why, answer) => {
    eligibility = answer;
    const { container } = render(
      <MakeParallelControl setId={SET_ID} setValue="Bowman" showToast={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("carries no aria-label, so its visible text is its name", () => {
    renderControl();
    expect(
      screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }).getAttribute("aria-label"),
    ).toBeNull();
  });
});

describe("MakeParallelControl — the dialog", () => {
  it("opens on the suggested set, preselects a new parallel and previews where it lands", async () => {
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));

    const dialog = screen.getByRole("dialog", { name: makeParallelCopy.title("Bowman Fuchsia") });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const bowman = screen.getByRole("button", { name: "Parallel of Bowman" });
    expect(bowman.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(bowman));
    // A set with no Parallel type yet is listed but cannot be picked.
    expect(
      screen.getByRole("button", { name: "Parallel of Bowman Sapphire Edition" }).getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: makeParallelCopy.newChoice("Fuchsia") }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(dialog.textContent).toContain("Bowman›, Parallel›, Fuchsianew");
  });

  it("makes a new parallel, then reports and drills to it", async () => {
    const { showToast, onReshaped } = renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: makeParallelCopy.confirm }));
    });
    expect(mockConvert).toHaveBeenCalledWith({
      setId: SET_ID,
      targetParallelTypeId: "pt-bowman",
    });
    expect(showToast).toHaveBeenCalledWith(
      makeParallelCopy.done("Bowman Fuchsia", "Bowman", "Fuchsia", true),
    );
    expect(onReshaped).toHaveBeenCalledWith([
      { _id: "s-bowman", level: "setName" },
      { _id: "pt-bowman", level: "variantType" },
      { _id: "p-new", level: "insert" },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("adds to an existing parallel when the operator picks one", async () => {
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));
    fireEvent.click(screen.getByRole("button", { name: "Add to Gold" }));
    expect(screen.getByRole("dialog").textContent).toContain("Goldjoins");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: makeParallelCopy.confirm }));
    });
    expect(mockConvert).toHaveBeenCalledWith({
      setId: SET_ID,
      targetParallelTypeId: "pt-bowman",
      attachToId: "p-gold",
    });
  });

  it("when a new parallel's name is taken, preselects the one to add to and says why", () => {
    details["s-bowman"] = bowmanDetail({
      newName: undefined,
      newRefusal: "Bowman already has a “Blue” parallel. Add it to that one instead.",
      sameAsId: "p-blue",
    });
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));
    expect(screen.getByRole("button", { name: "Add to Blue" }).getAttribute("aria-pressed")).toBe("true");
    const unavailable = screen.getByRole("button", { name: makeParallelCopy.newChoiceUnavailable });
    expect(unavailable.getAttribute("aria-disabled")).toBe("true");
    expect(unavailable.getAttribute("title")).toContain("already has a “Blue” parallel");
  });

  it("a parallel already holding the link cannot be picked, and nothing valid means no confirm", async () => {
    details["s-bowman"] = bowmanDetail({
      newName: undefined,
      newRefusal: "linked",
      parallels: [{ _id: "p-blue", value: "Blue", holdsLink: true }],
      holdsLinkReason: "“Blue” under Bowman already has this SportLots link.",
    });
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));
    fireEvent.click(screen.getByRole("button", { name: "Add to Blue" }));
    const confirm = screen.getByRole("button", { name: makeParallelCopy.confirm });
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it("switching the target set re-reads its parallels and resets the choice", () => {
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));
    fireEvent.click(screen.getByRole("button", { name: "Add to Gold" }));
    fireEvent.click(screen.getByRole("button", { name: "Parallel of Bowman Chrome" }));
    expect(screen.queryByRole("button", { name: "Add to Gold" })).toBeNull();
    expect(
      screen.getByRole("button", { name: makeParallelCopy.newChoice("Fuchsia") }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("a set with no Parallel type yet says what to do", () => {
    details["s-bowman"] = { ok: false, reason: "Bowman has no Parallel type yet. Pick Bowman, run Sync Variant Types, then come back." };
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));
    expect(screen.getByRole("dialog").textContent).toContain("run Sync Variant Types");
    expect(
      screen.getByRole("button", { name: makeParallelCopy.confirm }).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("a refusal lands inside the dialog, which stays open", async () => {
    mockConvert.mockRejectedValue(new ConvexError("That parallel moved. Refresh and try again."));
    const { onReshaped } = renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: makeParallelCopy.confirm }));
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("That parallel moved. Refresh and try again.");
    expect(screen.getByRole("dialog").getAttribute("aria-describedby")).toContain(alert.id);
    expect(onReshaped).not.toHaveBeenCalled();
  });

  it("Escape cancels and hands focus back to the trigger; the trigger is inert while open", async () => {
    renderControl();
    const trigger = screen.getByRole("button", { name: MAKE_PARALLEL_LABEL });
    fireEvent.click(trigger);
    expect(trigger.hasAttribute("inert")).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger.hasAttribute("inert")).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("Enter on the confirm (a synthetic key, as the E2E driver sends) confirms", async () => {
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("button", { name: makeParallelCopy.confirm }), {
        key: "Enter",
      });
    });
    expect(mockConvert).toHaveBeenCalledTimes(1);
  });

  it("no two buttons share a name while the dialog is up", () => {
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));
    const names = screen.getAllByRole("button").map(
      (b) => b.getAttribute("aria-label") ?? b.textContent,
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("choice buttons carry no DOM id, so their aria-label stays their E2E name", () => {
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));
    for (const name of ["Parallel of Bowman", "Add to Blue", makeParallelCopy.newChoice("Fuchsia")]) {
      expect(screen.getByRole("button", { name }).getAttribute("id")).toBeNull();
    }
  });
});

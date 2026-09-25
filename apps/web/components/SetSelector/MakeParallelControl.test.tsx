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
const NO_LOSS = { cardPrefix: false, featureKeys: [], team: false, dismissedNames: false };

function bowmanDetail(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    targetSetValue: "Bowman",
    parallelTypeId: "pt-bowman",
    parallelTypeValue: "Parallel",
    parallels: [
      { _id: "p-blue", value: "Blue", holdsLink: false, loses: NO_LOSS },
      { _id: "p-gold", value: "Gold", holdsLink: false, loses: NO_LOSS },
    ],
    newLoses: NO_LOSS,
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
    linkCount: 1,
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

/** Unfold "Parallel of" (it opens folded on the server's preselection). */
function changeTarget() {
  fireEvent.click(screen.getByRole("button", { name: makeParallelCopy.changeTarget }));
}

describe("MakeParallelControl — no description paragraph (NEO-306)", () => {
  it("says nothing above the lists: the title, the lists and the preview say it all", () => {
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));
    const dialog = screen.getByRole("dialog");
    const text = dialog.textContent ?? "";
    expect(text).not.toContain("Pick the set it belongs to");
    expect(text).not.toContain("stops being a set");
    expect(text).not.toContain("SportLots link");
    expect(dialog.getAttribute("aria-describedby")).toBeNull();
    expect("description" in makeParallelCopy).toBe(false);
  });
});

describe("MakeParallelControl — the dialog", () => {
  it("opens on the suggested set, preselects a new parallel and previews where it lands", async () => {
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));

    const dialog = screen.getByRole("dialog", { name: makeParallelCopy.title("Bowman Fuchsia") });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // NEO-306 — the preselected set is folded to one line and a Change button.
    expect(screen.getByText("Parallel of: Bowman")).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Parallel of Bowman" })).toBeNull();
    const change = screen.getByRole("button", { name: makeParallelCopy.changeTarget });
    expect(change.textContent).toBe("Change");
    expect(makeParallelCopy.changeTarget.startsWith(change.textContent!)).toBe(true);
    // Focus opens on the question still open: the checked destination.
    const fuchsia = screen.getByRole("radio", { name: makeParallelCopy.newChoice("Fuchsia") });
    expect(fuchsia.getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(fuchsia));
    expect(dialog.textContent).toContain("Bowman›, Parallel›, Fuchsianew");
    // Change unfolds it, the preselection still checked and focused; a set
    // with no Parallel type yet is listed but cannot be picked.
    changeTarget();
    const bowman = screen.getByRole("radio", { name: "Parallel of Bowman" });
    expect(bowman.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(bowman);
    expect(
      screen.getByRole("radio", { name: "Parallel of Bowman Sapphire Edition" }).getAttribute("aria-disabled"),
    ).toBe("true");
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
    fireEvent.click(screen.getByRole("radio", { name: "Add to Gold" }));
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
    expect(screen.getByRole("radio", { name: "Add to Blue" }).getAttribute("aria-checked")).toBe("true");
    const unavailable = screen.getByRole("radio", { name: makeParallelCopy.newChoiceUnavailable });
    expect(unavailable.getAttribute("aria-disabled")).toBe("true");
    expect(unavailable.getAttribute("title")).toContain("already has a “Blue” parallel");
  });

  it("a parallel already holding the link cannot be picked, and nothing valid means no confirm", async () => {
    details["s-bowman"] = bowmanDetail({
      newName: undefined,
      newRefusal: "linked",
      parallels: [{ _id: "p-blue", value: "Blue", holdsLink: true, loses: NO_LOSS }],
      holdsLinkReason: "“Blue” under Bowman already has this SportLots link.",
    });
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));
    fireEvent.click(screen.getByRole("radio", { name: "Add to Blue" }));
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
    fireEvent.click(screen.getByRole("radio", { name: "Add to Gold" }));
    changeTarget();
    // A real click focuses the radio first; folding then removes it.
    const chrome = screen.getByRole("radio", { name: "Parallel of Bowman Chrome" });
    chrome.focus();
    fireEvent.click(chrome);
    expect(screen.queryByRole("radio", { name: "Add to Gold" })).toBeNull();
    // The pick folds, and focus goes on to the new set's destination.
    expect(screen.getByText("Parallel of: Bowman Chrome")).toBeTruthy();
    const fuchsia = screen.getByRole("radio", { name: makeParallelCopy.newChoice("Fuchsia") });
    expect(fuchsia.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(fuchsia);
  });

  it("a set with no Parallel type yet says what to do", () => {
    details["s-bowman"] = { ok: false, reason: "Bowman has no Parallel type yet. Pick Bowman, run Sync Variant Types, then come back." };
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));
    expect(screen.getByRole("dialog").textContent).toContain("run Sync Variant Types");
    expect(
      screen.getByRole("button", { name: makeParallelCopy.confirm }).getAttribute("aria-disabled"),
    ).toBe("true");
    // A refused preselection stays open (never folded), on its own radio.
    expect(screen.queryByRole("button", { name: makeParallelCopy.changeTarget })).toBeNull();
    expect(screen.getByRole("radio", { name: "Parallel of Bowman" }).getAttribute("aria-checked")).toBe(
      "true",
    );
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
    const names = [...screen.getAllByRole("button"), ...screen.getAllByRole("radio")].map(
      (b) => b.getAttribute("aria-label") ?? b.textContent,
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("choice and Change buttons carry no DOM id, so their aria-label stays their E2E name", () => {
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));
    expect(
      screen.getByRole("button", { name: makeParallelCopy.changeTarget }).getAttribute("id"),
    ).toBeNull();
    changeTarget();
    for (const name of ["Parallel of Bowman", "Add to Blue", makeParallelCopy.newChoice("Fuchsia")]) {
      expect(screen.getByRole("radio", { name }).getAttribute("id")).toBeNull();
    }
  });
});

/** The confirm's `aria-describedby` ids, resolved to their text. */
function describedText(el: HTMLElement): string {
  return (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" | ");
}

describe("MakeParallelControl — audit fixes (NEO-305)", () => {
  it("when ANY parallel of the type holds the link, every destination is blocked and the reason is said on the confirm and the list", () => {
    const reason = "“Blue” under Bowman already has this SportLots link. Remove it from “Blue” first if “Bowman Fuchsia” is the one to keep.";
    details["s-bowman"] = bowmanDetail({
      newName: undefined,
      newRefusal: reason,
      parallels: [
        { _id: "p-blue", value: "Blue", holdsLink: true, loses: NO_LOSS },
        { _id: "p-gold", value: "Gold", holdsLink: false, loses: NO_LOSS },
      ],
      holdsLinkReason: reason,
    });
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));
    for (const name of ["Add to Blue", "Add to Gold", makeParallelCopy.newChoiceUnavailable]) {
      expect(screen.getByRole("radio", { name }).getAttribute("aria-disabled")).toBe("true");
    }
    fireEvent.click(screen.getByRole("radio", { name: "Add to Gold" }));
    expect(screen.getByRole("radio", { name: "Add to Gold" }).getAttribute("aria-checked")).toBe("false");
    const confirm = screen.getByRole("button", { name: makeParallelCopy.confirm });
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(describedText(confirm)).toContain(reason);
    const destinations = screen.getByRole("radiogroup", { name: makeParallelCopy.destinationLegend });
    expect(describedText(destinations)).toContain(reason);
  });

  it("a target with no Parallel type says why on the confirm and on the set list", () => {
    const reason = "Bowman has no Parallel type yet. Pick Bowman, run Sync Variant Types, then come back.";
    details["s-bowman"] = { ok: false, reason };
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));
    expect(describedText(screen.getByRole("button", { name: makeParallelCopy.confirm }))).toContain(reason);
    expect(
      describedText(screen.getByRole("radiogroup", { name: makeParallelCopy.targetsLegend })),
    ).toContain(reason);
  });

  it("names what an existing parallel will not keep, before confirm", () => {
    details["s-bowman"] = bowmanDetail({
      parallels: [
        {
          _id: "p-gold",
          value: "Gold",
          holdsLink: false,
          loses: { cardPrefix: true, featureKeys: ["releaseDate"], team: true, dismissedNames: false },
        },
      ],
    });
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));
    // A new parallel carries everything: nothing is said.
    expect(screen.getByRole("dialog").textContent).not.toContain("Not coming along");
    fireEvent.click(screen.getByRole("radio", { name: "Add to Gold" }));
    const sentence = "Not coming along: its card prefix, Release Date and its team.";
    expect(screen.getByRole("dialog").textContent).toContain(sentence);
    expect(describedText(screen.getByRole("button", { name: makeParallelCopy.confirm }))).toContain(sentence);
  });

  it("is a radio group: one Tab stop, and the arrow keys move focus with the choice, skipping what can't be chosen", () => {
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));
    changeTarget();
    const group = screen.getByRole("radiogroup", { name: makeParallelCopy.targetsLegend });
    const radios = () => Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]'));
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);

    fireEvent.keyDown(screen.getByRole("radio", { name: "Parallel of Bowman" }), { key: "ArrowDown" });
    const chrome = screen.getByRole("radio", { name: "Parallel of Bowman Chrome" });
    expect(chrome.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(chrome);
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);

    // Sapphire has no Parallel type: skipped, wrapping back to Bowman.
    fireEvent.keyDown(chrome, { key: "ArrowDown" });
    expect(screen.getByRole("radio", { name: "Parallel of Bowman" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(screen.getByRole("radio", { name: "Parallel of Bowman" }), { key: "ArrowUp" });
    expect(screen.getByRole("radio", { name: "Parallel of Bowman Chrome" }).getAttribute("aria-checked")).toBe("true");
    // NEO-306 — arrows browse, never fold; Enter settles it and folds it.
    expect(screen.getByRole("radiogroup", { name: makeParallelCopy.targetsLegend })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("radio", { name: "Parallel of Bowman Chrome" }), { key: "Enter" });
    expect(screen.getByText("Parallel of: Bowman Chrome")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: makeParallelCopy.newChoice("Fuchsia") }),
    );
  });

  it("“Where it goes” is the last question: picking in it never folds it", () => {
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));
    fireEvent.click(screen.getByRole("radio", { name: "Add to Gold" }));
    expect(
      screen.getByRole("radiogroup", { name: makeParallelCopy.destinationLegend }),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Change/ })).toHaveLength(1);
  });

  it("a long list gets a filter whose result count is said politely", () => {
    targets = {
      ...(targets as object),
      targets: Array.from({ length: 14 }, (_, i) => ({
        setId: `s-${i}`,
        value: `Bowman Set ${String.fromCharCode(65 + i)}`,
        parallelTypeId: `pt-${i}`,
        parallelTypeValue: "Parallel",
      })),
      suggestedSetId: "s-0",
    };
    details["s-0"] = bowmanDetail();
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: MAKE_PARALLEL_LABEL }));
    changeTarget();
    const filter = screen.getByLabelText(makeParallelCopy.targetsFilter);
    const live = filter.parentElement!.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe("");
    fireEvent.change(filter, { target: { value: "set c" } });
    expect(live.textContent).toBe("1 match");
    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(live.textContent).toBe("Nothing matches that.");
  });
});

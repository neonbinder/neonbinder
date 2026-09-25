/**
 * NEO-306 — the SportLots-only review dialog.
 *
 * Pins: every row defaults to its own set; the server's suggested set is
 * tagged in the list but never chosen; picking a set forces that set's Sync
 * Variant Types exactly ONCE per set per opening (Retry is the only second
 * call); the syncing / failed / retry states; a variant type is required once
 * a set is chosen; the bulk bar; the decisions sent are exactly the rows; an
 * incomplete save keeps the dialog open; Escape writes nothing; and rows that
 * another admin's save removes drop out without a crash.
 *
 * `convex/react` is module-mocked and routed by the (string) query reference,
 * the house pattern (`MakeInsertControl.test.tsx`). Module state is read on
 * every render, so a reactive change is a mutation of it plus a rerender.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    slSetReview: {
      getSlSetReview: "review",
      getVariantTypesOfSet: "types",
      applySlSetReview: "apply",
    },
    selectorOptions: {
      ensureSelectorOptions: "ensure",
      getSelectorSyncStatus: "status",
    },
  },
}));

let review: unknown;
let typesBySet: Record<string, unknown>;
let statusBySet: Record<string, unknown>;
const mockEnsure = vi.fn();
const mockApply = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (ref === "review") return review;
    if (ref === "types") return typesBySet[(args as { setId: string }).setId];
    if (ref === "status") return statusBySet[(args as { parentId: string }).parentId] ?? null;
    return undefined;
  },
  useAction: (ref: string) => (ref === "ensure" ? mockEnsure : mockApply),
}));

import SlSetReviewModal, { slReviewCopy, slReviewSavedText } from "./SlSetReviewModal";

const BRAND = "mfr-bowman" as never;

const ENTRIES = [
  { slId: "sl-aa", label: "All-America" },
  { slId: "sl-gold", label: "Gold", suggestedOfSetId: "s-bowman" },
  { slId: "sl-blue", label: "Blue", suggestedOfSetId: "s-bowman" },
];

function makeReview(overrides: Record<string, unknown> = {}) {
  return {
    yearId: "y-2026",
    manufacturerId: BRAND,
    brandValue: "Bowman",
    entries: ENTRIES,
    ofSets: [
      { _id: "s-bowman", value: "Bowman" },
      { _id: "s-chrome", value: "Bowman Chrome" },
    ],
    ofSetsTruncated: false,
    moreNextSync: 0,
    partial: false,
    classifiedAt: 1,
    ...overrides,
  };
}

const BOWMAN_TYPES = [
  { _id: "t-insert", value: "Insert", role: "insert" },
  { _id: "t-parallel", value: "Parallel", role: "parallel" },
];

function okResult(overrides: Record<string, unknown> = {}) {
  return {
    sets: 1,
    underType: { insert: 0, parallel: 2, none: 0 },
    skipped: 0,
    skippedByReason: {
      notInReview: 0,
      alreadyLinked: 0,
      nameTaken: 0,
      existsElsewhere: 0,
      invalid: 0,
    },
    knownBrandsAdded: 0,
    remaining: 0,
    incomplete: false,
    ...overrides,
  };
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const onClose = vi.fn();
const onSaved = vi.fn();

function renderModal(props: Partial<React.ComponentProps<typeof SlSetReviewModal>> = {}) {
  // A FRESH element per render: the same element object lets React bail out,
  // and the point of a rerender here is that module state (the "live" query
  // answer) changed.
  const ui = () => (
    <SlSetReviewModal manufacturerId={BRAND} onClose={onClose} onSaved={onSaved} {...props} />
  );
  const utils = render(ui());
  return { ...utils, rerenderSame: () => utils.rerender(ui()) };
}

const setPicker = (name: string) =>
  screen.getByRole("button", { name: slReviewCopy.setPicker(name) });
const typePicker = (name: string) =>
  screen.getByRole("button", { name: slReviewCopy.typePicker(name) });

async function click(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
}

/**
 * The ON-SCREEN copy of a sentence: busy states and results are also said in
 * the dialog's one polite live region, so a plain `getByText` finds two.
 */
function visible(text: string): HTMLElement {
  const found = screen
    .getAllByText(text)
    .filter((el) => el.closest("[aria-live]") === null);
  if (found.length !== 1) throw new Error(`expected one visible "${text}", got ${found.length}`);
  return found[0];
}
const noVisible = (text: string) =>
  screen.queryAllByText(text).filter((el) => el.closest("[aria-live]") === null).length === 0;

/** An option's text without its ✓ and its "suggested" tag. */
const optionName = (b: Element) =>
  (b.textContent ?? "").replace(/^✓/, "").replace(/, suggested$/, "");

/** Open a row's "Variant of" list and pick `setLabel` from it. */
async function pickSet(rowName: string, setLabel: string) {
  await click(setPicker(rowName));
  const list = screen.getByRole("group", { name: slReviewCopy.setList(rowName) });
  const option = within(list)
    .getAllByRole("button")
    .find((b) => optionName(b) === setLabel);
  if (!option) throw new Error(`no option ${setLabel}`);
  await click(option);
}

async function pickType(rowName: string, typeLabel: string, setLabel = "Bowman") {
  await click(typePicker(rowName));
  const list = screen.getByRole("group", { name: slReviewCopy.typeList(setLabel) });
  const option = within(list)
    .getAllByRole("button")
    .find((b) => optionName(b).split(",")[0] === typeLabel);
  if (!option) throw new Error(`no type ${typeLabel}`);
  await click(option);
}

beforeEach(() => {
  vi.clearAllMocks();
  review = makeReview();
  typesBySet = { "s-bowman": BOWMAN_TYPES, "s-chrome": [] };
  statusBySet = {};
  mockEnsure.mockResolvedValue({ ran: true, reason: "synced", skippedSides: [], pausedSides: [] });
  mockApply.mockResolvedValue(okResult());
});

describe("SlSetReviewModal — defaults (NEO-306)", () => {
  it("titles the brand, says what the rows are, and heads the three columns", () => {
    renderModal();
    expect(screen.getByRole("dialog", { name: "Sort SportLots sets for Bowman" })).toBeTruthy();
    expect(
      screen.getByText(
        "SportLots lists these under Bowman. Each is a set of its own unless it belongs to one.",
      ),
    ).toBeTruthy();
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers.slice(1)).toEqual(["SportLots set", "Variant of", "Variant type"]);
  });

  it("files every row as its own set by default, and says so on Save", () => {
    renderModal();
    for (const { label } of ENTRIES) {
      expect(setPicker(label).textContent).toContain("Its own set");
      expect(screen.queryByRole("button", { name: slReviewCopy.typePicker(label) })).toBeNull();
    }
    expect(screen.getByRole("button", { name: "Save 3 SportLots sets" })).toBeTruthy();
    expect(screen.getByText("Saves as 3 sets.")).toBeTruthy();
  });

  it("tags the suggested set in the list but does NOT choose it", async () => {
    renderModal();
    await click(setPicker("Gold"));
    const list = screen.getByRole("group", { name: slReviewCopy.setList("Gold") });
    const options = within(list).getAllByRole("button");
    // Its own set first, and current; then the suggestion, tagged, not current.
    expect(options[0].textContent).toContain("Its own set");
    expect(options[0].getAttribute("aria-current")).toBe("true");
    expect(options[1].textContent).toContain("Bowman");
    expect(options[1].textContent).toContain("suggested");
    expect(options[1].getAttribute("aria-current")).toBeNull();
    // The brand's other sets follow, the suggestion not repeated.
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Its own set"),
      expect.stringContaining("Bowman"),
      "Bowman Chrome",
    ]);
    expect(setPicker("Gold").textContent).toContain("Its own set");
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("a row with no suggestion lists its own set, then the brand's sets", async () => {
    renderModal();
    await click(setPicker("All-America"));
    const list = screen.getByRole("group", { name: slReviewCopy.setList("All-America") });
    expect(within(list).getAllByRole("button").map((o) => o.textContent)).toEqual([
      "✓Its own set",
      "Bowman",
      "Bowman Chrome",
    ]);
  });

  it("the pickers are disclosures: aria-expanded, aria-controls on the open list", async () => {
    renderModal();
    const trigger = setPicker("Gold");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-controls")).toBeNull();
    await click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const listId = trigger.getAttribute("aria-controls");
    expect(listId).toBeTruthy();
    expect(document.getElementById(listId!)?.getAttribute("aria-label")).toBe(
      slReviewCopy.setList("Gold"),
    );
  });

  it("puts no DOM id on any control (Maestro's resource-id is id || aria-label)", async () => {
    renderModal();
    await click(setPicker("Gold"));
    for (const button of screen.getAllByRole("button")) {
      expect(button.getAttribute("id")).toBeNull();
    }
    for (const box of screen.getAllByRole("checkbox")) {
      expect(box.getAttribute("id")).toBeNull();
    }
  });
});

describe("SlSetReviewModal — a pick syncs that set's variant types, once per session", () => {
  it("forces one sync per set, however many rows (and the bulk bar) pick it", async () => {
    renderModal();
    await pickSet("Gold", "Bowman");
    await pickSet("Blue", "Bowman");
    await click(screen.getByRole("button", { name: slReviewCopy.bulkSetPicker }));
    const bulkList = screen.getByRole("group", { name: slReviewCopy.bulkSetPicker });
    await click(within(bulkList).getByText("Bowman"));
    expect(mockEnsure).toHaveBeenCalledTimes(1);
    expect(mockEnsure).toHaveBeenCalledWith({
      level: "variantType",
      parentId: "s-bowman",
      force: true,
    });

    await pickSet("All-America", "Bowman Chrome");
    expect(mockEnsure).toHaveBeenCalledTimes(2);
    expect(mockEnsure).toHaveBeenLastCalledWith({
      level: "variantType",
      parentId: "s-chrome",
      force: true,
    });
  });

  it("re-picking a set after going back to its own set does not sync it again", async () => {
    renderModal();
    await pickSet("Gold", "Bowman");
    await pickSet("Gold", "Its own set");
    await pickSet("Gold", "Bowman");
    expect(mockEnsure).toHaveBeenCalledTimes(1);
  });

  it("choosing 'Its own set' asks for nothing", async () => {
    renderModal();
    await pickSet("Gold", "Its own set");
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("shows the syncing line while the sync runs, busy, with the type picker inert", async () => {
    const pending = deferred<unknown>();
    mockEnsure.mockReturnValue(pending.promise);
    renderModal();
    await pickSet("Gold", "Bowman");
    expect(visible("Syncing Bowman's variant types…")).toBeTruthy();
    const trigger = typePicker("Gold");
    expect(trigger.hasAttribute("inert")).toBe(true);
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    expect(trigger.closest("[role='cell']")?.getAttribute("aria-busy")).toBe("true");
    // Said politely too.
    const live = document.querySelector("[aria-live='polite']");
    expect(live?.textContent).toBe("Syncing Bowman's variant types…");

    await act(async () => {
      pending.resolve({ ran: true, reason: "synced", skippedSides: [], pausedSides: [] });
    });
    expect(noVisible("Syncing Bowman's variant types…")).toBe(true);
    expect(typePicker("Gold").hasAttribute("inert")).toBe(false);
    expect(document.querySelector("[aria-live='polite']")?.textContent).toBe(
      "Bowman's variant types are in.",
    );
  });

  it("reads another column's in-flight sync of the same set as syncing", async () => {
    statusBySet = { "s-bowman": { status: "syncing" } };
    renderModal();
    await pickSet("Gold", "Bowman");
    expect(screen.getByText("Syncing Bowman's variant types…")).toBeTruthy();
  });

  it("says a failed sync and offers Retry, which is the only second call", async () => {
    typesBySet = { "s-bowman": [] };
    mockEnsure.mockResolvedValueOnce({ ran: true, reason: "error", skippedSides: [], pausedSides: [] });
    renderModal();
    await pickSet("Gold", "Bowman");
    expect(visible("Couldn't sync Bowman's variant types.")).toBeTruthy();
    expect(typePicker("Gold").getAttribute("aria-disabled")).toBe("true");
    // The reason is wired to the picker.
    const describedBy = typePicker("Gold").getAttribute("aria-describedby");
    expect(document.getElementById(describedBy!)?.textContent).toContain(
      "Couldn't sync Bowman's variant types.",
    );

    typesBySet = { "s-bowman": BOWMAN_TYPES };
    await click(screen.getByRole("button", { name: "Retry syncing Bowman's variant types" }));
    expect(mockEnsure).toHaveBeenCalledTimes(2);
    expect(noVisible("Couldn't sync Bowman's variant types.")).toBe(true);
    expect(typePicker("Gold").getAttribute("aria-disabled")).toBeNull();
  });

  it("a thrown sync is a failure too", async () => {
    typesBySet = { "s-bowman": [] };
    mockEnsure.mockRejectedValueOnce(new Error("network"));
    renderModal();
    await pickSet("Gold", "Bowman");
    expect(visible("Couldn't sync Bowman's variant types.")).toBeTruthy();
  });

  it("a set with no variant types to file under says so", async () => {
    renderModal();
    await pickSet("Gold", "Bowman Chrome");
    expect(screen.getByText("Bowman Chrome has no variant types to file under yet.")).toBeTruthy();
    expect(typePicker("Gold").getAttribute("aria-disabled")).toBe("true");
  });
});

describe("SlSetReviewModal — the variant type", () => {
  it("lists the set's types with their role tags", async () => {
    renderModal();
    await pickSet("Gold", "Bowman");
    await click(typePicker("Gold"));
    const list = screen.getByRole("group", { name: slReviewCopy.typeList("Bowman") });
    expect(within(list).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Insert, inserts",
      "Parallel, parallels",
    ]);
  });

  it("is required once a set is chosen: the row and Save both say so, and Save writes nothing", async () => {
    renderModal();
    await pickSet("Gold", "Bowman");
    expect(screen.getByText("Pick a variant type.")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save 3 SportLots sets" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getElementById(save.getAttribute("aria-describedby")!);
    expect(reason?.textContent).toBe("1 row needs a variant type.");
    await click(save);
    await act(async () => {
      fireEvent.keyDown(save, { key: "Enter" });
    });
    expect(mockApply).not.toHaveBeenCalled();

    await pickType("Gold", "Parallel");
    expect(typePicker("Gold").textContent).toContain("Parallel");
    expect(save.getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByText("Pick a variant type.")).toBeNull();
    expect(screen.getByText("Saves as 2 sets, 1 parallel.")).toBeTruthy();
  });

  it("changing the set clears the type", async () => {
    typesBySet["s-chrome"] = [{ _id: "t-c-par", value: "Parallel", role: "parallel" }];
    renderModal();
    await pickSet("Gold", "Bowman");
    await pickType("Gold", "Parallel");
    await pickSet("Gold", "Bowman Chrome");
    expect(typePicker("Gold").textContent).toContain("Pick a type");
  });
});

describe("SlSetReviewModal — the bulk bar", () => {
  it("marks every selected row as a variant of the chosen set and type", async () => {
    renderModal();
    await click(screen.getByRole("checkbox", { name: "Select all shown" }));
    expect(
      screen.getAllByRole("checkbox").every((c) => c.getAttribute("aria-checked") === "true"),
    ).toBe(true);

    const apply = screen.getByRole("button", { name: "Apply to 3 selected" });
    expect(apply.getAttribute("aria-disabled")).toBe("true");

    await click(screen.getByRole("button", { name: slReviewCopy.bulkSetPicker }));
    await click(
      within(screen.getByRole("group", { name: slReviewCopy.bulkSetPicker })).getByText("Bowman"),
    );
    await click(screen.getByRole("button", { name: slReviewCopy.bulkTypePicker }));
    await click(
      within(screen.getByRole("group", { name: slReviewCopy.typeList("Bowman") })).getByText(
        "Parallel",
      ),
    );
    await click(screen.getByRole("button", { name: "Apply to 3 selected" }));

    for (const { label } of ENTRIES) {
      expect(setPicker(label).textContent).toContain("Bowman");
      expect(typePicker(label).textContent).toContain("Parallel");
    }
    expect(document.querySelector("[aria-live='polite']")?.textContent).toBe(
      "Marked 3 rows as Bowman › Parallel.",
    );
    // The selection clears, so a second Apply cannot re-mark by accident.
    expect(screen.getByRole("button", { name: "Apply to 0 selected" })).toBeTruthy();

    await click(screen.getByRole("button", { name: "Save 3 SportLots sets" }));
    expect(mockApply).toHaveBeenCalledWith({
      manufacturerId: BRAND,
      decisions: [
        { slId: "sl-aa", variantTypeId: "t-parallel" },
        { slId: "sl-gold", variantTypeId: "t-parallel" },
        { slId: "sl-blue", variantTypeId: "t-parallel" },
      ],
    });
  });

  it("'Mark selected as their own sets' puts selected rows back", async () => {
    renderModal();
    await pickSet("Gold", "Bowman");
    await pickType("Gold", "Parallel");
    await click(screen.getByRole("checkbox", { name: "Select Gold" }));
    await click(screen.getByRole("button", { name: "Mark selected as their own sets" }));
    expect(setPicker("Gold").textContent).toContain("Its own set");
    expect(screen.getByText("Saves as 3 sets.")).toBeTruthy();
  });

  it("the filter narrows the rows, and 'Select all shown' selects only those", async () => {
    renderModal();
    const filter = screen.getByRole("searchbox", { name: "Find a SportLots set" });
    await act(async () => {
      fireEvent.change(filter, { target: { value: "gol" } });
    });
    expect(screen.queryByRole("button", { name: slReviewCopy.setPicker("Blue") })).toBeNull();
    expect(screen.getByText("1 match")).toBeTruthy();
    await click(screen.getByRole("checkbox", { name: "Select all shown" }));
    await act(async () => {
      fireEvent.change(filter, { target: { value: "" } });
    });
    expect(screen.getByRole("checkbox", { name: "Select Gold" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("checkbox", { name: "Select Blue" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("checkbox", { name: "Select all shown" }).getAttribute("aria-checked")).toBe(
      "mixed",
    );
  });
});

describe("SlSetReviewModal — saving", () => {
  it("sends exactly one decision per row: an id alone for its own set, a type for a variant", async () => {
    renderModal();
    await pickSet("Gold", "Bowman");
    await pickType("Gold", "Parallel");
    await pickSet("Blue", "Bowman");
    await pickType("Blue", "Insert");
    await click(screen.getByRole("button", { name: "Save 3 SportLots sets" }));
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockApply).toHaveBeenCalledWith({
      manufacturerId: BRAND,
      decisions: [
        { slId: "sl-aa" },
        { slId: "sl-gold", variantTypeId: "t-parallel" },
        { slId: "sl-blue", variantTypeId: "t-insert" },
      ],
    });
    expect(onSaved).toHaveBeenCalledWith("Saved 1 set, 2 parallels.");
  });

  it("says Saving… and holds the rows it is saving while the doc empties under it", async () => {
    const pending = deferred<unknown>();
    mockApply.mockReturnValue(pending.promise);
    const { rerenderSame } = renderModal();
    await click(screen.getByRole("button", { name: "Save 3 SportLots sets" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeTruthy();
    expect(screen.getByRole("dialog").getAttribute("aria-busy")).toBe("true");
    // The save removes entries chunk by chunk; the doc is gone before the
    // action returns.
    review = null;
    rerenderSame();
    expect(setPicker("Gold")).toBeTruthy();
    await act(async () => {
      pending.resolve(okResult({ sets: 3, underType: { insert: 0, parallel: 0, none: 0 } }));
    });
    expect(onSaved).toHaveBeenCalledWith("Saved 3 sets.");
  });

  it("an incomplete save keeps the dialog open and says to save again", async () => {
    mockApply.mockResolvedValue(
      okResult({ sets: 1, underType: { insert: 0, parallel: 0, none: 0 }, remaining: 2, incomplete: true }),
    );
    renderModal();
    await click(screen.getByRole("button", { name: "Save 3 SportLots sets" }));
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(visible("Saved 1 set. 2 left — save again.")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("a refusal lands in the dialog as an alert", async () => {
    mockApply.mockRejectedValue(new ConvexError("That brand is gone. Close the dialog and sync again."));
    renderModal();
    await click(screen.getByRole("button", { name: "Save 3 SportLots sets" }));
    expect(screen.getByRole("alert").textContent).toBe(
      "That brand is gone. Close the dialog and sync again.",
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("a plain failure gets the house fallback, never the raw message", async () => {
    mockApply.mockRejectedValue(new Error("[CONVEX A(x)] Server Error"));
    renderModal();
    await click(screen.getByRole("button", { name: "Save 3 SportLots sets" }));
    expect(screen.getByRole("alert").textContent).toBe(slReviewCopy.saveFailed);
  });
});

describe("SlSetReviewModal — Escape, Cancel and focus", () => {
  it("Escape cancels and writes nothing", async () => {
    renderModal();
    await pickSet("Gold", "Bowman");
    await pickType("Gold", "Parallel");
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("Escape inside an open list closes the list and returns focus to its trigger", async () => {
    renderModal();
    await click(setPicker("Gold"));
    const list = screen.getByRole("group", { name: slReviewCopy.setList("Gold") });
    // Focus opened on the current choice.
    expect(document.activeElement?.textContent).toContain("Its own set");
    await act(async () => {
      fireEvent.keyDown(within(list).getAllByRole("button")[0], { key: "Escape" });
    });
    expect(screen.queryByRole("group", { name: slReviewCopy.setList("Gold") })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(setPicker("Gold"));
  });

  it("arrow keys move through a list, and a pick returns focus to the trigger", async () => {
    renderModal();
    await click(setPicker("Gold"));
    const list = screen.getByRole("group", { name: slReviewCopy.setList("Gold") });
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    });
    expect(document.activeElement?.textContent).toContain("Bowman");
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "End" });
    });
    expect(document.activeElement?.textContent).toBe("Bowman Chrome");
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    });
    expect(list.isConnected).toBe(false);
    expect(document.activeElement).toBe(setPicker("Gold"));
    expect(setPicker("Gold").textContent).toContain("Bowman Chrome");
  });

  it("Cancel writes nothing; focus opens on the filter and returns to the opener", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    const restoreFocusRef = { current: opener };
    const { unmount } = renderModal({ restoreFocusRef });
    expect(document.activeElement).toBe(
      screen.getByRole("searchbox", { name: "Find a SportLots set" }),
    );
    await click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockApply).not.toHaveBeenCalled();
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("falls back to the column when the opener is gone", () => {
    const opener = document.createElement("button");
    const column = document.createElement("div");
    column.tabIndex = -1;
    document.body.append(opener, column);
    const { unmount } = renderModal({
      restoreFocusRef: { current: opener },
      fallbackFocusRef: { current: column },
    });
    opener.remove();
    unmount();
    expect(document.activeElement).toBe(column);
    column.remove();
  });
});

describe("SlSetReviewModal — the review is shared", () => {
  it("drops rows another admin's save removed, and never sends them", async () => {
    const { rerenderSame } = renderModal();
    await pickSet("Gold", "Bowman");
    await pickType("Gold", "Parallel");
    await click(screen.getByRole("checkbox", { name: "Select Gold" }));
    review = makeReview({ entries: [ENTRIES[0], ENTRIES[2]] });
    rerenderSame();
    expect(screen.queryByRole("button", { name: slReviewCopy.setPicker("Gold") })).toBeNull();
    expect(screen.getByRole("button", { name: "Save 2 SportLots sets" })).toBeTruthy();
    // The vanished row's selection does not count.
    expect(screen.getByRole("button", { name: "Apply to 0 selected" })).toBeTruthy();
    await click(screen.getByRole("button", { name: "Save 2 SportLots sets" }));
    expect(mockApply).toHaveBeenCalledWith({
      manufacturerId: BRAND,
      decisions: [{ slId: "sl-aa" }, { slId: "sl-blue" }],
    });
  });

  it("a set that leaves the brand's list reads as its own set again", async () => {
    const { rerenderSame } = renderModal();
    await pickSet("Gold", "Bowman");
    await pickType("Gold", "Parallel");
    review = makeReview({ ofSets: [{ _id: "s-chrome", value: "Bowman Chrome" }] });
    rerenderSame();
    expect(setPicker("Gold").textContent).toContain("Its own set");
  });

  it("an emptied review says there is nothing left, with only Close", () => {
    const { rerenderSame } = renderModal();
    review = null;
    rerenderSame();
    expect(screen.getAllByText("Nothing left to sort here.").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("says when a save stopped part-way, and when more wait for the next sync", () => {
    review = makeReview({ partial: true, moreNextSync: 12 });
    renderModal();
    expect(screen.getByText(slReviewCopy.partial)).toBeTruthy();
    expect(
      screen.getByText("12 more SportLots sets will show up after the next Sync Sets."),
    ).toBeTruthy();
  });
});

describe("slReviewSavedText", () => {
  it("names what was saved, singular and plural, skipping zeros", () => {
    expect(slReviewSavedText(okResult({ sets: 1, underType: { insert: 1, parallel: 1, none: 0 } }) as never)).toBe(
      "Saved 1 set, 1 parallel, 1 insert.",
    );
    expect(
      slReviewSavedText(okResult({ sets: 0, underType: { insert: 2, parallel: 0, none: 1 } }) as never),
    ).toBe("Saved 3 inserts.");
  });

  it("says why rows were skipped", () => {
    expect(
      slReviewSavedText(
        okResult({
          sets: 2,
          underType: { insert: 0, parallel: 0, none: 0 },
          skipped: 3,
          skippedByReason: {
            notInReview: 0,
            alreadyLinked: 1,
            nameTaken: 2,
            existsElsewhere: 0,
            invalid: 0,
          },
        }) as never,
      ),
    ).toBe("Saved 2 sets. 3 skipped: 1 already linked, 2 already there by that name.");
  });

  it("says nothing new when nothing was written", () => {
    expect(
      slReviewSavedText(okResult({ sets: 0, underType: { insert: 0, parallel: 0, none: 0 } }) as never),
    ).toBe("Nothing new saved.");
  });
});

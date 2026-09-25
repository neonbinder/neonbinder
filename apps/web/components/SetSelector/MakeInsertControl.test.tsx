/**
 * NEO-306 — "Make insert of…": when the row action shows, the dialog's three
 * lists and what each preselects, the typed-name landing and its preview,
 * the confirm's reasons, the keyboard, the `landing` each choice sends and
 * where the operator is sent after.
 *
 * `convex/react` is module-mocked and routed by the (string) query reference,
 * the house pattern for these components (`MakeParallelControl.test.tsx`).
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    setInsertConversion: {
      getMakeInsertEligibility: "eligibility",
      getMakeInsertTargets: "targets",
      getMakeInsertTargetDetail: "detail",
      getMakeInsertInsertDetail: "insertDetail",
      getMakeInsertNamedPreview: "named",
      convertToInsert: "convert",
    },
  },
}));

let eligibility: unknown;
let targets: unknown;
let details: Record<string, unknown>;
let insertDetails: Record<string, unknown>;
/** Keyed by the typed name the preview was asked about. */
let namedPreviews: Record<string, unknown>;
const namedCalls: string[] = [];
const mockConvert = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (ref === "eligibility") return eligibility;
    if (ref === "targets") return targets;
    if (ref === "detail") return details[(args as { targetSetId: string }).targetSetId];
    if (ref === "insertDetail") return insertDetails[(args as { insertId: string }).insertId];
    if (ref === "named") {
      const name = (args as { name: string }).name;
      namedCalls.push(name);
      return namedPreviews[name];
    }
    return undefined;
  },
  useMutation: (ref: string) => (ref === "convert" ? mockConvert : vi.fn()),
}));

import MakeInsertControl, {
  MAKE_INSERT_LABEL,
  NAMED_PREVIEW_DEBOUNCE_MS,
  makeInsertCopy,
} from "./MakeInsertControl";
import { SET_ROW_ACTION_TONE_CLASSES } from "./SetRowActionButton";

const ROW_ID = "row-red-ink" as never;
const ROW = "All-America Game Autos Red Ink";
const NO_LOSS = { cardPrefix: false, featureKeys: [], team: false, dismissedNames: false };

function bowmanDetail(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    targetSetValue: "Bowman",
    insertTypeId: "it-bowman",
    insertTypeValue: "Insert",
    inserts: [
      { _id: "i-aag", value: "All-America Game Autos", holdsLink: false, loses: NO_LOSS },
      { _id: "i-prospects", value: "Prospects", holdsLink: false, loses: NO_LOSS },
    ],
    newLoses: NO_LOSS,
    newInsertName: "All-America Game Autos Red Ink",
    truncated: false,
    ...overrides,
  };
}

function aagDetail(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    insertValue: "All-America Game Autos",
    targetSetValue: "Bowman",
    joinLoses: NO_LOSS,
    parallels: [{ _id: "p-blue-ink", value: "Blue Ink", holdsLink: false, loses: NO_LOSS }],
    newLoses: NO_LOSS,
    newParallelName: "Red Ink",
    sameAsInsertSelf: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  namedCalls.length = 0;
  eligibility = { eligible: true };
  targets = {
    ok: true,
    kind: "row",
    rowValue: ROW,
    brandValue: "Bowman",
    ownSetId: "s-bowman",
    ownSetValue: "Bowman",
    cardCount: 4,
    targets: [
      { setId: "s-bowman", value: "Bowman", insertTypeId: "it-bowman", insertTypeValue: "Insert" },
      { setId: "s-chrome", value: "Bowman Chrome", insertTypeId: "it-chrome", insertTypeValue: "Insert" },
      { setId: "s-draft", value: "Bowman Draft" },
    ],
    suggestedSetId: "s-bowman",
    truncated: false,
  };
  details = {
    "s-bowman": bowmanDetail(),
    "s-chrome": bowmanDetail({
      targetSetValue: "Bowman Chrome",
      insertTypeId: "it-chrome",
      inserts: [],
      newInsertName: "All-America Game Autos Red Ink",
    }),
  };
  insertDetails = {
    "i-aag": aagDetail(),
    "i-prospects": aagDetail({
      insertValue: "Prospects",
      parallels: [],
      newParallelName: undefined,
      newParallelRefusal: "“All-America Game Autos Red Ink” is not a Prospects name.",
    }),
  };
  namedPreviews = {};
  mockConvert.mockResolvedValue({
    path: [
      { _id: "s-bowman", level: "setName", value: "Bowman" },
      { _id: "it-bowman", level: "variantType", value: "Insert" },
      { _id: "i-new", level: "insert", value: "All-America Game Autos Red Ink" },
    ],
    landedValue: "All-America Game Autos Red Ink",
    created: true,
    targetSetValue: "Bowman",
  });
});

function renderControl() {
  const showToast = vi.fn();
  const onReshaped = vi.fn();
  render(
    <MakeInsertControl
      rowId={ROW_ID}
      rowValue={ROW}
      showToast={showToast}
      onReshaped={onReshaped}
    />,
  );
  return { showToast, onReshaped };
}

function open() {
  fireEvent.click(screen.getByRole("button", { name: MAKE_INSERT_LABEL }));
}

const confirmButton = () => screen.getByRole("button", { name: makeInsertCopy.confirm });

async function confirm() {
  await act(async () => {
    fireEvent.click(confirmButton());
  });
}

/** An element's `aria-describedby` ids, resolved to their text. */
function describedText(el: HTMLElement): string {
  return (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" | ");
}

describe("MakeInsertControl — when it shows", () => {
  it("shows when the server says the row could become an insert, as a quiet chip named by its text", () => {
    renderControl();
    const button = screen.getByRole("button", { name: MAKE_INSERT_LABEL });
    expect(button.getAttribute("aria-label")).toBeNull();
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    for (const cls of SET_ROW_ACTION_TONE_CLASSES.quiet.split(" ")) {
      expect(button.classList.contains(cls)).toBe(true);
    }
  });

  it.each([
    ["the server says no", { eligible: false }],
    ["the answer has not arrived", undefined],
  ])("renders nothing when %s", (_why, answer) => {
    eligibility = answer;
    const { container } = render(
      <MakeInsertControl rowId={ROW_ID} rowValue={ROW} showToast={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("MakeInsertControl — the three lists", () => {
  it("opens on the suggested set, preselects a new insert and previews where it lands", async () => {
    renderControl();
    open();
    const dialog = screen.getByRole("dialog", { name: makeInsertCopy.title(ROW) });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const bowman = screen.getByRole("radio", { name: "Insert of Bowman" });
    expect(bowman.getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(bowman));
    // A set with no Insert type yet is listed but cannot be picked.
    expect(
      screen.getByRole("radio", { name: "Insert of Bowman Draft" }).getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen
        .getByRole("radio", { name: makeInsertCopy.newInsert("All-America Game Autos Red Ink") })
        .getAttribute("aria-checked"),
    ).toBe("true");
    // Existing inserts, and the typed-name choice last.
    const where = screen.getByRole("radiogroup", { name: makeInsertCopy.whereLegend });
    expect(
      Array.from(where.querySelectorAll('[role="radio"]')).map((r) => r.getAttribute("aria-label")),
    ).toEqual([
      makeInsertCopy.newInsert("All-America Game Autos Red Ink"),
      "Add to All-America Game Autos",
      "Add to Prospects",
      makeInsertCopy.namedChoice,
    ]);
    expect(dialog.textContent).toContain("Bowman›, Insert›, All-America Game Autos Red Inknew");
    // No "Under …" list until an existing insert is chosen.
    expect(screen.queryByRole("radiogroup", { name: /^Under / })).toBeNull();
  });

  it("the row description says what moves (S2: nothing about stopping being a set)", () => {
    renderControl();
    open();
    expect(screen.getByRole("dialog").textContent).toContain(
      makeInsertCopy.description(ROW, "row", 4),
    );
    expect(makeInsertCopy.description("Bowman Red Ink", "set", 1)).toBe(
      "Pick the set it belongs to, then where it goes. Its SportLots link and 1 card move over, and “Bowman Red Ink” stops being a set.",
    );
  });

  it("choosing an existing insert opens “Under {insert} as”, preselecting a new parallel", () => {
    renderControl();
    open();
    fireEvent.click(screen.getByRole("radio", { name: "Add to All-America Game Autos" }));
    const under = screen.getByRole("radiogroup", {
      name: makeInsertCopy.underLegend("All-America Game Autos"),
    });
    expect(
      Array.from(under.querySelectorAll('[role="radio"]')).map((r) => r.getAttribute("aria-label")),
    ).toEqual([makeInsertCopy.insertItself, makeInsertCopy.newParallel("Red Ink"), "Parallel of Blue Ink"]);
    expect(
      screen.getByRole("radio", { name: makeInsertCopy.newParallel("Red Ink") }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByRole("dialog").textContent).toContain(
      "Bowman›, Insert›, All-America Game Autos›, Red Inknew",
    );
  });

  it("preselects “The insert itself” when the label IS the insert's name", () => {
    insertDetails["i-aag"] = aagDetail({
      newParallelName: undefined,
      newParallelRefusal: "“All-America Game Autos” is “All-America Game Autos”’s own name, so add it to “All-America Game Autos” itself.",
      sameAsInsertSelf: true,
    });
    renderControl();
    open();
    fireEvent.click(screen.getByRole("radio", { name: "Add to All-America Game Autos" }));
    expect(
      screen.getByRole("radio", { name: makeInsertCopy.insertItself }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("radio", { name: makeInsertCopy.newParallelUnavailable }).getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.getByRole("dialog").textContent).toContain(
      "Bowman›, Insert›, All-America Game Autosjoins",
    );
  });

  it("when a new insert's name is taken, preselects the insert to add to and says why on the list", () => {
    const reason = "Bowman already has a “Prospects” insert. Add it to that one instead.";
    details["s-bowman"] = bowmanDetail({
      newInsertName: undefined,
      newInsertRefusal: reason,
      sameAsInsertId: "i-prospects",
    });
    renderControl();
    open();
    expect(screen.getByRole("radio", { name: "Add to Prospects" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    const unavailable = screen.getByRole("radio", { name: makeInsertCopy.newInsertUnavailable });
    expect(unavailable.getAttribute("aria-disabled")).toBe("true");
    expect(unavailable.getAttribute("title")).toBe(reason);
    expect(
      describedText(screen.getByRole("radiogroup", { name: makeInsertCopy.whereLegend })),
    ).toContain(reason);
  });

  it("switching the target set re-reads its inserts and resets every later choice", () => {
    renderControl();
    open();
    fireEvent.click(screen.getByRole("radio", { name: "Add to All-America Game Autos" }));
    fireEvent.click(screen.getByRole("radio", { name: "Insert of Bowman Chrome" }));
    expect(screen.queryByRole("radio", { name: "Add to All-America Game Autos" })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: /^Under / })).toBeNull();
    expect(
      screen
        .getByRole("radio", { name: makeInsertCopy.newInsert("All-America Game Autos Red Ink") })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("a set with no Insert type says what to do, on the list and on the confirm", () => {
    const reason = "Bowman has no Insert type yet. Pick Bowman, run Sync Variant Types, then come back.";
    details["s-bowman"] = { ok: false, reason };
    renderControl();
    open();
    expect(screen.getByRole("dialog").textContent).toContain(reason);
    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");
    expect(describedText(confirmButton())).toContain(reason);
    expect(
      describedText(screen.getByRole("radiogroup", { name: makeInsertCopy.targetsLegend })),
    ).toContain(reason);
  });

  it("when something under the Insert type holds the link, nothing can be chosen and the reason is on the confirm", async () => {
    const reason = "“Prospects” under Bowman already has this SportLots link. Remove it from “Prospects” first if “All-America Game Autos Red Ink” is the one to keep.";
    details["s-bowman"] = bowmanDetail({
      newInsertName: undefined,
      newInsertRefusal: reason,
      holdsLinkReason: reason,
      inserts: [
        { _id: "i-aag", value: "All-America Game Autos", holdsLink: false, loses: NO_LOSS },
        { _id: "i-prospects", value: "Prospects", holdsLink: true, loses: NO_LOSS },
      ],
    });
    renderControl();
    open();
    for (const name of [
      makeInsertCopy.newInsertUnavailable,
      "Add to All-America Game Autos",
      "Add to Prospects",
      makeInsertCopy.namedChoice,
    ]) {
      expect(screen.getByRole("radio", { name }).getAttribute("aria-disabled")).toBe("true");
    }
    fireEvent.click(screen.getByRole("radio", { name: "Add to All-America Game Autos" }));
    expect(screen.queryByRole("radiogroup", { name: /^Under / })).toBeNull();
    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");
    expect(describedText(confirmButton())).toContain(reason);
    await confirm();
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it("names what an existing row will not keep, before confirm", () => {
    insertDetails["i-aag"] = aagDetail({
      joinLoses: { cardPrefix: true, featureKeys: [], team: true, dismissedNames: false },
    });
    renderControl();
    open();
    expect(screen.getByRole("dialog").textContent).not.toContain("Not coming along");
    fireEvent.click(screen.getByRole("radio", { name: "Add to All-America Game Autos" }));
    fireEvent.click(screen.getByRole("radio", { name: makeInsertCopy.insertItself }));
    const sentence = "Not coming along: its card prefix and its team.";
    expect(screen.getByRole("dialog").textContent).toContain(sentence);
    expect(describedText(confirmButton())).toContain(sentence);
  });
});

describe("MakeInsertControl — New insert named…", () => {
  it("shows the name field only for that choice, previews the insert → parallel once typing rests, and confirms it", async () => {
    namedPreviews["All-America Game Autos"] = {
      ok: true,
      insertName: "All-America Game Autos",
      parallelName: "Red Ink",
    };
    mockConvert.mockResolvedValue({
      path: [
        { _id: "s-bowman", level: "setName", value: "Bowman" },
        { _id: "it-bowman", level: "variantType", value: "Insert" },
        { _id: "i-new", level: "insert", value: "All-America Game Autos" },
        { _id: "p-new", level: "parallel", value: "Red Ink" },
      ],
      landedValue: "Red Ink",
      created: true,
      targetSetValue: "Bowman",
    });
    const { showToast, onReshaped } = renderControl();
    open();
    expect(screen.queryByLabelText(makeInsertCopy.nameLabel)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: makeInsertCopy.namedChoice }));
    const input = screen.getByLabelText(makeInsertCopy.nameLabel) as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    // Nothing typed: nothing to confirm, and saying so on press.
    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");

    fireEvent.change(input, { target: { value: "All-America Game Autos" } });
    // Not asked on every keystroke — only once typing rests.
    expect(namedCalls).not.toContain("All-America Game Autos");
    await waitFor(
      () =>
        expect(screen.getByRole("dialog").textContent).toContain(
          "Bowman›, Insert›, All-America Game Autos›, Red Inknew",
        ),
      { timeout: NAMED_PREVIEW_DEBOUNCE_MS + 1000 },
    );
    expect(confirmButton().getAttribute("aria-disabled")).toBeNull();

    // Enter in the field confirms, as it does on the confirm button.
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(mockConvert).toHaveBeenCalledWith({
      rowId: ROW_ID,
      targetInsertTypeId: "it-bowman",
      landing: { kind: "newInsertNamed", name: "All-America Game Autos" },
    });
    expect(showToast).toHaveBeenCalledWith(
      `“${ROW}” is now “All-America Game Autos”’s “Red Ink” parallel.`,
    );
    expect(onReshaped).toHaveBeenCalledWith([
      { _id: "s-bowman", level: "setName" },
      { _id: "it-bowman", level: "variantType" },
      { _id: "i-new", level: "insert" },
      { _id: "p-new", level: "parallel" },
    ]);
  });

  it("a refused name is said under the field, on the field and on the confirm", async () => {
    const reason = `“${ROW}” is the whole of that name — pick New insert instead.`;
    namedPreviews[ROW] = { ok: false, reason };
    renderControl();
    open();
    fireEvent.click(screen.getByRole("radio", { name: makeInsertCopy.namedChoice }));
    const input = screen.getByLabelText(makeInsertCopy.nameLabel);
    fireEvent.change(input, { target: { value: `  ${ROW}  ` } });
    await waitFor(() => expect(describedText(input)).toContain(reason), {
      timeout: NAMED_PREVIEW_DEBOUNCE_MS + 1000,
    });
    // The server was asked about the trimmed name.
    expect(namedCalls).toContain(ROW);
    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");
    expect(describedText(confirmButton())).toContain(reason);
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it("an empty name on confirm asks for one", async () => {
    renderControl();
    open();
    fireEvent.click(screen.getByRole("radio", { name: makeInsertCopy.namedChoice }));
    await confirm();
    expect(mockConvert).not.toHaveBeenCalled();
  });
});

describe("MakeInsertControl — each landing sends what it says", () => {
  const pathTo = (tail: Array<{ _id: string; level: string; value: string }>) => [
    { _id: "s-bowman", level: "setName", value: "Bowman" },
    { _id: "it-bowman", level: "variantType", value: "Insert" },
    ...tail,
  ];

  it("new insert → { kind: newInsert }, toast, and the 3-step drill", async () => {
    const { showToast, onReshaped } = renderControl();
    open();
    await confirm();
    expect(mockConvert).toHaveBeenCalledWith({
      rowId: ROW_ID,
      targetInsertTypeId: "it-bowman",
      landing: { kind: "newInsert" },
    });
    expect(showToast).toHaveBeenCalledWith(
      `“${ROW}” is now Bowman’s “All-America Game Autos Red Ink” insert.`,
    );
    expect(onReshaped).toHaveBeenCalledWith([
      { _id: "s-bowman", level: "setName" },
      { _id: "it-bowman", level: "variantType" },
      { _id: "i-new", level: "insert" },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the insert itself → { kind: joinInsert }", async () => {
    mockConvert.mockResolvedValue({
      path: pathTo([{ _id: "i-aag", level: "insert", value: "All-America Game Autos" }]),
      landedValue: "All-America Game Autos",
      created: false,
      targetSetValue: "Bowman",
    });
    const { showToast } = renderControl();
    open();
    fireEvent.click(screen.getByRole("radio", { name: "Add to All-America Game Autos" }));
    fireEvent.click(screen.getByRole("radio", { name: makeInsertCopy.insertItself }));
    await confirm();
    expect(mockConvert).toHaveBeenCalledWith({
      rowId: ROW_ID,
      targetInsertTypeId: "it-bowman",
      landing: { kind: "joinInsert", insertId: "i-aag" },
    });
    expect(showToast).toHaveBeenCalledWith(
      `“${ROW}” joined Bowman’s “All-America Game Autos” insert.`,
    );
  });

  it("a new parallel of an insert → { kind: newParallel }, and a 4-step drill ending on the parallel", async () => {
    mockConvert.mockResolvedValue({
      path: pathTo([
        { _id: "i-aag", level: "insert", value: "All-America Game Autos" },
        { _id: "p-new", level: "parallel", value: "Red Ink" },
      ]),
      landedValue: "Red Ink",
      created: true,
      targetSetValue: "Bowman",
    });
    const { showToast, onReshaped } = renderControl();
    open();
    fireEvent.click(screen.getByRole("radio", { name: "Add to All-America Game Autos" }));
    await confirm();
    expect(mockConvert).toHaveBeenCalledWith({
      rowId: ROW_ID,
      targetInsertTypeId: "it-bowman",
      landing: { kind: "newParallel", insertId: "i-aag" },
    });
    expect(showToast).toHaveBeenCalledWith(
      `“${ROW}” is now “All-America Game Autos”’s “Red Ink” parallel.`,
    );
    expect(onReshaped).toHaveBeenCalledWith([
      { _id: "s-bowman", level: "setName" },
      { _id: "it-bowman", level: "variantType" },
      { _id: "i-aag", level: "insert" },
      { _id: "p-new", level: "parallel" },
    ]);
  });

  it("an existing parallel → { kind: joinParallel }", async () => {
    mockConvert.mockResolvedValue({
      path: pathTo([
        { _id: "i-aag", level: "insert", value: "All-America Game Autos" },
        { _id: "p-blue-ink", level: "parallel", value: "Blue Ink" },
      ]),
      landedValue: "Blue Ink",
      created: false,
      targetSetValue: "Bowman",
    });
    const { showToast } = renderControl();
    open();
    fireEvent.click(screen.getByRole("radio", { name: "Add to All-America Game Autos" }));
    fireEvent.click(screen.getByRole("radio", { name: "Parallel of Blue Ink" }));
    expect(screen.getByRole("dialog").textContent).toContain("Blue Inkjoins");
    await confirm();
    expect(mockConvert).toHaveBeenCalledWith({
      rowId: ROW_ID,
      targetInsertTypeId: "it-bowman",
      landing: { kind: "joinParallel", parallelId: "p-blue-ink" },
    });
    expect(showToast).toHaveBeenCalledWith(
      `“${ROW}” joined “All-America Game Autos”’s “Blue Ink” parallel.`,
    );
  });

  it("a new parallel that can't be named leaves nothing valid until the operator picks, and says why", () => {
    renderControl();
    open();
    fireEvent.click(screen.getByRole("radio", { name: "Add to Prospects" }));
    // Default falls back to the insert itself — a valid landing.
    expect(
      screen.getByRole("radio", { name: makeInsertCopy.insertItself }).getAttribute("aria-checked"),
    ).toBe("true");
    const under = screen.getByRole("radiogroup", { name: makeInsertCopy.underLegend("Prospects") });
    expect(describedText(under)).toContain("is not a Prospects name");
  });
});

describe("MakeInsertControl — keyboard, focus and refusals", () => {
  it("Escape cancels and hands focus back to the trigger; the trigger is inert while open", async () => {
    renderControl();
    const trigger = screen.getByRole("button", { name: MAKE_INSERT_LABEL });
    fireEvent.click(trigger);
    expect(trigger.hasAttribute("inert")).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger.hasAttribute("inert")).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it("Enter opens it, and Enter on the confirm (a synthetic key, as the E2E driver sends) confirms", async () => {
    renderControl();
    fireEvent.keyDown(screen.getByRole("button", { name: MAKE_INSERT_LABEL }), { key: "Enter" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(confirmButton(), { key: "Enter" });
    });
    expect(mockConvert).toHaveBeenCalledTimes(1);
  });

  it("a refusal lands inside the dialog, which stays open", async () => {
    mockConvert.mockRejectedValue(new ConvexError("That insert moved. Refresh and try again."));
    const { onReshaped, showToast } = renderControl();
    open();
    await confirm();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("That insert moved. Refresh and try again.");
    expect(screen.getByRole("dialog").getAttribute("aria-describedby")).toContain(alert.id);
    expect(onReshaped).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("no two buttons or fields share a name while the dialog is up, even with every list open", () => {
    renderControl();
    open();
    fireEvent.click(screen.getByRole("radio", { name: "Add to All-America Game Autos" }));
    const names = [...screen.getAllByRole("button"), ...screen.getAllByRole("radio")].map(
      (b) => b.getAttribute("aria-label") ?? b.textContent,
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("choice buttons carry no DOM id, so their aria-label stays their E2E name", () => {
    renderControl();
    open();
    fireEvent.click(screen.getByRole("radio", { name: "Add to All-America Game Autos" }));
    for (const name of [
      "Insert of Bowman",
      "Add to All-America Game Autos",
      makeInsertCopy.namedChoice,
      makeInsertCopy.insertItself,
      "Parallel of Blue Ink",
    ]) {
      expect(screen.getByRole("radio", { name }).getAttribute("id")).toBeNull();
    }
  });
});

/**
 * NEO-325 — the SportLots-only review dialog and NAME TWINS.
 *
 *   • twins show `(#id)` beside their label (and in the name that identifies
 *     the row to a screen reader); unique labels read as they always did;
 *   • each own-set row carries a Name field prefilled with the server's
 *     default name; the decision carries `name` only when the operator typed
 *     something other than that default;
 *   • a line the save refused for its name stays, says why, and clears the
 *     refusal when the name is edited; a refusal stored on the entry
 *     (`lastRefusal`) is shown again on reopen;
 *   • two own-set lines carrying one name block Save: `aria-disabled`, a
 *     `title` with the sentence, and a press writes nothing.
 *
 * Same harness as `SlSetReviewModal.test.tsx`.
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

import SlSetReviewModal, { refusedReasonText, slReviewCopy } from "./SlSetReviewModal";
import { RENAME_TIP, TITLE_CLASH_ROW_LINE } from "./ready-title-clashes";
import { MAX_SELECTOR_VALUE_LENGTH, checkSelectorValue } from "../../convex/selectorSyncMatch";

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

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * A row's pickers, found by the half of their name that does not move: the
 * name STARTS with the visible choice (SC 2.5.3) and ends with the row.
 */
const setPickerName = (name: string) =>
  new RegExp(`: set ${escapeRe(name)} belongs to$`);
const typePickerName = (name: string) => new RegExp(`: where ${escapeRe(name)} is filed$`);
const setPicker = (name: string) => screen.getByRole("button", { name: setPickerName(name) });
const typePicker = (name: string) => screen.getByRole("button", { name: typePickerName(name) });
const bulkSetPicker = () =>
  screen.getByRole("button", { name: /: set the selected rows belong to$/ });
const bulkTypePicker = () =>
  screen.getByRole("button", { name: /: where the selected rows are filed$/ });

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

/** Open a row's "Belongs to" list and pick `setLabel` from it. */
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


const TWIN_ENTRIES = [
  { slId: "sl-1", label: "Anime", twin: true, defaultName: "Bowman Anime" },
  { slId: "sl-2", label: "Anime", twin: true, defaultName: "Bowman Anime" },
  { slId: "sl-3", label: "Chrome", defaultName: "Bowman Chrome" },
];

const refusal = (over: Record<string, unknown> = {}) => ({
  name: "Bowman Anime",
  reason: "nameTaken" as const,
  target: "set" as const,
  clashWith: { _id: "s-existing" as never, value: "Bowman Anime" },
  ...over,
});

const nameField = (rowName: string) =>
  screen.getByLabelText(slReviewCopy.nameField(rowName)) as HTMLInputElement;

async function typeName(rowName: string, value: string) {
  const input = nameField(rowName);
  await act(async () => {
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  });
}

const saveBtn = (n: number) => screen.getByRole("button", { name: new RegExp(`^Save ${n} SportLots sets?$`) });

describe("SlSetReviewModal — twins (NEO-325)", () => {
  it("shows (#id) on twinned labels only, and the row's accessible name carries it", () => {
    review = makeReview({ entries: TWIN_ENTRIES });
    renderModal();

    expect(screen.getByLabelText(slReviewCopy.nameField("Anime (#sl-1)"))).toBeTruthy();
    expect(screen.getByLabelText(slReviewCopy.nameField("Anime (#sl-2)"))).toBeTruthy();
    expect(screen.getByLabelText(slReviewCopy.nameField("Chrome"))).toBeTruthy();
    expect(screen.queryByLabelText(slReviewCopy.nameField("Chrome (#sl-3)"))).toBeNull();
    expect(screen.getAllByText("(#sl-1)")).toHaveLength(1);
    expect(screen.queryByText("(#sl-3)")).toBeNull();
  });

  it("two entries sharing a label are twins even when the server did not flag them", () => {
    review = makeReview({
      entries: [
        { slId: "sl-1", label: "Anime", defaultName: "Bowman Anime" },
        { slId: "sl-2", label: "Anime", defaultName: "Bowman Anime 2" },
      ],
    });
    renderModal();

    expect(screen.getByLabelText(slReviewCopy.nameField("Anime (#sl-1)"))).toBeTruthy();
    expect(screen.getByLabelText(slReviewCopy.nameField("Anime (#sl-2)"))).toBeTruthy();
  });

  it("a server-flagged twin whose namesake is not in the list still shows its id", () => {
    review = makeReview({
      entries: [{ slId: "sl-1", label: "Anime", twin: true, defaultName: "Bowman Anime" }],
    });
    renderModal();

    expect(screen.getByLabelText(slReviewCopy.nameField("Anime (#sl-1)"))).toBeTruthy();
  });

  it("the filter matches on the label with its id, so a twin can be found by its id", async () => {
    review = makeReview({ entries: TWIN_ENTRIES });
    renderModal();

    await act(async () => {
      fireEvent.change(screen.getByRole("searchbox"), { target: { value: "sl-2" } });
    });

    expect(screen.queryByLabelText(slReviewCopy.nameField("Anime (#sl-1)"))).toBeNull();
    expect(screen.getByLabelText(slReviewCopy.nameField("Anime (#sl-2)"))).toBeTruthy();
  });
});

describe("SlSetReviewModal — the name field (NEO-325)", () => {
  it("is prefilled with the server's default name, falling back to the label", () => {
    review = makeReview({
      entries: [
        { slId: "sl-a", label: "Alpha", defaultName: "Bowman Alpha" },
        { slId: "sl-b", label: "Beta" },
      ],
    });
    renderModal();

    expect(nameField("Alpha").value).toBe("Bowman Alpha");
    expect(nameField("Beta").value).toBe("Beta");
  });

  it("sends no name when the operator leaves the default alone", async () => {
    review = makeReview({ entries: TWIN_ENTRIES.slice(2) });
    renderModal();

    await click(saveBtn(1));

    expect(mockApply).toHaveBeenCalledWith({
      manufacturerId: BRAND,
      decisions: [{ slId: "sl-3" }],
    });
  });

  it("sends the typed name on exactly the line it was typed on", async () => {
    review = makeReview({ entries: TWIN_ENTRIES });
    renderModal();

    await typeName("Anime (#sl-2)", "Bowman Anime Retail");
    await click(saveBtn(3));

    expect(mockApply.mock.calls[0][0].decisions).toEqual([
      { slId: "sl-1" },
      { slId: "sl-2", name: "Bowman Anime Retail" },
      { slId: "sl-3" },
    ]);
  });

  it("typing the default name back sends no name", async () => {
    review = makeReview({ entries: TWIN_ENTRIES.slice(2) });
    renderModal();

    await typeName("Chrome", "Bowman Chrome Retail");
    await typeName("Chrome", "Bowman Chrome");
    await click(saveBtn(1));

    expect(mockApply.mock.calls[0][0].decisions).toEqual([{ slId: "sl-3" }]);
  });

  it("a blank name snaps back to the default and sends none", async () => {
    review = makeReview({ entries: TWIN_ENTRIES.slice(2) });
    renderModal();

    await typeName("Chrome", "   ");

    expect(nameField("Chrome").value).toBe("Bowman Chrome");
    await click(saveBtn(1));
    expect(mockApply.mock.calls[0][0].decisions).toEqual([{ slId: "sl-3" }]);
  });

  it("Escape in the field reverts it and does not close the dialog", async () => {
    review = makeReview({ entries: TWIN_ENTRIES.slice(2) });
    renderModal();
    const input = nameField("Chrome");
    input.focus();

    await act(async () => {
      fireEvent.change(input, { target: { value: "Something else" } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
    });

    expect(input.value).toBe("Bowman Chrome");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("choosing a set for a row drops its name field: a variant row is named by the server unless it was refused", async () => {
    review = makeReview({ entries: TWIN_ENTRIES.slice(2) });
    typesBySet = { "s-bowman": BOWMAN_TYPES, "s-chrome": [] };
    renderModal();
    expect(screen.queryByLabelText(slReviewCopy.nameField("Chrome"))).not.toBeNull();

    await pickSet("Chrome", "Bowman");

    expect(screen.queryByLabelText(slReviewCopy.nameField("Chrome"))).toBeNull();
  });
});

describe("SlSetReviewModal — a refused name (NEO-325)", () => {
  it("a refusal stored on the entry shows on reopen, says how many need a name, and the field points at it", () => {
    review = makeReview({
      entries: [
        { slId: "sl-1", label: "Anime", defaultName: "Bowman Anime", lastRefusal: refusal() },
        { slId: "sl-3", label: "Chrome", defaultName: "Bowman Chrome" },
      ],
    });
    renderModal();

    const text = refusedReasonText({
      slId: "sl-1",
      label: "Anime",
      ...refusal(),
    });
    const p = screen.getByText(text);
    const input = nameField("Anime");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain(p.id);
    expect(input.value).toBe("Bowman Anime");
    expect(screen.getByText(slReviewCopy.needNames(1))).toBeTruthy();
    // The other row is untouched.
    expect(nameField("Chrome").getAttribute("aria-invalid")).toBeNull();
  });

  it("the prefill is the refused name, not the default", () => {
    review = makeReview({
      entries: [
        {
          slId: "sl-1",
          label: "Anime",
          defaultName: "Bowman Anime",
          lastRefusal: refusal({ name: "Bowman Anime Try 2" }),
        },
      ],
    });
    renderModal();

    expect(nameField("Anime").value).toBe("Bowman Anime Try 2");
  });

  it.each([
    ["nameTaken", { clashWith: { _id: "x", value: "Bowman Anime" } }],
    ["existsElsewhere", { clashWith: { _id: "x", value: "Bowman Anime", brand: "Topps" } }],
    ["invalid", { clashWith: undefined, detail: "That name is too long." }],
  ] as const)("a %s refusal reads differently and names what it needs", (reason, extra) => {
    review = makeReview({
      entries: [
        {
          slId: "sl-1",
          label: "Anime",
          defaultName: "Bowman Anime",
          lastRefusal: refusal({ reason, ...extra }),
        },
      ],
    });
    renderModal();

    expect(
      screen.getByText(
        refusedReasonText({ slId: "sl-1", label: "Anime", ...refusal({ reason, ...extra }) }),
      ),
    ).toBeTruthy();
  });

  it("the three reasons say three different things", () => {
    const base = { slId: "s", label: "L", name: "N", target: "set" as const };
    const texts = new Set([
      refusedReasonText({ ...base, reason: "nameTaken", clashWith: { _id: "x" as never, value: "V" } }),
      refusedReasonText({ ...base, reason: "existsElsewhere", clashWith: { _id: "x" as never, value: "V", brand: "Topps" } }),
      refusedReasonText({ ...base, reason: "invalid", detail: "Too long." }),
    ]);
    expect(texts.size).toBe(3);
    expect(
      refusedReasonText({ ...base, reason: "existsElsewhere", clashWith: { _id: "x" as never, value: "V", brand: "Topps" } }),
    ).toContain("Topps");
  });

  it("editing the name clears the refusal; a name that only differs by case does not", async () => {
    review = makeReview({
      entries: [
        { slId: "sl-1", label: "Anime", defaultName: "Bowman Anime", lastRefusal: refusal() },
      ],
    });
    renderModal();
    const text = refusedReasonText({ slId: "sl-1", label: "Anime", ...refusal() });

    await typeName("Anime", "bowman anime");
    expect(screen.queryByText(text)).not.toBeNull();

    await typeName("Anime", "Bowman Anime Retail");
    expect(screen.queryByText(text)).toBeNull();
    expect(nameField("Anime").getAttribute("aria-invalid")).toBeNull();
  });

  it("a save that refuses a line keeps it, says how many need new names, and does not count it as still to sort", async () => {
    review = makeReview({ entries: TWIN_ENTRIES });
    mockApply.mockResolvedValue(
      okResult({
        sets: 2,
        underType: { insert: 0, parallel: 0, none: 0 },
        remaining: 1,
        refused: [
          {
            slId: "sl-1",
            label: "Anime",
            ...refusal({ clashWith: { _id: "s-existing", value: "Bowman Anime" } }),
          },
        ],
        skippedByReason: {
          notInReview: 0,
          alreadyLinked: 0,
          nameTaken: 1,
          existsElsewhere: 0,
          invalid: 0,
        },
        skipped: 1,
      }),
    );
    renderModal();
    await typeName("Anime (#sl-2)", "Bowman Anime Retail");

    await click(saveBtn(3));

    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      screen.getByText(refusedReasonText({ slId: "sl-1", label: "Anime", ...refusal() })),
    ).toBeTruthy();
    const [said] = screen
      .getAllByText(new RegExp(escapeRe(slReviewCopy.needNames(1))))
      .filter((el) => el.closest("[aria-live]") === null);
    expect(said.textContent).not.toContain("still to sort");
    expect(said.textContent).not.toMatch(/skipped/);
  });

  it("a refusal from a save outranks the one stored on the entry", async () => {
    review = makeReview({
      entries: [
        { slId: "sl-1", label: "Anime", defaultName: "Bowman Anime", lastRefusal: refusal() },
      ],
    });
    const fresh = {
      slId: "sl-1",
      label: "Anime",
      ...refusal({ reason: "invalid", detail: "That name is too long.", clashWith: undefined }),
    };
    mockApply.mockResolvedValue(
      okResult({ sets: 0, remaining: 1, refused: [fresh], underType: { insert: 0, parallel: 0, none: 0 } }),
    );
    renderModal();

    await click(saveBtn(1));

    expect(screen.queryByText(refusedReasonText({ ...fresh, ...refusal() }))).toBeNull();
    expect(screen.getByText(refusedReasonText(fresh))).toBeTruthy();
  });

  it("a save that refuses a line filed under a variant type keeps its name field, prefilled with the refused name, and says why", async () => {
    review = makeReview({
      entries: [{ slId: "sl-g", label: "Gold", defaultName: "Bowman Gold" }],
    });
    const refused = {
      slId: "sl-g",
      label: "Gold",
      ...refusal({
        name: "Gold",
        target: "variantType",
        variantTypeId: "t-parallel",
        clashWith: { _id: "r1", value: "Gold" },
      }),
    };
    mockApply.mockResolvedValue(
      okResult({ sets: 0, remaining: 1, refused: [refused], underType: { insert: 0, parallel: 0, none: 0 } }),
    );
    renderModal();
    await pickSet("Gold", "Bowman");
    await pickType("Gold", "Parallel");
    // A variant row has no name field until a save has refused it.
    expect(screen.queryByLabelText(slReviewCopy.nameField("Gold"))).toBeNull();

    await click(saveBtn(1));

    expect(nameField("Gold").value).toBe("Gold");
    expect(screen.getByText(refusedReasonText(refused))).toBeTruthy();
  });
});

describe("SlSetReviewModal — two lines with one name block Save (NEO-325)", () => {
  const clashing = [
    { slId: "sl-1", label: "Anime", twin: true, defaultName: "Bowman Anime" },
    { slId: "sl-2", label: "Anime", twin: true, defaultName: "Bowman Anime" },
  ];

  it("Save is aria-disabled with a title that is the sentence, and a press writes nothing", async () => {
    review = makeReview({ entries: clashing });
    renderModal();

    const save = saveBtn(2);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    const sentence = save.getAttribute("title")!;
    expect(sentence).toContain("Bowman Anime");
    expect(save.getAttribute("aria-describedby")).toBeTruthy();
    await click(save);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("both name fields are marked invalid and point at text that is on the page; Save points at the sentence", () => {
    review = makeReview({ entries: clashing });
    renderModal();

    for (const row of ["Anime (#sl-1)", "Anime (#sl-2)"]) {
      const input = nameField(row);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      const ids = input.getAttribute("aria-describedby")!.split(" ");
      for (const id of ids) expect(document.getElementById(id)?.textContent).toBeTruthy();
    }
    const save = saveBtn(2);
    const sentence = save
      .getAttribute("aria-describedby")!
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(sentence).toBe(save.getAttribute("title"));
  });

  it("typing a different name on one re-enables Save before the field is left", async () => {
    review = makeReview({ entries: clashing });
    renderModal();

    await act(async () => {
      fireEvent.change(nameField("Anime (#sl-2)"), { target: { value: "Bowman Anime Retail" } });
    });

    expect(saveBtn(2).hasAttribute("aria-disabled")).toBe(false);
    expect(saveBtn(2).hasAttribute("title")).toBe(false);
  });

  it("two lines that start different but are typed to one name block Save", async () => {
    review = makeReview({ entries: TWIN_ENTRIES });
    renderModal();
    expect(saveBtn(3).getAttribute("aria-disabled")).toBe("true");
    await typeName("Anime (#sl-1)", "Bowman Anime A");
    await typeName("Anime (#sl-2)", "Bowman Anime B");
    expect(saveBtn(3).hasAttribute("aria-disabled")).toBe(false);

    await typeName("Anime (#sl-2)", "bowman anime a");

    expect(saveBtn(3).getAttribute("aria-disabled")).toBe("true");
  });

  it("a line filed under a set is not an own-set name: it never clashes", async () => {
    review = makeReview({ entries: clashing });
    renderModal();
    await pickSet("Anime (#sl-2)", "Bowman");
    await pickType("Anime (#sl-2)", "Parallel");

    expect(saveBtn(2).hasAttribute("aria-disabled")).toBe(false);
  });
});

describe("SlSetReviewModal — the name field keeps focus and says what it needs (NEO-325 a11y)", () => {
  it("Enter commits the name and focus stays on the SAME field, which sends the name on Save", async () => {
    review = makeReview({ entries: TWIN_ENTRIES.slice(2) });
    renderModal();
    const input = nameField("Chrome");
    input.focus();

    await act(async () => {
      fireEvent.change(input, { target: { value: "  Bowman Chrome Retail  " } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(nameField("Chrome")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Bowman Chrome Retail");
    await click(saveBtn(1));
    expect(mockApply.mock.calls[0][0].decisions).toEqual([
      { slId: "sl-3", name: "Bowman Chrome Retail" },
    ]);
  });

  it("Escape reverts the name and focus stays on the SAME field", async () => {
    review = makeReview({ entries: TWIN_ENTRIES.slice(2) });
    renderModal();
    const input = nameField("Chrome");
    input.focus();
    await act(async () => {
      fireEvent.change(input, { target: { value: "Something else" } });
    });

    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
    });

    expect(nameField("Chrome")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Bowman Chrome");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("takes at most the store's name ceiling, and always carries the rename tip as its placeholder", () => {
    review = makeReview({ entries: TWIN_ENTRIES.slice(2) });
    renderModal();

    expect(nameField("Chrome").maxLength).toBe(MAX_SELECTOR_VALUE_LENGTH);
    expect(nameField("Chrome").placeholder).toBe(RENAME_TIP);
  });

  it("a clashing name is described by its own line first, then the footer sentence", () => {
    review = makeReview({
      entries: [
        { slId: "sl-1", label: "Anime", twin: true, defaultName: "Bowman Anime", lastRefusal: refusal() },
        { slId: "sl-2", label: "Anime", twin: true, defaultName: "Bowman Anime" },
      ],
    });
    renderModal();

    const second = nameField("Anime (#sl-2)").getAttribute("aria-describedby")!.split(" ");
    expect(second).toHaveLength(2);
    expect(document.getElementById(second[0])?.textContent).toContain(TITLE_CLASH_ROW_LINE);
    expect(saveBtn(2).getAttribute("aria-describedby")).toContain(second[1]);

    // With a refusal as well: row line, then the refusal, then the footer.
    const first = nameField("Anime (#sl-1)").getAttribute("aria-describedby")!.split(" ");
    expect(first).toHaveLength(3);
    expect(document.getElementById(first[0])?.textContent).toContain(TITLE_CLASH_ROW_LINE);
    expect(document.getElementById(first[1])?.textContent).toBe(
      refusedReasonText({ slId: "sl-1", label: "Anime", ...refusal() }),
    );
    expect(first[2]).toBe(second[1]);
  });

  it("a name that does not clash has no row line", () => {
    review = makeReview({ entries: TWIN_ENTRIES.slice(2) });
    renderModal();

    expect(screen.queryByText(TITLE_CLASH_ROW_LINE, { exact: false })).toBeNull();
    expect(nameField("Chrome").hasAttribute("aria-describedby")).toBe(false);
  });

  it("pressing Save while names clash focuses the first field that needs a new name and writes nothing", async () => {
    review = makeReview({
      entries: [
        { slId: "sl-3", label: "Chrome", defaultName: "Bowman Chrome" },
        { slId: "sl-1", label: "Anime", twin: true, defaultName: "Bowman Anime" },
        { slId: "sl-2", label: "Anime", twin: true, defaultName: "Bowman Anime" },
      ],
    });
    renderModal();
    saveBtn(3).focus();

    await click(saveBtn(3));

    expect(document.activeElement).toBe(nameField("Anime (#sl-1)"));
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("pressing Save while ONLY a type is missing does not move focus to some other invalid field, and writes nothing", async () => {
    // Chrome's field is aria-invalid (a stored refusal) but nothing CLASHES, so
    // the only reason Save waits is Gold's missing type.
    review = makeReview({
      entries: [
        { slId: "sl-3", label: "Chrome", defaultName: "Bowman Chrome", lastRefusal: refusal({ name: "Bowman Chrome" }) },
        { slId: "sl-g", label: "Gold", defaultName: "Bowman Gold" },
      ],
    });
    renderModal();
    await pickSet("Gold", "Bowman");
    expect(nameField("Chrome").getAttribute("aria-invalid")).toBe("true");
    expect(saveBtn(2).getAttribute("aria-disabled")).toBe("true");
    saveBtn(2).focus();

    await click(saveBtn(2));

    expect(document.activeElement).toBe(saveBtn(2));
    expect(mockApply).not.toHaveBeenCalled();
  });
});

describe("SlSetReviewModal — a refused variant-type line (NEO-325)", () => {
  const GOLD = [{ slId: "sl-g", label: "Gold", defaultName: "Bowman Gold" }];
  const typeRefusal = (over: Record<string, unknown> = {}) => ({
    name: "Gold",
    reason: "nameTaken" as const,
    target: "variantType" as const,
    variantTypeId: "t-parallel" as never,
    clashWith: { _id: "r1" as never, value: "Gold" },
    ...over,
  });
  const refusedLine = (over: Record<string, unknown> = {}) => ({
    slId: "sl-g",
    label: "Gold",
    ...typeRefusal(over),
  });
  const noneLeft = { underType: { insert: 0, parallel: 0, none: 0 } };

  it("once renamed, the line keeps its field with the new name, and the re-save sends that name", async () => {
    review = makeReview({ entries: GOLD });
    mockApply.mockResolvedValueOnce(
      okResult({ sets: 0, remaining: 1, refused: [refusedLine()], ...noneLeft }),
    );
    renderModal();
    await pickSet("Gold", "Bowman");
    await pickType("Gold", "Parallel");
    await click(saveBtn(1));
    expect(nameField("Gold").value).toBe("Gold");

    await typeName("Gold", "Gold Retail");

    // The refusal is set aside, and the field is still there holding the name.
    expect(screen.queryByText(refusedReasonText(refusedLine()))).toBeNull();
    expect(nameField("Gold").value).toBe("Gold Retail");
    expect(nameField("Gold").getAttribute("aria-invalid")).toBeNull();

    await click(saveBtn(1));

    expect(mockApply).toHaveBeenCalledTimes(2);
    const second = mockApply.mock.calls[1][0].decisions as Array<Record<string, unknown>>;
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ slId: "sl-g", variantTypeId: "t-parallel", name: "Gold Retail" });
  });

  it("a variant-type refusal stored on the entry shows as 'not filed last time', counts as needing a name, and has no field to retype in", () => {
    review = makeReview({ entries: [{ ...GOLD[0], lastRefusal: typeRefusal() }] });
    renderModal();

    const reason = refusedReasonText(refusedLine());
    expect(screen.getByText(slReviewCopy.refusedParked(reason))).toBeTruthy();
    expect(screen.getByText(slReviewCopy.needNames(1))).toBeTruthy();
    // The refusal belongs to the type, not to the own-set name beside it.
    expect(screen.queryByText(reason)).toBeNull();
    expect(nameField("Gold").getAttribute("aria-invalid")).toBeNull();
  });

  it("picking that set and type again brings its refusal and field back, with the refused name", async () => {
    review = makeReview({ entries: [{ ...GOLD[0], lastRefusal: typeRefusal({ name: "Gold Try 2" }) }] });
    renderModal();
    const reason = refusedReasonText(refusedLine({ name: "Gold Try 2" }));

    await pickSet("Gold", "Bowman");
    // Filed under the set but no type yet: the parked line is gone, the type's
    // field is not back until the refused type is picked.
    expect(screen.queryByText(slReviewCopy.refusedParked(reason))).toBeNull();
    await pickType("Gold", "Parallel");

    expect(nameField("Gold").value).toBe("Gold Try 2");
    expect(nameField("Gold").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(reason)).toBeTruthy();
  });

  it("a refusal for one type is not shown under another type of the same set", async () => {
    review = makeReview({ entries: [{ ...GOLD[0], lastRefusal: typeRefusal() }] });
    renderModal();
    const reason = refusedReasonText(refusedLine());

    await pickSet("Gold", "Bowman");
    await pickType("Gold", "Insert");

    expect(screen.queryByText(reason)).toBeNull();
    expect(screen.queryByLabelText(slReviewCopy.nameField("Gold"))).toBeNull();
  });
});

describe("slReviewCopy.refusedInvalid (NEO-325)", () => {
  const cases: Array<[string, string]> = [
    ["blank", "   "],
    ["too long", "x".repeat(MAX_SELECTOR_VALUE_LENGTH + 1)],
    ["line break", "Bowman\nAnime"],
    ["control character", "Bowman\u0007Anime"],
    ["hidden character", "Bowman\u200bAnime"],
  ];

  it("every name the store would refuse gets a sentence of its own", () => {
    for (const [, name] of cases) expect(checkSelectorValue(name).ok).toBe(false);
    const texts = cases.map(([, name]) => slReviewCopy.refusedInvalid(name));
    // Blank, too long, line break (and control), hidden: four different ones.
    expect(new Set(texts).size).toBe(4);
    expect(texts[2]).toBe(texts[3]);
  });

  it("the too-long sentence states the ceiling", () => {
    expect(slReviewCopy.refusedInvalid("x".repeat(MAX_SELECTOR_VALUE_LENGTH + 1))).toContain(
      String(MAX_SELECTOR_VALUE_LENGTH),
    );
  });

  it("a name that is fine by the checks still gets a generic sentence, different from the others", () => {
    const generic = slReviewCopy.refusedInvalid("Bowman Anime");
    for (const [, name] of cases) expect(slReviewCopy.refusedInvalid(name)).not.toBe(generic);
  });

  it("a name that is too long is judged before its characters, and blank before both", () => {
    const longWithBreak = `${"x".repeat(MAX_SELECTOR_VALUE_LENGTH)}\n`.padEnd(MAX_SELECTOR_VALUE_LENGTH + 5, "y");
    expect(slReviewCopy.refusedInvalid(longWithBreak)).toBe(
      slReviewCopy.refusedInvalid("x".repeat(MAX_SELECTOR_VALUE_LENGTH + 1)),
    );
  });

  it("the reason on a refused line is read from the NAME it refused, not the server's detail", () => {
    const line = {
      slId: "s",
      label: "L",
      name: "Bowman\u200bAnime",
      reason: "invalid" as const,
      target: "set" as const,
      detail: "Name cannot contain zero-width or invisible characters",
    };
    expect(refusedReasonText(line)).toBe(slReviewCopy.refusedInvalid(line.name));
    expect(refusedReasonText(line)).not.toContain("zero-width");
  });
});

/**
 * NEO-71–74 regression coverage — SetAttributesPanel write-once feature
 * snapshots.
 *
 * This redesign made every `selectorOptions` row's `features` map a
 * COMPLETE, self-contained snapshot computed once at row-creation time (see
 * `convex/features/deriveCardFeatures.ts`). There is deliberately no
 * client-side ancestor-walk/inheritance computation left in the panel — it
 * reads `row.features[key]` directly. This file locks in:
 *
 *   1. Feature values render directly from `row.features[key]` — no
 *      "Inherited from X" text anywhere (that UI was deleted this session).
 *   2. `manufacturer`/`cardType`/`parallelName` are gone from
 *      EXPECTED_FEATURES entirely (confirmed-redundant — see
 *      expectedFeatures.ts) and never render at ANY level, not just hidden
 *      at some. The `applicableAtLevels` field that used to gate them was
 *      removed from the `ExpectedFeature` type along with the corresponding
 *      filter logic — there is no such field/logic left to test.
 *   3. `applicableSports` filtering still works (League hidden for Pokemon).
 *   4. Editing a feature calls `setSelectorOptionFeature(selectorOptionId,
 *      key, value)` and shows a "Saved {label}" toast — no "propagated to N
 *      cards" language (that no longer exists; propagation was removed).
 *   5. There is no "missing"/required warning treatment anywhere — none of
 *      these fields are actually required, so a blank row renders exactly
 *      like a filled-in one (the old amber border/⚠ icon/"N missing" badge
 *      were removed this session).
 *   6. Toggle-like features (`inputType === "checkbox" || "toggleOptions"`)
 *      are partitioned out of the 2-column grid and rendered together in one
 *      shared `role="group" aria-label="Set attribute toggles"` row — Vintage
 *      (now an editable checkbox, no longer read-only "derived" text),
 *      Reprint, Case Hit (new), Autographed (now toggle pills, not a
 *      `<select>`), and Short Print (same) all live there; plain text/select
 *      fields like Season stay in the grid below.
 *   7. `block`/`upc` are gone from EXPECTED_FEATURES entirely too (case/
 *      box-level facts, not set- or card-level ones) — covered in
 *      expectedFeatures.test.ts, not re-tested here.
 *   8. `signedBy` is now `hiddenAtLevels: ["set"]` — card-level only, since a
 *      whole set signed by one person is vanishingly rare.
 *
 * releaseDate/totalCardCount/block used to live in a separate `setMetadata`
 * object editable only at the setName level (a since-removed `setSetMetadata`
 * mutation). They're now plain features like everything else — this file no
 * longer mocks that mutation at all.
 *
 * --- Mocking strategy (mirrors EntityColumn.field-class.test.tsx /
 * drill-forms-onDone.test.tsx) ---
 * convex/react's useQuery/useMutation are module-mocked. useQuery is routed
 * by the (string-mocked) query reference so getSelectorOptionById and
 * getAncestorChain can return independently-controlled fixtures per test.
 * useMutation is routed the same way so setSelectorOptionFeature resolves to
 * a spy.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptionById: "getSelectorOptionById",
      getAncestorChain: "getAncestorChain",
      setSelectorOptionFeature: "setSelectorOptionFeature",
      getSelectorOptionHoldings: "getSelectorOptionHoldings",
      deleteSelectorOption: "deleteSelectorOption",
    },
  },
}));

const mockSetSelectorOptionFeature = vi.fn();
const mockDeleteSelectorOption = vi.fn();

let currentRow: unknown;
let currentChain: unknown;
/** `getSelectorOptionHoldings` — undefined means "still counting". */
let currentHoldings: unknown;

vi.mock("convex/react", () => ({
  useQuery: (query: string) => {
    if (query === "getSelectorOptionById") return currentRow;
    if (query === "getAncestorChain") return currentChain;
    if (query === "getSelectorOptionHoldings") return currentHoldings;
    return undefined;
  },
  useMutation: (mutation: string) => {
    if (mutation === "setSelectorOptionFeature")
      return mockSetSelectorOptionFeature;
    if (mutation === "deleteSelectorOption") return mockDeleteSelectorOption;
    return vi.fn();
  },
}));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks
// ---------------------------------------------------------------------------

import SetAttributesPanel from "./SetAttributesPanel";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SELECTOR_OPTION_ID = "selector-option-id-1" as unknown as Parameters<
  typeof SetAttributesPanel
>[0]["selectorOptionId"];

function makeRow(overrides: Partial<{
  level: string;
  value: string;
  isCustom: boolean;
  features: Record<string, string>;
  platformData: Record<string, Record<string, string>>;
}> = {}) {
  return {
    _id: SELECTOR_OPTION_ID,
    level: "setName",
    value: "2024 Topps Chrome",
    features: {},
    ...overrides,
  };
}

function makeChain(sport = "Baseball") {
  return [
    { _id: "sport-id", value: sport, level: "sport" },
    { _id: "year-id", value: "2024", level: "year" },
    { _id: "mfr-id", value: "Topps", level: "manufacturer" },
    { _id: "set-id", value: "2024 Topps Chrome", level: "setName" },
  ];
}

function renderPanel(onDeleted?: (level: string) => void) {
  return render(
    <SetAttributesPanel
      selectorOptionId={SELECTOR_OPTION_ID}
      defaultCollapsed={false}
      onDeleted={onDeleted as never}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SetAttributesPanel — write-once feature snapshot reads (NEO-71-74)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetSelectorOptionFeature.mockResolvedValue(undefined);
    mockDeleteSelectorOption.mockResolvedValue({ deleted: true });
    currentHoldings = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a row's own features[key] directly, with no 'Inherited' text anywhere", () => {
    currentRow = makeRow({
      level: "setName",
      features: { league: "MLB", era: "Modern (1980-Now)", manufacturer: "Topps" },
    });
    currentChain = makeChain("Baseball");

    renderPanel();

    // League select shows the row's own value.
    const leagueSelect = screen.getByLabelText(
      "Value for League",
    ) as HTMLSelectElement;
    expect(leagueSelect.value).toBe("MLB");

    const eraSelect = screen.getByLabelText("Value for Era") as HTMLSelectElement;
    expect(eraSelect.value).toBe("Modern (1980-Now)");

    // The deleted inheritance-hint UI must never appear.
    expect(screen.queryByText(/Inherited/i)).toBeNull();
  });

  it("does NOT render Card Type or Variation rows at sport/year/manufacturer/setName levels", () => {
    for (const level of ["sport", "year", "manufacturer", "setName"]) {
      currentRow = makeRow({ level, value: `node-${level}`, features: {} });
      currentChain = makeChain("Baseball");

      const { unmount } = renderPanel();

      expect(screen.queryByLabelText("Set feature Card Type")).toBeNull();
      expect(screen.queryByLabelText("Set feature Variation")).toBeNull();

      unmount();
    }
  });

  it("does NOT render Card Type or Variation rows at variantType/insert/parallel levels either — both were removed entirely, not just hidden at other levels", () => {
    // Old behavior gated these two rows to variantType/insert/parallel via
    // `applicableAtLevels`. Both the field and the gating logic are gone now
    // (manufacturer/cardType/parallelName were removed from EXPECTED_FEATURES
    // entirely — see expectedFeatures.ts), so these rows must be absent here
    // too, even though a stray `cardType`/`parallelName` key is still present
    // in the row's `features` map (e.g. from data written before the
    // removal) — nothing reads those keys anymore.
    for (const level of ["variantType", "insert", "parallel"]) {
      currentRow = makeRow({
        level,
        value: `node-${level}`,
        features: { cardType: "Base", parallelName: "Gold" },
      });
      currentChain = makeChain("Baseball");

      const { unmount } = renderPanel();

      expect(screen.queryByLabelText("Set feature Card Type")).toBeNull();
      expect(screen.queryByLabelText("Set feature Variation")).toBeNull();
      expect(screen.queryByLabelText("Value for Card Type")).toBeNull();
      expect(screen.queryByLabelText("Value for Variation")).toBeNull();

      unmount();
    }
  });

  it("does not render Signed By at the set level — card-level only, a whole set signed by one person is vanishingly rare", () => {
    currentRow = makeRow({
      level: "setName",
      features: { signedBy: "Mike Trout" },
    });
    currentChain = makeChain("Baseball");

    renderPanel();

    expect(screen.queryByLabelText("Set feature Signed By")).toBeNull();
    expect(screen.queryByLabelText("Value for Signed By")).toBeNull();
  });

  it("hides League for a non stick-and-ball sport (Pokemon) via applicableSports + ancestorSport", () => {
    currentRow = makeRow({ level: "setName", features: {} });
    currentChain = makeChain("Pokemon");

    renderPanel();

    expect(screen.queryByLabelText("Set feature League")).toBeNull();
    // Era has no applicableSports restriction — still shows for Pokemon.
    expect(screen.getByLabelText("Set feature Era")).toBeTruthy();
  });

  it("shows League for a stick-and-ball sport (Baseball)", () => {
    currentRow = makeRow({ level: "setName", features: {} });
    currentChain = makeChain("Baseball");

    renderPanel();

    expect(screen.getByLabelText("Set feature League")).toBeTruthy();
  });

  it("calls setSelectorOptionFeature(selectorOptionId, key, value) and shows a 'Saved {label}' toast on edit, without any propagation language", async () => {
    currentRow = makeRow({
      level: "setName",
      features: { season: "" },
    });
    currentChain = makeChain("Baseball");

    renderPanel();

    // signedBy is card-level only (hiddenAtLevels: ["set"]) — a whole set
    // being signed by one person is vanishingly rare — so this generic
    // "edit a text feature at the set level" test uses "season" instead,
    // which is still a plain text feature applicable at every set level.
    const seasonInput = screen.getByLabelText(
      "Value for Season",
    ) as HTMLInputElement;

    await act(async () => {
      // Real focus() + synthetic focus (sets both document.activeElement and
      // the hook's internal focusedRef — see useReactiveField.test.tsx).
      seasonInput.focus();
      fireEvent.focus(seasonInput);
      seasonInput.value = "2020-21";
      fireEvent.input(seasonInput, { target: { value: "2020-21" } });
      seasonInput.blur();
      fireEvent.blur(seasonInput);
    });

    await waitFor(() => {
      expect(mockSetSelectorOptionFeature).toHaveBeenCalledWith({
        selectorOptionId: SELECTOR_OPTION_ID,
        key: "season",
        value: "2020-21",
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Saved Season")).toBeTruthy();
    });

    // The old propagation-count toast copy must never appear.
    expect(screen.queryByText(/propagated/i)).toBeNull();
    expect(screen.queryByText(/updated \d+ cards/i)).toBeNull();
  });

  it("never shows a missing-count badge or amber warning, even with every field blank", () => {
    // None of these fields are required — a totally blank row (nothing set
    // at all) must render with no "N missing" badge and no amber/⚠
    // treatment on any row, collapsed or expanded.
    currentRow = makeRow({ level: "setName", features: {} });
    currentChain = makeChain("Baseball");

    const { unmount } = render(
      <SetAttributesPanel
        selectorOptionId={SELECTOR_OPTION_ID}
        defaultCollapsed={true}
      />,
    );
    expect(screen.queryByText(/\d+ missing/i)).toBeNull();
    unmount();

    render(
      <SetAttributesPanel
        selectorOptionId={SELECTOR_OPTION_ID}
        defaultCollapsed={false}
      />,
    );
    expect(screen.queryByText(/\d+ missing/i)).toBeNull();
    expect(screen.queryByLabelText("Missing required feature")).toBeNull();
    expect(screen.queryByText("⚠")).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Toggle-pill row grouping (NEO-71-74 redesign): checkbox + toggleOptions
  // features render together in one shared row, above the 2-column grid of
  // remaining text/select fields.
  // ---------------------------------------------------------------------

  it("groups every checkbox/toggleOptions feature into the 'Set attribute toggles' row, excluding plain text/select fields", () => {
    currentRow = makeRow({ level: "setName", features: {} });
    currentChain = makeChain("Baseball");

    renderPanel();

    const toggleGroup = screen.getByRole("group", {
      name: "Set attribute toggles",
    });

    // Vintage/Reprint/Case Hit (checkboxes) + Autographed/Short Print pills
    // (toggleOptions) all live inside the shared toggle row.
    for (const label of [
      "Value for Vintage",
      "Value for Reprint",
      "Value for Case Hit",
      "Value for Autographed: Auto (On Card)",
      "Value for Autographed: Auto (Sticker)",
      "Value for Short Print: SP",
      "Value for Short Print: SSP",
    ]) {
      expect(within(toggleGroup).getByLabelText(label)).toBeTruthy();
    }

    // A plain text field (no inputType override) must NOT be in the toggle
    // row — it stays in the 2-column grid below.
    expect(within(toggleGroup).queryByLabelText("Value for Season")).toBeNull();
    expect(screen.getByLabelText("Value for Season")).toBeTruthy();
  });

  it("Vintage renders as an interactive toggle pill (not static read-only text) and saves via setSelectorOptionFeature", async () => {
    currentRow = makeRow({ level: "setName", features: { vintage: "false" } });
    currentChain = makeChain("Baseball");

    renderPanel();

    const vintageToggle = screen.getByLabelText("Value for Vintage");
    // The old "derived" inputType rendered a bare read-only <span>; the new
    // checkbox inputType renders an actual <button> pill.
    expect(vintageToggle.tagName).toBe("BUTTON");
    expect(vintageToggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(vintageToggle);

    await waitFor(() => {
      expect(mockSetSelectorOptionFeature).toHaveBeenCalledWith({
        selectorOptionId: SELECTOR_OPTION_ID,
        key: "vintage",
        value: "true",
      });
    });
  });

  it("Case Hit is a new checkbox toggle that saves via setSelectorOptionFeature", async () => {
    currentRow = makeRow({ level: "setName", features: {} });
    currentChain = makeChain("Baseball");

    renderPanel();

    const caseHitToggle = screen.getByLabelText("Value for Case Hit");
    expect(caseHitToggle.tagName).toBe("BUTTON");
    expect(caseHitToggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(caseHitToggle);

    await waitFor(() => {
      expect(mockSetSelectorOptionFeature).toHaveBeenCalledWith({
        selectorOptionId: SELECTOR_OPTION_ID,
        key: "isCaseHit",
        value: "true",
      });
    });
  });
});

/**
 * NEO-219 part 3 — the one sanctioned delete.
 *
 * "Sets are fixed, never deleted" still holds; the single exception agreed
 * 2026-09-03 is a row with NOTHING below it. These tests pin the two halves
 * that make that exception safe to offer at all:
 *
 *   • the affordance never lies — it is inert, and says in words what is below
 *     the row, rather than greying out and leaving the operator to guess;
 *   • the client gate is only an affordance. The server re-checks, and when it
 *     refuses (the row stopped being empty while the dialog was open) the
 *     refusal is rendered INSIDE the dialog, where the question was asked,
 *     instead of the dialog closing as if it had worked.
 *
 * The trash is hidden — not disabled — for a protected row, which is exactly
 * the call the rename pencil already makes for a non-custom variantType: a
 * control that can only ever refuse is worse than no control.
 */
describe("SetAttributesPanel — delete affordance (NEO-219)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteSelectorOption.mockResolvedValue({ deleted: true });
    currentChain = makeChain("Baseball");
    currentHoldings = undefined;
  });

  it("is inert and names what is below the row when holdings exist", () => {
    currentRow = makeRow({ level: "manufacturer", value: "Topps" });
    // Exactly the server's shape: `kind: "rows"` names the children's level
    // when they share one. The noun is the operator's only clue about what is
    // in the way, so it comes from the server rather than being guessed here.
    currentHoldings = {
      holds: [
        {
          kind: "rows",
          count: 3,
          level: "setName",
          examples: ["Chrome", "Update", "Heritage"],
        },
        { kind: "cards", count: 220, examples: ["#1 Trout"] },
      ],
      protected: false,
    };

    renderPanel();

    const trash = screen.getByLabelText("Delete Topps");
    expect(trash.getAttribute("aria-disabled")).toBe("true");

    // The reason is in the DOM at all times as the button's described-by
    // target, so a screen reader hears it without any interaction.
    const reason = screen.getByText(
      "Holds 3 sets and 220 cards — delete what is below it first",
    );
    expect(trash.getAttribute("aria-describedby")).toBe(reason.id);

    // Clicking an inert control must not open the dialog — it answers the
    // question the inert state raises instead.
    fireEvent.click(trash);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockDeleteSelectorOption).not.toHaveBeenCalled();
  });

  it("says the neutral 'rows' when the children are mixed levels and the server names none", () => {
    // A variantType holding both inserts and parallels: the server OMITS
    // `level` because no single noun is right. Inventing one from the parent's
    // level would name the wrong thing in exactly that case, so the sentence
    // stays neutral instead.
    currentRow = makeRow({
      level: "variantType",
      value: "Inserts",
      isCustom: true,
    });
    currentHoldings = {
      holds: [{ kind: "rows", count: 3, examples: ["Gold", "Refractor"] }],
      protected: false,
    };

    renderPanel();

    expect(
      screen.getByText("Holds 3 rows — delete what is below it first"),
    ).toBeTruthy();
  });

  it("names an in-flight checklist review with its own remedy, not 'delete what is below it'", () => {
    // A review is work in progress ON the row, not a thing below it, so the
    // instruction has to differ: telling an operator to delete their way out
    // of a review they are halfway through is the wrong answer.
    currentRow = makeRow({ level: "setName", value: "2024 Topps Chrome" });
    currentHoldings = {
      holds: [{ kind: "review", count: 1, examples: ["#12 Trout"] }],
      protected: false,
    };

    const { unmount } = renderPanel();

    expect(
      screen.getByLabelText("Delete 2024 Topps Chrome").getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen.getByText(
        "A checklist review is in progress here — finish or cancel it first",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/delete what is below it first/)).toBeNull();
    unmount();

    // Both remedies can be true at once, so both are stated — and the review
    // clause pluralises like every other count in this sentence.
    currentHoldings = {
      holds: [
        { kind: "rows", count: 2, level: "variantType", examples: ["Base"] },
        { kind: "review", count: 3, examples: [] },
      ],
      protected: false,
    };
    renderPanel();
    expect(
      screen.getByText(
        "Holds 2 variant types — delete what is below it first; 3 checklist reviews are in progress here — finish or cancel them first",
      ),
    ).toBeTruthy();
  });

  it("is inert while the holdings query is still in flight — never optimistically deletable", () => {
    currentRow = makeRow({ level: "setName" });
    currentHoldings = undefined;

    renderPanel();

    const trash = screen.getByLabelText("Delete 2024 Topps Chrome");
    expect(trash.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Checking what is below it…")).toBeTruthy();
  });

  it("is hidden entirely for a protected row, and for the same rows the rename pencil refuses", () => {
    // Server-side protection (refusesValueRename) — hidden, not disabled.
    currentRow = makeRow({ level: "insert", value: "Refractors" });
    currentHoldings = { holds: [], protected: true };
    const { unmount } = renderPanel();
    expect(screen.queryByLabelText("Delete Refractors")).toBeNull();
    unmount();

    // Client-side, before the query answers: a non-custom variantType is
    // structural — canRenameSelectorRow already says so, and delete follows it.
    currentRow = makeRow({ level: "variantType", value: "Base" });
    currentHoldings = { holds: [], protected: false };
    renderPanel();
    expect(screen.queryByLabelText("Delete Base")).toBeNull();
    expect(screen.queryByLabelText("Rename Base")).toBeNull();
  });

  it("confirms, deletes, and hands the level back to its owner", async () => {
    currentRow = makeRow({ level: "setName", value: "2024 Topps Chrome" });
    currentHoldings = { holds: [], protected: false };
    const onDeleted = vi.fn();

    renderPanel(onDeleted);

    fireEvent.click(screen.getByLabelText("Delete 2024 Topps Chrome"));

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText('Delete Set "2024 Topps Chrome"?'),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("Nothing is below it. This cannot be undone."),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, delete" }));

    await waitFor(() => {
      expect(mockDeleteSelectorOption).toHaveBeenCalledWith({
        id: SELECTOR_OPTION_ID,
      });
    });
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("setName"));
  });

  it("renders the server's holds message inside the dialog when the row stopped being empty", async () => {
    currentRow = makeRow({ level: "setName", value: "2024 Topps Chrome" });
    currentHoldings = { holds: [], protected: false };
    mockDeleteSelectorOption.mockRejectedValue({
      data: {
        code: "SELECTOR_ROW_NOT_EMPTY",
        holds: [{ kind: "cards", count: 4, examples: ["#1", "#2"] }],
      },
    });
    const onDeleted = vi.fn();

    renderPanel(onDeleted);

    fireEvent.click(screen.getByLabelText("Delete 2024 Topps Chrome"));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));

    await waitFor(() => {
      expect(
        screen.getByRole("alert").textContent,
      ).toBe("Holds 4 cards — delete what is below it first");
    });
    // The dialog stays open — the answer belongs where the question was asked.
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("warns that a marketplace-linked row may come back, and only then", () => {
    // No ids attached: nothing will re-create it, so no sentence.
    currentRow = makeRow({ level: "setName", value: "2024 Topps Chrome" });
    currentHoldings = { holds: [], protected: false };
    const { unmount } = renderPanel();
    fireEvent.click(screen.getByLabelText("Delete 2024 Topps Chrome"));
    expect(screen.getByRole("dialog").textContent).not.toContain(
      "the next sync may add it back",
    );
    unmount();

    // A BSC slug is attached: the next Sync Sets will re-insert this row, and
    // an operator who is not told that reads the reappearance as a bug.
    currentRow = makeRow({
      level: "setName",
      value: "2024 Topps Chrome",
      platformData: { bsc: { b0: "2024-topps-chrome" } },
    });
    renderPanel();
    fireEvent.click(screen.getByLabelText("Delete 2024 Topps Chrome"));
    expect(screen.getByRole("dialog").textContent).toContain(
      "It is linked to BSC; the next sync may add it back.",
    );
  });
});

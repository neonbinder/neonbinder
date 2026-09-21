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
import { ConvexError } from "convex/values";
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
      renameSelectorOption: "renameSelectorOption",
      setBaseVariantType: "setBaseVariantType",
      // NEO-291
      setSelectorOptionCardNumberPrefix: "setSelectorOptionCardNumberPrefix",
      // NEO-277
      setSelectorOptionTeams: "setSelectorOptionTeams",
      getSelectorOptionTeamCascadePreview:
        "getSelectorOptionTeamCascadePreview",
    },
    teams: {
      getManyByIds: "teams.getManyByIds",
    },
    // NEO-279 — the header's Fill teams control reads these at render.
    teamFill: {
      previewTeamFill: "teamFill.previewTeamFill",
      applyTeamFill: "teamFill.applyTeamFill",
    },
    // NEO-237 — the Brand row's save, bound at render on every level.
    brandView: {
      setSelectorOptionSetNamePrefix: "brandView.setSelectorOptionSetNamePrefix",
    },
  },
}));

const mockSetSelectorOptionFeature = vi.fn();
const mockSetBaseVariantType = vi.fn();
const mockDeleteSelectorOption = vi.fn();
/** NEO-291 */
const mockSetSelectorOptionCardNumberPrefix = vi.fn();
/** NEO-277 */
const mockSetSelectorOptionTeams = vi.fn();
/**
 * NEO-277 — the Team row's two one-shot reads go through `useConvex().query`,
 * not `useQuery`; routed by the same string refs.
 */
const mockConvexQuery = vi.fn();

let currentRow: unknown;
let currentChain: unknown;
/** `getSelectorOptionHoldings` — undefined means "still counting". */
let currentHoldings: unknown;
/**
 * NEO-277: `teams.getManyByIds` — the collapsed bar's livery and the Team
 * row's own read of its stored team (for "Keep {team}" and the clear confirm).
 */
let currentTeamRows: unknown;
/** NEO-277: the team the mocked picker's trigger adds on click. */
let pickNext = "team-bulls";

vi.mock("convex/react", () => ({
  useQuery: (query: string) => {
    if (query === "getSelectorOptionById") return currentRow;
    if (query === "getAncestorChain") return currentChain;
    if (query === "getSelectorOptionHoldings") return currentHoldings;
    if (query === "teams.getManyByIds") return currentTeamRows;
    return undefined;
  },
  useMutation: (mutation: string) => {
    if (mutation === "setSelectorOptionFeature")
      return mockSetSelectorOptionFeature;
    if (mutation === "deleteSelectorOption") return mockDeleteSelectorOption;
    if (mutation === "setBaseVariantType") return mockSetBaseVariantType;
    if (mutation === "setSelectorOptionCardNumberPrefix")
      return mockSetSelectorOptionCardNumberPrefix;
    if (mutation === "setSelectorOptionTeams") return mockSetSelectorOptionTeams;
    return vi.fn();
  },
  useConvex: () => ({ query: mockConvexQuery }),
  // NEO-279 — FillTeamsControl mounts on every setName row; its actions are
  // inert here (its own behaviour is covered in FillTeamsControl's tests).
  useAction: () => vi.fn(),
}));

/**
 * NEO-277 — a stand-in for the real picker (same shape the card drawer's
 * tests use): the panel's contract with it is `value` in, the full next array
 * out. Two buttons stand in for a pick and a chip removal; `disabled` is
 * forwarded so the busy window can be asserted.
 */
vi.mock("./TeamPicker", () => ({
  // The real defaults, so the no-substring pin below measures against what
  // every other caller actually renders.
  DEFAULT_TEAM_PICKER_LABELS: {
    root: "Team picker",
    trigger: "Add team",
    search: "Search teams",
    results: "Team typeahead results",
  },
  default: ({
    value,
    onChange,
    sportId,
    disabled,
    labels,
    ariaDescribedBy,
  }: {
    value: string[];
    onChange: (next: string[]) => void;
    sportId?: string;
    disabled?: boolean;
    labels: { root: string; trigger: string; search: string; results: string };
    ariaDescribedBy?: string;
  }) => (
    <div aria-label={labels.root} data-sport-id={sportId ?? ""}>
      <span data-testid="team-picker-value">{value.join(",")}</span>
      {/* Mirrors the real trigger: visible text is `+ {labels.trigger}` and the
          hint id lands on it. A pick adds whichever team `pickNext` names. */}
      <button
        type="button"
        aria-label={labels.trigger}
        aria-describedby={ariaDescribedBy}
        disabled={disabled}
        onClick={() => onChange([...value, pickNext])}
      >
        + {labels.trigger}
      </button>
      {value.map((id) => (
        <button
          key={id}
          type="button"
          aria-label={`Remove team ${id}`}
          disabled={disabled}
          onClick={() => onChange(value.filter((v) => v !== id))}
        >
          ×
        </button>
      ))}
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks
// ---------------------------------------------------------------------------

import SetAttributesPanel, {
  SET_TEAM_PICKER_LABELS,
  teamCascadeConfirmCopy,
  teamClearConfirmCopy,
  teamSavedToast,
} from "./SetAttributesPanel";
import { DEFAULT_TEAM_PICKER_LABELS } from "./TeamPicker";
import { FILL_TEAMS_LABEL, FILL_TEAMS_LIST_LABEL } from "./FillTeamsControl";

/** The set row's picker trigger — see SET_TEAM_PICKER_LABELS. */
const PICK = SET_TEAM_PICKER_LABELS.trigger;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SELECTOR_OPTION_ID = "selector-option-id-1" as unknown as Parameters<
  typeof SetAttributesPanel
>[0]["selectorOptionId"];

function makeRow(overrides: Partial<{
  level: string;
  value: string;
  features: Record<string, string>;
  metadata: Record<string, unknown>;
  platformData: Record<string, Record<string, string>>;
  /** NEO-277 */
  teamIds: string[];
  /** NEO-277 — present while a cascade is (believed to be) still running. */
  teamCascadeStartedAt: number;
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

  it("is hidden entirely for a protected row — hidden, not disabled", () => {
    // A protected row is not "a thing you may do but not now", it is not a
    // thing you may do at all, so there is no control to disable.
    currentRow = makeRow({ level: "insert", value: "Refractors" });
    currentHoldings = { holds: [], protected: true };
    renderPanel();
    expect(screen.queryByLabelText("Delete Refractors")).toBeNull();
  });

  it("offers BOTH controls on an empty variantType — the custom gate is gone (NEO-239)", () => {
    // This half of the old assertion said a variantType that was not `isCustom`
    // hid both the pencil and the trash, via `canRenameSelectorRow`. NEO-239
    // deleted that predicate with the custom concept: a row either carries
    // marketplace ids or it does not, and both behave the same. Nothing became
    // deletable that the server would have refused — the gate moved from a
    // client-side flag to the row's real state, which is what `holdings`
    // answers, plus the server's own emptiness and protection checks.
    currentRow = makeRow({ level: "variantType", value: "Base" });
    currentHoldings = { holds: [], protected: false };
    renderPanel();
    expect(screen.getByLabelText("Delete Base")).toBeTruthy();
    expect(screen.getByLabelText("Rename Base")).toBeTruthy();
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

/**
 * NEO-217 — a set attribute can be UN-set.
 *
 * `handleSaveFeature` used to `return` on an empty value, and
 * `SelectValueControl`'s blank option was `disabled`. Between them, anything
 * ever written at this level was permanent: a League typed against the wrong
 * row, or a Season that turned out to belong to the parallel rather than the
 * set, could be corrected to a different wrong value but never to nothing.
 * Blank is a complete answer for every field in this panel — the panel's own
 * header comment says so — which made this a hole rather than a safeguard.
 *
 * The wire spelling is `value: ""`, and the server removes the key rather than
 * storing an empty string, so "attribute gone" has exactly one representation.
 */
describe("SetAttributesPanel — clearing an attribute (NEO-217)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetSelectorOptionFeature.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emptying a text row saves \"\" and says Cleared, not Saved", async () => {
    currentRow = makeRow({ level: "setName", features: { season: "2020-21" } });
    currentChain = makeChain("Baseball");

    renderPanel();

    const seasonInput = screen.getByLabelText(
      "Value for Season",
    ) as HTMLInputElement;

    await act(async () => {
      // Real focus() + synthetic focus (sets both document.activeElement and
      // the hook's internal focusedRef — see useReactiveField.test.tsx).
      seasonInput.focus();
      fireEvent.focus(seasonInput);
      fireEvent.change(seasonInput, { target: { value: "" } });
      seasonInput.blur();
      fireEvent.blur(seasonInput);
    });

    await waitFor(() => {
      expect(mockSetSelectorOptionFeature).toHaveBeenCalledWith({
        selectorOptionId: SELECTOR_OPTION_ID,
        key: "season",
        value: "",
      });
    });

    // A distinct string on purpose: "Saved Season" would claim a value was
    // stored. "Saved {label}" itself is unchanged — Maestro asserts it.
    await waitFor(() => {
      expect(screen.getByText("Cleared Season")).toBeTruthy();
    });
    expect(screen.queryByText("Saved Season")).toBeNull();
  });

  it("does not write when clearing a row that was already blank", async () => {
    currentRow = makeRow({ level: "setName", features: {} });
    currentChain = makeChain("Baseball");

    renderPanel();

    const seasonInput = screen.getByLabelText(
      "Value for Season",
    ) as HTMLInputElement;

    await act(async () => {
      seasonInput.focus();
      fireEvent.focus(seasonInput);
      seasonInput.blur();
      fireEvent.blur(seasonInput);
    });

    expect(mockSetSelectorOptionFeature).not.toHaveBeenCalled();
  });

  it("the League select offers an ENABLED blank option that clears the value", async () => {
    currentRow = makeRow({ level: "setName", features: { league: "MLB" } });
    currentChain = makeChain("Baseball");

    renderPanel();

    const leagueSelect = screen.getByLabelText(
      "Value for League",
    ) as HTMLSelectElement;
    const blank = Array.from(leagueSelect.options).find((o) => o.value === "")!;
    // It was `disabled`, i.e. a placeholder — which is why League could be set
    // but never un-set.
    expect(blank.disabled).toBe(false);
    // a11y (audit fix, NEO-216/217): the option's visible text IS its
    // accessible name (a11y-1 in FeatureValueControl.tsx) — "No value" says
    // what picking it does; a bare "—" announced as "hyphen" or nothing.
    expect(blank.textContent).toBe("No value");

    await act(async () => {
      fireEvent.change(leagueSelect, { target: { value: "" } });
    });

    await waitFor(() => {
      expect(mockSetSelectorOptionFeature).toHaveBeenCalledWith({
        selectorOptionId: SELECTOR_OPTION_ID,
        key: "league",
        value: "",
      });
    });
    await waitFor(() => {
      expect(screen.getByText("Cleared League")).toBeTruthy();
    });
  });

  it("re-picking the blank option on an already-blank select writes nothing", async () => {
    // The `next === selected` guard stays: a select that fires a mutation for
    // a no-op pick would write on every stray change event.
    currentRow = makeRow({ level: "setName", features: {} });
    currentChain = makeChain("Baseball");

    renderPanel();

    const leagueSelect = screen.getByLabelText(
      "Value for League",
    ) as HTMLSelectElement;
    expect(leagueSelect.value).toBe("");

    await act(async () => {
      fireEvent.change(leagueSelect, { target: { value: "" } });
    });

    expect(mockSetSelectorOptionFeature).not.toHaveBeenCalled();
  });
});

/**
 * A failure toast must never carry a raw `.message`.
 *
 * Production redacts a plain `throw new Error("…")` in a Convex function to
 * "Server Error", and even a message that survives reaches the client wrapped
 * in "[CONVEX M(selectorOptions:setSelectorOptionFeature)] [Request ID: …]".
 * So the old `Failed: ${e.message}` toast showed an operator either nothing
 * useful or an internal request id. Only a ConvexError's `data` is text the
 * backend deliberately chose for a person — which is the rule
 * `lib/errors/user-facing-message` exists to hold in one place.
 */
describe("SetAttributesPanel — failure toasts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function editSeason(value: string) {
    const seasonInput = screen.getByLabelText(
      "Value for Season",
    ) as HTMLInputElement;
    await act(async () => {
      seasonInput.focus();
      fireEvent.focus(seasonInput);
      fireEvent.change(seasonInput, { target: { value } });
      seasonInput.blur();
      fireEvent.blur(seasonInput);
    });
  }

  it("does not put a plain Error's text in the toast", async () => {
    mockSetSelectorOptionFeature.mockRejectedValue(
      new Error("[CONVEX M(selectorOptions:setSelectorOptionFeature)] boom"),
    );
    currentRow = makeRow({ level: "setName", features: {} });
    currentChain = makeChain("Baseball");

    renderPanel();
    await editSeason("2020-21");

    await waitFor(() => {
      expect(screen.getByText("Failed: Could not save Season")).toBeTruthy();
    });
    expect(screen.queryByText(/boom/)).toBeNull();
    expect(screen.queryByText(/CONVEX M\(/)).toBeNull();
  });

  it("shows a ConvexError's data verbatim — that text was chosen for a person", async () => {
    mockSetSelectorOptionFeature.mockRejectedValue(
      new ConvexError("Season must look like 2020-21."),
    );
    currentRow = makeRow({ level: "setName", features: {} });
    currentChain = makeChain("Baseball");

    renderPanel();
    await editSeason("nonsense");

    await waitFor(() => {
      expect(
        screen.getByText("Failed: Season must look like 2020-21."),
      ).toBeTruthy();
    });
  });
});

/**
 * NEO-239 — the base role, now that name matching is gone.
 *
 * Base used to be whichever variant type happened to be called "Base", which
 * is how a hand-built set got one: by the operator typing the right word.
 * Detection reads `metadata.isBase` now, so hand entry needs a way to SET it —
 * this is that control, and these tests are the reason it is safe to have
 * deleted the name match.
 *
 * The negative cases carry as much weight as the positive one: a set has
 * exactly one base and the mutation clears the siblings, so the row that
 * already IS the base must not offer the action again (it would be a no-op
 * that looks like a toggle), and no other level may offer it at all.
 */
describe("SetAttributesPanel — marking the base variant type (NEO-239)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetBaseVariantType.mockResolvedValue({
      baseId: SELECTOR_OPTION_ID,
      clearedIds: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls setBaseVariantType for the selected variant type", async () => {
    currentRow = makeRow({ level: "variantType", value: "Insert" });
    currentChain = makeChain("Baseball");

    renderPanel();

    fireEvent.click(screen.getByLabelText("Mark Insert as the base set"));

    await waitFor(() => {
      expect(mockSetBaseVariantType).toHaveBeenCalledWith({
        variantTypeId: SELECTOR_OPTION_ID,
      });
    });
    // Same verb as the control, so the operator can tell the tap landed.
    expect(
      await screen.findByText("Marked Insert as the base set"),
    ).toBeTruthy();
  });

  it("reports the sibling it took the role FROM, counted by the server", async () => {
    // The side effect the operator cannot see from here: this panel is scoped
    // to one row, so the row that just LOST the role is off-screen in another
    // column. `clearedIds` is the server's own count of it — the alternative
    // was a hedged "any other base is cleared", which says the same thing
    // whether or not anything happened.
    mockSetBaseVariantType.mockResolvedValueOnce({
      baseId: SELECTOR_OPTION_ID,
      clearedIds: ["other-variant-type-id"],
    });
    currentRow = makeRow({ level: "variantType", value: "Insert" });
    currentChain = makeChain("Baseball");

    renderPanel();

    fireEvent.click(screen.getByLabelText("Mark Insert as the base set"));

    expect(
      await screen.findByText(
        "Marked Insert as the base set — cleared 1 other",
      ),
    ).toBeTruthy();
  });

  it("does not claim a clear when the set had no base to take it from", async () => {
    // A hand-built set marking its first base. Saying "cleared 0 others"
    // would be noise, and saying "cleared any other" would be a claim about
    // something that did not happen.
    currentRow = makeRow({ level: "variantType", value: "Insert" });
    currentChain = makeChain("Baseball");

    renderPanel();

    fireEvent.click(screen.getByLabelText("Mark Insert as the base set"));

    const toast = await screen.findByRole("status");
    expect(toast.textContent).toBe("Marked Insert as the base set");
  });

  it("clears the role from the base row, leaving the set with no base", async () => {
    // `clear: true` is the way back for an operator who marked the wrong row.
    // Without it the only way to unset a base is to promote some OTHER row,
    // which forces exactly the guess the clear path exists to avoid — a set is
    // allowed to have no base at all.
    currentRow = makeRow({
      level: "variantType",
      value: "Insert",
      metadata: { isBase: true },
    });
    currentChain = makeChain("Baseball");

    renderPanel();

    fireEvent.click(screen.getByLabelText("Clear base set from Insert"));

    await waitFor(() => {
      expect(mockSetBaseVariantType).toHaveBeenCalledWith({
        variantTypeId: SELECTOR_OPTION_ID,
        clear: true,
      });
    });
    // No count: clearing touches only the row in front of the operator, so
    // there is no off-screen sibling to report.
    expect(await screen.findByText("Cleared the base set")).toBeTruthy();
  });

  it("drops the indicator once the cleared row comes back without the flag", () => {
    // The reactive round trip, as the panel sees it: the mutation lands, the
    // row re-resolves with no `isBase`, and this row is now an ordinary variant
    // type offering the mark action again. Asserted on the re-resolved row
    // rather than on local state — the indicator has no state of its own, and
    // it must not keep showing a role the server has taken away.
    currentRow = makeRow({
      level: "variantType",
      value: "Insert",
      metadata: { isBase: true },
    });
    currentChain = makeChain("Baseball");
    const { unmount } = renderPanel();
    expect(screen.getByText("Base set")).toBeTruthy();
    unmount();

    currentRow = makeRow({ level: "variantType", value: "Insert", metadata: {} });
    renderPanel();

    expect(screen.queryByText("Base set")).toBeNull();
    expect(screen.queryByLabelText("Clear base set from Insert")).toBeNull();
    expect(screen.getByLabelText("Mark Insert as the base set")).toBeTruthy();
  });

  it("says nothing changed when the CLEAR fails, and leaks no thrown text", async () => {
    mockSetBaseVariantType.mockRejectedValueOnce(
      new Error("[Request ID: xyz] Server Error"),
    );
    currentRow = makeRow({
      level: "variantType",
      value: "Insert",
      metadata: { isBase: true },
    });
    currentChain = makeChain("Baseball");

    renderPanel();

    fireEvent.click(screen.getByLabelText("Clear base set from Insert"));

    const toast = await screen.findByRole("status");
    expect(toast.textContent).toBe(
      "Couldn't clear the base set. Nothing changed.",
    );
    expect(toast.textContent).not.toContain("Request ID");
  });

  it("moves focus to 'Clear base set' when marking swaps the control away", async () => {
    // The acting button unmounts the moment the role lands, and with nothing to
    // move focus onto the browser drops it to <body> — a keyboard operator is
    // returned to the top of the document mid-task. The successor control is
    // also this action's undo, so it is where they are most likely headed.
    currentRow = makeRow({ level: "variantType", value: "Insert" });
    currentChain = makeChain("Baseball");
    const { rerender } = renderPanel();

    fireEvent.click(screen.getByLabelText("Mark Insert as the base set"));
    await waitFor(() => expect(mockSetBaseVariantType).toHaveBeenCalled());

    // The row comes back holding the role; the control swaps shape.
    currentRow = makeRow({
      level: "variantType",
      value: "Insert",
      metadata: { isBase: true },
    });
    rerender(
      <SetAttributesPanel
        selectorOptionId={SELECTOR_OPTION_ID}
        defaultCollapsed={false}
      />,
    );

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText("Clear base set from Insert"),
      ),
    );
  });

  it("moves focus to 'Mark as base set' when clearing swaps the control away", async () => {
    currentRow = makeRow({
      level: "variantType",
      value: "Insert",
      metadata: { isBase: true },
    });
    currentChain = makeChain("Baseball");
    const { rerender } = renderPanel();

    fireEvent.click(screen.getByLabelText("Clear base set from Insert"));
    await waitFor(() => expect(mockSetBaseVariantType).toHaveBeenCalled());

    currentRow = makeRow({
      level: "variantType",
      value: "Insert",
      metadata: {},
    });
    rerender(
      <SetAttributesPanel
        selectorOptionId={SELECTOR_OPTION_ID}
        defaultCollapsed={false}
      />,
    );

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText("Mark Insert as the base set"),
      ),
    );
  });

  it("does NOT steal focus when the role changes without this operator acting", async () => {
    // The role arrives from the server, so it can flip while nobody is touching
    // this panel — another tab, or a parallel worker, marking a sibling. Pulling
    // focus out of whatever the operator is typing in would be focus theft.
    currentRow = makeRow({ level: "variantType", value: "Insert" });
    currentChain = makeChain("Baseball");
    const { rerender } = renderPanel();

    const elsewhere = screen.getByLabelText("Rename Insert");
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    currentRow = makeRow({
      level: "variantType",
      value: "Insert",
      metadata: { isBase: true },
    });
    rerender(
      <SetAttributesPanel
        selectorOptionId={SELECTOR_OPTION_ID}
        defaultCollapsed={false}
      />,
    );

    // The control swapped, but focus stayed where the operator put it.
    expect(screen.getByLabelText("Clear base set from Insert")).toBeTruthy();
    expect(document.activeElement).toBe(elsewhere);
    expect(mockSetBaseVariantType).not.toHaveBeenCalled();
  });

  it("shows a static 'Base set' indicator, and no mark action, on the base row", () => {
    // `metadata.isBase` is the ONLY input. The row is called "Insert" here on
    // purpose: if the indicator ever went back to reading the display value,
    // this row would lose its badge and the test would say so.
    currentRow = makeRow({
      level: "variantType",
      value: "Insert",
      metadata: { isBase: true },
    });
    currentChain = makeChain("Baseball");

    renderPanel();

    expect(screen.getByText("Base set")).toBeTruthy();
    // Not the same control in an "on" position: marking is a transfer and this
    // row already holds the role, so the only thing left to offer is the clear.
    expect(screen.queryByLabelText("Mark Insert as the base set")).toBeNull();
    expect(screen.getByLabelText("Clear base set from Insert")).toBeTruthy();
  });

  it("offers the action on a variant type that is NOT the base", () => {
    // The other half of the same set. A row carrying metadata that says
    // nothing about the role is not the base, and can become it.
    currentRow = makeRow({
      level: "variantType",
      value: "Base",
      metadata: { isInsert: true },
    });
    currentChain = makeChain("Baseball");

    renderPanel();

    expect(screen.getByLabelText("Mark Base as the base set")).toBeTruthy();
    expect(screen.queryByText("Base set")).toBeNull();
    expect(screen.queryByLabelText("Clear base set from Base")).toBeNull();
  });

  it("does not offer the role at any other level", () => {
    // Only a variant type can be a set's base. Offering it on a set, a year or
    // a parallel would be an action with no meaning and a mutation that would
    // have to refuse it.
    for (const level of ["sport", "year", "manufacturer", "setName", "insert", "parallel"]) {
      currentRow = makeRow({ level, value: "Topps" });
      currentChain = makeChain("Baseball");
      const { unmount } = renderPanel();
      expect(screen.queryByLabelText("Mark Topps as the base set")).toBeNull();
      expect(screen.queryByText("Base set")).toBeNull();
      unmount();
    }
  });

  it("says nothing changed when the mutation fails, and leaks no thrown text", async () => {
    // A Convex/adapter error can carry a marketplace URL or a credential hint,
    // and the operator's actual question on a failure is whether their data
    // survived it.
    mockSetBaseVariantType.mockRejectedValueOnce(
      new Error("[Request ID: abc] Server Error"),
    );
    currentRow = makeRow({ level: "variantType", value: "Insert" });
    currentChain = makeChain("Baseball");

    renderPanel();

    fireEvent.click(screen.getByLabelText("Mark Insert as the base set"));

    const toast = await screen.findByRole("status");
    expect(toast.textContent).toBe("Couldn't set the base set. Nothing changed.");
    expect(toast.textContent).not.toContain("Request ID");
  });

  it("keeps the confirmation visible while the panel is COLLAPSED", async () => {
    // The control lives in the header, so it is reachable collapsed — which is
    // how an operator building a set by hand will meet it. The toast used to
    // render only inside the expanded branch, which would have made this tap
    // look like it did nothing.
    currentRow = makeRow({ level: "variantType", value: "Insert" });
    currentChain = makeChain("Baseball");

    render(
      <SetAttributesPanel
        selectorOptionId={SELECTOR_OPTION_ID}
        defaultCollapsed
      />,
    );

    fireEvent.click(screen.getByLabelText("Mark Insert as the base set"));

    expect(
      await screen.findByText("Marked Insert as the base set"),
    ).toBeTruthy();
  });
});

/**
 * NEO-291 — the Card prefix row, now that the Metadata box is gone.
 *
 * `showsCardPrefix` gates it to the levels cards actually hang from: an
 * insert, a parallel, or the base variant type (cards hang directly off
 * Base; any other variant type's cards hang from ITS inserts). Every other
 * level is a container, and a prefix there would apply to every checklist
 * beneath it, which no set does.
 */
describe("SetAttributesPanel — Card prefix row (NEO-291)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetSelectorOptionCardNumberPrefix.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const prefixField = () =>
    screen.getByLabelText("Value for Card prefix") as HTMLInputElement;

  it.each(["insert", "parallel"])(
    "renders at level %s",
    (level) => {
      currentRow = makeRow({ level, value: "Refractor" });
      currentChain = makeChain("Baseball");
      renderPanel();
      expect(screen.getByLabelText("Set feature Card prefix")).toBeTruthy();
    },
  );

  it("renders at variantType when the row is the base set", () => {
    currentRow = makeRow({
      level: "variantType",
      value: "Base",
      metadata: { isBase: true },
    });
    currentChain = makeChain("Baseball");
    renderPanel();
    expect(screen.getByLabelText("Set feature Card prefix")).toBeTruthy();
  });

  it("is absent at a variantType row that is NOT the base set", () => {
    currentRow = makeRow({
      level: "variantType",
      value: "Insert",
      metadata: { isInsert: true },
    });
    currentChain = makeChain("Baseball");
    renderPanel();
    expect(screen.queryByLabelText("Set feature Card prefix")).toBeNull();
  });

  it.each(["sport", "year", "manufacturer", "setName"])(
    "is absent at level %s",
    (level) => {
      currentRow = makeRow({ level, value: "Topps" });
      currentChain = makeChain("Baseball");
      renderPanel();
      expect(screen.queryByLabelText("Set feature Card prefix")).toBeNull();
    },
  );

  it("is the first cell of the attributes grid", () => {
    currentRow = makeRow({ level: "insert", value: "Refractor" });
    currentChain = makeChain("Baseball");
    const { container } = renderPanel();
    const grid = container.querySelector(".grid.grid-cols-1");
    expect(grid).toBeTruthy();
    expect(
      grid!.firstElementChild?.getAttribute("aria-label"),
    ).toBe("Set feature Card prefix");
  });

  it("saving a new value shows \"Saved Card prefix\"", async () => {
    currentRow = makeRow({ level: "insert", value: "Refractor" });
    currentChain = makeChain("Baseball");
    renderPanel();

    const input = prefixField();
    await act(async () => {
      input.focus();
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "DK-" } });
      input.blur();
      fireEvent.blur(input);
    });

    await waitFor(() => {
      expect(mockSetSelectorOptionCardNumberPrefix).toHaveBeenCalledWith({
        id: SELECTOR_OPTION_ID,
        cardNumberPrefix: "DK-",
      });
    });
    await waitFor(() => {
      expect(screen.getByText("Saved Card prefix")).toBeTruthy();
    });
  });

  it("clearing the value shows \"Cleared Card prefix\"", async () => {
    currentRow = makeRow({
      level: "insert",
      value: "Refractor",
      metadata: { cardNumberPrefix: "DK-" },
    });
    currentChain = makeChain("Baseball");
    renderPanel();

    const input = prefixField();
    expect(input.value).toBe("DK-");
    await act(async () => {
      input.focus();
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "" } });
      input.blur();
      fireEvent.blur(input);
    });

    await waitFor(() => {
      expect(mockSetSelectorOptionCardNumberPrefix).toHaveBeenCalledWith({
        id: SELECTOR_OPTION_ID,
        cardNumberPrefix: "",
      });
    });
    await waitFor(() => {
      expect(screen.getByText("Cleared Card prefix")).toBeTruthy();
    });
  });

  it("an unchanged value is a silent no-op — no mutation, no toast", async () => {
    currentRow = makeRow({
      level: "insert",
      value: "Refractor",
      metadata: { cardNumberPrefix: "DK-" },
    });
    currentChain = makeChain("Baseball");
    renderPanel();

    const input = prefixField();
    await act(async () => {
      input.focus();
      fireEvent.focus(input);
      input.blur();
      fireEvent.blur(input);
    });

    expect(mockSetSelectorOptionCardNumberPrefix).not.toHaveBeenCalled();
    expect(screen.queryByText("Saved Card prefix")).toBeNull();
    expect(screen.queryByText("Cleared Card prefix")).toBeNull();
  });

  it("shows the ConvexError's data verbatim on failure, via userFacingMessage", async () => {
    mockSetSelectorOptionCardNumberPrefix.mockRejectedValueOnce(
      new ConvexError("A card prefix is at most 32 characters."),
    );
    currentRow = makeRow({ level: "insert", value: "Refractor" });
    currentChain = makeChain("Baseball");
    renderPanel();

    const input = prefixField();
    await act(async () => {
      input.focus();
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "WAY-TOO-LONG" } });
      input.blur();
      fireEvent.blur(input);
    });

    await waitFor(() => {
      expect(
        screen.getByText("Failed: A card prefix is at most 32 characters."),
      ).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// NEO-277 — Team as a set-level attribute
// ---------------------------------------------------------------------------

describe("SetAttributesPanel — Team row (NEO-277)", () => {
  const BULLS = {
    _id: "team-bulls",
    name: "Bulls",
    location: "Durham",
    colors: { primary: "#4A9EFF", secondary: "#f5a623" },
  };
  const MUDCATS = {
    _id: "team-mudcats",
    name: "Mudcats",
    location: "Carolina",
    colors: { primary: "#c8102e", secondary: "#ffffff" },
  };
  const KNIGHTS = {
    _id: "team-knights",
    name: "Knights",
    location: "Charlotte",
    // A near-black primary that fails the panel's contrast floor, and a pale
    // secondary that clears it — the fallback order the livery relies on.
    colors: { primary: "#0b1a33", secondary: "#e8e8e8" },
  };
  const NOTHING_FOLLOWS = {
    nodesFollowing: 0,
    cardsFollowing: 0,
    cardsStaying: 0,
    cardsOverridden: 0,
    cardsTeamless: 0,
    cardsPendingName: 0,
    cardsCarryingCurrent: 0,
    truncated: false,
  };

  /**
   * Route the two one-shot reads by their (string-mocked) refs. `previews`
   * may answer the non-empty pick and the `[]` clear differently — that is
   * the whole point of `cardsCarryingCurrent`.
   */
  function armConvexQuery(
    preview: typeof NOTHING_FOLLOWS,
    rows: unknown[] = [BULLS],
    clearPreview: typeof NOTHING_FOLLOWS = preview,
  ) {
    mockConvexQuery.mockImplementation(
      async (ref: string, args: { teamIds?: string[] }) => {
        if (ref === "getSelectorOptionTeamCascadePreview") {
          return args.teamIds && args.teamIds.length === 0
            ? clearPreview
            : preview;
        }
        if (ref === "teams.getManyByIds") return rows;
        throw new Error(`unexpected convex.query(${ref})`);
      },
    );
  }

  /** The Team row's group, for scoping queries to it. */
  const teamGroup = () => screen.getByRole("group", { name: "Team" });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSetSelectorOptionTeams.mockResolvedValue(null);
    mockSetSelectorOptionFeature.mockResolvedValue(undefined);
    currentHoldings = { holds: [], protected: false };
    currentTeamRows = undefined;
    currentChain = makeChain("Baseball");
    pickNext = "team-bulls";
    armConvexQuery(NOTHING_FOLLOWS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the row at setName, labelled Team, ahead of every feature row, with the picker scoped to the sport ROW id", () => {
    currentRow = makeRow({ level: "setName", teamIds: [] });
    renderPanel();

    const group = teamGroup();
    expect(group).toBeTruthy();
    // The hint is the group's description, not a tooltip: it has to be
    // readable before the pick.
    expect(group.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      within(group).getByText(
        "Team issues, police sets, college sets, stadium giveaways: pick the team once and every card in this set gets it.",
      ),
    ).toBeTruthy();

    // Scoped by the sport row's id from the ancestor chain — never its name.
    expect(
      within(group).getByLabelText(SET_TEAM_PICKER_LABELS.root).getAttribute("data-sport-id"),
    ).toBe("sport-id");

    // First in the attributes area: it precedes the toggles row and the grid.
    const toggles = screen.getByRole("group", { name: "Set attribute toggles" });
    expect(
      group.compareDocumentPosition(toggles) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it.each([
    ["variantType", "variant"],
    ["insert", "insert"],
    ["parallel", "parallel"],
  ])(
    "renders the row at %s too, with the shorter hint naming that level",
    (level, noun) => {
      currentRow = makeRow({ level, value: `node-${level}`, teamIds: [] });
      renderPanel();
      expect(
        within(teamGroup()).getByText(
          `Every card in this ${noun} gets this team. Pick it once.`,
        ),
      ).toBeTruthy();
    },
  );

  it.each(["sport", "year", "manufacturer"])(
    "does NOT render the row at %s",
    (level) => {
      currentRow = makeRow({ level, value: `node-${level}`, teamIds: [] });
      renderPanel();
      expect(screen.queryByRole("group", { name: "Team" })).toBeNull();
      expect(screen.queryByLabelText(SET_TEAM_PICKER_LABELS.root)).toBeNull();
    },
  );

  it("names its picker distinctly from every other TeamPicker on the page — no shared substring in either direction", () => {
    // This panel can be expanded while the quick-add form or the card drawer
    // has a default-labelled picker open beneath it, and neither hides the
    // other. Maestro's `id:` selector is a regex find over the aria-label, so
    // a label that merely CONTAINED the default ("Add team to set") would make
    // a flow's `id: "Add team"` match both — the check is both ways and is
    // pinned here because the failure is silent in both.
    currentRow = makeRow({ level: "setName", teamIds: [] });
    renderPanel();

    for (const key of ["root", "trigger", "search", "results"] as const) {
      const distinct = SET_TEAM_PICKER_LABELS[key];
      const base = DEFAULT_TEAM_PICKER_LABELS[key];
      expect(distinct).not.toBe(base);
      expect(distinct.includes(base)).toBe(false);
      expect(base.includes(distinct)).toBe(false);
    }
    // And they are what this row actually renders — not the defaults.
    expect(screen.getByLabelText(SET_TEAM_PICKER_LABELS.root)).toBeTruthy();
    expect(screen.getByLabelText(SET_TEAM_PICKER_LABELS.trigger)).toBeTruthy();
    expect(screen.queryByLabelText(DEFAULT_TEAM_PICKER_LABELS.root)).toBeNull();
    expect(
      screen.queryByLabelText(DEFAULT_TEAM_PICKER_LABELS.trigger),
    ).toBeNull();
  });

  it("the trigger's visible text is contained in its accessible name (SC 2.5.3), and the hint describes it", () => {
    currentRow = makeRow({ level: "setName", teamIds: [] });
    renderPanel();

    const trigger = screen.getByLabelText(PICK);
    const name = trigger.getAttribute("aria-label") ?? "";
    const visible = (trigger.textContent ?? "").replace(/^\+\s*/, "").trim();
    expect(visible).toBe("Add set team");
    expect(name).toBe("Add set team");
    expect(name.includes(visible)).toBe(true);

    // The hint reaches the trigger as well as the group: a screen-reader user
    // arrives at the button before the sentence under it.
    const describedBy = trigger.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain(
      "pick the team once and every card in this set gets it",
    );
    expect(teamGroup().getAttribute("aria-describedby")).toBe(describedBy);
  });

  it("saves straight away, with no dialog, when no card beneath would follow", async () => {
    currentRow = makeRow({ level: "setName", teamIds: [] });
    armConvexQuery(NOTHING_FOLLOWS);
    renderPanel();

    fireEvent.click(screen.getByLabelText(PICK));

    await waitFor(() => {
      expect(mockSetSelectorOptionTeams).toHaveBeenCalledWith({
        selectorOptionId: SELECTOR_OPTION_ID,
        teamIds: ["team-bulls"],
      });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("Saved Team")).toBeTruthy();
    // The preview was asked with the value about to be saved.
    expect(mockConvexQuery).toHaveBeenCalledWith(
      "getSelectorOptionTeamCascadePreview",
      { selectorOptionId: SELECTOR_OPTION_ID, teamIds: ["team-bulls"] },
    );
  });

  it("saves straight away when only empty rows (no cards) would follow — the confirm counts cards", async () => {
    currentRow = makeRow({ level: "setName", teamIds: [] });
    armConvexQuery({ ...NOTHING_FOLLOWS, nodesFollowing: 3 });
    renderPanel();

    fireEvent.click(screen.getByLabelText(PICK));

    await waitFor(() => {
      expect(mockSetSelectorOptionTeams).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("Saved Team")).toBeTruthy();
  });

  it("asks first when cards would follow, names the team and the card count only, and saves on confirm", async () => {
    currentRow = makeRow({ level: "setName", teamIds: [] });
    armConvexQuery({
      ...NOTHING_FOLLOWS,
      nodesFollowing: 3,
      cardsFollowing: 28,
      cardsStaying: 2,
      cardsOverridden: 2,
    });
    renderPanel();

    fireEvent.click(screen.getByLabelText(PICK));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Apply Durham Bulls to this set?"),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "28 cards under this set will get Durham Bulls. 2 cards carry a different team — these will not change.",
      ),
    ).toBeTruthy();
    // No "3 variants" anywhere: rows are not a thing a collector counts.
    expect(dialog.textContent).not.toContain("variant");
    // Nothing written while the question is open.
    expect(mockSetSelectorOptionTeams).not.toHaveBeenCalled();
    // The picker already shows the pick, so the operator sees what the
    // question is about.
    expect(screen.getByTestId("team-picker-value").textContent).toBe(
      "team-bulls",
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, apply" }));

    await waitFor(() => {
      expect(mockSetSelectorOptionTeams).toHaveBeenCalledWith({
        selectorOptionId: SELECTOR_OPTION_ID,
        teamIds: ["team-bulls"],
      });
    });
    expect(
      await screen.findByText("Saved Team · applying to 28 cards"),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("reverts the picker and writes nothing on cancel, then parks focus on the picker trigger", async () => {
    currentRow = makeRow({ level: "setName", teamIds: [] });
    armConvexQuery({ ...NOTHING_FOLLOWS, cardsFollowing: 5 });
    renderPanel();

    fireEvent.click(screen.getByLabelText(PICK));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("5 cards under this set will get Durham Bulls."),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockSetSelectorOptionTeams).not.toHaveBeenCalled();
    expect(screen.getByTestId("team-picker-value").textContent).toBe("");
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText(PICK));
    });
  });

  // --- the change-team gesture ------------------------------------------

  describe("removing the last chip", () => {
    beforeEach(() => {
      currentRow = makeRow({ level: "setName", teamIds: ["team-bulls"] });
      currentTeamRows = [BULLS];
    });

    it("does NOT save: the picker empties, the stored value stands, and two actions appear", async () => {
      renderPanel();

      fireEvent.click(screen.getByLabelText("Remove team team-bulls"));

      expect(screen.getByTestId("team-picker-value").textContent).toBe("");
      const group = teamGroup();
      expect(
        within(group).getByRole("button", { name: "Clear team" }),
      ).toBeTruthy();
      expect(
        within(group).getByRole("button", { name: "Keep Durham Bulls" }),
      ).toBeTruthy();
      // No write, no preview, no dialog — nothing has been decided yet.
      expect(mockSetSelectorOptionTeams).not.toHaveBeenCalled();
      expect(mockConvexQuery).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      // The × that was pressed is gone; focus is on the trigger, not <body>.
      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByLabelText(PICK));
      });
    });

    it("'Keep' reverts the picker to the stored value, writes nothing, and parks focus on the trigger", async () => {
      renderPanel();
      fireEvent.click(screen.getByLabelText("Remove team team-bulls"));

      fireEvent.click(screen.getByRole("button", { name: "Keep Durham Bulls" }));

      expect(screen.getByTestId("team-picker-value").textContent).toBe(
        "team-bulls",
      );
      expect(screen.queryByRole("button", { name: "Clear team" })).toBeNull();
      expect(mockSetSelectorOptionTeams).not.toHaveBeenCalled();
      expect(mockConvexQuery).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByLabelText(PICK));
      });
    });

    it("re-adding the stored team from the empty state is a Keep, not a save", () => {
      renderPanel();
      fireEvent.click(screen.getByLabelText("Remove team team-bulls"));

      fireEvent.click(screen.getByLabelText(PICK)); // adds team-bulls back

      expect(screen.getByTestId("team-picker-value").textContent).toBe(
        "team-bulls",
      );
      expect(screen.queryByRole("button", { name: "Clear team" })).toBeNull();
      expect(mockSetSelectorOptionTeams).not.toHaveBeenCalled();
      expect(mockConvexQuery).not.toHaveBeenCalled();
    });

    it("'Clear team' with cards carrying the team asks first, then sends [] on confirm", async () => {
      armConvexQuery(NOTHING_FOLLOWS, [BULLS], {
        ...NOTHING_FOLLOWS,
        cardsCarryingCurrent: 28,
      });
      renderPanel();
      fireEvent.click(screen.getByLabelText("Remove team team-bulls"));

      fireEvent.click(screen.getByRole("button", { name: "Clear team" }));

      const dialog = await screen.findByRole("dialog");
      expect(mockConvexQuery).toHaveBeenCalledWith(
        "getSelectorOptionTeamCascadePreview",
        { selectorOptionId: SELECTOR_OPTION_ID, teamIds: [] },
      );
      expect(
        within(dialog).getByText("Take Durham Bulls off this set?"),
      ).toBeTruthy();
      expect(
        within(dialog).getByText(
          "28 cards keep Durham Bulls. Picked the wrong team? Pick the right one instead and they'll follow.",
        ),
      ).toBeTruthy();
      expect(mockSetSelectorOptionTeams).not.toHaveBeenCalled();

      fireEvent.click(
        within(dialog).getByRole("button", { name: "Yes, clear" }),
      );

      await waitFor(() => {
        expect(mockSetSelectorOptionTeams).toHaveBeenCalledWith({
          selectorOptionId: SELECTOR_OPTION_ID,
          teamIds: [],
        });
      });
      expect(
        await screen.findByText("Cleared Team · cards unchanged"),
      ).toBeTruthy();
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(screen.queryByRole("button", { name: "Clear team" })).toBeNull();
      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByLabelText(PICK));
      });
    });

    it("cancelling the take-off dialog leaves the row pending-empty, nothing written", async () => {
      armConvexQuery(NOTHING_FOLLOWS, [BULLS], {
        ...NOTHING_FOLLOWS,
        cardsCarryingCurrent: 1,
      });
      renderPanel();
      fireEvent.click(screen.getByLabelText("Remove team team-bulls"));
      fireEvent.click(screen.getByRole("button", { name: "Clear team" }));
      const dialog = await screen.findByRole("dialog");
      expect(
        within(dialog).getByText(/^1 card keeps Durham Bulls\./),
      ).toBeTruthy();

      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(mockSetSelectorOptionTeams).not.toHaveBeenCalled();
      expect(screen.getByTestId("team-picker-value").textContent).toBe("");
      expect(screen.getByRole("button", { name: "Clear team" })).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Keep Durham Bulls" }),
      ).toBeTruthy();
    });

    it("'Clear team' with no card carrying the team clears directly, no dialog, focus on the trigger", async () => {
      armConvexQuery(NOTHING_FOLLOWS, [BULLS], NOTHING_FOLLOWS);
      renderPanel();
      fireEvent.click(screen.getByLabelText("Remove team team-bulls"));

      fireEvent.click(screen.getByRole("button", { name: "Clear team" }));

      await waitFor(() => {
        expect(mockSetSelectorOptionTeams).toHaveBeenCalledWith({
          selectorOptionId: SELECTOR_OPTION_ID,
          teamIds: [],
        });
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(
        await screen.findByText("Cleared Team · cards unchanged"),
      ).toBeTruthy();
      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByLabelText(PICK));
      });
    });

    it("adding a different team from the empty state previews against the STORED team and confirms with the cards that follow", async () => {
      pickNext = "team-mudcats";
      armConvexQuery(
        { ...NOTHING_FOLLOWS, cardsFollowing: 28 },
        [MUDCATS],
      );
      renderPanel();
      fireEvent.click(screen.getByLabelText("Remove team team-bulls"));
      expect(screen.getByRole("button", { name: "Clear team" })).toBeTruthy();

      fireEvent.click(screen.getByLabelText(PICK)); // adds team-mudcats

      // The two actions withdraw the moment a replacement is picked.
      expect(screen.queryByRole("button", { name: "Clear team" })).toBeNull();
      const dialog = await screen.findByRole("dialog");
      // The preview was asked for the replacement while the row still stores
      // Bulls, so the server's `previous` is Bulls and its cards follow.
      expect(mockConvexQuery).toHaveBeenCalledWith(
        "getSelectorOptionTeamCascadePreview",
        { selectorOptionId: SELECTOR_OPTION_ID, teamIds: ["team-mudcats"] },
      );
      expect(
        within(dialog).getByText("Apply Carolina Mudcats to this set?"),
      ).toBeTruthy();
      expect(
        within(dialog).getByText(
          "28 cards under this set will get Carolina Mudcats.",
        ),
      ).toBeTruthy();
      // Exactly one write, and it never passed through [].
      expect(mockSetSelectorOptionTeams).not.toHaveBeenCalled();
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Yes, apply" }),
      );
      await waitFor(() => {
        expect(mockSetSelectorOptionTeams).toHaveBeenCalledTimes(1);
      });
      expect(mockSetSelectorOptionTeams).toHaveBeenCalledWith({
        selectorOptionId: SELECTOR_OPTION_ID,
        teamIds: ["team-mudcats"],
      });
      expect(
        await screen.findByText("Saved Team · applying to 28 cards"),
      ).toBeTruthy();
    });
  });

  it("removing ONE chip of a multi-team row is the ordinary non-empty path — no pending actions", async () => {
    currentRow = makeRow({
      level: "setName",
      teamIds: ["team-bulls", "team-knights"],
    });
    currentTeamRows = [BULLS, KNIGHTS];
    armConvexQuery({ ...NOTHING_FOLLOWS, cardsFollowing: 4 }, [BULLS]);
    renderPanel();

    fireEvent.click(screen.getByLabelText("Remove team team-knights"));

    expect(screen.queryByRole("button", { name: "Clear team" })).toBeNull();
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Apply Durham Bulls to this set?"),
    ).toBeTruthy();
    expect(mockConvexQuery).toHaveBeenCalledWith(
      "getSelectorOptionTeamCascadePreview",
      { selectorOptionId: SELECTOR_OPTION_ID, teamIds: ["team-bulls"] },
    );
  });

  // --- cascade in flight --------------------------------------------------

  describe("while a cascade is in flight", () => {
    it("disables the picker, hides the pending actions, and says so beside the control", () => {
      currentRow = makeRow({
        level: "setName",
        teamIds: ["team-bulls"],
        teamCascadeStartedAt: Date.now() - 5_000,
      });
      currentTeamRows = [BULLS];
      renderPanel();

      const group = teamGroup();
      expect(
        within(group).getByRole("status").textContent,
      ).toBe("Applying to cards…");
      expect(
        (screen.getByLabelText(PICK) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(
        (screen.getByLabelText("Remove team team-bulls") as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(screen.queryByRole("button", { name: "Clear team" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Keep Durham Bulls" }),
      ).toBeNull();
    });

    it("treats a timestamp older than ten minutes as NOT in flight", () => {
      currentRow = makeRow({
        level: "setName",
        teamIds: ["team-bulls"],
        teamCascadeStartedAt: Date.now() - 11 * 60 * 1000,
      });
      currentTeamRows = [BULLS];
      renderPanel();

      expect(within(teamGroup()).queryByRole("status")).toBeNull();
      expect(
        (screen.getByLabelText(PICK) as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    it("toasts 'Team applied to cards' when the row leaves the in-flight state while mounted", async () => {
      currentRow = makeRow({
        level: "setName",
        teamIds: ["team-bulls"],
        teamCascadeStartedAt: Date.now() - 5_000,
      });
      currentTeamRows = [BULLS];
      const { rerender } = renderPanel();
      expect(screen.queryByText("Team applied to cards")).toBeNull();

      // The cascade's last chunk clears the field; the subscription delivers
      // the row again without it.
      currentRow = makeRow({ level: "setName", teamIds: ["team-bulls"] });
      rerender(
        <SetAttributesPanel
          selectorOptionId={SELECTOR_OPTION_ID}
          defaultCollapsed={false}
        />,
      );

      expect(await screen.findByText("Team applied to cards")).toBeTruthy();
      expect(within(teamGroup()).queryByRole("status")).toBeNull();
      expect(
        (screen.getByLabelText(PICK) as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    it("does not toast when it mounts already NOT in flight", () => {
      currentRow = makeRow({ level: "setName", teamIds: ["team-bulls"] });
      currentTeamRows = [BULLS];
      renderPanel();
      expect(screen.queryByText("Team applied to cards")).toBeNull();
    });

    it("shows the server's 'still applying' refusal verbatim when a save races the cascade", async () => {
      currentRow = makeRow({ level: "setName", teamIds: [] });
      mockSetSelectorOptionTeams.mockRejectedValue(
        new ConvexError(
          "Still applying the last team change. Try again in a moment.",
        ),
      );
      renderPanel();

      fireEvent.click(screen.getByLabelText(PICK));

      const toast = await screen.findByRole("status");
      await waitFor(() =>
        expect(toast.textContent).toBe(
          "Failed: Still applying the last team change. Try again in a moment.",
        ),
      );
    });
  });

  it("routes the PREVIEW's own refusal through the failure toast, verbatim, on both the pick and the clear", async () => {
    // The preview throws when the row is gone rather than answering zeros —
    // zeros would read as "nothing follows" and save straight away.
    currentRow = makeRow({ level: "setName", teamIds: ["team-bulls"] });
    currentTeamRows = [BULLS];
    mockConvexQuery.mockImplementation(async (ref: string) => {
      if (ref === "getSelectorOptionTeamCascadePreview") {
        throw new ConvexError("That row is gone. Refresh and try again.");
      }
      return [MUDCATS];
    });
    pickNext = "team-mudcats";
    renderPanel();

    fireEvent.click(screen.getByLabelText(PICK));
    let toast = await screen.findByRole("status");
    await waitFor(() =>
      expect(toast.textContent).toBe(
        "Failed: That row is gone. Refresh and try again.",
      ),
    );
    expect(mockSetSelectorOptionTeams).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The picker is back on the stored value.
    await waitFor(() =>
      expect(screen.getByTestId("team-picker-value").textContent).toBe(
        "team-bulls",
      ),
    );

    fireEvent.click(screen.getByLabelText("Remove team team-bulls"));
    fireEvent.click(screen.getByRole("button", { name: "Clear team" }));
    toast = await screen.findByRole("status");
    await waitFor(() =>
      expect(toast.textContent).toBe(
        "Failed: That row is gone. Refresh and try again.",
      ),
    );
    expect(mockSetSelectorOptionTeams).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not put a plain Error's text in the toast when the save fails", async () => {
    currentRow = makeRow({ level: "setName", teamIds: [] });
    mockSetSelectorOptionTeams.mockRejectedValue(
      new Error("[CONVEX M(selectorOptions:setSelectorOptionTeams)] [Request ID: abc] Server Error"),
    );
    renderPanel();

    fireEvent.click(screen.getByLabelText(PICK));

    const toast = await screen.findByRole("status");
    await waitFor(() =>
      expect(toast.textContent).toBe("Failed: Could not save Team"),
    );
    expect(toast.textContent).not.toContain("Request ID");
    // The picker is back on the row's value, not stuck on the failed pick.
    await waitFor(() =>
      expect(screen.getByTestId("team-picker-value").textContent).toBe(""),
    );
  });

  it("shows a ConvexError's data verbatim when the save fails", async () => {
    currentRow = makeRow({ level: "setName", teamIds: [] });
    mockSetSelectorOptionTeams.mockRejectedValue(
      new ConvexError("That team belongs to another sport."),
    );
    renderPanel();

    fireEvent.click(screen.getByLabelText(PICK));

    const toast = await screen.findByRole("status");
    await waitFor(() =>
      expect(toast.textContent).toBe(
        "Failed: That team belongs to another sport.",
      ),
    );
  });

  it("shows the team on the COLLAPSED bar as its short name in livery, and not while expanded", () => {
    currentRow = makeRow({ level: "setName", teamIds: ["team-bulls"] });
    currentTeamRows = [BULLS];

    const { unmount } = render(
      <SetAttributesPanel
        selectorOptionId={SELECTOR_OPTION_ID}
        defaultCollapsed
      />,
    );

    const chip = screen.getByText("Bulls");
    expect(chip.getAttribute("title")).toBe("Durham Bulls");
    // Primary clears 4.5:1 on the panel ground, so it is the colour used —
    // normalised to lower-case `#rrggbb` on the way through.
    expect(chip.style.color).toBe("#4a9eff");
    // Screen readers hear what the word is.
    expect(chip.parentElement?.parentElement?.textContent).toContain("Team: ");

    unmount();

    // Expanded, the picker says it; the bar does not repeat it.
    renderPanel();
    expect(screen.queryByText("Bulls")).toBeNull();
    expect(screen.getByTestId("team-picker-value").textContent).toBe(
      "team-bulls",
    );
  });

  it("falls back to the secondary colour when the primary fails contrast, and to muted when both do", () => {
    currentRow = makeRow({
      level: "setName",
      teamIds: ["team-knights", "team-muted"],
    });
    currentTeamRows = [
      KNIGHTS,
      { _id: "team-muted", name: "Shadows", colors: { primary: "#111111" } },
    ];

    render(
      <SetAttributesPanel
        selectorOptionId={SELECTOR_OPTION_ID}
        defaultCollapsed
      />,
    );

    expect(screen.getByText("Knights").style.color).toBe("#e8e8e8");
    const muted = screen.getByText("Shadows");
    expect(muted.style.color).toBe("");
    expect(muted.className).toContain("text-gray-300");
  });

  it("does not show the bar chip at a level that has no Team row", () => {
    currentRow = makeRow({ level: "year", value: "2024", teamIds: ["team-bulls"] });
    currentTeamRows = [BULLS];
    render(
      <SetAttributesPanel
        selectorOptionId={SELECTOR_OPTION_ID}
        defaultCollapsed
      />,
    );
    expect(screen.queryByText("Bulls")).toBeNull();
  });
});

describe("teamCascadeConfirmCopy / teamClearConfirmCopy / teamSavedToast (NEO-277)", () => {
  const NONE = {
    nodesFollowing: 0,
    cardsFollowing: 0,
    cardsStaying: 0,
    cardsOverridden: 0,
    cardsTeamless: 0,
    cardsPendingName: 0,
    cardsCarryingCurrent: 0,
    truncated: false,
  };

  it("counts cards only, pluralises, and drops the staying sentence when nothing stays", () => {
    expect(
      teamCascadeConfirmCopy({
        teamNames: "Durham Bulls",
        levelLabel: "Insert",
        preview: { ...NONE, nodesFollowing: 1, cardsFollowing: 1 },
      }),
    ).toEqual({
      title: "Apply Durham Bulls to this insert?",
      description: "1 card under this insert will get Durham Bulls.",
    });
  });

  it("says 'More than' when the preview stopped counting", () => {
    const copy = teamCascadeConfirmCopy({
      teamNames: "Durham Bulls and Charlotte Knights",
      levelLabel: "Set",
      preview: { ...NONE, nodesFollowing: 12, cardsFollowing: 500, truncated: true },
    });
    expect(copy.description).toBe(
      "More than 500 cards under this set will get Durham Bulls and Charlotte Knights.",
    );
    expect(
      teamSavedToast({ ...NONE, nodesFollowing: 12, cardsFollowing: 500, truncated: true }),
    ).toBe("Saved Team · applying to more than 500 cards");
  });

  describe("the staying sentence, split by reason", () => {
    const body = (parts: Partial<typeof NONE>) =>
      teamCascadeConfirmCopy({
        teamNames: "Durham Bulls",
        levelLabel: "Set",
        preview: {
          ...NONE,
          cardsFollowing: 10,
          ...parts,
          cardsStaying:
            (parts.cardsOverridden ?? 0) +
            (parts.cardsTeamless ?? 0) +
            (parts.cardsPendingName ?? 0),
        },
      }).description;

    it("all three reasons, plural", () => {
      expect(
        body({ cardsOverridden: 2, cardsTeamless: 3, cardsPendingName: 4 }),
      ).toBe(
        "10 cards under this set will get Durham Bulls. 2 cards carry a different team, 3 are marked as having no team, 4 have a team name waiting for review — these will not change.",
      );
    });

    it("the example from the brief — mixed singular and plural", () => {
      expect(
        body({ cardsOverridden: 2, cardsTeamless: 1, cardsPendingName: 3 }),
      ).toBe(
        "10 cards under this set will get Durham Bulls. 2 cards carry a different team, 1 is marked as having no team, 3 have a team name waiting for review — these will not change.",
      );
    });

    it("a different team alone, singular and plural", () => {
      expect(body({ cardsOverridden: 1 })).toBe(
        "10 cards under this set will get Durham Bulls. 1 card carries a different team — these will not change.",
      );
      expect(body({ cardsOverridden: 5 })).toBe(
        "10 cards under this set will get Durham Bulls. 5 cards carry a different team — these will not change.",
      );
    });

    it("no team alone, singular and plural — leads with the noun", () => {
      expect(body({ cardsTeamless: 1 })).toBe(
        "10 cards under this set will get Durham Bulls. 1 card is marked as having no team — these will not change.",
      );
      expect(body({ cardsTeamless: 2 })).toBe(
        "10 cards under this set will get Durham Bulls. 2 cards are marked as having no team — these will not change.",
      );
    });

    it("a name in review alone, singular and plural — leads with the noun", () => {
      expect(body({ cardsPendingName: 1 })).toBe(
        "10 cards under this set will get Durham Bulls. 1 card has a team name waiting for review — these will not change.",
      );
      expect(body({ cardsPendingName: 6 })).toBe(
        "10 cards under this set will get Durham Bulls. 6 cards have a team name waiting for review — these will not change.",
      );
    });

    it("two of three, in the fixed order: different team, no team, name in review", () => {
      expect(body({ cardsTeamless: 1, cardsPendingName: 1 })).toBe(
        "10 cards under this set will get Durham Bulls. 1 card is marked as having no team, 1 has a team name waiting for review — these will not change.",
      );
      expect(body({ cardsOverridden: 1, cardsPendingName: 2 })).toBe(
        "10 cards under this set will get Durham Bulls. 1 card carries a different team, 2 have a team name waiting for review — these will not change.",
      );
      expect(body({ cardsOverridden: 3, cardsTeamless: 1 })).toBe(
        "10 cards under this set will get Durham Bulls. 3 cards carry a different team, 1 is marked as having no team — these will not change.",
      );
    });

    it("says nothing about staying when every reason is zero", () => {
      expect(body({})).toBe("10 cards under this set will get Durham Bulls.");
    });
  });

  it("the clear confirm names the team, the level and the cards that keep it", () => {
    expect(
      teamClearConfirmCopy({
        teamNames: "Durham Bulls",
        levelLabel: "Set",
        cardsCarryingCurrent: 28,
      }),
    ).toEqual({
      title: "Take Durham Bulls off this set?",
      description:
        "28 cards keep Durham Bulls. Picked the wrong team? Pick the right one instead and they'll follow.",
    });
    expect(
      teamClearConfirmCopy({
        teamNames: "Durham Bulls",
        levelLabel: "Parallel",
        cardsCarryingCurrent: 1,
      }),
    ).toEqual({
      title: "Take Durham Bulls off this parallel?",
      description:
        "1 card keeps Durham Bulls. Picked the wrong team? Pick the right one instead and they'll follow.",
    });
  });

  it("the toast is plain 'Saved Team' when no card followed — rows alone do not count", () => {
    expect(teamSavedToast(null)).toBe("Saved Team");
    expect(teamSavedToast({ ...NONE, cardsStaying: 3, cardsOverridden: 3 })).toBe(
      "Saved Team",
    );
    expect(teamSavedToast({ ...NONE, nodesFollowing: 4 })).toBe("Saved Team");
    expect(teamSavedToast({ ...NONE, cardsFollowing: 1 })).toBe(
      "Saved Team · applying to 1 card",
    );
  });
});

describe("SetAttributesPanel — Fill teams render gate (NEO-279)", () => {
  it("renders Fill teams at setName, named by its text so the name follows its state", () => {
    currentRow = makeRow({ level: "setName" });
    renderPanel();
    const button = screen.getByRole("button", { name: FILL_TEAMS_LABEL });
    expect(button.getAttribute("aria-label")).toBeNull();
    expect(button.textContent).toBe(FILL_TEAMS_LABEL);
  });

  it("renders exactly ONE Fill teams button after the selection moves to another set row", () => {
    // CI run 34930152576: the control and the delete control beside it were
    // both keyed on the bare row id. Two siblings with one key is undefined
    // for React ("children may be duplicated and/or omitted"), and after a
    // drill the header carried three Fill teams buttons with the dialog's
    // state landing on the wrong one. The panel does not remount when the
    // selection moves, so this is the shape that has to stay clean.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    currentRow = makeRow({ level: "setName" });
    const { rerender } = renderPanel();
    expect(screen.getAllByRole("button", { name: FILL_TEAMS_LABEL })).toHaveLength(1);

    currentRow = makeRow({ level: "setName", value: "Another set" });
    rerender(
      <SetAttributesPanel
        selectorOptionId={"selopt_another_set_row" as never}
        defaultCollapsed={false}
      />,
    );
    expect(screen.getAllByRole("button", { name: FILL_TEAMS_LABEL })).toHaveLength(1);
    expect(
      consoleError.mock.calls.some((args) =>
        args.some((a) => typeof a === "string" && a.includes("same key")),
      ),
    ).toBe(false);
    consoleError.mockRestore();
  });

  it.each(["variantType", "insert", "parallel"])(
    "does not render Fill teams at %s",
    (level) => {
      currentRow = makeRow({ level });
      renderPanel();
      expect(screen.queryByRole("button", { name: FILL_TEAMS_LABEL })).toBeNull();
    },
  );

  it("names its trigger and its ledger distinctly from the set team picker — no shared substring in either direction", () => {
    currentRow = makeRow({ level: "setName", teamIds: [] });
    renderPanel();

    for (const own of [FILL_TEAMS_LABEL, FILL_TEAMS_LIST_LABEL]) {
      for (const key of ["root", "trigger", "search", "results"] as const) {
        const picker = SET_TEAM_PICKER_LABELS[key];
        expect(own).not.toBe(picker);
        expect(own.includes(picker)).toBe(false);
        expect(picker.includes(own)).toBe(false);
      }
    }
  });
});

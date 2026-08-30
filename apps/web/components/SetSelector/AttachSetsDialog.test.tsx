/**
 * NEO-196 — AttachSetsDialog.
 *
 * This dialog decides which marketplace sets a NeonBinder row draws its cards
 * from, so a wrong answer here mis-sources an entire checklist. It shipped with
 * no test at all, which is how the reported defect survived: the candidate pool
 * was scoped to the row's OWN level under its OWN parent, so from a
 * Base / Insert / Parallel row the operator could only ever see other variants
 * of the same set — never the sibling set their cards were actually released in
 * (1996 Score DCAP is split across two BSC sets; 2021 Score's last 20 cards
 * shipped in Chronicles).
 *
 * What is pinned here:
 *
 *   1. The pool matches the rung being browsed. BSC opens on the row's own set
 *      and SportLots opens on every set under the year/manufacturer, each via
 *      its own action — SL is NOT asked at the NB row's level, which is what
 *      returned nothing for variantType and errored for parallel.
 *   2. The BSC browse control actually changes the pool: up to the year's set
 *      list, then back down into a SIBLING set's variants. This is the
 *      reported bug, expressed as an assertion.
 *   3. A BSC set in the set list is BOTH attachable and browsable (NEO-189),
 *      and a set already attached stays listed as a browse route but cannot be
 *      attached twice.
 *   4. Every BSC selection carries the FACET it was picked from — `setName`
 *      from the set list, `variantName` from a set's variant list (NEO-189).
 *      Without it the checklist fetch cannot tell a set slug from a variant
 *      slug and buckets it on the row's NB level instead, which is what
 *      discarded setName ids attached to Base and Parallel rows.
 *   5. Already-attached ids are excluded from both panes.
 *   6. Search filters each pane independently.
 *   7. Confirm batches everything selected — across both marketplaces AND
 *      across BSC sets reached by browsing — into ONE attachPlatformIds call.
 *   8. An adapter failure is reported in the pane that failed and does not
 *      blank the other. Before NEO-196 the dialog ignored `errors[]` entirely,
 *      so an outage and an empty marketplace both read "No unattached
 *      candidates."
 *   9. Enter on a browse button browses; it does not attach.
 *
 * --- Mocking strategy (mirrors BaseMappingForm.test.tsx) ---
 * convex/react's useAction/useMutation are module-mocked and routed by the
 * (string-mocked) action/mutation reference, so each backend call resolves
 * from an independently-controlled fixture per test.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    setReconciliation: {
      fetchSlAttachSets: "fetchSlAttachSets",
      fetchBscAttachOptions: "fetchBscAttachOptions",
    },
    selectorOptions: {
      attachPlatformIds: "attachPlatformIds",
    },
  },
}));

const mockFetchSl = vi.fn();
const mockFetchBsc = vi.fn();
const mockAttach = vi.fn();

vi.mock("convex/react", () => ({
  useAction: (ref: string) => {
    if (ref === "fetchSlAttachSets") return mockFetchSl;
    if (ref === "fetchBscAttachOptions") return mockFetchBsc;
    return vi.fn();
  },
  useMutation: (ref: string) =>
    ref === "attachPlatformIds" ? mockAttach : vi.fn(),
}));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks
// ---------------------------------------------------------------------------

import AttachSetsDialog from "./AttachSetsDialog";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROW_ID = "row-id-1" as unknown as Parameters<
  typeof AttachSetsDialog
>[0]["selectorOptionId"];

const PARENT_FILTERS = {
  sport: "Baseball",
  year: "2024",
  manufacturer: "Topps",
  setName: "2024 Topps Series 1",
};

/** Variants filed under the row's OWN BSC set. */
const OWN_SET_VARIANTS = [
  { value: "Gold Foil", platformValue: "gold-foil" },
  { value: "Rainbow Foil", platformValue: "rainbow-foil" },
];

/** Every BSC set for the year — one rung up. */
const YEAR_SETS = [
  { value: "Topps Chrome", platformValue: "topps-chrome" },
  { value: "Topps Heritage", platformValue: "topps-heritage" },
  { value: "Bowman", platformValue: "bowman" },
];

/** Variants filed under the SIBLING set the operator browses to. */
const SIBLING_SET_VARIANTS = [
  { value: "Heritage Chrome Refractor", platformValue: "heritage-chrome-ref" },
  { value: "Heritage Clubhouse Collection", platformValue: "heritage-clubhouse" },
];

/** SportLots' flat set list for the sport/year/brand. */
const SL_SETS = [
  { value: "Topps Chrome", platformValue: "884412" },
  { value: "Topps Heritage", platformValue: "889001" },
  { value: "Series 1", platformValue: "870555" },
];

function bscResponder() {
  return vi.fn(
    async (args: { view: "sets" | "variants"; setSlug?: string }) => {
      if (args.view === "sets") {
        return { success: true, options: YEAR_SETS, message: "" };
      }
      if (args.setSlug === "topps-heritage") {
        return {
          success: true,
          options: SIBLING_SET_VARIANTS,
          setSlug: "topps-heritage",
          message: "",
        };
      }
      return {
        success: true,
        options: OWN_SET_VARIANTS,
        setSlug: "topps-series-1",
        message: "",
      };
    },
  );
}

function renderDialog(
  overrides: {
    alreadyAttached?: { bsc: Set<string>; sportlots: Set<string> };
  } = {},
) {
  const onClose = vi.fn();
  render(
    <AttachSetsDialog
      isOpen
      parentFilters={PARENT_FILTERS}
      selectorOptionId={ROW_ID}
      alreadyAttached={
        overrides.alreadyAttached ?? {
          bsc: new Set<string>(),
          sportlots: new Set<string>(),
        }
      }
      onClose={onClose}
    />,
  );
  return { onClose };
}

const bscPane = () => screen.getByLabelText("BSC candidates");
const slPane = () => screen.getByLabelText("SportLots candidates");

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchSl.mockResolvedValue({
    success: true,
    options: SL_SETS,
    message: "",
  });
  mockFetchBsc.mockImplementation(bscResponder());
  mockAttach.mockResolvedValue({
    success: true,
    message: "",
    attachedCount: 1,
  });
});

// ---------------------------------------------------------------------------

describe("AttachSetsDialog — opening pools", () => {
  test("opens on the row's own BSC set and on every SportLots set for the year/manufacturer", async () => {
    renderDialog();

    await waitFor(() =>
      expect(within(bscPane()).getByLabelText("Toggle Gold Foil")).toBeTruthy(),
    );

    // BSC: the row's own set, requested without an explicit slug so the server
    // resolves it off the ancestor chain.
    expect(mockFetchBsc).toHaveBeenCalledTimes(1);
    expect(mockFetchBsc.mock.calls[0][0]).toEqual({
      selectorOptionId: ROW_ID,
      view: "variants",
    });

    // SportLots is asked its own question — NOT the NB row's level, which is
    // what returned nothing for variantType and errored outright for parallel.
    expect(mockFetchSl).toHaveBeenCalledTimes(1);
    expect(mockFetchSl.mock.calls[0][0]).toEqual({ selectorOptionId: ROW_ID });

    const sl = within(slPane());
    expect(sl.getByLabelText("Toggle Topps Chrome")).toBeTruthy();
    expect(sl.getByLabelText("Toggle Topps Heritage")).toBeTruthy();
    expect(sl.getByLabelText("Toggle Series 1")).toBeTruthy();
  });
});

describe("AttachSetsDialog — the BSC browse control changes the pool", () => {
  /**
   * The reported defect, as an assertion. From a Base / Insert / Parallel row
   * the operator must be able to step one level up to the year's sets and back
   * down into a SIBLING set — reaching candidates that do not exist under this
   * row's own parent at any level.
   */
  test("browses up to the year's sets and back down into a sibling set", async () => {
    renderDialog();
    await waitFor(() =>
      expect(within(bscPane()).getByLabelText("Toggle Gold Foil")).toBeTruthy(),
    );

    // --- one rung up: the year's set list
    fireEvent.click(screen.getByLabelText("Browse all BSC sets"));

    await waitFor(() =>
      expect(
        within(bscPane()).getByLabelText("Browse BSC set Topps Heritage"),
      ).toBeTruthy(),
    );
    expect(mockFetchBsc).toHaveBeenCalledTimes(2);
    expect(mockFetchBsc.mock.calls[1][0]).toEqual({
      selectorOptionId: ROW_ID,
      view: "sets",
    });

    // The pool genuinely swapped — the own-set variants are gone, the year's
    // sets are here, and they span manufacturers (BSC has no manufacturer
    // facet, so "Bowman" is expected and the pane says so).
    const bscUp = within(bscPane());
    expect(bscUp.queryByLabelText("Toggle Gold Foil")).toBeNull();
    expect(bscUp.getByLabelText("Browse BSC set Topps Chrome")).toBeTruthy();
    expect(bscUp.getByLabelText("Browse BSC set Bowman")).toBeTruthy();

    // --- back down into the sibling set
    fireEvent.click(screen.getByLabelText("Browse BSC set Topps Heritage"));

    await waitFor(() =>
      expect(
        within(bscPane()).getByLabelText("Toggle Heritage Chrome Refractor"),
      ).toBeTruthy(),
    );
    expect(mockFetchBsc).toHaveBeenCalledTimes(3);
    expect(mockFetchBsc.mock.calls[2][0]).toEqual({
      selectorOptionId: ROW_ID,
      view: "variants",
      setSlug: "topps-heritage",
    });

    const bscDown = within(bscPane());
    expect(bscDown.getByLabelText("Toggle Heritage Clubhouse Collection")).toBeTruthy();
    expect(bscDown.queryByLabelText("Toggle Gold Foil")).toBeNull();
  });

  test("a BSC set in the set list is BOTH attachable and browsable (NEO-189)", async () => {
    // It used to be browse-only, because `fetchBscChecklist` read every BSC id
    // on a row as a variantName and a setName slug therefore sourced nothing.
    // NEO-189 records the facet on the slot, so a setName slug plus the row's
    // own variant IS a source of cards — and it is the only way to express the
    // split this whole feature exists for (BSC files Topps Series 1 and
    // Series 2 as two sets where SportLots files one).
    renderDialog();
    await waitFor(() =>
      expect(within(bscPane()).getByLabelText("Toggle Gold Foil")).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText("Browse all BSC sets"));
    await waitFor(() =>
      expect(
        within(bscPane()).getByLabelText("Browse BSC set Topps Heritage"),
      ).toBeTruthy(),
    );

    const bsc = within(bscPane());
    expect(bsc.getByLabelText("Toggle Topps Heritage")).toBeTruthy();
    expect(bsc.getByLabelText("Toggle Bowman")).toBeTruthy();
    // Select and browse stay separate controls: attaching a set and stepping
    // into it are different intents and must not share a click target.
    expect(bsc.getByLabelText("Browse BSC set Bowman")).toBeTruthy();
  });

  test("a BSC set already attached stays browsable but cannot be attached twice", async () => {
    // Filtering it out of the list instead would make its variants
    // unreachable the moment the operator attached the set itself — the set
    // list is the ONLY route down into a sibling set.
    renderDialog({
      alreadyAttached: {
        bsc: new Set(["topps-heritage"]),
        sportlots: new Set<string>(),
      },
    });
    await waitFor(() =>
      expect(within(bscPane()).getByLabelText("Toggle Gold Foil")).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText("Browse all BSC sets"));
    await waitFor(() =>
      expect(
        within(bscPane()).getByLabelText("Browse BSC set Topps Heritage"),
      ).toBeTruthy(),
    );

    const bsc = within(bscPane());
    expect(bsc.queryByLabelText("Toggle Topps Heritage")).toBeNull();
    expect(
      bsc.getByLabelText("Topps Heritage is already attached"),
    ).toBeTruthy();
    // Still listed, still a route down.
    expect(bsc.getByLabelText("Browse BSC set Topps Heritage")).toBeTruthy();
    // Unattached siblings are unaffected.
    expect(bsc.getByLabelText("Toggle Bowman")).toBeTruthy();
  });

  test("a selected BSC set carries facet setName; a selected variant carries variantName", async () => {
    // THE BUG THIS PINS: a BSC slug is not self-describing. Sent without a
    // facet, `topps-heritage` is bucketed by the row's NB level — dropped
    // outright on a Base or Parallel row — and the operator gets a checklist
    // that silently sources nothing from the set they just attached.
    renderDialog();
    await waitFor(() =>
      expect(within(bscPane()).getByLabelText("Toggle Gold Foil")).toBeTruthy(),
    );

    // …a variant, from the variants rung
    fireEvent.click(within(bscPane()).getByLabelText("Toggle Gold Foil"));

    // …and a SET, from the set-list rung
    fireEvent.click(screen.getByLabelText("Browse all BSC sets"));
    await waitFor(() =>
      expect(
        within(bscPane()).getByLabelText("Toggle Topps Heritage"),
      ).toBeTruthy(),
    );
    fireEvent.click(within(bscPane()).getByLabelText("Toggle Topps Heritage"));

    fireEvent.click(screen.getByLabelText("Confirm attach sets"));
    await waitFor(() => expect(mockAttach).toHaveBeenCalledTimes(1));

    expect(mockAttach.mock.calls[0][0].additions.bsc).toEqual([
      { id: "gold-foil", label: "Gold Foil", facet: "variantName" },
      { id: "topps-heritage", label: "Topps Heritage", facet: "setName" },
    ]);
    // SportLots has one unit of attachment, so it never carries a facet.
    expect(mockAttach.mock.calls[0][0].additions.sportlots).toEqual([]);
  });

  test("two BSC sets on one row — the N:M case — attach as two setName ids", async () => {
    // The product owner's example: BSC files 2024 Topps as Series 1 and
    // Series 2 while SportLots files one set, so one NB Base row has to draw
    // from two BSC setName sets. Before NEO-189 neither could be attached at
    // all, and had they been, `fetchBscChecklist` would have sent both slugs
    // as one multi-value facet — which BSC answers 200 OK with an empty body.
    renderDialog();
    await waitFor(() =>
      expect(within(bscPane()).getByLabelText("Toggle Gold Foil")).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText("Browse all BSC sets"));
    await waitFor(() =>
      expect(
        within(bscPane()).getByLabelText("Toggle Topps Chrome"),
      ).toBeTruthy(),
    );
    fireEvent.click(within(bscPane()).getByLabelText("Toggle Topps Chrome"));
    fireEvent.click(within(bscPane()).getByLabelText("Toggle Topps Heritage"));

    fireEvent.click(screen.getByLabelText("Confirm attach sets"));
    await waitFor(() => expect(mockAttach).toHaveBeenCalledTimes(1));

    expect(mockAttach.mock.calls[0][0].additions.bsc).toEqual([
      { id: "topps-chrome", label: "Topps Chrome", facet: "setName" },
      { id: "topps-heritage", label: "Topps Heritage", facet: "setName" },
    ]);
  });

  test("browsing BSC does not re-run the SportLots fetch", async () => {
    renderDialog();
    await waitFor(() => expect(mockFetchSl).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByLabelText("Browse all BSC sets"));
    await waitFor(() =>
      expect(
        within(bscPane()).getByLabelText("Browse BSC set Topps Heritage"),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByLabelText("Browse BSC set Topps Heritage"));
    await waitFor(() => expect(mockFetchBsc).toHaveBeenCalledTimes(3));

    // SL's list is scraped HTML and does not depend on the BSC rung.
    expect(mockFetchSl).toHaveBeenCalledTimes(1);
  });
});

describe("AttachSetsDialog — exclusions and search", () => {
  test("excludes already-attached ids from both panes", async () => {
    renderDialog({
      alreadyAttached: {
        bsc: new Set(["gold-foil"]),
        sportlots: new Set(["884412"]),
      },
    });

    await waitFor(() =>
      expect(within(bscPane()).getByLabelText("Toggle Rainbow Foil")).toBeTruthy(),
    );

    expect(within(bscPane()).queryByLabelText("Toggle Gold Foil")).toBeNull();

    const sl = within(slPane());
    expect(sl.queryByLabelText("Toggle Topps Chrome")).toBeNull();
    expect(sl.getByLabelText("Toggle Topps Heritage")).toBeTruthy();
  });

  test("the exclusion follows the operator into a sibling set", async () => {
    renderDialog({
      alreadyAttached: {
        bsc: new Set(["heritage-clubhouse"]),
        sportlots: new Set<string>(),
      },
    });
    await waitFor(() =>
      expect(within(bscPane()).getByLabelText("Toggle Gold Foil")).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText("Browse all BSC sets"));
    await waitFor(() =>
      expect(
        within(bscPane()).getByLabelText("Browse BSC set Topps Heritage"),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByLabelText("Browse BSC set Topps Heritage"));

    await waitFor(() =>
      expect(
        within(bscPane()).getByLabelText("Toggle Heritage Chrome Refractor"),
      ).toBeTruthy(),
    );
    expect(
      within(bscPane()).queryByLabelText("Toggle Heritage Clubhouse Collection"),
    ).toBeNull();
  });

  test("search filters each pane independently", async () => {
    renderDialog();
    await waitFor(() =>
      expect(within(bscPane()).getByLabelText("Toggle Gold Foil")).toBeTruthy(),
    );

    // Narrow SportLots only.
    fireEvent.change(screen.getByLabelText("Search SportLots sets"), {
      target: { value: "heritage" },
    });

    const sl = within(slPane());
    expect(sl.getByLabelText("Toggle Topps Heritage")).toBeTruthy();
    expect(sl.queryByLabelText("Toggle Topps Chrome")).toBeNull();
    expect(sl.queryByLabelText("Toggle Series 1")).toBeNull();

    // BSC is untouched by SportLots' query.
    const bscUntouched = within(bscPane());
    expect(bscUntouched.getByLabelText("Toggle Gold Foil")).toBeTruthy();
    expect(bscUntouched.getByLabelText("Toggle Rainbow Foil")).toBeTruthy();

    // Now narrow BSC only, and confirm SportLots keeps its own query.
    fireEvent.change(screen.getByLabelText("Search BSC sets"), {
      target: { value: "rainbow" },
    });

    const bsc = within(bscPane());
    expect(bsc.getByLabelText("Toggle Rainbow Foil")).toBeTruthy();
    expect(bsc.queryByLabelText("Toggle Gold Foil")).toBeNull();
    expect(within(slPane()).getByLabelText("Toggle Topps Heritage")).toBeTruthy();
    expect(within(slPane()).queryByLabelText("Toggle Topps Chrome")).toBeNull();
  });

  test("a search that matches nothing says so, rather than claiming the marketplace is empty", async () => {
    renderDialog();
    await waitFor(() =>
      expect(within(slPane()).getByLabelText("Toggle Series 1")).toBeTruthy(),
    );

    fireEvent.change(screen.getByLabelText("Search SportLots sets"), {
      target: { value: "panini" },
    });

    const sl = within(slPane());
    expect(sl.getByText(/No matches for/i)).toBeTruthy();
    expect(sl.queryByText(/No unattached SportLots sets/i)).toBeNull();
  });

  test("search matches the marketplace id as well as the display name", async () => {
    renderDialog();
    await waitFor(() =>
      expect(within(slPane()).getByLabelText("Toggle Series 1")).toBeTruthy(),
    );

    fireEvent.change(screen.getByLabelText("Search SportLots sets"), {
      target: { value: "889001" },
    });

    const sl = within(slPane());
    expect(sl.getByLabelText("Toggle Topps Heritage")).toBeTruthy();
    expect(sl.queryByLabelText("Toggle Series 1")).toBeNull();
  });
});

describe("AttachSetsDialog — confirming", () => {
  test("batches both marketplaces and both BSC sets into one attachPlatformIds call", async () => {
    const { onClose } = renderDialog();
    await waitFor(() =>
      expect(within(bscPane()).getByLabelText("Toggle Gold Foil")).toBeTruthy(),
    );

    // One from the row's own BSC set…
    fireEvent.click(within(bscPane()).getByLabelText("Toggle Gold Foil"));
    // …one from SportLots…
    fireEvent.click(within(slPane()).getByLabelText("Toggle Topps Heritage"));

    // …and one from a SIBLING BSC set reached by browsing. A selection made
    // before browsing must survive the rung change, or batching across sets is
    // impossible and the operator has to re-open the dialog per set.
    fireEvent.click(screen.getByLabelText("Browse all BSC sets"));
    await waitFor(() =>
      expect(
        within(bscPane()).getByLabelText("Browse BSC set Topps Heritage"),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByLabelText("Browse BSC set Topps Heritage"));
    await waitFor(() =>
      expect(
        within(bscPane()).getByLabelText("Toggle Heritage Chrome Refractor"),
      ).toBeTruthy(),
    );
    fireEvent.click(
      within(bscPane()).getByLabelText("Toggle Heritage Chrome Refractor"),
    );

    expect(screen.getByText("3 sets selected")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Confirm attach sets"));

    await waitFor(() => expect(mockAttach).toHaveBeenCalledTimes(1));
    expect(mockAttach.mock.calls[0][0]).toEqual({
      selectorOptionId: ROW_ID,
      additions: {
        bsc: [
          { id: "gold-foil", label: "Gold Foil", facet: "variantName" },
          {
            id: "heritage-chrome-ref",
            label: "Heritage Chrome Refractor",
            facet: "variantName",
          },
        ],
        sportlots: [{ id: "889001", label: "Topps Heritage" }],
      },
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  test("an edited label is what gets attached", async () => {
    renderDialog();
    await waitFor(() =>
      expect(within(slPane()).getByLabelText("Toggle Topps Chrome")).toBeTruthy(),
    );

    fireEvent.click(within(slPane()).getByLabelText("Toggle Topps Chrome"));
    fireEvent.change(screen.getByLabelText("Edit label for Topps Chrome"), {
      target: { value: "Chrome (SL)" },
    });
    fireEvent.click(screen.getByLabelText("Confirm attach sets"));

    await waitFor(() => expect(mockAttach).toHaveBeenCalledTimes(1));
    expect(mockAttach.mock.calls[0][0].additions.sportlots).toEqual([
      { id: "884412", label: "Chrome (SL)" },
    ]);
  });

  test("Confirm is inert with nothing selected", async () => {
    renderDialog();
    await waitFor(() =>
      expect(within(bscPane()).getByLabelText("Toggle Gold Foil")).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText("Confirm attach sets"));
    expect(mockAttach).not.toHaveBeenCalled();
  });
});

describe("AttachSetsDialog — failures and keyboard", () => {
  test("a BSC failure is reported in the BSC pane and does not blank SportLots", async () => {
    mockFetchBsc.mockResolvedValue({
      success: false,
      options: [],
      message: "No BSC token available",
    });

    renderDialog();

    await waitFor(() =>
      expect(within(bscPane()).getByRole("alert")).toBeTruthy(),
    );
    expect(within(bscPane()).getByRole("alert").textContent).toContain(
      "No BSC token available",
    );
    // The empty-state copy must NOT stand in for a failure — that equivalence
    // is exactly what hid this class of bug.
    expect(
      within(bscPane()).queryByText(/already attached/i),
    ).toBeNull();

    const sl = within(slPane());
    expect(sl.getByLabelText("Toggle Topps Chrome")).toBeTruthy();
    expect(sl.queryByRole("alert")).toBeNull();
  });

  test("a SportLots failure is reported in the SportLots pane and does not blank BSC", async () => {
    mockFetchSl.mockResolvedValue({
      success: false,
      options: [],
      message: "SportLots session expired. Re-authenticate from Profile.",
    });

    renderDialog();

    await waitFor(() =>
      expect(within(slPane()).getByRole("alert")).toBeTruthy(),
    );
    expect(within(slPane()).getByRole("alert").textContent).toContain(
      "session expired",
    );
    expect(within(bscPane()).getByLabelText("Toggle Gold Foil")).toBeTruthy();
  });

  test("Enter on a browse button browses instead of attaching", async () => {
    renderDialog();
    await waitFor(() =>
      expect(within(bscPane()).getByLabelText("Toggle Gold Foil")).toBeTruthy(),
    );
    fireEvent.click(within(bscPane()).getByLabelText("Toggle Gold Foil"));

    // The dialog's document-level Enter handler used to preventDefault() on
    // every Enter that was not in a text input, which would swallow a browse
    // button's own activation and attach instead.
    const browseButton = screen.getByLabelText("Browse all BSC sets");
    browseButton.focus();
    fireEvent.keyDown(browseButton, { key: "Enter" });

    expect(mockAttach).not.toHaveBeenCalled();
  });

  test("Escape cancels", async () => {
    const { onClose } = renderDialog();
    await waitFor(() =>
      expect(within(bscPane()).getByLabelText("Toggle Gold Foil")).toBeTruthy(),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockAttach).not.toHaveBeenCalled();
  });
});

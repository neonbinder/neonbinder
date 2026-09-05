/**
 * NEO-189 — MultiSourcePanel is the only place an operator sees what a row is
 * actually attached to, so it has to say which BSC FACET each slot filters on.
 *
 * Two BSC slugs on one row can mean completely different things: a slug tagged
 * `setName` sources the whole set at this row's variant (the Topps Series 1 /
 * Series 2 split this feature exists for), while a slug tagged `variantName`
 * sources one named variant inside a set. Nothing in the label or the slug
 * separates them, and getting it wrong mis-sources an entire checklist — which
 * is the failure mode this whole surface guards against.
 *
 * An UNTAGGED slot renders with no tag at all, deliberately. Every slot written
 * before NEO-189 and every slot the reconciler writes is untagged, and those
 * are handled by the old NB-level rule; showing a guessed tag would tell the
 * operator the row sources something it does not.
 *
 * Mocking strategy mirrors AttachSetsDialog.test.tsx: convex/react's
 * useQuery/useMutation are module-mocked and routed by the (string-mocked)
 * function reference.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptionById: "getSelectorOptionById",
      getAncestorChain: "getAncestorChain",
      detachPlatformId: "detachPlatformId",
      renamePlatformLabel: "renamePlatformLabel",
      getSlotCardCounts: "getSlotCardCounts",
    },
    setReconciliation: {
      fetchSlAttachSets: "fetchSlAttachSets",
      fetchBscAttachOptions: "fetchBscAttachOptions",
    },
  },
}));

const queryResults: Record<string, unknown> = {};
/** One stable spy per mutation reference, so a test can assert its args. */
const mutationSpies: Record<string, ReturnType<typeof vi.fn>> = {};

vi.mock("convex/react", () => ({
  useQuery: (ref: string) => queryResults[ref],
  useMutation: (ref: string) => {
    if (!mutationSpies[ref]) mutationSpies[ref] = vi.fn();
    return mutationSpies[ref];
  },
  useAction: () => vi.fn(),
}));

import MultiSourcePanel from "./MultiSourcePanel";

const ROW_ID = "row-1" as unknown as Parameters<
  typeof MultiSourcePanel
>[0]["selectorOptionId"];

const SERIES_1 = "2024-topps-series-1";
const SERIES_2 = "2024-topps-series-2";

/** A Base row carrying the reconciler's untagged slot plus tagged extras. */
function setRow(row: Record<string, unknown>) {
  queryResults.getSelectorOptionById = {
    _id: ROW_ID,
    level: "variantType",
    value: "Base",
    ...row,
  };
  queryResults.getAncestorChain = [
    { _id: "sport-1", level: "sport", value: "Baseball", platformData: {} },
    { _id: ROW_ID, level: "variantType", value: "Base", platformData: {} },
  ];
}

const bscColumn = () => screen.getByText("BSC").parentElement as HTMLElement;

beforeEach(() => {
  delete queryResults.getSelectorOptionById;
  delete queryResults.getAncestorChain;
  delete queryResults.getSlotCardCounts;
  mutationSpies.detachPlatformId = vi.fn().mockResolvedValue({ success: true });
  mutationSpies.renamePlatformLabel = vi.fn().mockResolvedValue({ success: true });
});

describe("MultiSourcePanel — the facet a BSC slot filters on (NEO-189)", () => {
  test("a setName slot reads 'set' and a variantName slot reads 'variant'", () => {
    setRow({
      platformData: { bsc: { b0: "base", b1: SERIES_1, b2: "gold-foil" } },
      platformLabels: {
        bsc: { b0: "Base", b1: "Series 1", b2: "Gold Foil" },
      },
      platformFacets: { bsc: { b1: "setName", b2: "variantName" } },
      primaryPlatformId: { bsc: "b0" },
    });
    render(<MultiSourcePanel selectorOptionId={ROW_ID} />);

    const bsc = within(bscColumn());
    expect(
      bsc.getByLabelText("Series 1 is attached as a BSC set"),
    ).toBeTruthy();
    expect(
      bsc.getByLabelText("Gold Foil is attached as a BSC variant"),
    ).toBeTruthy();
  });

  test("an UNTAGGED slot shows no facet tag — it is inert, not unknown", () => {
    // NEO-239 moved WHERE it renders (it is under "Needs re-mapping" now,
    // not a chip), but the original point stands and is retested here: a slot
    // whose facet nobody recorded must never be shown a guessed one. The panel
    // saying "set" over an untagged slug would tell the operator this row
    // sources a whole set when the fetch ignores it entirely.
    setRow({
      platformData: { bsc: { b0: "base" } },
      platformLabels: { bsc: { b0: "Base" } },
      primaryPlatformId: { bsc: "b0" },
    });
    render(<MultiSourcePanel selectorOptionId={ROW_ID} />);

    const bsc = within(bscColumn());
    expect(bsc.getByText("Base")).toBeTruthy();
    expect(bsc.queryByLabelText(/is attached as a BSC/)).toBeNull();
  });

  test("both halves of an N:M split are listed, each tagged as a set", () => {
    // The product owner's case rendered: one NB Base row, two BSC sets.
    setRow({
      platformData: { bsc: { b1: SERIES_1, b2: SERIES_2 } },
      platformLabels: { bsc: { b1: "Series 1", b2: "Series 2" } },
      platformFacets: { bsc: { b1: "setName", b2: "setName" } },
      primaryPlatformId: { bsc: "b1" },
    });
    render(<MultiSourcePanel selectorOptionId={ROW_ID} />);

    const bsc = within(bscColumn());
    expect(bsc.getByLabelText("Series 1 is attached as a BSC set")).toBeTruthy();
    expect(bsc.getByLabelText("Series 2 is attached as a BSC set")).toBeTruthy();
  });

  test("a `variant` slot is SCOPE — it qualifies the source instead of being one", () => {
    // The reported bug. A Base variant type carries BSC's `base` slug (which
    // narrows the query to the base cards) beside the set Base mapping stored.
    // Rendered as two chips they read as two sources; there is one source,
    // sliced. The slug becomes the qualifier on the chip it narrows.
    setRow({
      platformData: { bsc: { b0: "base", b1: "topps" } },
      platformLabels: { bsc: { b0: "Base", b1: "Topps" } },
      platformFacets: { bsc: { b0: "variant", b1: "setName" } },
      primaryPlatformId: { bsc: "b1" },
    });
    render(<MultiSourcePanel selectorOptionId={ROW_ID} />);

    const bsc = within(bscColumn());
    // ONE chip, and it reads "Topps · base cards".
    expect(bsc.getByLabelText("Remove Topps")).toBeTruthy();
    expect(bsc.getByText("· base cards")).toBeTruthy();
    // The scope slug is not a chip, has no ×, and is not up for re-mapping
    // either — it is doing its job.
    expect(bsc.queryByLabelText("Remove Base")).toBeNull();
    expect(bsc.queryByText("Needs re-mapping")).toBeNull();
  });

  test("an insert's source carries NO qualifier — its scope is all ancestral", () => {
    // The set and the variant slice are ancestors, and the breadcrumb above the
    // panel already names them. Repeating them per chip would make the chip
    // look like it describes a different source.
    queryResults.getSelectorOptionById = {
      _id: ROW_ID,
      level: "insert",
      value: "Homefield Advantage",
      platformData: { bsc: { b0: "homefield-advantage" } },
      platformLabels: { bsc: { b0: "Homefield Advantage" } },
      platformFacets: { bsc: { b0: "variantName" } },
      primaryPlatformId: { bsc: "b0" },
    };
    queryResults.getAncestorChain = [
      { _id: "set-1", level: "setName", value: "Topps", platformData: { bsc: { b0: "topps" } } },
      { _id: "vt-1", level: "variantType", value: "Insert", platformData: { bsc: { b0: "insert" } }, platformFacets: { bsc: { b0: "variant" } } },
      { _id: ROW_ID, level: "insert", value: "Homefield Advantage", platformData: { bsc: { b0: "homefield-advantage" } } },
    ];
    render(<MultiSourcePanel selectorOptionId={ROW_ID} />);

    const bsc = within(bscColumn());
    expect(bsc.getByLabelText("Remove Homefield Advantage")).toBeTruthy();
    expect(bsc.queryByText(/· .* cards/)).toBeNull();
  });

  test("a legacy untagged slot is listed under 'Needs re-mapping', with no ×", () => {
    // The NEO-189 corruption class: a mis-saved mapping wrote a setName slug
    // into a variantType row's slot. It sources nothing, so it is not a chip —
    // but hiding it is how it went unnoticed in the first place. Shown, inert,
    // and named for the fix. No detach: the remedy is to re-attach it with a
    // facet, not to delete the evidence.
    setRow({
      platformData: { bsc: { b0: "topps" } },
      platformLabels: { bsc: { b0: "Topps" } },
      primaryPlatformId: { bsc: "b0" },
    });
    render(<MultiSourcePanel selectorOptionId={ROW_ID} />);

    const bsc = within(bscColumn());
    expect(bsc.getByText("Needs re-mapping")).toBeTruthy();
    expect(bsc.getByText("Topps")).toBeTruthy();
    expect(bsc.queryByLabelText("Remove Topps")).toBeNull();
    expect(bsc.queryByLabelText("Rename label for topps")).toBeNull();
    // Not the empty state either: there IS something attached, it just does
    // not source anything yet.
    expect(bsc.queryByText("No sets attached.")).toBeNull();
  });

  test("renders for a row with NO ids at all — that is the attach affordance", () => {
    // NEO-239. This panel used to return null for a row flagged `isCustom`, on
    // the theory that a hand-entered row "has no marketplace concept". It was
    // backwards: the panel IS the only way to attach a first id, so hiding it
    // on exactly the rows that have none made them permanently unattachable,
    // and made a set entered by hand a second class of thing. A set either
    // carries marketplace ids or it does not, and both behave the same.
    setRow({ platformData: {}, isCustom: true });
    render(<MultiSourcePanel selectorOptionId={ROW_ID} />);

    expect(screen.getByText("Multi-source sets")).toBeTruthy();
    expect(screen.getByLabelText("Attach more source sets")).toBeTruthy();
    // Both sides say so explicitly rather than rendering an empty column.
    expect(screen.getAllByText("No sets attached.")).toHaveLength(2);
  });

  test("SportLots chips never carry a facet tag", () => {
    // SL has one unit of attachment, so a tag there would be noise that reads
    // as a distinction the marketplace does not make.
    setRow({
      platformData: { sportlots: { s0: "884412" } },
      platformLabels: { sportlots: { s0: "Topps" } },
      primaryPlatformId: { sportlots: "s0" },
    });
    render(<MultiSourcePanel selectorOptionId={ROW_ID} />);

    const sl = within(screen.getByText("SportLots").parentElement as HTMLElement);
    expect(sl.getByText("Topps")).toBeTruthy();
    expect(sl.queryByLabelText(/is attached as a BSC/)).toBeNull();
  });
});

/**
 * NEO-219 part 1 — every detach asks first, and the question states the cost.
 *
 * The old panel had two × buttons with two contracts: the primary chip's asked
 * ("a later sync could re-add it"), the non-primary chip's detached on the
 * first click. That was backwards. Detaching retires the slot key for good
 * (`platformSlotSeq` is never rewound), so every card sourced through that slot
 * is left holding an orphaned ref that re-attaching does NOT heal — while
 * "primary" only records which slot the reconciler refreshes. So the count of
 * cards is the thing the confirm has to say, and it is the thing these tests
 * pin: the sentence, the side it names, and the `acknowledgedCards` handshake
 * that stops a detach being committed against a number the operator never saw.
 */
describe("MultiSourcePanel — one confirm for every detach (NEO-219)", () => {
  /**
   * Two BSC slots (b0 primary "Base", b1 extra "Series 1") plus one SL slot,
   * so one fixture covers primary/non-primary and both side labels.
   */
  function setTwoSidedRow() {
    // NEO-239: both BSC slots are TAGGED here, where this fixture once left
    // them bare. An untagged slot on a variantType row resolves to no facet at
    // all, so it is no longer a chip — and these tests are about the detach
    // CONFIRM, which needs a chip to hang off. Tagging them is what the rows
    // actually look like after NEO-189; every assertion below is unchanged.
    setRow({
      platformData: {
        bsc: { b0: "base", b1: SERIES_1 },
        sportlots: { s0: "884412" },
      },
      platformFacets: { bsc: { b0: "setName", b1: "setName" } },
      platformLabels: {
        bsc: { b0: "Base", b1: "Series 1" },
        sportlots: { s0: "Topps" },
      },
      primaryPlatformId: { bsc: "b0", sportlots: "s0" },
    });
  }

  function setCounts(counts: {
    bsc?: Record<string, number>;
    sportlots?: Record<string, number>;
  }) {
    const bsc = counts.bsc ?? {};
    const sportlots = counts.sportlots ?? {};
    queryResults.getSlotCardCounts = {
      bsc,
      sportlots,
      total: [...Object.values(bsc), ...Object.values(sportlots)].reduce(
        (a, b) => a + b,
        0,
      ),
    };
  }

  test("the NON-primary chip's × opens the confirm instead of detaching — the old one-click path is gone", () => {
    setTwoSidedRow();
    setCounts({ bsc: { b0: 110, b1: 1 } });
    render(<MultiSourcePanel selectorOptionId={ROW_ID} />);

    // The old asymmetric label is gone: both chips offer the same control.
    expect(screen.queryByLabelText("Detach Series 1")).toBeNull();
    fireEvent.click(screen.getByLabelText("Remove Series 1"));

    expect(screen.getByRole("group", { name: /Detach BSC "Series 1"\?/ })).toBeTruthy();
    expect(mutationSpies.detachPlatformId).not.toHaveBeenCalled();
  });

  test("the sentence carries the card count and the side it belongs to", () => {
    setTwoSidedRow();
    setCounts({ bsc: { b0: 110, b1: 1 }, sportlots: { s0: 0 } });
    render(<MultiSourcePanel selectorOptionId={ROW_ID} />);

    // Plural, non-primary: no re-add clause.
    fireEvent.click(screen.getByLabelText("Remove Series 1"));
    expect(
      screen.getByText(
        'Detach BSC "Series 1"? 1 card was fetched from it; its BSC link will be dropped.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Cancel detach Series 1"));

    // Primary: same sentence plus the consequence only it carries.
    fireEvent.click(screen.getByLabelText("Remove Base"));
    expect(
      screen.getByText(
        'Detach BSC "Base"? 110 cards were fetched from it; their BSC link will be dropped. A later sync of this row could re-add it.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Cancel detach Base"));

    // SportLots side, and the zero case, which drops the dangling clause
    // entirely rather than promising to drop a link no card holds.
    fireEvent.click(screen.getByLabelText("Remove Topps"));
    expect(
      screen.getByText(
        'Detach SportLots "Topps"? No cards were fetched from it. A later sync of this row could re-add it.',
      ),
    ).toBeTruthy();
  });

  test("Escape returns to idle, detaches nothing, and puts focus back on the ×", async () => {
    setTwoSidedRow();
    setCounts({ bsc: { b0: 110, b1: 1 } });
    render(<MultiSourcePanel selectorOptionId={ROW_ID} />);

    fireEvent.click(screen.getByLabelText("Remove Series 1"));
    const group = screen.getByRole("group", { name: /Detach BSC "Series 1"\?/ });
    fireEvent.keyDown(group, { key: "Escape" });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText("Remove Series 1"));
    });
    expect(screen.queryByRole("group", { name: /Detach BSC/ })).toBeNull();
    expect(mutationSpies.detachPlatformId).not.toHaveBeenCalled();
  });

  test("focus opens on Cancel, and Enter there does not detach", async () => {
    setTwoSidedRow();
    setCounts({ bsc: { b0: 110, b1: 1 } });
    render(<MultiSourcePanel selectorOptionId={ROW_ID} />);

    fireEvent.click(screen.getByLabelText("Remove Series 1"));
    const cancel = screen.getByLabelText("Cancel detach Series 1");
    await waitFor(() => expect(document.activeElement).toBe(cancel));

    // There is deliberately no row-level Enter handler: Enter may only fire
    // the button that actually has focus, which on open is the safe one.
    fireEvent.keyDown(cancel, { key: "Enter" });
    expect(mutationSpies.detachPlatformId).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: /Detach BSC "Series 1"\?/ })).toBeTruthy();
  });

  test("Confirm sends the count the operator was shown as acknowledgedCards", async () => {
    setTwoSidedRow();
    setCounts({ bsc: { b0: 110, b1: 1 } });
    render(<MultiSourcePanel selectorOptionId={ROW_ID} />);

    fireEvent.click(screen.getByLabelText("Remove Series 1"));
    fireEvent.click(screen.getByLabelText("Confirm detach Series 1"));

    await waitFor(() => {
      expect(mutationSpies.detachPlatformId).toHaveBeenCalledWith({
        selectorOptionId: ROW_ID,
        side: "bsc",
        slot: "b1",
        confirmPrimary: false,
        acknowledgedCards: 1,
      });
    });
  });

  test("Confirm is inert and says so while the count is still in flight", () => {
    setTwoSidedRow();
    // getSlotCardCounts deliberately unresolved.
    render(<MultiSourcePanel selectorOptionId={ROW_ID} />);

    fireEvent.click(screen.getByLabelText("Remove Series 1"));
    const confirm = screen.getByLabelText("Counting cards for Series 1");
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(confirm.textContent).toBe("Counting cards…");
    // The sentence must not claim zero before the query has answered.
    expect(screen.queryByText(/No cards were fetched/)).toBeNull();

    fireEvent.click(confirm);
    expect(mutationSpies.detachPlatformId).not.toHaveBeenCalled();
  });

  test("a DETACH_COUNT_CHANGED refusal keeps the confirm open, showing the server's fresh count", async () => {
    setTwoSidedRow();
    setCounts({ bsc: { b0: 110, b1: 1 } });
    mutationSpies.detachPlatformId = vi
      .fn()
      .mockRejectedValue({ data: { code: "DETACH_COUNT_CHANGED", cards: 7 } });
    render(<MultiSourcePanel selectorOptionId={ROW_ID} />);

    fireEvent.click(screen.getByLabelText("Remove Series 1"));
    fireEvent.click(screen.getByLabelText("Confirm detach Series 1"));

    await waitFor(() => {
      expect(
        screen.getByText(
          'Detach BSC "Series 1"? 7 cards were fetched from it; their BSC link will be dropped.',
        ),
      ).toBeTruthy();
    });
    expect(screen.getByRole("alert").textContent).toContain("it now reads 7");
    // Still open, still offering the same decision — nothing was written.
    expect(screen.getByLabelText("Confirm detach Series 1")).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // Adversarial pass (NEO-219 readiness)
  // ---------------------------------------------------------------------------

  test("DETACH_COUNT_CHANGED can fire twice in a row — the SECOND fresh count replaces the first, and still nothing commits", async () => {
    setTwoSidedRow();
    setCounts({ bsc: { b0: 110, b1: 1 } });
    mutationSpies.detachPlatformId = vi
      .fn()
      .mockRejectedValueOnce({ data: { code: "DETACH_COUNT_CHANGED", cards: 7 } })
      .mockRejectedValueOnce({ data: { code: "DETACH_COUNT_CHANGED", cards: 9 } });
    render(<MultiSourcePanel selectorOptionId={ROW_ID} />);

    fireEvent.click(screen.getByLabelText("Remove Series 1"));
    fireEvent.click(screen.getByLabelText("Confirm detach Series 1"));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("it now reads 7");
    });

    // Confirm again against the fresh (7) number — the mock refuses AGAIN with
    // a still-newer number.
    fireEvent.click(screen.getByLabelText("Confirm detach Series 1"));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("it now reads 9");
    });
    expect(
      screen.getByText(
        'Detach BSC "Series 1"? 9 cards were fetched from it; their BSC link will be dropped.',
      ),
    ).toBeTruthy();
    expect(mutationSpies.detachPlatformId).toHaveBeenCalledTimes(2);
    // Both calls acknowledged the number shown AT THE TIME of that click, not
    // some stale original value.
    expect(mutationSpies.detachPlatformId).toHaveBeenNthCalledWith(1, {
      selectorOptionId: ROW_ID,
      side: "bsc",
      slot: "b1",
      confirmPrimary: false,
      acknowledgedCards: 1,
    });
    expect(mutationSpies.detachPlatformId).toHaveBeenNthCalledWith(2, {
      selectorOptionId: ROW_ID,
      side: "bsc",
      slot: "b1",
      confirmPrimary: false,
      acknowledgedCards: 7,
    });
  });

  test("Escape closes the confirm even while the count is still 'Counting cards…'", async () => {
    setTwoSidedRow();
    // getSlotCardCounts deliberately unresolved — mirrors the
    // "inert while counting" test above, but exercises Escape instead of a
    // click on the disabled Confirm.
    render(<MultiSourcePanel selectorOptionId={ROW_ID} />);

    fireEvent.click(screen.getByLabelText("Remove Series 1"));
    expect(screen.getByLabelText("Counting cards for Series 1")).toBeTruthy();

    const group = screen.getByRole("group", { name: /Detach BSC "Series 1"\?/ });
    fireEvent.keyDown(group, { key: "Escape" });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText("Remove Series 1"));
    });
    expect(screen.queryByRole("group", { name: /Detach BSC/ })).toBeNull();
    expect(mutationSpies.detachPlatformId).not.toHaveBeenCalled();
  });
});

/**
 * NEO-211 (plan B) — the partial-failure guard, and the unlink notice.
 *
 * The bug these lock down: `fetchRawOptions` reports a dead adapter as
 * `success: true` with a per-platform `errors` entry and an EMPTY option list
 * for that side. `VariantForm` read "one side has options, the other does not"
 * as the ordinary single-platform case and stored it — and the store, being
 * delete-what-you-did-not-name, then deleted every row the dead side owned and
 * stripped its linkage from the rest. A SportLots timeout destroyed SportLots
 * data, silently, with a success message.
 *
 * So the load-bearing assertion in this file is a NEGATIVE one: on a partial
 * failure the mutation is not called AT ALL. The visible alert matters too (the
 * operator has to know their re-sync did nothing), but a green message over a
 * silent write would be the same bug with better manners.
 *
 * First component tests for this file. Mocking mirrors `BaseMappingForm.test.tsx`
 * — `convex/react`'s hooks module-mocked and routed by the string-mocked
 * function reference, so each query resolves independently.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    setReconciliation: {
      fetchRawOptions: "fetchRawOptions",
      storeReconciledOptions: "storeReconciledOptions",
    },
    selectorOptions: {
      getAncestorChain: "getAncestorChain",
      getUsedInsertIdentifiersBySet: "getUsedInsertIdentifiersBySet",
      getSelectorOptions: "getSelectorOptions",
      getBaseVariantBySet: "getBaseVariantBySet",
    },
  },
}));

const mockFetchRawOptions = vi.fn();
const mockStore = vi.fn();

vi.mock("convex/react", () => ({
  useAction: (ref: string) =>
    ref === "fetchRawOptions" ? mockFetchRawOptions : vi.fn(),
  useMutation: (ref: string) =>
    ref === "storeReconciledOptions" ? mockStore : vi.fn(),
  useQuery: (ref: string) => {
    if (ref === "getAncestorChain") return CHAIN;
    // Loaded-but-absent, not undefined: the auto-sync effect gates on
    // `baseVariant !== undefined`, so undefined would never fire doSync.
    if (ref === "getBaseVariantBySet") return null;
    if (ref === "getSelectorOptions") return [];
    if (ref === "getUsedInsertIdentifiersBySet")
      return { slPlatformValues: [], bscPlatformValues: [] };
    return undefined;
  },
}));

import VariantForm from "./VariantForm";

const CHAIN = [
  { _id: "sport1", level: "sport", value: "Hockey" },
  { _id: "year1", level: "year", value: "1972-73" },
  { _id: "mfg1", level: "manufacturer", value: "Topps" },
  { _id: "set1", level: "setName", value: "Topps" },
  { _id: "vt1", level: "variantType", value: "Insert" },
];

const VARIANT_TYPE_ID = "vt1" as unknown as Parameters<
  typeof VariantForm
>[0]["variantTypeId"];

/** Neither adapter returned anything, and both said why. */
function bothEmpty(errors: Array<{ platform: string; message: string }>) {
  return { ...bscOnly(errors), bscOptions: [] };
}

/** A fetch result with BSC rows and an EMPTY SportLots side. */
function bscOnly(errors: Array<{ platform: string; message: string }> = []) {
  return {
    success: true,
    bscOptions: [{ value: "Team Canada", platformValue: "team-canada" }],
    slOptions: [],
    autoMatched: [],
    unmatchedBsc: [],
    unmatchedSl: [],
    slCandidates: [],
    errors,
    message: "BSC: 1, SL: 0",
  };
}

async function renderForm(onDone = vi.fn()) {
  const result = render(
    <VariantForm variantTypeId={VARIANT_TYPE_ID} onDone={onDone} />,
  );
  await act(async () => {});
  return { ...result, onDone };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.mockResolvedValue({ success: true, unlinked: [] });
});

describe("VariantForm — single-platform store (NEO-211 plan B)", () => {
  it("stores, with BOTH sides covered, when the empty side succeeded empty", async () => {
    mockFetchRawOptions.mockResolvedValue(bscOnly());
    const { onDone } = await renderForm();

    await waitFor(() => expect(mockStore).toHaveBeenCalledTimes(1));
    const args = mockStore.mock.calls[0][0];
    expect(args.level).toBe("insert");
    // The point of coveredSides: SportLots was REACHED and had nothing, so the
    // store is allowed to act on rows linked to it. Absent, it unlinks nothing.
    expect(args.coveredSides).toEqual(["bsc", "sportlots"]);
    // NEO-211 F1: what the FETCH returned, per side. The empty side comes
    // through as [] — "asked, returned nothing" — which is the statement that
    // licenses unlinking its rows.
    expect(args.returnedIds).toEqual({
      bsc: ["team-canada"],
      sportlots: [],
    });
    expect(args.reconciledItems).toHaveLength(1);
    // Nothing to report, so the panel closes as it always did.
    expect(onDone).toHaveBeenCalled();
  });

  it("writes NOTHING when the empty side errored, and names the platform", async () => {
    mockFetchRawOptions.mockResolvedValue(
      bscOnly([{ platform: "sportlots", message: "socket hang up" }]),
    );
    await renderForm();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Sync failed: could not load variants");
    expect(alert.textContent).toContain("SportLots failed, nothing was changed.");
    // THE assertion: a partial result must not reach the store at all.
    expect(mockStore).not.toHaveBeenCalled();
  });

  it("keeps the panel up with a Retry on the refused store", async () => {
    // onDone would return EntityColumn to idle, which unmounts this form and
    // takes the alert AND its Retry with it — so the operator would be told
    // nothing and have no way to re-run.
    mockFetchRawOptions.mockResolvedValue(
      bscOnly([{ platform: "sportlots", message: "socket hang up" }]),
    );
    const { onDone } = await renderForm();

    await screen.findByRole("alert");
    expect(screen.getByText("Retry")).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("does not leak the adapter's own error text into the alert", async () => {
    // Security review, 2026-09-03: no user-facing error copy is BUILT from
    // marketplace response text on the client.
    mockFetchRawOptions.mockResolvedValue(
      bscOnly([{ platform: "sportlots", message: "<script>boom</script>" }]),
    );
    await renderForm();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("boom");
  });

  it("spells the platform out in full, unlike the rest of the UI", async () => {
    mockFetchRawOptions.mockResolvedValue({
      ...bscOnly(),
      bscOptions: [],
      slOptions: [{ value: "Team Canada", platformValue: "884412" }],
      errors: [{ platform: "bsc", message: "503" }],
    });
    await renderForm();

    const alert = await screen.findByRole("alert");
    // "BuySportsCards", not "BSC": an outage message is the one place the admin
    // may be about to go look up a status page.
    expect(alert.textContent).toContain(
      "BuySportsCards failed, nothing was changed.",
    );
    expect(mockStore).not.toHaveBeenCalled();
  });
});

describe("VariantForm — reconciliation confirm (NEO-211 F1)", () => {
  // Both sides populated → the modal opens instead of the direct store.
  const BSC_ITEM = { value: "Team Canada", platformValue: "bsc-tc" };
  const SL_ITEM = { value: "Team Canada", platformValue: "884412" };
  const BSC_TWO = { value: "Team USA", platformValue: "bsc-usa" };
  const SL_TWO = { value: "Team USA", platformValue: "884413" };

  function bothSides() {
    return {
      success: true,
      bscOptions: [BSC_ITEM, BSC_TWO],
      slOptions: [SL_ITEM, SL_TWO],
      autoMatched: [
        { displayName: "Team Canada", bsc: BSC_ITEM, sl: SL_ITEM, confidence: 0.9 },
        { displayName: "Team USA", bsc: BSC_TWO, sl: SL_TWO, confidence: 0.9 },
      ],
      unmatchedBsc: [],
      unmatchedSl: [],
      slCandidates: [],
      errors: [],
      message: "BSC: 2, SL: 2",
    };
  }

  it("sends the fetch's id universe even when the operator DISBANDED the row", async () => {
    // THE F1 case. The store used to infer "what the marketplace returned" from
    // `reconciledItems` — but those are what the OPERATOR confirmed. Disbanding
    // a row removes it from that list while the marketplace is still listing it
    // happily, so the store unlinked it and told the admin "No longer listed on
    // BSC", which was simply false. returnedIds is the honest source.
    mockFetchRawOptions.mockResolvedValue(bothSides());
    await renderForm();

    // Both auto-matches arrive as Ready sets. Disband one; the other still
    // saves, so Save stays enabled (it is disabled at zero sets).
    fireEvent.click(await screen.findByLabelText("Remove set Team Canada"));
    await act(async () => {
      fireEvent.click(screen.getByText(/Save 1 sets/));
    });

    await waitFor(() => expect(mockStore).toHaveBeenCalledTimes(1));
    const args = mockStore.mock.calls[0][0];
    // The disbanded row is NOT in what the operator confirmed...
    expect(args.reconciledItems).toHaveLength(1);
    expect(args.reconciledItems[0].value).toBe("Team USA");
    // ...but its ids WERE returned by both marketplaces, so it must not be
    // unlinked and the admin must not be told it was delisted.
    expect(args.returnedIds).toEqual({
      bsc: ["bsc-tc", "bsc-usa"],
      sportlots: ["884412", "884413"],
    });
    expect(args.coveredSides).toEqual(["bsc", "sportlots"]);
  });

  it("shows an error IN the dialog when the save throws, keeping the work", async () => {
    // Regression for the CI seed flow: storeReconciledOptions threw (the
    // returnedIds cap), ReconciliationModal's handleConfirm has a `finally` but
    // no `catch`, so it became an unhandled rejection — the dialog sat open
    // after "Save 76 sets" with no error and no way to tell anything failed.
    mockFetchRawOptions.mockResolvedValue(bothSides());
    mockStore.mockRejectedValueOnce(
      new Error("[Request ID: abc] returnedIds.sportlots has 2563 entries"),
    );
    await renderForm();

    await act(async () => {
      fireEvent.click(await screen.findByText(/Save 2 sets/));
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Couldn't save these sets. Nothing was changed — press Save to try again, or Cancel to close.",
    );
    // Our own string only — no thrown text, no request id, no counts.
    expect(alert.textContent).not.toContain("2563");
    expect(alert.textContent).not.toContain("Request ID");
    // The dialog stays open: it holds the whole reconciliation, and closing it
    // would make the operator redo every mapping.
    expect(screen.getByText(/Save 2 sets/)).toBeTruthy();
  });

  it("lets the operator retry Save after a failure, and clears the stale error", async () => {
    mockFetchRawOptions.mockResolvedValue(bothSides());
    mockStore.mockRejectedValueOnce(new Error("boom"));
    const { onDone } = await renderForm();

    await act(async () => {
      fireEvent.click(await screen.findByText(/Save 2 sets/));
    });
    await screen.findByRole("alert");
    expect(onDone).not.toHaveBeenCalled();

    // Second press succeeds — Save is live again (confirming reset in finally).
    mockStore.mockResolvedValue({ success: true, unlinked: [] });
    await act(async () => {
      fireEvent.click(screen.getByText(/Save 2 sets/));
    });

    expect(mockStore).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onDone).toHaveBeenCalled();
  });

  it("omits coveredSides entirely rather than claiming both sides were fine", async () => {
    // coveredSidesFromErrors fails closed on an absent fetch result; this pins
    // that the confirm path spreads it rather than assigning undefined.
    mockFetchRawOptions.mockResolvedValue(bothSides());
    await renderForm();
    await act(async () => {
      fireEvent.click(await screen.findByText(/Save 2 sets/));
    });
    const args = mockStore.mock.calls[0][0];
    expect(args.coveredSides).toEqual(["bsc", "sportlots"]);
    expect(args.returnedIds.bsc).toEqual(["bsc-tc", "bsc-usa"]);
  });
});

describe("VariantForm — both adapters empty (NEO-211)", () => {
  it("keeps the alert and Retry mounted instead of closing the panel", async () => {
    // This branch used to call onDone() — which returns EntityColumn to idle and
    // UNMOUNTS this form, taking the alert and its Retry with it. The message
    // was set and then immediately destroyed, so a total marketplace outage
    // looked like a column that simply had nothing in it. Partial-failure
    // visibility is acceptance #2 of the ticket; a message that never renders
    // cannot deliver it.
    mockFetchRawOptions.mockResolvedValue(
      bothEmpty([
        { platform: "bsc", message: "503" },
        { platform: "sportlots", message: "socket hang up" },
      ]),
    );
    const { onDone } = await renderForm();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Sync failed: could not load variants");
    expect(alert.textContent).toContain(
      "BuySportsCards and SportLots failed, nothing was changed.",
    );
    expect(screen.getByText("Retry")).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    expect(mockStore).not.toHaveBeenCalled();
  });

  it("leaves the panel-header actions one Cancel click away", async () => {
    // The original reason for calling onDone here was to make "Group Parallels"
    // reachable again. It still is — via this panel's own footer — which is a
    // far better trade than an invisible failure.
    mockFetchRawOptions.mockResolvedValue(
      bothEmpty([{ platform: "bsc", message: "503" }]),
    );
    const { onDone } = await renderForm();

    await screen.findByRole("alert");
    fireEvent.click(screen.getByText("Cancel"));
    expect(onDone).toHaveBeenCalled();
  });

  it("renders neither the URL nor the message of a failed fetch (F3)", async () => {
    // `result.message` on the !success path is fetchRawOptions' OUTER-CATCH
    // string, which embeds the thrown exception — an adapter response body, a
    // marketplace URL, or a credential hint.
    mockFetchRawOptions.mockResolvedValue({
      ...bothEmpty([{ platform: "sportlots", message: "boom" }]),
      success: false,
      message:
        "Failed to fetch options: GET https://api.sportlots.com/x?key=SECRET 500",
    });
    await renderForm();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("sportlots.com");
    expect(alert.textContent).not.toContain("SECRET");
    expect(alert.textContent).not.toContain("Failed to fetch options");
    expect(alert.textContent).toBe(
      "Sync failed: could not load variants. SportLots failed, nothing was changed.",
    );
  });

  it("does not leak either adapter's error text", async () => {
    mockFetchRawOptions.mockResolvedValue(
      bothEmpty([
        { platform: "bsc", message: "<script>boom</script>" },
        { platform: "sportlots", message: "ECONNRESET at 10.0.0.4" },
      ]),
    );
    await renderForm();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("boom");
    expect(alert.textContent).not.toContain("10.0.0.4");
  });
});

describe("VariantForm — unlink notice (NEO-211 plan D)", () => {
  it("reports what the store detached, and holds the panel open to do it", async () => {
    mockFetchRawOptions.mockResolvedValue(bscOnly());
    mockStore.mockResolvedValue({
      success: true,
      unlinked: [
        { id: "row1", value: "Team Canada", side: "sportlots" },
        { id: "row2", value: "Series 2", side: "sportlots" },
      ],
    });
    const { onDone } = await renderForm();

    const notice = await screen.findByText(/No longer listed on SportLots/);
    expect(notice.textContent).toContain("2 inserts");
    expect(notice.textContent).toContain("Team Canada");
    // A detach the operator has not seen is a silent data change.
    expect(onDone).not.toHaveBeenCalled();
  });

  it("reports the server's TRUE count, not the size of its 50-row sample", async () => {
    // The store truncates `unlinked`; `unlinkedTotal` carries the real number.
    mockFetchRawOptions.mockResolvedValue(bscOnly());
    mockStore.mockResolvedValue({
      success: true,
      unlinked: [
        { id: "r1", value: "Team Canada", side: "sportlots" },
        { id: "r2", value: "Series 2", side: "sportlots" },
      ],
      unlinkedTotal: 312,
    });
    await renderForm();

    const notice = await screen.findByText(/No longer listed on SportLots/);
    expect(notice.textContent).toContain("312 inserts");
    expect(notice.textContent).toContain("and 310 more");
  });

  it("flags a row that still has cards under it", async () => {
    mockFetchRawOptions.mockResolvedValue(bscOnly());
    mockStore.mockResolvedValue({
      success: true,
      unlinked: [
        { id: "row1", value: "Team Canada", side: "bsc", hasCards: true },
      ],
    });
    await renderForm();

    const notice = await screen.findByText(/No longer listed on BSC/);
    expect(notice.textContent).toContain(
      "Team Canada (has cards — listing on BSC will fail until re-linked)",
    );
  });
});

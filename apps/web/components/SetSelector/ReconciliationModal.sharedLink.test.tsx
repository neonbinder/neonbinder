/**
 * NEO-137 — "Link shared": the operator path that creates an
 * M-NB-rows-to-1-marketplace-set mapping from the reconcile dialog.
 *
 * This is the 1996 Score case. BSC splits Dugout Collection Artist's Proofs
 * into Series 1 and Series 2; SportLots carries one combined set. Every
 * `computeMatches` pass splices its match out of BOTH arrays, so the single SL
 * set is consumed by whichever series matched first and the other is left with
 * nothing — that exclusivity is structural, not a threshold to tune.
 *
 * The backend answer is `slCandidates`: still offer the claimed set to the
 * loser, flagged `alreadyMatched`. These tests cover the UI half — that the
 * offer is rendered and that confirming it yields TWO reconciled rows pointing
 * at ONE marketplace id, which is the mapping itself.
 *
 * Nothing here is automatic, deliberately: the two series are indistinguishable
 * from the data (each can contain a card #1), so only an operator can say which
 * is which.
 */

import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ReconciliationModal, {
  type PlatformItem,
  type SlCandidateGroup,
} from "./ReconciliationModal";

const S1: PlatformItem = {
  value: "Dugout Collection Artist's Proofs Series 1",
  platformValue: "dcap-series-1",
};
const S2: PlatformItem = {
  value: "Dugout Collection Artist's Proofs Series 2",
  platformValue: "dcap-series-2",
};
const SHARED_SL: PlatformItem = {
  value: "Dugout Collection Artists Proofs",
  platformValue: "884412",
};

/** Series 2 won the greedy match; Series 1 is offered the same set at 78%. */
function scenario(): {
  autoMatched: Array<{
    displayName: string;
    bsc: PlatformItem;
    sl: PlatformItem;
    confidence: number;
  }>;
  unmatchedBsc: PlatformItem[];
  unmatchedSl: PlatformItem[];
  slCandidates: SlCandidateGroup[];
} {
  return {
    autoMatched: [
      { displayName: S2.value, bsc: S2, sl: SHARED_SL, confidence: 0.78 },
    ],
    unmatchedBsc: [S1],
    unmatchedSl: [],
    slCandidates: [
      {
        bsc: S1,
        candidates: [
          { sl: SHARED_SL, confidence: 0.78, alreadyMatched: true },
        ],
      },
    ],
  };
}

function renderModal(initialData: ReturnType<typeof scenario>) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  render(
    <ReconciliationModal
      isOpen
      onClose={vi.fn()}
      onConfirm={onConfirm}
      level="insert"
      initialData={initialData}
    />,
  );
  return { onConfirm };
}

describe("ReconciliationModal — Link shared (NEO-137)", () => {
  test("offers the already-claimed SL set to the row that lost the greedy match", () => {
    renderModal(scenario());
    const offer = screen.getByLabelText(
      `Also link ${S1.value} to shared set ${SHARED_SL.value}`,
    );
    expect(offer).toBeTruthy();
    // The operator is told it is already spoken for, and how confident the
    // match is — both are needed to make this an informed decision.
    expect(screen.getByText(/already linked/)).toBeTruthy();
    expect(screen.getByText(/78%/)).toBeTruthy();
  });

  test("confirming yields TWO rows pointing at ONE marketplace set", async () => {
    const { onConfirm } = renderModal(scenario());

    fireEvent.click(
      screen.getByLabelText(
        `Also link ${S1.value} to shared set ${SHARED_SL.value}`,
      ),
    );
    // The confirm button carries no aria-label; it renders its count.
    // After linking shared, both series are matched -> "Save 2 matched".
    fireEvent.click(screen.getByText(/Save 2 matched/));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const items = onConfirm.mock.calls[0][0].items as Array<{
      value: string;
      platformData: { bsc?: string; sportlots?: string };
    }>;

    const s1 = items.find((i) => i.value === S1.value);
    const s2 = items.find((i) => i.value === S2.value);
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();

    // THE MAPPING: both NB rows carry the same SportLots id...
    expect(s1!.platformData.sportlots).toBe("884412");
    expect(s2!.platformData.sportlots).toBe("884412");
    // ...while keeping their own distinct BSC series sets.
    expect(s1!.platformData.bsc).toBe("dcap-series-1");
    expect(s2!.platformData.bsc).toBe("dcap-series-2");
  });

  test("linking shared does NOT steal the set from the row that already had it", async () => {
    const { onConfirm } = renderModal(scenario());

    fireEvent.click(
      screen.getByLabelText(
        `Also link ${S1.value} to shared set ${SHARED_SL.value}`,
      ),
    );
    // The confirm button carries no aria-label; it renders its count.
    // After linking shared, both series are matched -> "Save 2 matched".
    fireEvent.click(screen.getByText(/Save 2 matched/));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const items = onConfirm.mock.calls[0][0].items as Array<{ value: string }>;
    // Series 2 survives. A plain LINK removes the SL item from the pool, which
    // would have un-matched it — LINK_SHARED must not.
    expect(items.map((i) => i.value)).toContain(S2.value);
    expect(items).toHaveLength(2);
  });

  test("no offer is rendered when nothing is already claimed", () => {
    const data = scenario();
    data.slCandidates = [
      {
        bsc: S1,
        // A candidate that no auto-match took is NOT a shared-set offer —
        // it is an ordinary unmatched item the operator can drag normally.
        candidates: [{ sl: SHARED_SL, confidence: 0.78, alreadyMatched: false }],
      },
    ];
    renderModal(data);
    expect(
      screen.queryByLabelText(
        `Also link ${S1.value} to shared set ${SHARED_SL.value}`,
      ),
    ).toBeNull();
  });

  test("callers that pass no candidates render unchanged", () => {
    const data = scenario();
    // @ts-expect-error — deliberately exercising the optional-prop path.
    delete data.slCandidates;
    renderModal(data);
    expect(screen.queryByText(/already linked/)).toBeNull();
    // The unmatched row itself is still there.
    expect(screen.getByText(S1.value)).toBeTruthy();
  });
});

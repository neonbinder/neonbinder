/**
 * NEO-137 — the reconcile modal builds NeonBinder SETS, not marketplace pairs.
 *
 * The model: NB owns the set and its title. A set maps to 0-N BSC sets and
 * 0-N SportLots sets, the two sides completely independent. A marketplace id
 * records how that marketplace carves up the same cards — it is not exclusive,
 * so any number of NB sets may map to the same id.
 *
 * This replaced a pair-shaped modal (`{bsc, sl}`, one id per side). Everything
 * awkward about that model came from treating a marketplace set as a scarce
 * resource: an item with no partner needed a "keep as platform-only" shelf, and
 * a set wanted by two rows produced a winner and a loser that then needed
 * "link shared" escape hatches to undo.
 *
 * The motivating case is 1996 Score: BSC splits Dugout Collection Artist's
 * Proofs into Series 1 and Series 2, SportLots carries one combined set. Both
 * answers must be expressible — ONE NB set mapping to both BSC sets, or TWO NB
 * sets each mapping to the shared SL set — because which one is right is a
 * judgement about our catalogue, not about the marketplaces.
 */

import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ReconciliationModal, {
  type PlatformItem,
} from "./ReconciliationModal";

const BSC_S1: PlatformItem = {
  value: "Dugout Collection Artist's Proofs Series 1",
  platformValue: "dcap-series-1",
};
const BSC_S2: PlatformItem = {
  value: "Dugout Collection Artist's Proofs Series 2",
  platformValue: "dcap-series-2",
};
const SL_COMBINED: PlatformItem = {
  value: "Dugout Collection Artists Proofs",
  platformValue: "884412",
};

type InitialData = Parameters<typeof ReconciliationModal>[0]["initialData"];

function renderModal(initialData: InitialData, extra?: { showMetadata?: boolean }) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  render(
    <ReconciliationModal
      isOpen
      onClose={vi.fn()}
      onConfirm={onConfirm}
      level="insert"
      initialData={initialData}
      {...extra}
    />,
  );
  return { onConfirm };
}

/** Nothing auto-matched: two BSC sets and one SL set, all pending. */
function allPending(): InitialData {
  return {
    autoMatched: [],
    unmatchedBsc: [BSC_S1, BSC_S2],
    unmatchedSl: [SL_COMBINED],
    slCandidates: [],
  };
}

async function itemsFromConfirm(onConfirm: ReturnType<typeof vi.fn>) {
  await waitFor(() => expect(onConfirm).toHaveBeenCalled());
  return onConfirm.mock.calls[0][0].items as Array<{
    value: string;
    platformData: { bsc?: string[]; sportlots?: string[] };
    platformLabels?: {
      bsc?: Record<string, string>;
      sportlots?: Record<string, string>;
    };
  }>;
}

/** Select a pending item, then click a Ready set's "add" button. */
function attachToFirstSet(pendingLabel: string) {
  fireEvent.click(screen.getByText(pendingLabel));
  const add = screen
    .getAllByRole("button")
    .find((b) => b.getAttribute("aria-label")?.startsWith(`Add ${pendingLabel} to `));
  expect(add).toBeTruthy();
  fireEvent.click(add!);
}

describe("ReconciliationModal — NB sets with 0-N mappings per side", () => {
  test("pairing two pending items makes ONE set — the 1:1 case stays one gesture", async () => {
    const { onConfirm } = renderModal(allPending());

    fireEvent.click(screen.getByText(BSC_S1.value));
    fireEvent.click(screen.getByText(SL_COMBINED.value));

    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);

    expect(items).toHaveLength(1);
    expect(items[0].value).toBe(BSC_S1.value);
    expect(items[0].platformData.bsc).toEqual(["dcap-series-1"]);
    expect(items[0].platformData.sportlots).toEqual(["884412"]);
  });

  test("ONE set can map to TWO BSC sets and one SL set", async () => {
    const { onConfirm } = renderModal(allPending());

    // Series 1 + the SL set become a set...
    fireEvent.click(screen.getByText(BSC_S1.value));
    fireEvent.click(screen.getByText(SL_COMBINED.value));
    // ...then Series 2 joins that same set rather than starting its own.
    attachToFirstSet(BSC_S2.value);

    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);

    expect(items).toHaveLength(1);
    expect(items[0].platformData.bsc).toEqual([
      "dcap-series-1",
      "dcap-series-2",
    ]);
    expect(items[0].platformData.sportlots).toEqual(["884412"]);
    // Each id carries the marketplace's own name so the slots stay tellable
    // apart once there is more than one on a side.
    expect(items[0].platformLabels?.bsc).toEqual({
      "dcap-series-1": BSC_S1.value,
      "dcap-series-2": BSC_S2.value,
    });
  });

  test("the set title is OURS — editable, and it is what gets saved", async () => {
    const { onConfirm } = renderModal(allPending());

    fireEvent.click(screen.getByText(BSC_S1.value));
    fireEvent.click(screen.getByText(SL_COMBINED.value));

    const title = screen.getByLabelText(
      `NeonBinder set name for ${BSC_S1.value}`,
    );
    fireEvent.change(title, {
      target: { value: "Dugout Collection Artists Proofs" },
    });
    // Committed on blur, not per keystroke — dispatching a reducer action per
    // character re-renders every row of the modal between characters, which is
    // how controlled inputs drop keystrokes here.
    fireEvent.blur(title);

    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);

    expect(items[0].value).toBe("Dugout Collection Artists Proofs");
    // Renaming must not disturb the mapping.
    expect(items[0].platformData.bsc).toEqual(["dcap-series-1"]);
  });

  test("TWO sets may map to the SAME SL id — mapping does not consume it", async () => {
    // The 1996 Score answer when you want Series 1 and Series 2 to stay
    // SEPARATE NB sets. Both must reach the one SportLots set.
    //
    // This is the case the first cut of the Ready/Pending model could not
    // express: ATTACH looked its item up in Pending only, so the SL set became
    // unreachable the moment the first set mapped it — the exact exclusivity
    // the redesign was meant to delete, reintroduced one layer down.
    const { onConfirm } = renderModal(allPending());

    fireEvent.click(screen.getByText(BSC_S1.value));
    fireEvent.click(screen.getByText(SL_COMBINED.value));

    // Series 2 becomes its own set...
    fireEvent.click(
      screen.getByLabelText(`Make ${BSC_S2.value} its own NeonBinder set`),
    );

    // ...and the SL set, already mapped by set #1, is revealed and mapped again.
    fireEvent.click(
      screen.getByLabelText("Show SportLots sets already mapped"),
    );
    expect(screen.getByText(`mapped to ${BSC_S1.value}`)).toBeTruthy();

    // The name now appears twice — as set #1's chip and in the revealed list.
    // Only the latter is draggable, which is the one to select.
    const revealed = screen
      .getAllByText(SL_COMBINED.value)
      .find((el) => el.closest(".cursor-grab") !== null);
    fireEvent.click(revealed!);

    const add = screen
      .getAllByRole("button")
      .find((b) =>
        b
          .getAttribute("aria-label")
          ?.startsWith(`Add ${SL_COMBINED.value} to ${BSC_S2.value}`),
      );
    fireEvent.click(add!);

    fireEvent.click(screen.getByText(/Save 2 sets/));
    const items = await itemsFromConfirm(onConfirm);

    expect(items).toHaveLength(2);
    const s1 = items.find((i) => i.value === BSC_S1.value)!;
    const s2 = items.find((i) => i.value === BSC_S2.value)!;
    expect(s1.platformData.bsc).toEqual(["dcap-series-1"]);
    expect(s2.platformData.bsc).toEqual(["dcap-series-2"]);
    // BOTH carry the one SportLots id. Neither stole it from the other.
    expect(s1.platformData.sportlots).toEqual(["884412"]);
    expect(s2.platformData.sportlots).toEqual(["884412"]);
  });

  test("a set with no SL mapping is ordinary, not a platform-only special case", async () => {
    const { onConfirm } = renderModal(allPending());

    fireEvent.click(
      screen.getByLabelText(`Make ${BSC_S2.value} its own NeonBinder set`),
    );
    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);

    expect(items[0].platformData.bsc).toEqual(["dcap-series-2"]);
    expect(items[0].platformData.sportlots).toBeUndefined();
  });

  test("a lone item can become a set — there is no platform-only shelf", async () => {
    const { onConfirm } = renderModal({
      autoMatched: [],
      unmatchedBsc: [BSC_S1],
      unmatchedSl: [],
      slCandidates: [],
    });

    fireEvent.click(
      screen.getByLabelText(`Make ${BSC_S1.value} its own NeonBinder set`),
    );
    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);

    expect(items).toHaveLength(1);
    expect(items[0].platformData.bsc).toEqual(["dcap-series-1"]);
    expect(items[0].platformData.sportlots).toBeUndefined();
  });

  test("detaching the last mapping removes the set rather than saving an empty one", () => {
    renderModal(allPending());

    fireEvent.click(
      screen.getByLabelText(`Make ${BSC_S1.value} its own NeonBinder set`),
    );
    expect(screen.getByText(/Save 1 sets/)).toBeTruthy();

    fireEvent.click(
      screen.getByLabelText(`Remove ${BSC_S1.value} from ${BSC_S1.value}`),
    );

    // Save is disabled at zero sets, and the item is back in Pending.
    expect(screen.getByText(/Save 0 sets/)).toBeTruthy();
    expect(
      screen.getByLabelText(`Make ${BSC_S1.value} its own NeonBinder set`),
    ).toBeTruthy();
  });

  test("auto-matches arrive as Ready sets, and pending items are NOT saved", async () => {
    const { onConfirm } = renderModal({
      autoMatched: [
        {
          displayName: BSC_S2.value,
          bsc: BSC_S2,
          sl: SL_COMBINED,
          confidence: 0.78,
        },
      ],
      unmatchedBsc: [BSC_S1],
      unmatchedSl: [],
      slCandidates: [],
    });

    expect(screen.getByText(/78%/)).toBeTruthy();

    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);

    // Only the auto-matched set is written; Series 1 sat in Pending untouched.
    expect(items).toHaveLength(1);
    expect(items[0].value).toBe(BSC_S2.value);
  });

});

describe("ReconciliationModal — restoring saved rows", () => {
  // The pair model kept only platformData.bsc[0] when seeding, silently
  // dropping operator-attached extras on every reopen — invisible, because a
  // row with one id still looks perfectly healthy.
  test("a saved row with two BSC ids comes back with both", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <ReconciliationModal
        isOpen
        onClose={vi.fn()}
        onConfirm={onConfirm}
        level="insert"
        initialData={{
          autoMatched: [],
          unmatchedBsc: [],
          unmatchedSl: [],
          slCandidates: [],
        }}
        existingRows={[
          {
            value: "Dugout Collection Artists Proofs",
            platformData: {
              bsc: ["dcap-series-1", "dcap-series-2"],
              sportlots: ["884412"],
            },
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByText(/Save 1 sets/));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const items = onConfirm.mock.calls[0][0].items as Array<{
      platformData: { bsc?: string[]; sportlots?: string[] };
    }>;

    expect(items[0].platformData.bsc).toEqual([
      "dcap-series-1",
      "dcap-series-2",
    ]);
    expect(items[0].platformData.sportlots).toEqual(["884412"]);
  });

  test("removing a set returns EVERY mapping to Pending, not just one", () => {
    // Disband is the undo for a wrong auto-match. It has to release both sides
    // or the released set is stranded: invisible in Pending and unreachable to
    // re-pair, with the only recovery being Cancel and re-sync.
    renderModal(allPending());
    fireEvent.click(screen.getByText(BSC_S1.value));
    fireEvent.click(screen.getByText(SL_COMBINED.value));
    expect(screen.getByText(/Save 1 sets/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText(`Remove set ${BSC_S1.value}`));

    expect(screen.getByText(/Save 0 sets/)).toBeTruthy();
    // Both halves are pending again — each offers its solo affordance, which
    // only renders for a Pending item.
    expect(
      screen.getByLabelText(`Make ${BSC_S1.value} its own NeonBinder set`),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(`Make ${SL_COMBINED.value} its own NeonBinder set`),
    ).toBeTruthy();
  });

  test("the Ready list can be filtered by our title OR by a mapped marketplace name", () => {
    // Not cosmetic. The dialog body is its own scroller and Maestro — like a
    // user with a trackpad — cannot easily get past a long Ready list to the
    // Pending columns and Save below it. A real reconcile holds a dozen-plus
    // sets. Filtering is how both halves stay reachable.
    renderModal(allPending());
    fireEvent.click(screen.getByText(BSC_S1.value));
    fireEvent.click(screen.getByText(SL_COMBINED.value));
    fireEvent.click(
      screen.getByLabelText(`Make ${BSC_S2.value} its own NeonBinder set`),
    );
    expect(screen.getByText(/Ready \(2\)/)).toBeTruthy();

    const filter = screen.getByLabelText("Filter NeonBinder sets");

    // By OUR title.
    fireEvent.change(filter, { target: { value: "Series 2" } });
    expect(screen.getByText(/Ready \(1 of 2\)/)).toBeTruthy();

    // By a MAPPED marketplace name — the SL set's name appears on neither
    // title, so this only matches if mappings are searched too.
    fireEvent.change(filter, { target: { value: "Artists Proofs" } });
    expect(screen.getByText(/Ready \(1 of 2\)/)).toBeTruthy();

    fireEvent.change(filter, { target: { value: "nothing matches this" } });
    expect(screen.getByText(/No sets match/)).toBeTruthy();
    // Filtering is a VIEW — it must not drop sets from what gets saved.
    expect(screen.getByText(/Save 2 sets/)).toBeTruthy();
  });

  test("an emptied title snaps back rather than saving a nameless set", () => {
    renderModal(allPending());
    fireEvent.click(screen.getByText(BSC_S1.value));
    fireEvent.click(screen.getByText(SL_COMBINED.value));

    const title = screen.getByLabelText(
      `NeonBinder set name for ${BSC_S1.value}`,
    );
    fireEvent.change(title, { target: { value: "   " } });
    fireEvent.blur(title);

    expect(
      screen.getByLabelText(`NeonBinder set name for ${BSC_S1.value}`),
    ).toHaveProperty("value", BSC_S1.value);
  });
});

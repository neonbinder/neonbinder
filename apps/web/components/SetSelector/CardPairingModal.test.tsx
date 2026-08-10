/**
 * NEO-137 — CardPairingModal.
 *
 * The rule under test is the one that decides which NB cards come into
 * existence: confirmed pairs plus deliberately-kept singles, and NOTHING else.
 * That discard rule is what stops a shared SportLots set's sibling-owned cards
 * being invented under the wrong row, so it is worth pinning directly.
 */

import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CardPairingModal, { type PairingCard } from "./CardPairingModal";

const bscCard = (n: string, name: string): PairingCard => ({
  cardNumber: n,
  cardName: name,
  platformData: { bsc: { ref: `bsc-${n}`, setId: "dcap-s1" } },
  unmatched: "sl",
});

const slCard = (n: string, name: string): PairingCard => ({
  cardNumber: n,
  cardName: name,
  platformData: { sportlots: { ref: `#${n} ${name}`, setId: "884412" } },
  unmatched: "bsc",
});

const pairedCard = (n: string, name: string): PairingCard => ({
  cardNumber: n,
  cardName: name,
  platformData: {
    bsc: { ref: `bsc-${n}`, setId: "dcap-s1" },
    sportlots: { ref: `#A${n} ${name}`, setId: "884412" },
  },
});

function renderModal(
  overrides: Partial<{
    autoMatched: Array<{ card: PairingCard; confidence: number }>;
    unmatchedBsc: PairingCard[];
    unmatchedSl: PairingCard[];
  }> = {},
) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  render(
    <CardPairingModal
      isOpen
      onClose={vi.fn()}
      onConfirm={onConfirm}
      initialData={{
        autoMatched: overrides.autoMatched ?? [],
        unmatchedBsc: overrides.unmatchedBsc ?? [],
        unmatchedSl: overrides.unmatchedSl ?? [],
      }}
    />,
  );
  return { onConfirm };
}

describe("CardPairingModal", () => {
  test("confirms auto-matched pairs", async () => {
    const { onConfirm } = renderModal({
      autoMatched: [{ card: pairedCard("1", "Ken Griffey Jr."), confidence: 1 }],
    });

    fireEvent.click(screen.getByLabelText("Confirm card matches"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm.mock.calls[0][0].cards).toHaveLength(1);
    expect(onConfirm.mock.calls[0][0].cards[0].cardNumber).toBe("1");
  });

  /**
   * The 1996 Score case: Series 1 syncs, and the shared SL set also returns
   * Series 2's cards. Left alone, they must NOT become cards under this row.
   */
  test("discards unmatched cards the operator did not keep", async () => {
    const { onConfirm } = renderModal({
      autoMatched: [{ card: pairedCard("1", "Ken Griffey Jr."), confidence: 1 }],
      unmatchedSl: [slCard("B1", "Cal Ripken Jr."), slCard("B2", "Barry Bonds")],
    });

    fireEvent.click(screen.getByLabelText("Confirm card matches"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const cards = onConfirm.mock.calls[0][0].cards;
    expect(cards).toHaveLength(1);
    expect(cards.map((c: PairingCard) => c.cardNumber)).not.toContain("B1");
    expect(cards.map((c: PairingCard) => c.cardNumber)).not.toContain("B2");
  });

  test("a kept SportLots-only card IS saved", async () => {
    const { onConfirm } = renderModal({
      unmatchedSl: [slCard("77", "SL Only Card")],
    });

    fireEvent.click(screen.getByLabelText("Keep #77 SL Only Card as SportLots-only"));
    fireEvent.click(screen.getByLabelText("Confirm card matches"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const cards = onConfirm.mock.calls[0][0].cards;
    expect(cards).toHaveLength(1);
    expect(cards[0].cardNumber).toBe("77");
    expect(cards[0].platformData.sportlots).toBeDefined();
    expect(cards[0].platformData.bsc).toBeUndefined();
  });

  test("a kept BSC-only card IS saved", async () => {
    const { onConfirm } = renderModal({
      unmatchedBsc: [bscCard("5", "BSC Only Card")],
    });

    fireEvent.click(screen.getByLabelText("Keep #5 BSC Only Card as BSC-only"));
    fireEvent.click(screen.getByLabelText("Confirm card matches"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const cards = onConfirm.mock.calls[0][0].cards;
    expect(cards).toHaveLength(1);
    expect(cards[0].platformData.bsc).toBeDefined();
    expect(cards[0].platformData.sportlots).toBeUndefined();
  });

  test("manually pairing a BSC card to an SL card merges both refs onto one card", async () => {
    const { onConfirm } = renderModal({
      unmatchedBsc: [bscCard("1", "Ken Griffey Jr.")],
      unmatchedSl: [slCard("A1", "Ken Griffey Jr.")],
    });

    fireEvent.click(screen.getByLabelText("Select BSC card #1 Ken Griffey Jr."));
    fireEvent.click(
      screen.getByLabelText("Link selected BSC card to #A1 Ken Griffey Jr."),
    );
    fireEvent.click(screen.getByLabelText("Confirm card matches"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const cards = onConfirm.mock.calls[0][0].cards;
    expect(cards).toHaveLength(1);
    // NB card number follows BSC, the side that splits the series.
    expect(cards[0].cardNumber).toBe("1");
    expect(cards[0].platformData.bsc?.ref).toBe("bsc-1");
    expect(cards[0].platformData.sportlots?.ref).toBe("#A1 Ken Griffey Jr.");
  });

  test("an SL card cannot be linked until a BSC card is selected", () => {
    renderModal({
      unmatchedBsc: [bscCard("1", "Griffey")],
      unmatchedSl: [slCard("A1", "Griffey")],
    });
    expect(
      (screen.getByLabelText(
        "Link selected BSC card to #A1 Griffey",
      ) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("removing a kept card returns it to its unmatched column and it is discarded", async () => {
    const { onConfirm } = renderModal({
      unmatchedSl: [slCard("77", "SL Only Card")],
    });

    fireEvent.click(screen.getByLabelText("Keep #77 SL Only Card as SportLots-only"));
    fireEvent.click(screen.getByLabelText("Remove #77 SL Only Card from save list"));
    fireEvent.click(screen.getByLabelText("Confirm card matches"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].cards).toHaveLength(0);
  });

  test("unlinking a pair returns both sides so neither is saved", async () => {
    const { onConfirm } = renderModal({
      autoMatched: [{ card: pairedCard("1", "Griffey"), confidence: 0.78 }],
    });

    // Matched section is collapsed by default.
    fireEvent.click(screen.getByLabelText("Expand matched cards"));
    fireEvent.click(screen.getByLabelText("Unlink #1 Griffey"));
    fireEvent.click(screen.getByLabelText("Confirm card matches"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].cards).toHaveLength(0);
  });

  test("a low-confidence auto-match shows its score so it can be reviewed", async () => {
    renderModal({
      autoMatched: [{ card: pairedCard("1", "Griffey"), confidence: 0.78 }],
    });
    fireEvent.click(screen.getByLabelText("Expand matched cards"));
    expect(screen.getByText("78%")).toBeTruthy();
  });

  /**
   * setup.yaml depends on this: a real set that simply is not on the other
   * marketplace produces an entire column of legitimate unmatched cards, and
   * without "Keep all" the discard-by-default rule would silently narrow the
   * provisioned checklist and break its strict card counts.
   */
  test("Keep all saves every card in a column", async () => {
    const { onConfirm } = renderModal({
      unmatchedBsc: [bscCard("1", "A"), bscCard("2", "B"), bscCard("3", "C")],
      unmatchedSl: [slCard("A1", "D")],
    });

    fireEvent.click(screen.getByLabelText("Keep all BSC-only cards"));
    fireEvent.click(screen.getByLabelText("Confirm card matches"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const cards = onConfirm.mock.calls[0][0].cards;
    // All three BSC cards kept; the SL column was left alone and discarded.
    expect(cards).toHaveLength(3);
    expect(cards.map((c: PairingCard) => c.cardNumber).sort()).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  test("Keep all is disabled when its column is empty", () => {
    renderModal({ unmatchedBsc: [bscCard("1", "A")] });
    expect(
      (screen.getByLabelText("Keep all BSC-only cards") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (
        screen.getByLabelText(
          "Keep all SportLots-only cards",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test("the footer reports how many cards will be saved", async () => {
    renderModal({
      autoMatched: [{ card: pairedCard("1", "Griffey"), confidence: 1 }],
      unmatchedSl: [slCard("77", "SL Only")],
    });

    expect(screen.getByText("1 card will be saved")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Keep #77 SL Only as SportLots-only"));
    expect(screen.getByText("2 cards will be saved")).toBeTruthy();
  });
});

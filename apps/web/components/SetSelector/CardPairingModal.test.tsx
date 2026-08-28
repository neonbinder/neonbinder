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
    setLabel: string;
  }> = {},
) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  render(
    <CardPairingModal
      isOpen
      onClose={vi.fn()}
      onConfirm={onConfirm}
      setLabel={overrides.setLabel}
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

    // With nothing unmatched the section opens EXPANDED, so no disclosure to
    // click first (see the "nothing left to reconcile" describe below).
    fireEvent.click(screen.getByLabelText("Unlink #1 Griffey"));
    fireEvent.click(screen.getByLabelText("Confirm card matches"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].cards).toHaveLength(0);
  });

  test("a low-confidence auto-match shows its score so it can be reviewed", async () => {
    renderModal({
      autoMatched: [{ card: pairedCard("1", "Griffey"), confidence: 0.78 }],
    });
    // Opens expanded — nothing is unmatched.
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

/**
 * The fully-matched case. Reported from live use: after the BSC fan-out fix a
 * 220-card insert paired completely, and the dialog still opened COLLAPSED —
 * "▶ Matched (220)" above two "(0)" columns, two dead filter inputs, and
 * "Nothing kept — every unmatched card above will be discarded" describing
 * cards that did not exist. Every visible element referred to work that was
 * not there, and the one thing worth reviewing was hidden behind a disclosure.
 */
describe("CardPairingModal — nothing left to reconcile", () => {
  test("opens with the matched list EXPANDED when nothing is unmatched", () => {
    renderModal({
      autoMatched: [
        { card: pairedCard("1", "Greg Maddux"), confidence: 1 },
        { card: pairedCard("2", "Pedro Martinez"), confidence: 1 },
      ],
    });

    // The cards themselves are on screen, not behind a collapsed section.
    expect(screen.getByText(/Greg Maddux/)).toBeTruthy();
    expect(screen.getByText(/Pedro Martinez/)).toBeTruthy();
    expect(screen.getByLabelText("Collapse matched cards")).toBeTruthy();
  });

  test("still opens COLLAPSED when there is unmatched work to do", () => {
    // Collapsing exists to point attention at the columns below; that reason
    // holds whenever the columns have anything in them.
    renderModal({
      autoMatched: [{ card: pairedCard("1", "Greg Maddux"), confidence: 1 }],
      unmatchedBsc: [bscCard("99", "BSC Only")],
    });

    expect(screen.queryByText(/Greg Maddux/)).toBeNull();
    expect(screen.getByLabelText("Expand matched cards")).toBeTruthy();
  });

  test("hides the empty columns and keep shelf entirely", () => {
    renderModal({
      autoMatched: [{ card: pairedCard("1", "Greg Maddux"), confidence: 1 }],
    });

    expect(screen.queryByText(/BSC only/)).toBeNull();
    expect(screen.queryByText(/SportLots only/)).toBeNull();
    expect(screen.queryByText(/Keeping/)).toBeNull();
    expect(screen.queryByText(/Nothing kept/)).toBeNull();
    // The discard warning is false when no column can hold anything.
    expect(screen.queryByText(/Anything left in a column/)).toBeNull();
    expect(screen.getByText(/Every card paired across both marketplaces/)).toBeTruthy();
  });

  test("unlinking a pair brings the columns straight back", () => {
    // The flag is derived from CURRENT state, not the opening snapshot, so the
    // dialog must not strand the operator with no way to re-pair.
    renderModal({
      autoMatched: [{ card: pairedCard("1", "Greg Maddux"), confidence: 1 }],
    });
    expect(screen.queryByText(/BSC only/)).toBeNull();

    fireEvent.click(screen.getByLabelText(/^Unlink /));

    expect(screen.getByText(/BSC only/)).toBeTruthy();
    expect(screen.getByText(/SportLots only/)).toBeTruthy();
    expect(screen.getByText(/Keeping/)).toBeTruthy();
  });

  test("the header names the set so a distracted operator can tell where they are", () => {
    renderModal({
      autoMatched: [{ card: pairedCard("1", "Greg Maddux"), confidence: 1 }],
      setLabel: "Dugout Collection Artist's Proofs",
    });

    expect(
      screen.getByText(/Match Cards — Dugout Collection Artist's Proofs/),
    ).toBeTruthy();
  });
});

/**
 * NEO-195 — a streamed fetch releases candidates as their stems resolve, not in
 * card order, so the modal has to impose the order itself. A list in arrival
 * order is not a checklist.
 */
describe("CardPairingModal — natural card-number order", () => {
  // Nested elements repeat a row's text, so collect in DOM order and keep the
  // first sighting of each number.
  const numbersIn = (columnLabel: RegExp) => {
    const region = screen.getByText(columnLabel).closest("div")!.parentElement!;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const el of Array.from(region.querySelectorAll("*"))) {
      const n = (el.textContent ?? "").match(/^#(\d+[a-z]?)\s/i)?.[1];
      if (n && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
    return out;
  };

  test("out-of-order candidates render in card order, not arrival order", () => {
    renderModal({
      unmatchedBsc: [
        bscCard("351", "Dillon Dingler"),
        bscCard("2", "Thairo Estrada"),
        bscCard("40", "Mookie Betts"),
        bscCard("10", "Connor Wong"),
      ],
    });
    const seen = numbersIn(/BSC only/);
    expect(seen).toEqual(["2", "10", "40", "351"]);
  });

  test("#2 sorts before #10 — string ordering would invert them", () => {
    renderModal({ unmatchedBsc: [bscCard("10", "Ten"), bscCard("2", "Two")] });
    expect(numbersIn(/BSC only/)).toEqual(["2", "10"]);
  });

  test("a variation sorts directly after the card it varies", () => {
    renderModal({
      unmatchedBsc: [
        bscCard("20b", "Coby Mayo VAR"),
        bscCard("21", "Nick Lodolo"),
        bscCard("20", "Coby Mayo"),
      ],
    });
    expect(numbersIn(/BSC only/)).toEqual(["20", "20b", "21"]);
  });
});

/**
 * NEO-189 — a set's variations are otherwise indistinguishable in this list.
 * 2021 Topps ships three "#13x Mookie Betts" rows; without the variation name
 * an operator pairing by hand cannot tell which is which.
 */
describe("CardPairingModal — variation names are shown", () => {
  const varCard = (n: string, name: string, variation: string): PairingCard => ({
    cardNumber: n,
    cardName: name,
    cardVariation: variation,
    isVariation: true,
    platformData: { bsc: { ref: `bsc-${n}`, setId: "topps-2021" } },
    unmatched: "sl",
  });

  test("two variations of one card are told apart by name", () => {
    renderModal({
      unmatchedBsc: [
        varCard("1b", "Fernando Tatis Jr.", "Sliding"),
        varCard("1c", "Fernando Tatis Jr.", "In Dugout"),
      ],
    });
    expect(screen.getByText(/#1b Fernando Tatis Jr\. · Sliding/)).toBeTruthy();
    expect(screen.getByText(/#1c Fernando Tatis Jr\. · In Dugout/)).toBeTruthy();
  });

  test("the name reaches the accessible label, not just the visible text", () => {
    renderModal({
      unmatchedBsc: [varCard("13b", "Mookie Betts", "Pointing Up")],
    });
    // Scoped to the select button — the text also appears as the button's own
    // content, and the Keep control carries it too.
    expect(
      screen.getByRole("button", {
        name: "Select BSC card #13b Mookie Betts · Pointing Up",
      }),
    ).toBeTruthy();
  });

  test("a card with no variation name is unchanged", () => {
    renderModal({ unmatchedBsc: [bscCard("2", "Roberto Osuna")] });
    expect(screen.getByText("#2 Roberto Osuna")).toBeTruthy();
  });
});

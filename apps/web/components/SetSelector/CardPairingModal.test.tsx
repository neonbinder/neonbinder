/**
 * NEO-137 — CardPairingModal.
 *
 * The rule under test is the one that decides which NB cards come into
 * existence: confirmed pairs plus deliberately-kept singles, and NOTHING else.
 * That discard rule is what stops a shared SportLots set's sibling-owned cards
 * being invented under the wrong row, so it is worth pinning directly.
 */

import { describe, expect, test, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

/**
 * NEO-199 — an auto-matched pair as `fetchCardChecklist` now hands it over when
 * the two marketplaces disagree about who is on the card.
 *
 * `cardName` is BSC's, exactly as the server's merge leaves it; `nameConflict`
 * is the loser that merge used to throw away. Both names travel, so the modal
 * can raise the same choice a hand-linked conflict gets.
 */
const autoConflict = (n: string, bscName: string, slName: string) => ({
  card: {
    ...pairedCard(n, bscName),
    nameConflict: { bsc: bscName, sportlots: slName },
  } satisfies PairingCard,
  confidence: 1,
});

function renderModal(
  overrides: Partial<{
    autoMatched: Array<{ card: PairingCard; confidence: number }>;
    unmatchedBsc: PairingCard[];
    unmatchedSl: PairingCard[];
    setLabel: string;
    isStreaming: boolean;
    streamProgress: { ready: number; total: number };
  }> = {},
) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  render(
    <CardPairingModal
      isOpen
      onClose={vi.fn()}
      onConfirm={onConfirm}
      setLabel={overrides.setLabel}
      isStreaming={overrides.isStreaming}
      streamProgress={overrides.streamProgress}
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

/**
 * NEO-195/a11y — the a11y defect this pins: Confirm used to go native
 * `disabled` while streaming, which pulls a button out of the tab order
 * entirely. A keyboard user tabbing through the footer would never even land
 * on Confirm to learn why it wasn't doing anything. The fix keeps it
 * FOCUSABLE via `aria-disabled` and relies on `handleConfirm`'s own
 * `isStreaming` guard to make activating it a no-op. Native `disabled` is
 * reserved for the real terminal state (`confirming`, i.e. already saving).
 *
 * An unwitting "simplification" back to a single `disabled={isStreaming ||
 * confirming}` would reintroduce exactly the defect that was fixed — these
 * tests exist to catch that regression specifically.
 */
describe("CardPairingModal — isStreaming (NEO-195/a11y)", () => {
  test("Confirm stays focusable (no native disabled) while streaming", () => {
    renderModal({ isStreaming: true });
    const confirm = screen.getByLabelText(
      "Confirm card matches",
    ) as HTMLButtonElement;
    // The accessibility-defect regression: native `disabled` removes a
    // button from the tab order. It must stay false while merely streaming.
    expect(confirm.disabled).toBe(false);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
  });

  test("Confirm carries aria-describedby pointing at the streaming status region", () => {
    renderModal({ isStreaming: true });
    const confirm = screen.getByLabelText("Confirm card matches");
    expect(confirm.getAttribute("aria-describedby")).toBe(
      "pairing-streaming-status",
    );
    // The id it points at must actually exist and be the status banner.
    const status = document.getElementById("pairing-streaming-status");
    expect(status).toBeTruthy();
    expect(status?.getAttribute("role")).toBe("status");
  });

  test("Confirm has no aria-describedby when not streaming", () => {
    renderModal({});
    const confirm = screen.getByLabelText("Confirm card matches");
    expect(confirm.hasAttribute("aria-describedby")).toBe(false);
  });

  test('label reads "Loading…" while streaming', () => {
    renderModal({ isStreaming: true });
    expect(
      screen.getByRole("button", { name: "Confirm card matches" }).textContent,
    ).toBe("Loading…");
  });

  test('label reads "Confirm" when neither streaming nor confirming', () => {
    renderModal({});
    expect(
      screen.getByRole("button", { name: "Confirm card matches" }).textContent,
    ).toBe("Confirm");
  });

  test('label reads "Saving…" once the terminal confirming state is reached, even though the button IS natively disabled there', async () => {
    const { onConfirm } = renderModal({
      autoMatched: [{ card: pairedCard("1", "Griffey"), confidence: 1 }],
    });
    // Hold onConfirm open so the component stays in the `confirming` state
    // long enough to assert against.
    let resolveConfirm: () => void = () => {};
    onConfirm.mockImplementation(
      () => new Promise<void>((resolve) => (resolveConfirm = resolve)),
    );

    fireEvent.click(screen.getByLabelText("Confirm card matches"));

    await waitFor(() =>
      expect(
        (screen.getByLabelText("Confirm card matches") as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    expect(
      screen.getByRole("button", { name: "Confirm card matches" }).textContent,
    ).toBe("Saving…");

    resolveConfirm();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  test("activating the still-focusable Confirm while streaming is a no-op — onConfirm is NOT called", () => {
    const { onConfirm } = renderModal({
      isStreaming: true,
      autoMatched: [{ card: pairedCard("1", "Griffey"), confidence: 1 }],
    });

    fireEvent.click(screen.getByLabelText("Confirm card matches"));

    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("the streaming banner has role=status and reports N-of-M progress", () => {
    renderModal({
      isStreaming: true,
      streamProgress: { ready: 7, total: 20 },
    });
    const status = screen.getByRole("status");
    expect(status.id).toBe("pairing-streaming-status");
    expect(status.textContent).toContain("7 of 20 done");
  });

  test("the streaming banner is absent when not streaming", () => {
    renderModal({});
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.getElementById("pairing-streaming-status")).toBeNull();
  });
});

/**
 * NEO-189 — the marketplaces disagree about WHO IS ON the card.
 *
 * The live case, from 2021 Topps: SportLots carries
 * "Mike Yastrzemski|Carl Yastrzemski · SSSP" where BSC carries a bare
 * "#227c Mike Yastrzemski" with an EMPTY variation description. The card is
 * actually CARL — a "Legend" short print whose variation pictures a different
 * player than the base card (2021 Topps #52 is Archie Bradley; 52b/c/d are
 * Mickey Mantle). Merging took BSC's name unconditionally, so the fact that it
 * is Carl was silently lost, and the first anyone hears about it is a returned
 * listing and seller feedback.
 *
 * The rule this feature runs on is that ambiguity is REPORTED, never resolved
 * by heuristic — `resolveVariationParents` returns `unresolvedStems` rather
 * than picking a parent, and `suggestVariationPairings` leaves un-confident
 * pairs alone. These tests pin that same rule here: both names survive the
 * merge, the row says the sources disagree, and the operator chooses.
 */
describe("CardPairingModal — marketplace name conflicts (NEO-189)", () => {
  // The real row shapes. BSC suffixes the number and named the variation
  // NOTHING; SportLots keeps the parent's number and names both players.
  const yastrzemskiBsc: PairingCard = {
    cardNumber: "227c",
    cardName: "Mike Yastrzemski",
    isVariation: true,
    platformData: { bsc: { ref: "bsc-227c", setId: "topps-2021" } },
    unmatched: "sl",
  };
  const yastrzemskiSl: PairingCard = {
    cardNumber: "227",
    cardName: "Mike Yastrzemski|Carl Yastrzemski",
    cardVariation: "SSSP",
    isVariation: true,
    platformData: {
      sportlots: {
        ref: "#227 Mike Yastrzemski|Carl Yastrzemski [ VAR SSSP ]",
        setId: "884412",
      },
    },
    unmatched: "bsc",
  };

  /** Select the BSC row, then link it to the SL row, by accessible name. */
  const linkByLabel = (bscLabel: string, slLabel: string) => {
    fireEvent.click(screen.getByLabelText(`Select BSC card ${bscLabel}`));
    fireEvent.click(
      screen.getByLabelText(`Link selected BSC card to ${slLabel}`),
    );
  };

  const linkYastrzemski = () =>
    linkByLabel("#227c Mike Yastrzemski", "#227 Mike Yastrzemski|Carl Yastrzemski · SSSP");

  test("the Yastrzemski merge surfaces BOTH names instead of silently keeping BSC's", () => {
    renderModal({
      unmatchedBsc: [yastrzemskiBsc],
      unmatchedSl: [yastrzemskiSl],
    });

    linkYastrzemski();

    // The disagreement is announced as its own labelled region on the row.
    expect(screen.getByRole("group", { name: "Name conflict on #227c" })).toBeTruthy();
    // Both names are on screen — "Carl" is no longer thrown away by the merge.
    expect(screen.getByText(/BSC: Mike Yastrzemski/)).toBeTruthy();
    expect(
      screen.getByText(/SportLots: Mike Yastrzemski\|Carl Yastrzemski/),
    ).toBeTruthy();
  });

  test("neither name is pre-resolved as correct — BSC is marked as the current default, SportLots is one click away", () => {
    renderModal({
      unmatchedBsc: [yastrzemskiBsc],
      unmatchedSl: [yastrzemskiSl],
    });
    linkYastrzemski();

    const bscChoice = screen.getByRole("radio", {
      name: 'BSC: Mike Yastrzemski — use this name for #227c',
    });
    const slChoice = screen.getByRole("radio", {
      name: 'SportLots: Mike Yastrzemski|Carl Yastrzemski — use this name for #227c',
    });
    expect(bscChoice.getAttribute("aria-checked")).toBe("true");
    expect(slChoice.getAttribute("aria-checked")).toBe("false");
  });

  test("choosing SportLots commits Carl's name, not Mike's", async () => {
    const { onConfirm } = renderModal({
      unmatchedBsc: [yastrzemskiBsc],
      unmatchedSl: [yastrzemskiSl],
    });
    linkYastrzemski();

    fireEvent.click(
      screen.getByRole("radio", {
        name: 'SportLots: Mike Yastrzemski|Carl Yastrzemski — use this name for #227c',
      }),
    );
    fireEvent.click(screen.getByLabelText("Confirm card matches"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const cards = onConfirm.mock.calls[0][0].cards;
    expect(cards).toHaveLength(1);
    expect(cards[0].cardName).toBe("Mike Yastrzemski|Carl Yastrzemski");
    // Everything else still follows the merge rules: BSC owns the number, and
    // SportLots' variation name survives BSC's empty one.
    expect(cards[0].cardNumber).toBe("227c");
    expect(cards[0].cardVariation).toBe("SSSP");
  });

  test("the row's own label follows the choice, so the list shows what will be saved", () => {
    renderModal({
      unmatchedBsc: [yastrzemskiBsc],
      unmatchedSl: [yastrzemskiSl],
    });
    linkYastrzemski();

    expect(screen.getByLabelText("Unlink #227c Mike Yastrzemski · SSSP")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("radio", {
        name: 'SportLots: Mike Yastrzemski|Carl Yastrzemski — use this name for #227c',
      }),
    );
    expect(
      screen.getByLabelText(
        "Unlink #227c Mike Yastrzemski|Carl Yastrzemski · SSSP",
      ),
    ).toBeTruthy();
  });

  test("switching back to BSC restores its name — the choice is reversible before Confirm", async () => {
    const { onConfirm } = renderModal({
      unmatchedBsc: [yastrzemskiBsc],
      unmatchedSl: [yastrzemskiSl],
    });
    linkYastrzemski();

    fireEvent.click(
      screen.getByRole("radio", {
        name: 'SportLots: Mike Yastrzemski|Carl Yastrzemski — use this name for #227c',
      }),
    );
    fireEvent.click(
      screen.getByRole("radio", {
        name: 'BSC: Mike Yastrzemski — use this name for #227c',
      }),
    );
    fireEvent.click(screen.getByLabelText("Confirm card matches"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].cards[0].cardName).toBe("Mike Yastrzemski");
  });

  /**
   * Deliberately NOT a gate. The name is editable in CardDetailPanel after
   * Confirm, so a conflict is recoverable; blocking would let one flagged row
   * in a streamed 660-card set hold the whole commit hostage. The default is
   * unchanged behaviour — what changed is that it is no longer silent.
   */
  test("an unresolved conflict does NOT block Confirm, and still defaults to BSC", async () => {
    const { onConfirm } = renderModal({
      unmatchedBsc: [yastrzemskiBsc],
      unmatchedSl: [yastrzemskiSl],
    });
    linkYastrzemski();

    const confirm = screen.getByLabelText(
      "Confirm card matches",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    expect(confirm.hasAttribute("aria-disabled")).toBe(false);

    fireEvent.click(confirm);
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].cards[0].cardName).toBe("Mike Yastrzemski");
  });

  /**
   * The Matched section collapses by default whenever a column has anything in
   * it — which is necessarily true while the operator is linking by hand. A
   * warning inside a closed section is not a warning.
   */
  test("linking a conflicting pair opens the collapsed Matched section", () => {
    renderModal({
      unmatchedBsc: [yastrzemskiBsc, bscCard("5", "Roberto Osuna")],
      unmatchedSl: [yastrzemskiSl, slCard("5", "Roberto Osuna")],
    });
    // Unmatched work exists, so it opens collapsed.
    expect(screen.getByLabelText(/^Expand matched cards/)).toBeTruthy();

    linkYastrzemski();

    expect(screen.getByRole("group", { name: "Name conflict on #227c" })).toBeTruthy();
  });

  test("a clean link leaves the section as the operator had it", () => {
    renderModal({
      unmatchedBsc: [yastrzemskiBsc, bscCard("5", "Roberto Osuna")],
      unmatchedSl: [yastrzemskiSl, slCard("5", "Roberto Osuna")],
    });

    linkByLabel("#5 Roberto Osuna", "#5 Roberto Osuna");

    // No conflict, so no reason to seize the operator's attention.
    expect(screen.getByLabelText("Expand matched cards")).toBeTruthy();
  });

  test("the collapsed header still reports the conflict count, in text and to assistive tech", () => {
    renderModal({
      unmatchedBsc: [yastrzemskiBsc, bscCard("5", "Roberto Osuna")],
      unmatchedSl: [yastrzemskiSl, slCard("5", "Roberto Osuna")],
    });
    linkYastrzemski();

    // Re-collapse: the signal must survive the operator closing the section.
    fireEvent.click(
      screen.getByLabelText("Collapse matched cards, 1 with a name conflict"),
    );
    expect(screen.getByText(/1 name conflict/)).toBeTruthy();
    expect(
      screen.getByLabelText("Expand matched cards, 1 with a name conflict"),
    ).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Name conflict on #227c" })).toBeNull();
  });

  test("the header label is untouched when nothing conflicts", () => {
    renderModal({
      autoMatched: [{ card: pairedCard("1", "Griffey"), confidence: 1 }],
    });
    expect(screen.getByLabelText("Collapse matched cards")).toBeTruthy();
    expect(screen.queryByText(/name conflict/)).toBeNull();
  });

  /**
   * Unlink has to actually undo the merge. Spreading the merged card onto both
   * halves stamped BSC's "Mike Yastrzemski" over SportLots' row, so the SL
   * column lost Carl permanently and a re-link could never detect the conflict
   * again — the two rows now agreed, wrongly.
   */
  test("unlinking gives each side its OWN name back", () => {
    renderModal({
      unmatchedBsc: [yastrzemskiBsc],
      unmatchedSl: [yastrzemskiSl],
    });
    linkYastrzemski();
    fireEvent.click(screen.getByLabelText(/^Unlink /));

    expect(
      screen.getByLabelText(/^Select BSC card #227c Mike Yastrzemski ·/),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(
        /^Link selected BSC card to #227c Mike Yastrzemski\|Carl Yastrzemski ·/,
      ),
    ).toBeTruthy();
  });

  test("re-linking after an unlink detects the conflict again", () => {
    renderModal({
      unmatchedBsc: [yastrzemskiBsc],
      unmatchedSl: [yastrzemskiSl],
    });
    linkYastrzemski();
    fireEvent.click(screen.getByLabelText(/^Unlink /));

    linkByLabel(
      "#227c Mike Yastrzemski · SSSP",
      "#227c Mike Yastrzemski|Carl Yastrzemski · SSSP",
    );

    expect(screen.getByRole("group", { name: "Name conflict on #227c" })).toBeTruthy();
    expect(
      screen.getByText(/SportLots: Mike Yastrzemski\|Carl Yastrzemski/),
    ).toBeTruthy();
  });

  /**
   * Scope: EVERY merged pair, not only `isVariation` ones. A mis-click one row
   * off in a 660-row column merges two different players, and the name
   * disagreement is the only signal that it happened. Restricting the check to
   * variations would also risk missing the motivating row itself, since BSC
   * filed #227c with an empty variation description.
   */
  test("a non-variation pair whose names disagree is flagged too", () => {
    renderModal({
      unmatchedBsc: [bscCard("40", "Mookie Betts")],
      unmatchedSl: [slCard("40", "Corey Seager")],
    });

    linkByLabel("#40 Mookie Betts", "#40 Corey Seager");

    expect(screen.getByRole("group", { name: "Name conflict on #40" })).toBeTruthy();
  });

  describe("differences that are spelling, not disagreement, stay quiet", () => {
    const noConflict = (bscName: string, slName: string) => {
      renderModal({
        unmatchedBsc: [bscCard("9", bscName)],
        unmatchedSl: [slCard("9", slName)],
      });
      linkByLabel(`#9 ${bscName}`, `#9 ${slName}`);
      expect(screen.queryByRole("group", { name: /^Name conflict/ })).toBeNull();
      expect(screen.queryByText(/name conflict/)).toBeNull();
    };

    test("identical names", () => noConflict("Ken Griffey Jr.", "Ken Griffey Jr."));
    test("trailing punctuation", () => noConflict("Ken Griffey Jr.", "Ken Griffey Jr"));
    test("casing", () => noConflict("Ken Griffey Jr.", "KEN GRIFFEY JR."));
    // BSC routinely strips the accents SportLots keeps.
    test("accents", () => noConflict("Jose Ramirez", "José Ramírez"));
    // BSC joins co-subjects with " / ", SportLots with "|".
    test("multi-player separators", () =>
      noConflict("Mike Trout / Shohei Ohtani", "Mike Trout|Shohei Ohtani"));
  });

  test("a side with no name at all is not a disagreement — the other side simply wins", async () => {
    const { onConfirm } = renderModal({
      unmatchedBsc: [bscCard("60", "")],
      unmatchedSl: [slCard("60", "Wander Franco")],
    });

    fireEvent.click(screen.getByLabelText("Select BSC card #60"));
    fireEvent.click(
      screen.getByLabelText("Link selected BSC card to #60 Wander Franco"),
    );

    expect(screen.queryByRole("group", { name: /^Name conflict/ })).toBeNull();
    fireEvent.click(screen.getByLabelText("Confirm card matches"));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].cards[0].cardName).toBe("Wander Franco");
  });

  /**
   * NEO-199 — the auto-matched path, which is where most rows actually come
   * from: a 660-card set auto-matches nearly all of it and manual linking is
   * the leftovers.
   *
   * This block replaces a pin that read "an auto-matched pair carries no
   * conflict marker". That pin was RIGHT about the rule it enforced — the modal
   * must not invent a marker it cannot substantiate — and WRONG about why it
   * could not: the reason was that `fetchCardChecklist` discarded the losing
   * name server-side, so the client had nothing to compare. The server now
   * sends both names when they disagree, so the marker IS substantiated, and
   * the rule survives here in its exact original form — a pair the server did
   * not flag still gets nothing.
   */
  describe("a conflict the SERVER found is surfaced like one found here", () => {
    const yaz = () =>
      autoConflict("227c", "Mike Yastrzemski", "Mike Yastrzemski|Carl Yastrzemski");

    test("the choice is offered on arrival, with both names, before any operator action", () => {
      renderModal({ autoMatched: [yaz()] });

      expect(
        screen.getByRole("radiogroup", { name: "Name for #227c" }),
      ).toBeTruthy();
      expect(
        screen.getByRole("radio", { name: /^BSC: Mike Yastrzemski —/ }),
      ).toBeTruthy();
      expect(
        screen.getByRole("radio", {
          name: /^SportLots: Mike Yastrzemski\|Carl Yastrzemski —/,
        }),
      ).toBeTruthy();
    });

    /**
     * The Matched section collapses by default whenever a column has anything
     * in it, and an auto-matched conflict is there from the first paint — so on
     * a real sync the header badge is the ONLY thing standing between the
     * operator and a silently mis-named card.
     */
    test("it is counted on the header, which is all that shows while Matched is collapsed", () => {
      renderModal({
        autoMatched: [yaz()],
        unmatchedSl: [slCard("B1", "Cal Ripken Jr.")],
      });

      expect(
        screen.getByLabelText("Expand matched cards, 1 with a name conflict"),
      ).toBeTruthy();
      expect(screen.getByText(/1 name conflict/)).toBeTruthy();
    });

    /**
     * The assertion that matters: what gets SAVED. Internal state proving the
     * radio moved would pass just as well with a card that still commits Mike.
     */
    test("choosing SportLots changes the name the card is COMMITTED with", async () => {
      const { onConfirm } = renderModal({ autoMatched: [yaz()] });

      fireEvent.click(
        screen.getByRole("radio", {
          name: /^SportLots: Mike Yastrzemski\|Carl Yastrzemski —/,
        }),
      );
      fireEvent.click(screen.getByLabelText("Confirm card matches"));

      await waitFor(() => expect(onConfirm).toHaveBeenCalled());
      expect(onConfirm.mock.calls[0][0].cards[0].cardName).toBe(
        "Mike Yastrzemski|Carl Yastrzemski",
      );
    });

    /** Non-blocking, and BSC still wins by default: doing nothing commits what
     *  it committed before this feature existed. */
    test("doing nothing commits BSC's name, exactly as before", async () => {
      const { onConfirm } = renderModal({ autoMatched: [yaz()] });

      fireEvent.click(screen.getByLabelText("Confirm card matches"));

      await waitFor(() => expect(onConfirm).toHaveBeenCalled());
      expect(onConfirm.mock.calls[0][0].cards[0].cardName).toBe(
        "Mike Yastrzemski",
      );
    });

    /**
     * `previewCardValidator` was widened so the second name could reach the
     * client — not so it could travel onwards. `resolveEntities` and
     * `commitCardChecklist` receive the same card shape they always did.
     */
    test("the wire field is lifted onto the pair and never reaches onConfirm", async () => {
      const { onConfirm } = renderModal({ autoMatched: [yaz()] });

      fireEvent.click(screen.getByLabelText("Confirm card matches"));

      await waitFor(() => expect(onConfirm).toHaveBeenCalled());
      expect(onConfirm.mock.calls[0][0].cards[0]).not.toHaveProperty(
        "nameConflict",
      );
    });

    /**
     * The original pin, intact. An agreeing pair carries no extra field on the
     * wire — that is what keeps a 908-row payload flat — and the modal invents
     * nothing on top of it.
     */
    test("a pair the server did not flag carries no marker", () => {
      renderModal({
        autoMatched: [
          { card: pairedCard("1", "Ken Griffey Jr."), confidence: 1 },
        ],
      });
      expect(screen.queryByRole("group", { name: /^Name conflict/ })).toBeNull();
    });

    /**
     * Proof the two paths share ONE predicate rather than agreeing by
     * coincidence: the client re-runs `conflictingNames` over what it was sent.
     * Two spellings of one name cannot produce a radiogroup asking the operator
     * to choose between two identical options, however the flag got set.
     */
    test("a flagged pair whose names only differ in spelling is still quiet", () => {
      renderModal({
        autoMatched: [autoConflict("4", "Jose Ramirez", "José Ramírez")],
      });
      expect(screen.queryByRole("group", { name: /^Name conflict/ })).toBeNull();
      expect(screen.queryByText(/name conflict/)).toBeNull();
    });

    /**
     * The streamed path. The modal opens on the first ready stem and absorbs
     * the rest over the next ~70 seconds, so a conflict on a late-arriving row
     * has to be flagged on arrival too — not only on rows present at mount.
     */
    test("a conflict on a row that streams in later is flagged when it lands", () => {
      const onConfirm = vi.fn().mockResolvedValue(undefined);
      const { rerender } = render(
        <CardPairingModal
          isOpen
          onClose={vi.fn()}
          onConfirm={onConfirm}
          initialData={{
            autoMatched: [
              { card: pairedCard("1", "Ken Griffey Jr."), confidence: 1 },
            ],
            unmatchedBsc: [],
            unmatchedSl: [],
          }}
        />,
      );
      expect(screen.queryByRole("group", { name: /^Name conflict/ })).toBeNull();

      rerender(
        <CardPairingModal
          isOpen
          onClose={vi.fn()}
          onConfirm={onConfirm}
          initialData={{
            autoMatched: [
              { card: pairedCard("1", "Ken Griffey Jr."), confidence: 1 },
              yaz(),
            ],
            unmatchedBsc: [],
            unmatchedSl: [],
          }}
        />,
      );

      expect(
        screen.getByRole("group", { name: "Name conflict on #227c" }),
      ).toBeTruthy();
    });
  });

  /**
   * a11y audit (NEO-189) — the two name choices are mutually exclusive
   * (exactly one is always chosen), which is what the WAI-ARIA radio-group
   * pattern is for, not a pair of independent aria-pressed toggles. Kept as a
   * pair of pill BUTTONS visually — only the semantics changed.
   */
  describe("a11y — the name choice is a radiogroup, not two independent toggles", () => {
    test("exposes role=radiogroup with an accessible name, and each option as role=radio", () => {
      renderModal({
        unmatchedBsc: [yastrzemskiBsc],
        unmatchedSl: [yastrzemskiSl],
      });
      linkYastrzemski();

      expect(
        screen.getByRole("radiogroup", { name: "Name for #227c" }),
      ).toBeTruthy();
      expect(screen.getByRole("radio", { name: /^BSC:/ })).toBeTruthy();
      expect(screen.getByRole("radio", { name: /^SportLots:/ })).toBeTruthy();
    });

    test("the radiogroup is described by the warning explaining WHY there is a choice", () => {
      renderModal({
        unmatchedBsc: [yastrzemskiBsc],
        unmatchedSl: [yastrzemskiSl],
      });
      linkYastrzemski();

      const group = screen.getByRole("radiogroup", { name: "Name for #227c" });
      const describedBy = group.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy!)?.textContent).toMatch(
        /marketplaces name this card differently/,
      );
    });

    test("only the checked option is a Tab stop (roving tabindex)", () => {
      renderModal({
        unmatchedBsc: [yastrzemskiBsc],
        unmatchedSl: [yastrzemskiSl],
      });
      linkYastrzemski();

      const bscChoice = screen.getByRole("radio", { name: /^BSC:/ });
      const slChoice = screen.getByRole("radio", { name: /^SportLots:/ });
      expect(bscChoice.tabIndex).toBe(0);
      expect(slChoice.tabIndex).toBe(-1);
    });

    test("arrow keys move BOTH the selection and keyboard focus, per the APG radio-group pattern", async () => {
      renderModal({
        unmatchedBsc: [yastrzemskiBsc],
        unmatchedSl: [yastrzemskiSl],
      });
      linkYastrzemski();

      const bscChoice = screen.getByRole("radio", { name: /^BSC:/ });
      const slChoice = screen.getByRole("radio", { name: /^SportLots:/ });
      bscChoice.focus();

      fireEvent.keyDown(bscChoice, { key: "ArrowRight" });

      expect(bscChoice.getAttribute("aria-checked")).toBe("false");
      expect(slChoice.getAttribute("aria-checked")).toBe("true");
      await waitFor(() => expect(document.activeElement).toBe(slChoice));
      expect(slChoice.tabIndex).toBe(0);
      expect(bscChoice.tabIndex).toBe(-1);
    });
  });

  /**
   * a11y audit (NEO-189) — WCAG 2.5.3 Label in Name: the accessible name of a
   * control has to CONTAIN the control's own visible text, or a speech-input
   * user saying what they see on screen ("click SportLots: ...") cannot match
   * what assistive tech announces. `Use the SportLots name "..." for #N` does
   * not contain the visible label `SportLots: ...` anywhere in it.
   */
  test("each name choice's accessible name starts with its own visible label (WCAG 2.5.3)", () => {
    renderModal({
      unmatchedBsc: [yastrzemskiBsc],
      unmatchedSl: [yastrzemskiSl],
    });
    linkYastrzemski();

    // SportLots starts UNCHECKED, so its visible text carries no checkmark —
    // this isolates the label-in-name check from the colour-blind fix below.
    const slChoice = screen.getByRole("radio", { name: /^SportLots:/ });
    expect(slChoice.textContent).toBe(
      "SportLots: Mike Yastrzemski|Carl Yastrzemski",
    );
    expect(slChoice.getAttribute("aria-label")).toMatch(
      /^SportLots: Mike Yastrzemski\|Carl Yastrzemski\b/,
    );
  });

  /**
   * a11y audit (NEO-189) — WCAG 1.4.1 Use of Color: the chosen/unchosen fills
   * (cyan-900/60 vs gray-700/60) differ in relative luminance by ~1.06:1 —
   * effectively identical lightness, distinguished only by hue. An operator
   * with a color-vision deficiency has no way to tell which name is about to
   * be saved without a non-colour cue.
   */
  test("the chosen name carries a non-colour cue, not colour alone (WCAG 1.4.1)", () => {
    renderModal({
      unmatchedBsc: [yastrzemskiBsc],
      unmatchedSl: [yastrzemskiSl],
    });
    linkYastrzemski();

    // BSC is the default choice straight after LINK.
    const bscChoice = screen.getByRole("radio", { name: /^BSC:/ });
    const slChoice = screen.getByRole("radio", { name: /^SportLots:/ });
    expect(bscChoice.textContent?.startsWith("✓")).toBe(true);
    expect(slChoice.textContent?.startsWith("✓")).toBe(false);

    fireEvent.click(slChoice);
    expect(slChoice.textContent?.startsWith("✓")).toBe(true);
    expect(bscChoice.textContent?.startsWith("✓")).toBe(false);
  });

  /**
   * a11y audit (NEO-189) — the warning glyph is decorative: "These
   * marketplaces name this card differently" already says everything the
   * glyph would, in words. Without aria-hidden, some screen readers announce
   * U+26A0 by its Unicode name ("warning sign") ahead of that sentence — a
   * redundant announcement, not a wrong one, but worth not shipping twice.
   */
  test("the warning glyphs are decorative, not literal announced content", () => {
    renderModal({
      unmatchedBsc: [yastrzemskiBsc],
      unmatchedSl: [yastrzemskiSl],
    });
    linkYastrzemski();

    const warning = screen.getByText(
      /These marketplaces name this card differently/,
    );
    expect(warning.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      "⚠",
    );

    const badge = screen.getByText(/1 name conflict/);
    expect(badge.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      "⚠",
    );
  });

  /**
   * a11y audit (NEO-189) — linking a conflicting pair unmounts the very
   * button the operator just clicked (it moves from unmatchedSl into
   * matched) AND opens a brand-new decision (which name to keep). Left
   * alone, focus falls to <body> at exactly the moment there is something
   * the keyboard operator needs to act on.
   */
  test("linking a conflicting pair sends focus to the name choice, not <body>", async () => {
    renderModal({
      unmatchedBsc: [yastrzemskiBsc],
      unmatchedSl: [yastrzemskiSl],
    });

    linkYastrzemski();

    const bscChoice = screen.getByRole("radio", { name: /^BSC:/ });
    await waitFor(() => expect(document.activeElement).toBe(bscChoice));
  });

  test("linking a NON-conflicting pair does not steal focus onto a radio that doesn't exist", async () => {
    renderModal({
      unmatchedBsc: [bscCard("5", "Roberto Osuna")],
      unmatchedSl: [slCard("5", "Roberto Osuna")],
    });

    linkByLabel("#5 Roberto Osuna", "#5 Roberto Osuna");

    expect(screen.queryByRole("radio")).toBeNull();
    // Focus is simply wherever it already was (jsdom defaults to <body>);
    // the point of this test is only that nothing throws trying to find a
    // conflict radio that was never rendered.
    expect(document.body).toBeTruthy();
  });
});

/**
 * NEO-189 — a card and its variation share a printed number, so the CARD
 * NUMBER is not an identity anywhere on this screen.
 *
 * `LINK` was fixed for this; `KEEP` and `UNKEEP` were not, and they are the
 * two actions that decide what is committed. A number-keyed lookup moves
 * whichever same-numbered row sorted first, so the operator watches the row
 * they clicked leave the column while a DIFFERENT card lands on the keep
 * shelf and, from there, on the checklist. Every assertion below is on the
 * payload handed to `onConfirm` — the wrong card reaching the checklist is
 * the defect; internal state is not.
 *
 * Shapes are the ones SportLots really returns: one number, one player, two
 * bracketed variation descriptions, two distinct refs.
 */
describe("CardPairingModal — same number, different cards (NEO-189)", () => {
  const slVariation = (
    n: string,
    name: string,
    variation: string,
  ): PairingCard => ({
    cardNumber: n,
    cardName: name,
    cardVariation: variation,
    isVariation: true,
    platformData: {
      sportlots: { ref: `#${n} ${name} [ ${variation} ]`, setId: "884412" },
    },
    unmatched: "bsc",
  });

  const bscVariation = (
    n: string,
    name: string,
    variation: string,
  ): PairingCard => ({
    cardNumber: n,
    cardName: name,
    cardVariation: variation,
    isVariation: true,
    platformData: {
      bsc: { ref: `bsc-${n}-${variation}`, setId: "topps-2021" },
    },
    unmatched: "sl",
  });

  const sliding = slVariation("1", "Ken Griffey Jr.", "Sliding");
  const inDugout = slVariation("1", "Ken Griffey Jr.", "In Dugout");

  test("keeping the SECOND of two same-numbered SportLots rows commits THAT row", async () => {
    const { onConfirm } = renderModal({ unmatchedSl: [sliding, inDugout] });

    fireEvent.click(
      screen.getByLabelText(
        "Keep #1 Ken Griffey Jr. · In Dugout as SportLots-only",
      ),
    );
    fireEvent.click(screen.getByLabelText("Confirm card matches"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const cards = onConfirm.mock.calls[0][0].cards;
    expect(cards).toHaveLength(1);
    expect(cards[0].cardVariation).toBe("In Dugout");
    expect(cards[0].platformData.sportlots.ref).toBe(
      "#1 Ken Griffey Jr. [ In Dugout ]",
    );
  });

  test("keeping the SECOND of two same-numbered BSC rows commits THAT row", async () => {
    const { onConfirm } = renderModal({
      unmatchedBsc: [
        bscVariation("1", "Ken Griffey Jr.", "Sliding"),
        bscVariation("1", "Ken Griffey Jr.", "In Dugout"),
      ],
    });

    fireEvent.click(
      screen.getByLabelText("Keep #1 Ken Griffey Jr. · In Dugout as BSC-only"),
    );
    fireEvent.click(screen.getByLabelText("Confirm card matches"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const cards = onConfirm.mock.calls[0][0].cards;
    expect(cards).toHaveLength(1);
    expect(cards[0].cardVariation).toBe("In Dugout");
    expect(cards[0].platformData.bsc.ref).toBe("bsc-1-In Dugout");
  });

  test("removing one of two same-numbered kept rows removes the one that was clicked", async () => {
    const { onConfirm } = renderModal({ unmatchedSl: [sliding, inDugout] });

    fireEvent.click(
      screen.getByLabelText("Keep #1 Ken Griffey Jr. · Sliding as SportLots-only"),
    );
    fireEvent.click(
      screen.getByLabelText(
        "Keep #1 Ken Griffey Jr. · In Dugout as SportLots-only",
      ),
    );
    fireEvent.click(
      screen.getByLabelText(
        "Remove #1 Ken Griffey Jr. · In Dugout from save list",
      ),
    );
    fireEvent.click(screen.getByLabelText("Confirm card matches"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const cards = onConfirm.mock.calls[0][0].cards;
    expect(cards).toHaveLength(1);
    expect(cards[0].cardVariation).toBe("Sliding");
  });

  /**
   * The rendered lists have the same identity problem as the reducer: two
   * same-numbered rows produced two `<li>` with the same React key, and
   * `ordered()` re-sorts after EVERY dispatch, so this list reconciles
   * constantly. React only warns; what it does with the duplicate is
   * undefined, and row state can end up on the wrong row.
   */
  test("same-numbered rows do not collide as React keys, in the columns or on the keep shelf", () => {
    const errors: unknown[][] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args);
      });
    try {
      renderModal({
        unmatchedSl: [sliding, inDugout],
        unmatchedBsc: [
          bscVariation("1", "Ken Griffey Jr.", "Sliding"),
          bscVariation("1", "Ken Griffey Jr.", "In Dugout"),
        ],
      });
      // The keep shelf renders its own <li> per kept card — same defect, so
      // move both columns onto it and let it render too.
      fireEvent.click(screen.getByLabelText("Keep all SportLots-only cards"));
      fireEvent.click(screen.getByLabelText("Keep all BSC-only cards"));
    } finally {
      spy.mockRestore();
    }

    expect(
      errors.filter((e) => String(e[0]).includes("same key")),
    ).toHaveLength(0);
  });

  /**
   * The name-conflict row hands out a DOM `id` (for `aria-describedby`) and a
   * `data-name-conflict` handle that `refocusSelectedRadio` re-queries after a
   * dispatch. Both were built from the card number, so two conflicting pairs
   * on one number emitted a duplicate id and aimed focus at the first row's
   * radiogroup no matter which row the operator was in.
   */
  describe("two conflicting pairs on one number", () => {
    const bscSliding = bscVariation("227", "Mike Yastrzemski", "Sliding");
    const bscDugout = bscVariation("227", "Mike Yastrzemski", "In Dugout");
    const slCarl: PairingCard = {
      cardNumber: "227",
      cardName: "Carl Yastrzemski",
      cardVariation: "SSSP",
      isVariation: true,
      platformData: {
        sportlots: { ref: "#227 Carl Yastrzemski [ VAR SSSP ]", setId: "884412" },
      },
      unmatched: "bsc",
    };
    const slMantle: PairingCard = {
      cardNumber: "227",
      cardName: "Mickey Mantle",
      cardVariation: "Legend",
      isVariation: true,
      platformData: {
        sportlots: { ref: "#227 Mickey Mantle [ VAR LEG ]", setId: "884412" },
      },
      unmatched: "bsc",
    };

    /** Link Carl first, then Mantle, so Mantle is the SECOND conflicting row. */
    const linkBoth = () => {
      renderModal({
        unmatchedBsc: [bscSliding, bscDugout],
        unmatchedSl: [slCarl, slMantle],
      });
      fireEvent.click(
        screen.getByLabelText("Select BSC card #227 Mike Yastrzemski · Sliding"),
      );
      fireEvent.click(
        screen.getByLabelText(
          "Link selected BSC card to #227 Carl Yastrzemski · SSSP",
        ),
      );
      fireEvent.click(
        screen.getByLabelText(
          "Select BSC card #227 Mike Yastrzemski · In Dugout",
        ),
      );
      fireEvent.click(
        screen.getByLabelText(
          "Link selected BSC card to #227 Mickey Mantle · Legend",
        ),
      );
    };

    test("each row's warning gets its own id, so aria-describedby resolves to its own row", () => {
      linkBoth();

      const ids = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[id^="name-conflict-warning-"]',
        ),
      ).map((el) => el.id);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);

      for (const group of screen.getAllByRole("radiogroup")) {
        const describedBy = group.getAttribute("aria-describedby")!;
        expect(
          group.closest("li")!.querySelector(`#${CSS.escape(describedBy)}`),
        ).toBeTruthy();
      }
    });

    test("linking the second one focuses ITS name choice, not the first row's", async () => {
      linkBoth();

      const mantleRow = screen
        .getByRole("radio", { name: /^SportLots: Mickey Mantle/ })
        .closest('[role="radiogroup"]')!;
      await waitFor(() =>
        expect(
          within(mantleRow as HTMLElement).getByRole("radio", { name: /^BSC:/ }),
        ).toBe(document.activeElement),
      );
    });
  });
});

/**
 * NEO-201 — the rendered order must not depend on the order candidates
 * ARRIVED in.
 *
 * `ordered()` sorted on the card number alone, and the card number is not
 * unique on this screen — that is the fact the whole branch turns on. Two rows
 * sharing a number tied, and a tie in `Array.prototype.sort` falls through to
 * the order the array was already in. During a streamed fetch that is arrival
 * order, and `ABSORB` appends, so a card and its variation could trade places
 * between renders while the operator was part-way through reviewing them.
 *
 * Not a correctness bug since `65d8352` — nothing here is selected, kept or
 * linked by position any more. It is a legibility one, and rows moving under
 * someone reviewing 900 of them is its own kind of wrong.
 *
 * Every test below renders the SAME cards in DIFFERENT arrival orders and
 * asserts one rendering. That is the assertion that actually pins it: an
 * expected-list test would still pass on a comparator that merely happened to
 * agree with the fixture's declaration order.
 */
describe("CardPairingModal — order does not depend on arrival order (NEO-201)", () => {
  const slRow = (n: string, name: string, variation?: string): PairingCard => ({
    cardNumber: n,
    cardName: name,
    ...(variation ? { cardVariation: variation, isVariation: true } : {}),
    platformData: {
      sportlots: {
        ref: variation ? `#${n} ${name} [ ${variation} ]` : `#${n} ${name}`,
        setId: "884412",
      },
    },
    unmatched: "bsc",
  });

  const bscRow = (n: string, name: string, variation?: string): PairingCard => ({
    cardNumber: n,
    cardName: name,
    ...(variation ? { cardVariation: variation, isVariation: true } : {}),
    platformData: {
      bsc: { ref: `bsc-${n}${variation ? `-${variation}` : ""}`, setId: "t21" },
    },
    unmatched: "sl",
  });

  /** The shapes SportLots really returns: one number, three different cards. */
  const griffeyBase = slRow("1", "Ken Griffey Jr.");
  const griffeySliding = slRow("1", "Ken Griffey Jr.", "Sliding");
  const griffeyDugout = slRow("1", "Ken Griffey Jr.", "In Dugout");
  const bonds = slRow("2", "Barry Bonds");
  const ripken = slRow("10", "Cal Ripken Jr.");

  /**
   * Rotations plus the reverse — deliberately enumerated rather than randomly
   * shuffled, so a failure names a specific arrival order and reproduces.
   */
  function arrivalOrders<T>(xs: T[]): T[][] {
    const orders = xs.map((_, k) => [...xs.slice(k), ...xs.slice(0, k)]);
    orders.push([...xs].reverse());
    return orders;
  }

  const namesMatching = (re: RegExp) =>
    screen.queryAllByLabelText(re).map((el) => el.getAttribute("aria-label"));

  function renderOnce(initialData: {
    autoMatched?: Array<{ card: PairingCard; confidence: number }>;
    unmatchedBsc?: PairingCard[];
    unmatchedSl?: PairingCard[];
  }) {
    return render(
      <CardPairingModal
        isOpen
        onClose={vi.fn()}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
        initialData={{
          autoMatched: initialData.autoMatched ?? [],
          unmatchedBsc: initialData.unmatchedBsc ?? [],
          unmatchedSl: initialData.unmatchedSl ?? [],
        }}
      />,
    );
  }

  const link227 = (bscLabel: string, slLabel: string) => {
    fireEvent.click(screen.getByLabelText(`Select BSC card ${bscLabel}`));
    fireEvent.click(
      screen.getByLabelText(`Link selected BSC card to ${slLabel}`),
    );
  };

  test("the SportLots column renders identically whatever order the fetch produced", () => {
    const cards = [griffeyBase, griffeySliding, griffeyDugout, bonds, ripken];
    const renderings = new Set<string>();

    for (const arrival of arrivalOrders(cards)) {
      const { unmount } = renderOnce({ unmatchedSl: arrival });
      renderings.add(
        JSON.stringify(namesMatching(/ as SportLots-only$/)),
      );
      unmount();
    }

    expect(renderings.size).toBe(1);
  });

  test("the BSC column renders identically whatever order the fetch produced", () => {
    const cards = [
      bscRow("1", "Ken Griffey Jr."),
      bscRow("1", "Ken Griffey Jr.", "Sliding"),
      bscRow("1", "Ken Griffey Jr.", "In Dugout"),
      bscRow("2", "Barry Bonds"),
      bscRow("10", "Cal Ripken Jr."),
    ];
    const renderings = new Set<string>();

    for (const arrival of arrivalOrders(cards)) {
      const { unmount } = renderOnce({ unmatchedBsc: arrival });
      renderings.add(JSON.stringify(namesMatching(/ as BSC-only$/)));
      unmount();
    }

    expect(renderings.size).toBe(1);
  });

  test("the matched list renders identically whatever order the fetch produced", () => {
    const pairs = [
      { card: pairedCard("1", "Ken Griffey Jr."), confidence: 1 },
      {
        card: {
          ...pairedCard("1", "Ken Griffey Jr."),
          cardVariation: "Sliding",
          isVariation: true,
          platformData: {
            bsc: { ref: "bsc-1-sliding", setId: "t21" },
            sportlots: { ref: "#1 Griffey [ Sliding ]", setId: "884412" },
          },
        },
        confidence: 1,
      },
      {
        card: {
          ...pairedCard("1", "Ken Griffey Jr."),
          cardVariation: "In Dugout",
          isVariation: true,
          platformData: {
            bsc: { ref: "bsc-1-dugout", setId: "t21" },
            sportlots: { ref: "#1 Griffey [ In Dugout ]", setId: "884412" },
          },
        },
        confidence: 1,
      },
      { card: pairedCard("10", "Cal Ripken Jr."), confidence: 1 },
    ];
    const renderings = new Set<string>();

    for (const arrival of arrivalOrders(pairs)) {
      const { unmount } = renderOnce({ autoMatched: arrival });
      renderings.add(JSON.stringify(namesMatching(/^Unlink /)));
      unmount();
    }

    expect(renderings.size).toBe(1);
  });

  /**
   * The tiebreak is not just deterministic, it is the order a checklist is
   * printed in: the base card, then the things that vary from it, in a fixed
   * and nameable order rather than an opaque one.
   */
  test("a parent sorts ahead of its own variations, and #2 still precedes #10", () => {
    renderOnce({
      unmatchedSl: [ripken, griffeySliding, bonds, griffeyDugout, griffeyBase],
    });

    expect(namesMatching(/ as SportLots-only$/)).toEqual([
      "Keep #1 Ken Griffey Jr. as SportLots-only",
      "Keep #1 Ken Griffey Jr. · In Dugout as SportLots-only",
      "Keep #1 Ken Griffey Jr. · Sliding as SportLots-only",
      "Keep #2 Barry Bonds as SportLots-only",
      "Keep #10 Cal Ripken Jr. as SportLots-only",
    ]);
  });

  /**
   * The streamed case specifically: `ABSORB` appends, so a variation that
   * became ready after the modal opened arrives at the bottom of the array.
   * It must render in its printed place, indistinguishably from a session
   * where everything arrived at once.
   */
  test("a candidate that arrives mid-session lands in its printed place, not at the bottom", () => {
    const everything = renderOnce({
      unmatchedSl: [griffeyBase, griffeySliding, griffeyDugout, bonds, ripken],
    });
    const allAtOnce = namesMatching(/ as SportLots-only$/);
    everything.unmount();

    const streamed = renderOnce({ unmatchedSl: [ripken, griffeyBase] });
    streamed.rerender(
      <CardPairingModal
        isOpen
        onClose={vi.fn()}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
        initialData={{
          autoMatched: [],
          unmatchedBsc: [],
          // A second batch, itself out of order — exactly what a stem-by-stem
          // release produces.
          // Note the two #1 variations arrive in the OPPOSITE relative order
          // to the all-at-once fixture: with no secondary key, a stable sort
          // preserves that and the two renderings diverge.
          unmatchedSl: [ripken, griffeyBase, bonds, griffeyDugout, griffeySliding],
        }}
      />,
    );

    expect(namesMatching(/ as SportLots-only$/)).toEqual(allAtOnce);
  });

  /**
   * `cardName` is deliberately not a sort key. It is the one field
   * CHOOSE_NAME rewrites, so sorting on it would make the row the operator is
   * working in jump somewhere else the instant they resolved its conflict.
   */
  test("resolving a name conflict does not move the row it is on", () => {
    // Both rows on ONE number, so the tiebreak is the only thing deciding
    // their order — and the names are picked so that a `cardName` tiebreak
    // would put them in one order before the choice ("Aaron" < "Mookie") and
    // the OTHER order after it ("Zack" > "Mookie").
    const bscA: PairingCard = {
      cardNumber: "227",
      cardName: "Aaron Nola",
      platformData: { bsc: { ref: "bsc-227-a", setId: "t21" } },
      unmatched: "sl",
    };
    const bscB: PairingCard = {
      cardNumber: "227",
      cardName: "Mookie Betts",
      platformData: { bsc: { ref: "bsc-227-b", setId: "t21" } },
      unmatched: "sl",
    };
    renderOnce({
      unmatchedBsc: [bscA, bscB],
      unmatchedSl: [slRow("227", "Zack Wheeler"), slRow("227", "Mookie Betts")],
    });

    link227("#227 Aaron Nola", "#227 Zack Wheeler");
    link227("#227 Mookie Betts", "#227 Mookie Betts");

    expect(namesMatching(/^Unlink /)).toEqual([
      "Unlink #227 Aaron Nola",
      "Unlink #227 Mookie Betts",
    ]);

    fireEvent.click(
      screen.getByRole("radio", { name: /^SportLots: Zack Wheeler/ }),
    );

    // The name changed — and the row stayed exactly where it was.
    expect(namesMatching(/^Unlink /)).toEqual([
      "Unlink #227 Zack Wheeler",
      "Unlink #227 Mookie Betts",
    ]);
  });
});

/**
 * NEO-201 — naming the name-conflict controls when one card number carries
 * two of them.
 *
 * `65d8352` fixed the machine-readable half of this: `data-name-conflict`, the
 * warning `id` and the `aria-describedby` that resolves to it all key on the
 * marketplace ref. The human-readable half was left on the card number alone,
 * so a screen-reader user met two identically-named regions and two
 * identically-named radiogroups with nothing to tell them apart — the exact
 * ambiguity `label()` exists to kill in the unmatched columns.
 *
 * `label(m.card)` is NOT the fix: it reads `cardName`, and `cardName` is what
 * these controls change. A region that renames itself under the operator is
 * worse than an ambiguous one. Everything asserted below is therefore about a
 * disambiguator that holds still while the choice is made.
 */
describe("CardPairingModal — naming two conflicts on one number (NEO-201)", () => {
  const bscOn227 = (name: string, ref: string, variation?: string): PairingCard => ({
    cardNumber: "227",
    cardName: name,
    ...(variation ? { cardVariation: variation, isVariation: true } : {}),
    platformData: { bsc: { ref, setId: "topps-2021" } },
    unmatched: "sl",
  });
  const slOn227 = (name: string, variation?: string): PairingCard => ({
    cardNumber: "227",
    cardName: name,
    ...(variation ? { cardVariation: variation, isVariation: true } : {}),
    platformData: {
      sportlots: { ref: `#227 ${name}`, setId: "884412" },
    },
    unmatched: "bsc",
  });

  const link = (bscLabel: string, slLabel: string) => {
    fireEvent.click(screen.getByLabelText(`Select BSC card ${bscLabel}`));
    fireEvent.click(
      screen.getByLabelText(`Link selected BSC card to ${slLabel}`),
    );
  };

  const accessibleNames = (role: string) =>
    screen.getAllByRole(role).map((el) => el.getAttribute("aria-label"));

  /**
   * The variation description is the disambiguator that MEANS something:
   * "Sliding" and "In Dugout" is how the two rows differ on the printed card.
   */
  test("the variation description separates the two regions and the two radiogroups", () => {
    renderModal({
      unmatchedBsc: [
        bscOn227("Mike Yastrzemski", "bsc-227-sliding", "Sliding"),
        bscOn227("Mike Yastrzemski", "bsc-227-dugout", "In Dugout"),
      ],
      unmatchedSl: [slOn227("Carl Yastrzemski"), slOn227("Mickey Mantle")],
    });

    link("#227 Mike Yastrzemski · In Dugout", "#227 Carl Yastrzemski");
    link("#227 Mike Yastrzemski · Sliding", "#227 Mickey Mantle");

    expect(accessibleNames("group")).toEqual([
      "Name conflict on #227 · In Dugout",
      "Name conflict on #227 · Sliding",
    ]);
    expect(accessibleNames("radiogroup")).toEqual([
      "Name for #227 · In Dugout",
      "Name for #227 · Sliding",
    ]);
  });

  /**
   * The motivating row had BSC filing #227c with an EMPTY variation
   * description, so the meaningful disambiguator is exactly the one that can
   * be missing. An ordinal is always available; it is the fallback, not the
   * default, and it is applied to the WHOLE group so a group never mixes
   * "· Sliding" with "(2 of 2)".
   */
  test("falls back to an ordinal when no variation is recorded on either row", () => {
    renderModal({
      unmatchedBsc: [
        bscOn227("Mike Yastrzemski", "bsc-227-a"),
        bscOn227("Roberto Osuna", "bsc-227-b"),
      ],
      unmatchedSl: [slOn227("Carl Yastrzemski"), slOn227("Mickey Mantle")],
    });

    link("#227 Mike Yastrzemski", "#227 Carl Yastrzemski");
    link("#227 Roberto Osuna", "#227 Mickey Mantle");

    expect(accessibleNames("group")).toEqual([
      "Name conflict on #227 (1 of 2)",
      "Name conflict on #227 (2 of 2)",
    ]);
    expect(accessibleNames("radiogroup")).toEqual([
      "Name for #227 (1 of 2)",
      "Name for #227 (2 of 2)",
    ]);
  });

  /** A variation that both rows share separates nothing, so it is not used. */
  test("falls back to an ordinal when both rows carry the SAME variation", () => {
    renderModal({
      unmatchedBsc: [
        bscOn227("Mike Yastrzemski", "bsc-227-a", "SSSP"),
        bscOn227("Roberto Osuna", "bsc-227-b", "SSSP"),
      ],
      unmatchedSl: [slOn227("Carl Yastrzemski"), slOn227("Mickey Mantle")],
    });

    link("#227 Mike Yastrzemski · SSSP", "#227 Carl Yastrzemski");
    link("#227 Roberto Osuna · SSSP", "#227 Mickey Mantle");

    expect(accessibleNames("group")).toEqual([
      "Name conflict on #227 (1 of 2)",
      "Name conflict on #227 (2 of 2)",
    ]);
  });

  /**
   * The degrade case. One conflict on a number is not ambiguous, so it gets no
   * suffix at all — "(1 of 1)" would be noise on every ordinary row, and this
   * is also what keeps the existing Maestro selectors byte-valid.
   */
  test("a lone conflict on a number is named by the number alone — never '1 of 1'", () => {
    renderModal({
      unmatchedBsc: [bscOn227("Mike Yastrzemski", "bsc-227-a")],
      unmatchedSl: [slOn227("Carl Yastrzemski")],
    });

    link("#227 Mike Yastrzemski", "#227 Carl Yastrzemski");

    expect(accessibleNames("group")).toEqual(["Name conflict on #227"]);
    expect(accessibleNames("radiogroup")).toEqual(["Name for #227"]);
  });

  /**
   * Two conflicts on one number, on DIFFERENT numbers, still each named by
   * their own number alone — the suffix is decided per number, not globally.
   */
  test("conflicts on different numbers are each named by their number alone", () => {
    renderModal({
      unmatchedBsc: [bscCard("40", "Mookie Betts"), bscCard("41", "Zack Wheeler")],
      unmatchedSl: [slCard("40", "Corey Seager"), slCard("41", "Aaron Nola")],
    });

    link("#40 Mookie Betts", "#40 Corey Seager");
    link("#41 Zack Wheeler", "#41 Aaron Nola");

    expect(accessibleNames("group")).toEqual([
      "Name conflict on #40",
      "Name conflict on #41",
    ]);
  });

  /**
   * THE constraint. `label(m.card)` would satisfy every test above and fail
   * this one: the region and radiogroup name the control the operator is
   * currently using, and a name that mutates mid-use is worse than an
   * ambiguous one.
   */
  test("the region and radiogroup names hold still while the operator switches names", () => {
    renderModal({
      unmatchedBsc: [
        bscOn227("Mike Yastrzemski", "bsc-227-sliding", "Sliding"),
        bscOn227("Mike Yastrzemski", "bsc-227-dugout", "In Dugout"),
      ],
      unmatchedSl: [slOn227("Carl Yastrzemski"), slOn227("Mickey Mantle")],
    });

    link("#227 Mike Yastrzemski · In Dugout", "#227 Carl Yastrzemski");
    link("#227 Mike Yastrzemski · Sliding", "#227 Mickey Mantle");

    const groupsBefore = accessibleNames("group");
    const radiogroupsBefore = accessibleNames("radiogroup");

    fireEvent.click(
      screen.getByRole("radio", { name: /^SportLots: Carl Yastrzemski/ }),
    );
    fireEvent.click(
      screen.getByRole("radio", { name: /^SportLots: Mickey Mantle/ }),
    );

    // The choice took effect — both rows now carry SportLots' name…
    expect(
      screen.getByLabelText("Unlink #227 Carl Yastrzemski · In Dugout"),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Unlink #227 Mickey Mantle · Sliding"),
    ).toBeTruthy();
    // …and the things naming the controls that did it did not budge.
    expect(accessibleNames("group")).toEqual(groupsBefore);
    expect(accessibleNames("radiogroup")).toEqual(radiogroupsBefore);
  });

  /** Same guarantee on the ordinal path, where there is no variation to lean on. */
  test("the ordinal names hold still while the operator switches names", () => {
    renderModal({
      unmatchedBsc: [
        bscOn227("Mike Yastrzemski", "bsc-227-a"),
        bscOn227("Roberto Osuna", "bsc-227-b"),
      ],
      unmatchedSl: [slOn227("Carl Yastrzemski"), slOn227("Mickey Mantle")],
    });

    link("#227 Mike Yastrzemski", "#227 Carl Yastrzemski");
    link("#227 Roberto Osuna", "#227 Mickey Mantle");

    const before = accessibleNames("group");
    fireEvent.click(
      screen.getByRole("radio", { name: /^SportLots: Carl Yastrzemski/ }),
    );

    expect(screen.getByLabelText("Unlink #227 Carl Yastrzemski")).toBeTruthy();
    expect(accessibleNames("group")).toEqual(before);
  });
});

/**
 * NEO-90/NEO-195 — team names that resolve AFTER the dialog opened.
 *
 * A checklist fetch publishes every candidate at ~6s and then spends ~74s
 * resolving one team per card against BSC, patching each onto the streamed row
 * as it lands. `ABSORB` was append-only, so those patches hit rows the modal
 * already held and were dropped: only the cards whose team happened to resolve
 * before the first paint kept one.
 *
 * Nothing on screen showed it — the modal never displays a team. `teams` is
 * carried through `onConfirm` into `resolveChecklistEntities` (which puts new
 * ones in front of the operator in the review wizard) and
 * `commitCardChecklist` (which resolves them to `teamOnCardIds`), so the
 * symptom was cards committed with no team, teams never reviewed, and the
 * background enrichment queue quietly fetching the same names a second time
 * after the commit.
 *
 * These pin the merge and its limit: `teams` is adopted, and nothing else is.
 */
describe("CardPairingModal — enrichment that lands after the dialog opened", () => {
  /** The same card, before and after its BSC team lookup came back. */
  const withoutTeam = pairedCard("50", "Elly De La Cruz");
  const withTeam: PairingCard = {
    ...withoutTeam,
    teams: ["Cincinnati Reds"],
  };

  function renderThenStream(
    first: PairingCard,
    second: PairingCard,
    opts: { keep?: boolean } = {},
  ) {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const props = (card: PairingCard) => ({
      autoMatched: opts.keep ? [] : [{ card, confidence: 1 }],
      unmatchedBsc: opts.keep ? [card] : [],
      unmatchedSl: [],
    });
    const { rerender } = render(
      <CardPairingModal
        isOpen
        onClose={vi.fn()}
        onConfirm={onConfirm}
        initialData={props(first)}
      />,
    );
    return {
      onConfirm,
      stream: () =>
        rerender(
          <CardPairingModal
            isOpen
            onClose={vi.fn()}
            onConfirm={onConfirm}
            initialData={props(second)}
          />,
        ),
    };
  }

  test("a team resolved mid-session reaches onConfirm", async () => {
    const { onConfirm, stream } = renderThenStream(withoutTeam, withTeam);

    stream();
    fireEvent.click(screen.getByLabelText("Confirm card matches"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].cards[0].teams).toEqual([
      "Cincinnati Reds",
    ]);
  });

  test("it reaches a card the operator has already moved to the keep shelf", async () => {
    // The shelf is the case append-only handling missed most obviously: the
    // row is no longer in any column the stream writes to, so a late team had
    // nowhere to land at all.
    const { onConfirm, stream } = renderThenStream(withoutTeam, withTeam, {
      keep: true,
    });

    fireEvent.click(
      screen.getByLabelText("Keep #50 Elly De La Cruz as BSC-only"),
    );
    stream();
    fireEvent.click(screen.getByLabelText("Confirm card matches"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].cards[0].teams).toEqual([
      "Cincinnati Reds",
    ]);
  });

  test("a name the operator chose is NOT overwritten by a later update", async () => {
    // `cardName` is the one field CHOOSE_NAME rewrites. Merging it would undo
    // the operator's decision the next time the stream ticked — which, during
    // a 900-row enrichment, is seconds later.
    const conflicted = autoConflict("227c", "Mike Yastrzemski", "Carl Yastrzemski");
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const data = (card: PairingCard) => ({
      autoMatched: [{ card, confidence: 1 }],
      unmatchedBsc: [],
      unmatchedSl: [],
    });
    const { rerender } = render(
      <CardPairingModal
        isOpen
        onClose={vi.fn()}
        onConfirm={onConfirm}
        initialData={data(conflicted.card)}
      />,
    );

    fireEvent.click(
      screen.getByRole("radio", { name: /^SportLots: Carl Yastrzemski —/ }),
    );
    // The stream ticks again — same row, still carrying BSC's name, now with
    // its team resolved.
    rerender(
      <CardPairingModal
        isOpen
        onClose={vi.fn()}
        onConfirm={onConfirm}
        initialData={data({
          ...conflicted.card,
          teams: ["Boston Red Sox"],
        })}
      />,
    );
    fireEvent.click(screen.getByLabelText("Confirm card matches"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const saved = onConfirm.mock.calls[0][0].cards[0];
    expect(saved.cardName).toBe("Carl Yastrzemski");
    expect(saved.teams).toEqual(["Boston Red Sox"]);
  });
});

/**
 * NEO-189 follow-up — the operator retypes a matched card's name.
 *
 * The gap this closes: the name-conflict control lets the operator pick
 * BETWEEN the two marketplaces, and it is very often the case that neither of
 * them is right. Both sources are transcriptions of a printed card; the
 * operator is the only party in the loop actually holding it. Before this, a
 * name known to be wrong had to be committed and then fixed in
 * CardDetailPanel — which means a wrong name existed as a real NB card, and
 * anything that read it in between (a listing, an entity resolution) read the
 * wrong one.
 *
 * No backend change is involved and that is the point: this rewrites
 * `card.cardName`, exactly the field CHOOSE_NAME already rewrote, and that
 * field already travels through `onConfirm` into `commitCardChecklist`. So
 * every assertion about what is SAVED is an assertion on the `onConfirm`
 * payload, as everywhere else in this file.
 */
describe("CardPairingModal — editing a matched card's name", () => {
  /** Open the editor on a matched row, by the title button's accessible name. */
  const openEditor = (rowLabel: string) =>
    fireEvent.click(screen.getByLabelText(`Edit name for ${rowLabel}`));

  const editorFor = (cardNumber: string) =>
    screen.getByLabelText(`Edit name for #${cardNumber}`) as HTMLInputElement;

  /** Type into the open editor without committing. */
  const typeInto = (input: HTMLInputElement, value: string) =>
    fireEvent.change(input, { target: { value } });

  test("the title is a control that says what activating it does", () => {
    renderModal({
      autoMatched: [{ card: pairedCard("461", "Noah Cameron"), confidence: 1 }],
    });

    const title = screen.getByRole("button", {
      name: "Edit name for #461 Noah Cameron",
    });
    // WCAG 2.5.3 Label in Name — the accessible name contains the visible
    // text verbatim, so a speech-input operator saying what they can see
    // matches. The hover affordance is CSS only, deliberately: a glyph inside
    // the button would land in its textContent and stop the visible label
    // being the row label.
    expect(title.textContent).toBe("#461 Noah Cameron");
  });

  test("Enter commits, and the new name is what reaches onConfirm", async () => {
    const { onConfirm } = renderModal({
      autoMatched: [{ card: pairedCard("461", "Noah Cameron"), confidence: 1 }],
    });

    openEditor("#461 Noah Cameron");
    typeInto(editorFor("461"), "Noah Cameron Jr.");
    fireEvent.keyDown(editorFor("461"), { key: "Enter" });

    // The row itself now reads what will be saved.
    expect(screen.getByLabelText("Unlink #461 Noah Cameron Jr.")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Confirm card matches"));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].cards[0].cardName).toBe(
      "Noah Cameron Jr.",
    );
    // The number is not the operator's to edit and was never in the field.
    expect(onConfirm.mock.calls[0][0].cards[0].cardNumber).toBe("461");
  });

  test("blur commits too — clicking away is not a way to lose the edit", async () => {
    const { onConfirm } = renderModal({
      autoMatched: [{ card: pairedCard("461", "Noah Cameron"), confidence: 1 }],
    });

    openEditor("#461 Noah Cameron");
    typeInto(editorFor("461"), "Nolan Cameron");
    fireEvent.blur(editorFor("461"));

    fireEvent.click(screen.getByLabelText("Confirm card matches"));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].cards[0].cardName).toBe("Nolan Cameron");
  });

  /**
   * The dialog root's own onKeyDown closes the WHOLE modal on Escape. Without
   * stopPropagation on the field, abandoning a rename would throw away every
   * pairing decision on the screen — a far worse outcome than the edit the
   * operator meant to abandon.
   */
  test("Escape cancels the edit and does NOT close the modal", () => {
    const onClose = vi.fn();
    render(
      <CardPairingModal
        isOpen
        onClose={onClose}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
        initialData={{
          autoMatched: [
            { card: pairedCard("461", "Noah Cameron"), confidence: 1 },
          ],
          unmatchedBsc: [],
          unmatchedSl: [],
        }}
      />,
    );

    openEditor("#461 Noah Cameron");
    typeInto(editorFor("461"), "Something Else");
    fireEvent.keyDown(editorFor("461"), { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/Match Cards/)).toBeTruthy();
    // The name is untouched and the editor is closed.
    expect(screen.getByLabelText("Unlink #461 Noah Cameron")).toBeTruthy();
    expect(screen.queryByLabelText("Edit name for #461")).toBeNull();
  });

  /**
   * The commit-on-blur path must not be able to resurrect an edit that Escape
   * (or Enter) has already settled.
   *
   * Browsers dispatch `blur`/`focusout` when the focused element is REMOVED
   * from the DOM, and closing the editor removes it — so in a real browser
   * Escape produces keydown → (unmount) → blur, and a blur handler that
   * commits unconditionally would save the draft the operator just abandoned.
   * The keystroke and the commit-on-blur are individually correct; it is the
   * pair that is wrong, which is why neither of their own tests can catch it.
   *
   * jsdom does not model that removal-blur at all, so the sequence is driven
   * explicitly. Both events are dispatched inside ONE `act()` so React has not
   * yet flushed the unmount when the blur lands — that ordering is the point,
   * and a `fireEvent.blur` on the already-detached node would be vacuous
   * (React's delegated listener is on the container, so a detached node
   * reaches no handler and the test would pass against the bug).
   */
  test("a blur delivered after Escape does not commit the abandoned draft", async () => {
    const { onConfirm } = renderModal({
      autoMatched: [{ card: pairedCard("461", "Noah Cameron"), confidence: 1 }],
    });

    openEditor("#461 Noah Cameron");
    const field = editorFor("461");
    // Deliberately DIFFERENT from the current name: RENAME no-ops on an
    // unchanged name, so an unchanged draft would pass whether or not the
    // guard exists.
    typeInto(field, "Wrong Name");

    act(() => {
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      // React's onBlur is delegated from the native `focusout`, which bubbles.
      field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    expect(screen.getByLabelText("Unlink #461 Noah Cameron")).toBeTruthy();
    expect(screen.queryByLabelText("Unlink #461 Wrong Name")).toBeNull();

    fireEvent.click(screen.getByLabelText("Confirm card matches"));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].cards[0].cardName).toBe("Noah Cameron");
  });

  test("the field is prefilled with the NAME only — not the number, not the variation", () => {
    renderModal({
      autoMatched: [
        {
          card: {
            ...pairedCard("1b", "Fernando Tatis Jr."),
            cardVariation: "Sliding",
            isVariation: true,
          },
          confidence: 1,
        },
      ],
    });

    openEditor("#1b Fernando Tatis Jr. · Sliding");
    expect(editorFor("1b").value).toBe("Fernando Tatis Jr.");
    // Both are still on screen as context — they are separate fields on the
    // card, and losing sight of the number is losing sight of which row you
    // are in.
    expect(screen.getByText("#1b")).toBeTruthy();
    expect(screen.getByText("· Sliding")).toBeTruthy();
  });

  test("an empty or whitespace-only name is a cancel, not a rename to nothing", async () => {
    const { onConfirm } = renderModal({
      autoMatched: [{ card: pairedCard("461", "Noah Cameron"), confidence: 1 }],
    });

    openEditor("#461 Noah Cameron");
    typeInto(editorFor("461"), "   ");
    fireEvent.keyDown(editorFor("461"), { key: "Enter" });

    expect(screen.getByLabelText("Unlink #461 Noah Cameron")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Confirm card matches"));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].cards[0].cardName).toBe("Noah Cameron");
  });

  test("committing the name it already had changes nothing", async () => {
    const { onConfirm } = renderModal({
      autoMatched: [{ card: pairedCard("461", "Noah Cameron"), confidence: 1 }],
    });

    openEditor("#461 Noah Cameron");
    // Straight blur, nothing typed — the ordinary "opened it by mistake" path.
    fireEvent.blur(editorFor("461"));

    expect(screen.getByLabelText("Unlink #461 Noah Cameron")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Confirm card matches"));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].cards[0].cardName).toBe("Noah Cameron");
  });

  test("the surrounding name is trimmed", async () => {
    const { onConfirm } = renderModal({
      autoMatched: [{ card: pairedCard("461", "Noah Cameron"), confidence: 1 }],
    });

    openEditor("#461 Noah Cameron");
    typeInto(editorFor("461"), "  Noah Cameron Sr.  ");
    fireEvent.keyDown(editorFor("461"), { key: "Enter" });

    fireEvent.click(screen.getByLabelText("Confirm card matches"));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].cards[0].cardName).toBe(
      "Noah Cameron Sr.",
    );
  });

  /**
   * a11y — the title button is the element the operator activated, and it does
   * not exist while the editor is open. Left alone, closing the editor drops
   * focus to <body>, which for a keyboard operator part-way down a 220-row
   * list loses their place entirely. Same defect and same fix as
   * `refocusSelectedRadio`.
   */
  test("focus returns to the title after a commit", async () => {
    renderModal({
      autoMatched: [{ card: pairedCard("461", "Noah Cameron"), confidence: 1 }],
    });

    openEditor("#461 Noah Cameron");
    typeInto(editorFor("461"), "Noah C.");
    fireEvent.keyDown(editorFor("461"), { key: "Enter" });

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText("Edit name for #461 Noah C."),
      ),
    );
  });

  test("focus returns to the title after a cancel", async () => {
    renderModal({
      autoMatched: [{ card: pairedCard("461", "Noah Cameron"), confidence: 1 }],
    });

    openEditor("#461 Noah Cameron");
    fireEvent.keyDown(editorFor("461"), { key: "Escape" });

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText("Edit name for #461 Noah Cameron"),
      ),
    );
  });

  /**
   * The editor's identity is `candidateKey` — the marketplace ref — NOT the
   * array index, for the same reason `KEEP` and `refocusSelectedRadio` avoid
   * indexes: `ordered()` re-sorts `state.matched` after every dispatch and
   * `ABSORB` inserts into it while the operator works, so a held index comes
   * to mean a different row. An open field that silently retargets is the same
   * class of defect as number-keyed KEEP moving the wrong card to the shelf,
   * and worse in effect: the operator is looking straight at it.
   */
  test("a row streaming in above the one being edited does not steal the editor", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const dataWith = (
      pairs: Array<{ card: PairingCard; confidence: number }>,
    ) => ({ autoMatched: pairs, unmatchedBsc: [], unmatchedSl: [] });
    const ripken = { card: pairedCard("10", "Cal Ripken Jr."), confidence: 1 };
    const griffey = { card: pairedCard("2", "Ken Griffey Jr."), confidence: 1 };

    const { rerender } = render(
      <CardPairingModal
        isOpen
        onClose={vi.fn()}
        onConfirm={onConfirm}
        initialData={dataWith([ripken])}
      />,
    );

    openEditor("#10 Cal Ripken Jr.");
    // #2 sorts ahead of #10, so absorbing it moves Ripken from index 0 to 1.
    rerender(
      <CardPairingModal
        isOpen
        onClose={vi.fn()}
        onConfirm={onConfirm}
        initialData={dataWith([ripken, griffey])}
      />,
    );

    // Still Ripken's field, and still Ripken who gets renamed.
    const field = editorFor("10");
    typeInto(field, "Cal Ripken");
    fireEvent.keyDown(field, { key: "Enter" });

    fireEvent.click(screen.getByLabelText("Confirm card matches"));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const byNumber = Object.fromEntries(
      onConfirm.mock.calls[0][0].cards.map((c: PairingCard) => [
        c.cardNumber,
        c.cardName,
      ]),
    );
    expect(byNumber).toEqual({ "10": "Cal Ripken", "2": "Ken Griffey Jr." });
  });

  test("only matched rows are editable — the unmatched columns are untouched", () => {
    renderModal({
      unmatchedBsc: [bscCard("5", "Roberto Osuna")],
      unmatchedSl: [slCard("6", "Someone Else")],
    });

    expect(screen.queryByLabelText(/^Edit name for /)).toBeNull();
  });
});

/**
 * NEO-189 follow-up — a rename on a row the marketplaces already disagree
 * about.
 *
 * The two features have to compose, not sit next to each other. A rename that
 * merely overwrote `card.cardName` would leave a radiogroup underneath still
 * claiming BSC's name was the one winning, while the row displayed a third
 * name that appeared in neither option — the control would be lying about the
 * card it governs.
 *
 * So the typed name joins the group as a third option. Which keeps the
 * property the group was built for in the first place: exactly one of the
 * names on offer is checked, and it is the one that will be saved.
 */
describe("CardPairingModal — renaming a row that already has a name conflict", () => {
  const conflicted = () =>
    autoConflict("227c", "Mike Yastrzemski", "Carl Yastrzemski");

  const openEditor = (rowLabel: string) =>
    fireEvent.click(screen.getByLabelText(`Edit name for ${rowLabel}`));
  const editor = () =>
    screen.getByLabelText("Edit name for #227c") as HTMLInputElement;

  const rename = (from: string, to: string) => {
    openEditor(from);
    fireEvent.change(editor(), { target: { value: to } });
    fireEvent.keyDown(editor(), { key: "Enter" });
  };

  const radios = () => screen.getAllByRole("radio");
  const checkedNames = () =>
    radios()
      .filter((r) => r.getAttribute("aria-checked") === "true")
      .map((r) => r.getAttribute("aria-label"));

  test("a name matching NEITHER marketplace becomes a third, checked option", () => {
    renderModal({ autoMatched: [conflicted()] });

    rename("#227c Mike Yastrzemski", "Carl Yastrzemski (Legend SP)");

    const custom = screen.getByRole("radio", {
      name: "Custom: Carl Yastrzemski (Legend SP) — use this name for #227c",
    });
    expect(custom.getAttribute("aria-checked")).toBe("true");
    // Visible label plus the non-colour ✓ cue the other two pills carry.
    expect(custom.textContent).toBe("✓ Custom: Carl Yastrzemski (Legend SP)");
    // Both marketplace names are still one click away — the choice stays as
    // reversible as the original two-way one.
    expect(screen.getByRole("radio", { name: /^BSC:/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^SportLots:/ })).toBeTruthy();
  });

  test("the radiogroup still exposes exactly one checked option, with three of them", () => {
    renderModal({ autoMatched: [conflicted()] });

    rename("#227c Mike Yastrzemski", "Carl Yastrzemski (Legend SP)");

    expect(radios()).toHaveLength(3);
    expect(checkedNames()).toEqual([
      "Custom: Carl Yastrzemski (Legend SP) — use this name for #227c",
    ]);

    // …and it stays exactly one as the operator moves between them.
    fireEvent.click(screen.getByRole("radio", { name: /^BSC:/ }));
    expect(checkedNames()).toEqual([
      "BSC: Mike Yastrzemski — use this name for #227c",
    ]);
    expect(radios()).toHaveLength(3);
  });

  test("the operator's name is what gets committed", async () => {
    const { onConfirm } = renderModal({ autoMatched: [conflicted()] });

    rename("#227c Mike Yastrzemski", "Carl Yastrzemski (Legend SP)");
    fireEvent.click(screen.getByLabelText("Confirm card matches"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].cards[0].cardName).toBe(
      "Carl Yastrzemski (Legend SP)",
    );
  });

  /**
   * Typing a marketplace's name verbatim IS clicking its pill — anything else
   * would render "Custom: Mike Yastrzemski" checked beside an unchecked,
   * identical "BSC: Mike Yastrzemski", i.e. a control asking the operator to
   * choose between two spellings of the same decision.
   */
  test("typing BSC's name exactly is the same as choosing BSC — no third option appears", () => {
    renderModal({ autoMatched: [conflicted()] });

    // Move off BSC first, so landing back on it is a real transition.
    fireEvent.click(screen.getByRole("radio", { name: /^SportLots:/ }));
    rename("#227c Carl Yastrzemski", "Mike Yastrzemski");

    expect(radios()).toHaveLength(2);
    expect(checkedNames()).toEqual([
      "BSC: Mike Yastrzemski — use this name for #227c",
    ]);
  });

  test("typing SportLots' name exactly is the same as choosing SportLots", () => {
    renderModal({ autoMatched: [conflicted()] });

    rename("#227c Mike Yastrzemski", "Carl Yastrzemski");

    expect(radios()).toHaveLength(2);
    expect(checkedNames()).toEqual([
      "SportLots: Carl Yastrzemski — use this name for #227c",
    ]);
  });

  /**
   * `conflictingNames` folds accents and punctuation so that spelling
   * differences are not reported as disagreements. That folding must NOT be
   * reused here: an operator typing "José Ramírez" over BSC's "Jose Ramirez"
   * is making a correction, and treating it as "you picked BSC" would discard
   * it silently — the one failure mode this whole control exists to prevent.
   */
  test("a name that differs from BSC's only in accents is a real correction, not a pick", () => {
    renderModal({
      autoMatched: [autoConflict("30", "Jose Ramirez", "J. Ramirez|Andres Gimenez")],
    });

    fireEvent.click(screen.getByLabelText("Edit name for #30 Jose Ramirez"));
    const field = screen.getByLabelText("Edit name for #30");
    fireEvent.change(field, { target: { value: "José Ramírez" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(
      screen
        .getByRole("radio", { name: /^Custom:/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByLabelText("Unlink #30 José Ramírez")).toBeTruthy();
  });

  test("choosing a marketplace name afterwards keeps the typed one on offer", () => {
    renderModal({ autoMatched: [conflicted()] });

    rename("#227c Mike Yastrzemski", "Carl Yastrzemski (Legend SP)");
    fireEvent.click(screen.getByRole("radio", { name: /^SportLots:/ }));

    expect(screen.getByLabelText("Unlink #227c Carl Yastrzemski")).toBeTruthy();
    const custom = screen.getByRole("radio", { name: /^Custom:/ });
    expect(custom.getAttribute("aria-checked")).toBe("false");

    // And it is still selectable, which is what makes the rename reversible.
    fireEvent.click(custom);
    expect(
      screen.getByLabelText("Unlink #227c Carl Yastrzemski (Legend SP)"),
    ).toBeTruthy();
  });

  test("re-typing replaces the custom option rather than adding a fourth", () => {
    renderModal({ autoMatched: [conflicted()] });

    rename("#227c Mike Yastrzemski", "Carl Y.");
    rename("#227c Carl Y.", "Carl Yastrzemski (Legend SP)");

    expect(radios()).toHaveLength(3);
    expect(checkedNames()).toEqual([
      "Custom: Carl Yastrzemski (Legend SP) — use this name for #227c",
    ]);
  });

  /**
   * Unlink splits the pair back into its two halves, each with its OWN
   * marketplace name. A typed name belongs to the MERGED card and to neither
   * half, so stamping it onto both would destroy the disagreement the operator
   * was in the middle of correcting — and a re-link could never detect it
   * again, because both rows would now agree.
   */
  test("unlinking a renamed row still gives each side its own marketplace name back", () => {
    renderModal({ autoMatched: [conflicted()] });

    rename("#227c Mike Yastrzemski", "Carl Yastrzemski (Legend SP)");
    fireEvent.click(
      screen.getByLabelText("Unlink #227c Carl Yastrzemski (Legend SP)"),
    );

    expect(
      screen.getByLabelText("Select BSC card #227c Mike Yastrzemski"),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(
        "Link selected BSC card to #227c Carl Yastrzemski",
      ),
    ).toBeTruthy();
  });

  /**
   * `nameConflictCount` counts rows the MARKETPLACES disagree about. A rename
   * does not settle that disagreement — it replaces the answer, and the row is
   * still one where two sources said different things. Deliberately unchanged.
   */
  test("the header conflict count is unaffected by a rename", () => {
    renderModal({ autoMatched: [conflicted()] });

    expect(screen.getByText(/1 name conflict/)).toBeTruthy();
    rename("#227c Mike Yastrzemski", "Carl Yastrzemski (Legend SP)");
    expect(screen.getByText(/1 name conflict/)).toBeTruthy();
  });

  describe("a11y — three options in the radiogroup", () => {
    test("arrow keys cycle through all three and wrap, moving focus with selection", async () => {
      renderModal({ autoMatched: [conflicted()] });
      rename("#227c Mike Yastrzemski", "Carl Yastrzemski (Legend SP)");

      const bsc = () => screen.getByRole("radio", { name: /^BSC:/ });
      const sl = () => screen.getByRole("radio", { name: /^SportLots:/ });
      const custom = () => screen.getByRole("radio", { name: /^Custom:/ });

      // Starting on the custom option, which the rename checked.
      fireEvent.keyDown(custom(), { key: "ArrowRight" });
      expect(checkedNames()).toEqual([bsc().getAttribute("aria-label")]);
      await waitFor(() => expect(document.activeElement).toBe(bsc()));

      fireEvent.keyDown(bsc(), { key: "ArrowRight" });
      expect(checkedNames()).toEqual([sl().getAttribute("aria-label")]);
      await waitFor(() => expect(document.activeElement).toBe(sl()));

      fireEvent.keyDown(sl(), { key: "ArrowRight" });
      expect(checkedNames()).toEqual([custom().getAttribute("aria-label")]);
      await waitFor(() => expect(document.activeElement).toBe(custom()));
    });

    test("arrow keys go backwards too, so the third option is not a one-way trip", async () => {
      renderModal({ autoMatched: [conflicted()] });
      rename("#227c Mike Yastrzemski", "Carl Yastrzemski (Legend SP)");

      const sl = () => screen.getByRole("radio", { name: /^SportLots:/ });
      const custom = () => screen.getByRole("radio", { name: /^Custom:/ });

      fireEvent.keyDown(custom(), { key: "ArrowLeft" });
      expect(checkedNames()).toEqual([sl().getAttribute("aria-label")]);
      await waitFor(() => expect(document.activeElement).toBe(sl()));
    });

    test("roving tabindex still puts exactly one Tab stop in the group", () => {
      renderModal({ autoMatched: [conflicted()] });
      rename("#227c Mike Yastrzemski", "Carl Yastrzemski (Legend SP)");

      expect(radios().map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
    });

    test("the custom option carries the same non-colour ✓ cue (WCAG 1.4.1)", () => {
      renderModal({ autoMatched: [conflicted()] });
      rename("#227c Mike Yastrzemski", "Carl Yastrzemski (Legend SP)");

      const custom = screen.getByRole("radio", { name: /^Custom:/ });
      expect(custom.textContent?.startsWith("✓")).toBe(true);
      fireEvent.click(screen.getByRole("radio", { name: /^BSC:/ }));
      expect(custom.textContent?.startsWith("✓")).toBe(false);
      // …and its accessible name still STARTS with its visible label
      // (WCAG 2.5.3), unchecked, exactly like the other two.
      expect(custom.getAttribute("aria-label")).toMatch(
        /^Custom: Carl Yastrzemski \(Legend SP\) —/,
      );
    });

    /**
     * The editor and the radiogroup are both on the row at once and both are
     * about the same question, so they must not share an accessible name — a
     * screen-reader user would meet "Name for #227c" twice on one row, which
     * is the ambiguity `conflictScopeLabels` exists to remove. It would also
     * make the Maestro selector `id: "Name for #FS-1"` — already used against
     * the radiogroup in checklist-pairing-dialog-cancel.yaml — match two
     * elements.
     */
    test("the editor and the radiogroup do not share an accessible name", () => {
      renderModal({ autoMatched: [conflicted()] });
      fireEvent.click(screen.getByLabelText("Edit name for #227c Mike Yastrzemski"));

      expect(screen.getByLabelText("Name for #227c").getAttribute("role")).toBe(
        "radiogroup",
      );
      expect(screen.getByLabelText("Edit name for #227c").tagName).toBe(
        "INPUT",
      );
    });
  });

  /**
   * Layout, requested after operator testing: the warning sentence and the
   * pills were `flex flex-wrap`, so they sat side by side when the two names
   * happened to be short and dropped below when they were not — the same
   * control laid out two different ways on adjacent rows, purely as a function
   * of name length. Pinned as a class assertion because there is no other way
   * to observe layout in jsdom; the pills' own wrapping is what keeps two long
   * names from overflowing and must survive.
   */
  test("the warning sits on its own line above the pills, always", () => {
    renderModal({ autoMatched: [conflicted()] });

    const group = screen.getByRole("group", {
      name: "Name conflict on #227c",
    });
    expect(group.className).toContain("flex-col");
    expect(group.className).not.toContain("flex-wrap");
    expect(
      screen.getByRole("radiogroup", { name: "Name for #227c" }).className,
    ).toContain("flex-wrap");
  });
});

/**
 * NEO-189 operator feedback — the unmatched columns are drag-and-drop, and say
 * so.
 *
 * Two halves, and only one of them is testable here:
 *
 *  1. THE GESTURE. Simulating a dnd-kit pointer drag in jsdom is not worth
 *     trusting: every element measures 0×0 at (0,0), so `pointerWithin` is
 *     deciding collisions between degenerate rects and a passing test would be
 *     evidence about jsdom's layout engine, not about the feature. It is not
 *     covered by Maestro either — Maestro's web driver drags flakily, and
 *     converting the existing flow would have traded a reliable end-to-end
 *     assertion about LINKING for an unreliable one about dragging.
 *
 *  2. WHAT THE GESTURE COSTS. That is what these tests pin. Adding drag
 *     listeners to a row is only safe if the row's existing controls are
 *     untouched — the click path is the keyboard/assistive-tech path and the
 *     one the Maestro flow drives — and if the wrapper does not quietly join
 *     the dialog's focus trap or hide its own children from AT.
 *
 * The linking behaviour the drag path performs is not re-asserted here because
 * it is not a second implementation: both paths call one `performLink`, so
 * every existing test that links by clicking (the merge, the name-conflict
 * auto-expand, the refocus) is already a test of the code the drop runs.
 */
describe("CardPairingModal — drag-and-drop linking (NEO-189 follow-up)", () => {
  const rowFor = (labelText: string) =>
    screen.getByLabelText(labelText).closest("li") as HTMLLIElement;

  test("the hint names BOTH gestures, above the columns", () => {
    renderModal({
      unmatchedBsc: [bscCard("1", "Griffey")],
      unmatchedSl: [slCard("A1", "Griffey")],
    });

    const hint = screen.getByText(/Drag a card onto its match/);
    expect(hint.textContent).toContain("click one, then click its match");
    // Above the lists, not below them: on any set with real unmatched counts
    // the columns are taller than the dialog's inner scroller, and Maestro
    // cannot drive that overflow — nor can an operator find an instruction
    // they have to scroll past the problem to reach.
    expect(
      hint.compareDocumentPosition(screen.getByLabelText("Filter BSC cards")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  /**
   * A single lonely unmatched card is exactly when an operator is most likely
   * to be stuck, so the hint is keyed on "the columns are showing", not on
   * "a link is currently possible".
   */
  test("the hint shows with only one column populated, either side", () => {
    const { unmount } = render(
      <CardPairingModal
        isOpen
        onClose={vi.fn()}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
        initialData={{
          autoMatched: [],
          unmatchedBsc: [bscCard("5", "BSC Only")],
          unmatchedSl: [],
        }}
      />,
    );
    expect(screen.getByText(/Drag a card onto its match/)).toBeTruthy();
    unmount();

    renderModal({ unmatchedSl: [slCard("77", "SL Only")] });
    expect(screen.getByText(/Drag a card onto its match/)).toBeTruthy();
  });

  test("the hint is absent when there is nothing left to reconcile", () => {
    renderModal({
      autoMatched: [{ card: pairedCard("1", "Griffey"), confidence: 1 }],
    });
    expect(screen.queryByText(/Drag a card onto its match/)).toBeNull();
  });

  /**
   * dnd-kit's `useDraggable` hands back `attributes` carrying `role="button"`
   * and `tabIndex=0`. Spreading them onto this row would do two things this
   * change must not do, so they are deliberately left off — pinned here
   * because a later "just spread the attributes like the other modals do"
   * would look like a tidy-up and silently break both.
   */
  test("the drag wrapper does not become a widget, and does not join the focus trap", () => {
    renderModal({
      unmatchedBsc: [bscCard("1", "Griffey")],
      unmatchedSl: [slCard("A1", "Griffey")],
    });

    for (const row of [
      rowFor("Select BSC card #1 Griffey"),
      rowFor("Link selected BSC card to #A1 Griffey"),
    ]) {
      // role="button" on the wrapper would make its own <button> children
      // presentational to assistive tech — taking select / link / keep off the
      // AT path, which is the path this feature is an addition to.
      expect(row.getAttribute("role")).toBeNull();
      // tabIndex=0 would add one dead tab stop per row to the dialog's Tab
      // handler, which queries `[tabindex]:not([tabindex="-1"])`. A 900-row
      // set would grow 900 stops that do nothing when activated.
      expect(row.getAttribute("tabindex")).toBeNull();
    }
  });

  /**
   * The 5px activation constraint is what makes this true: a stationary press
   * never starts a drag, so the row's listeners cannot swallow the button's
   * click. Without it the Maestro flow's `tapOn "Select BSC card …"` stops
   * working the moment the listeners go on.
   */
  test("click-to-select still works with drag listeners attached", () => {
    renderModal({
      unmatchedBsc: [bscCard("1", "Griffey")],
      unmatchedSl: [slCard("A1", "Griffey")],
    });

    fireEvent.click(screen.getByLabelText("Select BSC card #1 Griffey"));

    expect(
      screen.getByLabelText("#1 Griffey, selected. Press to deselect."),
    ).toBeTruthy();
    expect(
      (
        screen.getByLabelText(
          "Link selected BSC card to #A1 Griffey",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});

/**
 * NEO-189 operator feedback — the Matched toggle sticks to the top of the
 * dialog's scroll body, so the collapse control is reachable from anywhere in
 * a 220-row list.
 *
 * WHAT IS TESTABLE HERE, AND WHY IT IS ONLY THIS. `position: sticky` is a pure
 * layout behaviour and jsdom implements no layout at all: every box is 0×0,
 * nothing scrolls, and `getComputedStyle` returns the declared value whether
 * or not the element could ever stick. So a test that "scrolled" and asserted
 * the bar stayed put would pass on markup that is broken in a real browser —
 * worse than no test.
 *
 * What CAN be pinned is the set of conditions sticky needs, all of which are
 * structural:
 *   - the declaration is present, on a full-width opaque container rather than
 *     on the button (which is only as wide as its text);
 *   - it is inside the <section> that owns the matched list, which is what
 *     makes the bar un-stick at the list's end instead of hovering over the
 *     unmatched columns;
 *   - nothing between that container and the scroll container introduces its
 *     own overflow, transform, filter or containment — any one of those
 *     silently retargets the containing block and kills sticky. This is the
 *     failure mode a future wrapper div would introduce, and it is invisible
 *     in review;
 *   - the scroller carries scroll-padding-top, which is what stops the
 *     focus-driven auto-scroll after a link from parking the merged row
 *     underneath the bar.
 */
describe("CardPairingModal — the Matched header sticks (NEO-189 follow-up)", () => {
  const stickyBar = () =>
    screen.getByLabelText(/^(Collapse|Expand) matched cards/)
      .parentElement as HTMLElement;

  test("the toggle sits in a sticky, opaque, full-width bar", () => {
    renderModal({
      autoMatched: [{ card: pairedCard("1", "Griffey"), confidence: 1 }],
    });

    const bar = stickyBar();
    expect(bar.className).toContain("sticky");
    expect(bar.className).toContain("top-0");
    // Opaque, and the same colour as the dialog body — rows must disappear
    // under it, not show through it.
    expect(bar.className).toContain("bg-gray-900");
    // Above the static matched rows and the draggable unmatched ones; dnd-kit's
    // DragOverlay is fixed at z-999 and still passes over the top.
    expect(bar.className).toContain("z-20");
    // Full-bleed across the scroll container's padding, so no row edge is
    // visible beside the bar.
    expect(bar.className).toContain("-mx-4");
  });

  /**
   * The bar leaked once already: with `pt-4` on the SCROLLER, the stuck bar sat
   * 16px below the scrollport's top edge and rows slid up through the gap and
   * were visible above it. The fix is that the bar owns that padding instead,
   * so there is no band between the scrollport top and the bar for anything to
   * show through — which means the two halves have to stay in sync, and a
   * later "tidy `px-4 pb-4` back into `p-4`" silently reopens the gap.
   *
   * This is the one pairing jsdom CAN speak to. It cannot tell us the bar is
   * flush (no layout), but it can tell us the invariant that makes it flush is
   * still declared in both places.
   */
  test("the scroller has no top padding and the bar owns it instead", () => {
    renderModal({
      autoMatched: [{ card: pairedCard("1", "Griffey"), confidence: 1 }],
    });

    const bar = stickyBar();
    const scroller = bar.closest(".overflow-y-auto") as HTMLElement;

    // `p-4` would reintroduce the 16px see-through band above the stuck bar.
    expect(scroller.className).not.toMatch(/(^|\s)p-4(\s|$)/);
    expect(scroller.className).not.toMatch(/(^|\s)pt-\d/);
    // The same 16px, now inside the bar's opaque box.
    expect(bar.className).toContain("pt-4");
    // And it still reads as a header rows travel under, not a clip edge.
    expect(bar.className).toMatch(/border-b|shadow-/);
  });

  test("the sticky bar's containing block is the section that owns the list", () => {
    renderModal({
      autoMatched: [{ card: pairedCard("1", "Griffey"), confidence: 1 }],
    });

    const section = stickyBar().closest("section") as HTMLElement;
    // Same <section> holds the row list, so the bar un-sticks when the matched
    // list ends rather than following the operator into the columns below.
    expect(section.contains(screen.getByLabelText("Unlink #1 Griffey"))).toBe(
      true,
    );
  });

  test("nothing between the bar and the scroll container can defeat sticky", () => {
    renderModal({
      autoMatched: [{ card: pairedCard("1", "Griffey"), confidence: 1 }],
    });

    const bar = stickyBar();
    const scroller = bar.closest(".overflow-y-auto") as HTMLElement;
    expect(scroller).toBeTruthy();

    // Any overflow, transform, filter or containment on an ancestor below the
    // scroller re-roots the sticky element's containing block and it stops
    // sticking — with no error and no visual clue in review.
    const hostile = /(^|\s)(overflow-|transform|filter|contain-|backdrop-)/;
    for (let el = bar.parentElement; el && el !== scroller; el = el.parentElement) {
      expect(el.className).not.toMatch(hostile);
    }

    // The other scroll cause Jason named: linking a pair focuses the merged
    // row, and the browser scrolls it into view by itself. Without
    // scroll-padding on the scroller it lands under the bar.
    expect(scroller.className).toMatch(/(^|\s)scroll-pt-/);
  });

  test("the toggle keeps its accessible name and its ref-driven focus", () => {
    renderModal({
      autoMatched: [
        { card: pairedCard("1", "Griffey"), confidence: 1 },
        autoConflict("227c", "Mike Yastrzemski", "Carl Yastrzemski"),
      ],
    });

    // The Maestro flow taps this by aria-label, including the conflict suffix.
    const toggle = screen.getByLabelText(
      "Collapse matched cards, 1 with a name conflict",
    );
    expect(toggle.tagName).toBe("BUTTON");
    // Wrapping it changed nothing about focusability or tab order — the
    // wrapper is an unfocusable div.
    expect(stickyBar().getAttribute("tabindex")).toBeNull();
    toggle.focus();
    expect(document.activeElement).toBe(toggle);

    fireEvent.click(toggle);
    expect(
      screen.getByLabelText("Expand matched cards, 1 with a name conflict"),
    ).toBeTruthy();
  });
});

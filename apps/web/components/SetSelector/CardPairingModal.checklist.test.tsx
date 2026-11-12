/**
 * NEO-490 — the publisher's checklist as a source in Match Cards.
 *
 * What is pinned here, and why it matters:
 *
 *  - SOLO MODE (a one-marketplace set whose checklist needs the operator):
 *    every card from the one marketplace is saved, at seed and as it streams
 *    in, and the dialog offers no Keep, Keep all or Remove. A fetched
 *    marketplace card is never discarded on this path.
 *  - A link keeps an unmatched card; taking the card off the save list drops
 *    the link; unlinking a pair keeps the link on the BSC half (and that half
 *    stays saved).
 *  - Cards the server already paired to a row are not listed, but they are
 *    still SAVED. If that path broke, cards would vanish silently.
 *  - Confirm asks the server (through `resolveChecklistPairs`) what the links
 *    mean, merges the answers in place, and keeps `conflictsByIndex` aligned.
 *    A failed answer confirms nothing.
 *
 * The reducer is not exported, so everything goes through the rendered dialog
 * and the `onConfirm` payload, like the rest of the Match Cards tests.
 */

import { describe, expect, test, vi } from "vitest";
import { keyboardDrag, stubLayout } from "../../lib/testing/keyboard-drag";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import CardPairingModal, {
  CHECKLIST_COLUMN_SUBTITLE,
  CHECKLIST_LINKS_FAILED,
  alreadyMatchedText,
  soloChecklistSubtitle,
  type PairingCard,
} from "./CardPairingModal";
import type {
  ChecklistLinkRow,
  ChecklistPairAnswer,
  ChecklistPairRequest,
} from "./checklist-match-apply";
import { checklistRowLine } from "./PublishedChecklistDialog";

type Checklist = {
  rows: ChecklistLinkRow[];
  unusedRowIndices: number[];
  leftoverCardKeys: string[];
  alreadyMatched: number;
  suggestions?: Array<{ cardKey: string; rowIndex: number }>;
};

/** A card from the one marketplace; the key is its BSC ref `bsc-<n>`. */
const bscCard = (n: string, name: string, players?: string[]): PairingCard => ({
  cardNumber: n,
  cardName: name,
  ...(players ? { players } : {}),
  platformData: { bsc: { ref: `bsc-${n}`, setId: "sig-1" } },
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
    bsc: { ref: `bsc-${n}`, setId: "sig-1" },
    sportlots: { ref: `#A${n} ${name}`, setId: "884412" },
  },
});

const row = (
  number: string,
  players: string[],
  teams: string[] = [],
): ChecklistLinkRow => ({ number, players, teams });

/** Every row unused, every given ref a leftover. */
const checklistFor = (
  rows: ChecklistLinkRow[],
  leftoverCardKeys: string[],
  extra: Partial<Checklist> = {},
): Checklist => ({
  rows,
  unusedRowIndices: rows.map((_, i) => i),
  leftoverCardKeys,
  alreadyMatched: 0,
  ...extra,
});

type Data = {
  autoMatched?: Array<{ card: PairingCard; confidence: number }>;
  unmatchedBsc?: PairingCard[];
  unmatchedSl?: PairingCard[];
};

type Props = {
  data: Data;
  soloSide?: "bsc" | "sl";
  checklist?: Checklist;
  resolve?: (pairs: ChecklistPairRequest[]) => Promise<ChecklistPairAnswer[]>;
  isStreaming?: boolean;
  streamSettled?: boolean;
};

function mount(initial: Props) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const ui = (p: Props) => (
    <CardPairingModal
      isOpen
      onClose={onClose}
      onConfirm={onConfirm}
      soloSide={p.soloSide}
      checklist={p.checklist}
      resolveChecklistPairs={p.resolve}
      isStreaming={p.isStreaming}
      streamSettled={p.streamSettled}
      streamProgress={
        p.isStreaming || p.streamSettled === false
          ? { ready: 0, total: 1 }
          : undefined
      }
      initialData={{
        autoMatched: p.data.autoMatched ?? [],
        unmatchedBsc: p.data.unmatchedBsc ?? [],
        unmatchedSl: p.data.unmatchedSl ?? [],
      }}
    />
  );
  const { rerender } = render(ui(initial));
  return {
    onConfirm,
    onClose,
    update: (next: Partial<Props>) => rerender(ui({ ...initial, ...next })),
  };
}

const confirm = () =>
  act(async () => {
    fireEvent.click(screen.getByLabelText("Confirm card matches"));
  });

const confirmedCards = (onConfirm: ReturnType<typeof vi.fn>): PairingCard[] =>
  onConfirm.mock.calls[0][0].cards;

/** Cards with no players, so the name seed never links them. */
const plainCards = () => [
  bscCard("A1", "Card One"),
  bscCard("A2", "Card Two"),
  bscCard("A3", "Card Three"),
];
const plainRows = () => [
  row("1", ["Frank Thomas"], ["Chicago White Sox"]),
  row("2", ["Jacob Wilson"]),
  row("3", ["Matt Shaw"]),
];
const plainKeys = ["bsc-A1", "bsc-A2", "bsc-A3"];

describe("CardPairingModal — solo checklist mode (NEO-490)", () => {
  test("every card is saved at seed, with nothing linked and no Keep controls", async () => {
    const { onConfirm } = mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(plainRows(), plainKeys),
    });

    expect(screen.queryByLabelText(/^Keep /)).toBeNull();
    expect(screen.queryByRole("button", { name: /Keep all/ })).toBeNull();
    expect(screen.queryByLabelText(/^Remove .* from save list/)).toBeNull();
    expect(screen.queryByText(/^Keeping \(/)).toBeNull();

    await confirm();

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(confirmedCards(onConfirm).map((c) => c.cardNumber)).toEqual([
      "A1",
      "A2",
      "A3",
    ]);
  });

  test("a card that streams in after the dialog opened is kept too (ABSORB)", async () => {
    const { onConfirm, update } = mount({
      soloSide: "bsc",
      data: { unmatchedBsc: [bscCard("A1", "Card One")] },
      checklist: checklistFor(plainRows(), ["bsc-A1", "bsc-A2"]),
    });

    update({
      data: { unmatchedBsc: [bscCard("A1", "Card One"), bscCard("A2", "Card Two")] },
    });
    expect(screen.queryByLabelText(/^Keep /)).toBeNull();
    expect(screen.getByText("#A2 Card Two")).toBeTruthy();

    await confirm();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(confirmedCards(onConfirm).map((c) => c.cardNumber)).toEqual([
      "A1",
      "A2",
    ]);
  });

  test("a SportLots-only set keeps its cards the same way, and names no marketplace in the subtitle", async () => {
    const { onConfirm } = mount({
      soloSide: "sl",
      data: { unmatchedSl: [slCard("77", "SL Card")] },
      checklist: checklistFor([row("1", ["Somebody"])], ["#77 SL Card"]),
    });

    expect(screen.getByText(soloChecklistSubtitle())).toBeTruthy();
    expect(screen.getByRole("heading", { name: "SportLots cards (1)" })).toBeTruthy();
    expect(screen.queryByLabelText(/^Keep /)).toBeNull();

    await confirm();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(confirmedCards(onConfirm)).toHaveLength(1);
    expect(confirmedCards(onConfirm)[0].platformData.sportlots).toBeDefined();
  });

  test("the solo subtitle says every card is saved and unlinked rows are not", () => {
    mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(plainRows(), plainKeys),
    });
    expect(
      screen.getByText(
        soloChecklistSubtitle(),
      ),
    ).toBeTruthy();
  });

  test("unlinked rows are dropped: Confirm sends no question and no row anywhere", async () => {
    const resolve = vi.fn().mockResolvedValue([]);
    const { onConfirm } = mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(plainRows(), plainKeys),
      resolve,
    });

    await confirm();

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(resolve).not.toHaveBeenCalled();
    for (const card of confirmedCards(onConfirm)) {
      expect(JSON.stringify(card)).not.toMatch(/Frank Thomas|Jacob Wilson|Matt Shaw/);
    }
    expect(confirmedCards(onConfirm)).toHaveLength(3);
  });

  test("only the linked rows are asked about, with the card's current players and teams", async () => {
    const resolve = vi.fn().mockResolvedValue([]);
    const { onConfirm } = mount({
      soloSide: "bsc",
      data: {
        unmatchedBsc: [
          { ...bscCard("A1", "Card One", ["Frank Thomas"]), teams: ["Cubs"] },
          bscCard("A2", "Card Two"),
        ],
      },
      checklist: checklistFor(
        [row("9", ["Someone Else"], ["Chicago White Sox"]), row("2", ["Jacob Wilson"])],
        ["bsc-A1", "bsc-A2"],
      ),
      resolve,
    });

    fireEvent.click(screen.getByLabelText("Select #9 Someone Else · Chicago White Sox"));
    fireEvent.click(screen.getByLabelText("Link selected checklist row to #A1 Card One"));
    await confirm();

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith([
      {
        cardKey: "bsc-A1",
        card: { cardNumber: "A1", players: ["Frank Thomas"], teams: ["Cubs"] },
        row: { number: "9", players: ["Someone Else"], teams: ["Chicago White Sox"] },
      },
    ]);
    // The card keeps the number it was fetched with: a link never renumbers.
    expect(confirmedCards(onConfirm).map((c) => c.cardNumber)).toEqual(["A1", "A2"]);
  });

  test("cards the server already paired are not listed, yet still reach onConfirm", async () => {
    const { onConfirm } = mount({
      soloSide: "bsc",
      data: {
        unmatchedBsc: [
          bscCard("H1", "Hidden One"),
          bscCard("H2", "Hidden Two"),
          bscCard("A1", "Card One"),
        ],
      },
      // Only A1 is a leftover; H1 and H2 were paired to rows on the server.
      checklist: checklistFor([row("5", ["Left Over"])], ["bsc-A1"], {
        alreadyMatched: 2,
      }),
    });

    expect(screen.getByText(alreadyMatchedText(2))).toBeTruthy();
    expect(screen.getByText("2 cards already matched to your checklist — they're saved too")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "BuySportsCards cards (1)" })).toBeTruthy();
    expect(screen.queryByText("#H1 Hidden One")).toBeNull();
    expect(screen.queryByText("#H2 Hidden Two")).toBeNull();

    await confirm();

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(confirmedCards(onConfirm).map((c) => c.cardNumber).sort()).toEqual([
      "A1",
      "H1",
      "H2",
    ]);
  });

  test("a hidden server-paired card that streams in later is saved too", async () => {
    const { onConfirm, update } = mount({
      soloSide: "bsc",
      data: { unmatchedBsc: [bscCard("A1", "Card One")] },
      checklist: checklistFor([row("5", ["Left Over"])], ["bsc-A1"]),
    });

    update({
      data: {
        unmatchedBsc: [bscCard("A1", "Card One"), bscCard("H9", "Late Hidden")],
      },
    });
    await confirm();

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(confirmedCards(onConfirm).map((c) => c.cardNumber)).toContain("H9");
  });

  test("the one-card summary reads in the singular", () => {
    mount({
      soloSide: "bsc",
      data: { unmatchedBsc: [bscCard("A1", "Card One")] },
      checklist: checklistFor([row("5", ["Left Over"])], ["bsc-A1"], {
        alreadyMatched: 1,
      }),
    });
    expect(screen.getByText("1 card already matched to your checklist — it's saved too")).toBeTruthy();
  });
});

describe("CardPairingModal — checklist names (NEO-490)", () => {
  test("the list, filter, select, link and unlink controls carry the planned names", () => {
    mount({
      soloSide: "bsc",
      data: { unmatchedBsc: [bscCard("A1", "Card One"), bscCard("A2", "Card Two")] },
      checklist: checklistFor(
        [row("1", ["Frank Thomas"], ["Chicago White Sox"]), row("2", ["Jacob Wilson"])],
        ["bsc-A1", "bsc-A2"],
      ),
    });

    const list = screen.getByRole("list", { name: "Leftover checklist rows" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("textbox", { name: "Filter checklist rows" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Your checklist (2 to link)" }),
    ).toBeTruthy();

    const select = screen.getByRole("button", {
      name: "Select #1 Frank Thomas · Chicago White Sox",
    });
    expect(select.getAttribute("aria-pressed")).toBe("false");
    // Without a picked row there is nothing to link yet.
    expect(
      screen.queryByRole("button", { name: /^Link selected checklist row to / }),
    ).toBeNull();

    fireEvent.click(select);
    expect(select.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(
      screen.getByRole("button", { name: "Link selected checklist row to #A2 Card Two" }),
    );

    expect(
      screen.getByRole("button", {
        name: "Unlink checklist row #1 Frank Thomas · Chicago White Sox from #A2 Card Two",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Linked to #A2 Card Two")).toBeTruthy();
    expect(screen.getByText("Checklist #1")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Your checklist (1 to link)" }),
    ).toBeTruthy();
  });

  test("the filter narrows the rows by their line", () => {
    mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(plainRows(), plainKeys),
    });

    fireEvent.change(screen.getByRole("textbox", { name: "Filter checklist rows" }), {
      target: { value: "wilson" },
    });

    const list = screen.getByRole("list", { name: "Leftover checklist rows" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByLabelText("Select #2 Jacob Wilson")).toBeTruthy();
  });

  test("a row the server paired (not in unusedRowIndices) is not listed", () => {
    mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: {
        rows: plainRows(),
        unusedRowIndices: [1],
        leftoverCardKeys: plainKeys,
        alreadyMatched: 0,
      },
    });
    const list = screen.getByRole("list", { name: "Leftover checklist rows" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByLabelText(/Select #1 /)).toBeNull();
  });

  test("a card that is not a leftover offers no Link, even with a row picked", () => {
    mount({
      soloSide: "bsc",
      data: { unmatchedBsc: [bscCard("A1", "Card One"), bscCard("H1", "Hidden")] },
      checklist: checklistFor([row("1", ["Frank Thomas"])], ["bsc-A1"]),
    });
    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas"));
    expect(screen.getAllByRole("button", { name: /^Link selected checklist row to / })).toHaveLength(1);
  });
});

describe("CardPairingModal — linking rows (NEO-490)", () => {
  test("a linked row cannot be linked to a second card, and its card cannot take a second row", () => {
    mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(plainRows(), plainKeys),
    });

    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas · Chicago White Sox"));
    fireEvent.click(screen.getByLabelText("Link selected checklist row to #A1 Card One"));

    // The row is now linked: no Select for it, and nothing else to link it to.
    expect(screen.queryByLabelText(/Select #1 /)).toBeNull();
    expect(screen.queryByLabelText(/^Link selected checklist row to /)).toBeNull();

    // A second row is offered only on the cards without a link.
    fireEvent.click(screen.getByLabelText("Select #2 Jacob Wilson"));
    expect(screen.queryByLabelText("Link selected checklist row to #A1 Card One")).toBeNull();
    expect(screen.getByLabelText("Link selected checklist row to #A2 Card Two")).toBeTruthy();
    expect(screen.getAllByText(/^Checklist #/)).toHaveLength(1);
  });

  test("Unlink returns the row to the list and offers the card a row again", () => {
    mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(plainRows(), plainKeys),
    });
    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas · Chicago White Sox"));
    fireEvent.click(screen.getByLabelText("Link selected checklist row to #A1 Card One"));

    fireEvent.click(screen.getByLabelText("Unlink checklist row #1 Frank Thomas · Chicago White Sox from #A1 Card One"));

    expect(screen.getByLabelText("Select #1 Frank Thomas · Chicago White Sox")).toBeTruthy();
    expect(screen.queryByText(/^Checklist #/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Your checklist (3 to link)" })).toBeTruthy();
  });

  test("linking an unmatched card in a two-marketplace set keeps it, and it is saved", async () => {
    const resolve = vi.fn().mockResolvedValue([]);
    const { onConfirm } = mount({
      data: {
        unmatchedBsc: [bscCard("A1", "Card One")],
        unmatchedSl: [slCard("Z9", "Other Side")],
      },
      checklist: checklistFor([row("1", ["Frank Thomas"])], ["bsc-A1"]),
      resolve,
    });

    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas"));
    fireEvent.click(screen.getByLabelText("Link selected checklist row to #A1 Card One"));

    expect(screen.getByText(/^Keeping \(1\)$/)).toBeTruthy();
    expect(screen.getByLabelText("Remove #A1 Card One from save list")).toBeTruthy();

    await confirm();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    // The linked card is saved; the SportLots card nobody kept is not.
    expect(confirmedCards(onConfirm).map((c) => c.cardNumber)).toEqual(["A1"]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test("an unmatched card nobody linked is still discarded in a two-marketplace set", async () => {
    const { onConfirm } = mount({
      data: { unmatchedBsc: [bscCard("A1", "Card One")] },
      checklist: checklistFor([row("1", ["Frank Thomas"])], ["bsc-A1"]),
    });
    await confirm();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(confirmedCards(onConfirm)).toHaveLength(0);
  });

  test("taking a linked card off the save list drops the link and returns the row", async () => {
    const resolve = vi.fn().mockResolvedValue([]);
    const { onConfirm } = mount({
      data: { unmatchedBsc: [bscCard("A1", "Card One")] },
      checklist: checklistFor([row("1", ["Frank Thomas"])], ["bsc-A1"]),
      resolve,
    });
    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas"));
    fireEvent.click(screen.getByLabelText("Link selected checklist row to #A1 Card One"));

    fireEvent.click(screen.getByLabelText("Remove #A1 Card One from save list"));

    expect(screen.getByLabelText("Select #1 Frank Thomas")).toBeTruthy();
    expect(screen.queryByText(/^Checklist #/)).toBeNull();
    await confirm();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(confirmedCards(onConfirm)).toHaveLength(0);
    expect(resolve).not.toHaveBeenCalled();
  });

  test("unlinking a linked pair keeps the link and the BSC half; the SportLots half goes back to its column", async () => {
    const resolve = vi.fn().mockResolvedValue([]);
    const { onConfirm } = mount({
      data: { autoMatched: [{ card: pairedCard("5", "Pair Card"), confidence: 1 }] },
      checklist: checklistFor([row("1", ["Frank Thomas"])], ["bsc-5"]),
      resolve,
    });
    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas"));
    fireEvent.click(screen.getByLabelText("Link selected checklist row to #5 Pair Card"));
    expect(screen.getByText("Checklist #1")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Unlink #5 Pair Card"));

    // The BSC half is on the keep shelf with its chip, and the row is still linked.
    expect(screen.getByLabelText("Remove #5 Pair Card from save list")).toBeTruthy();
    expect(screen.getByText("Checklist #1")).toBeTruthy();
    expect(
      screen.getByLabelText("Unlink checklist row #1 Frank Thomas from #5 Pair Card"),
    ).toBeTruthy();
    // The SportLots half is waiting in its column, unkept.
    expect(screen.getByLabelText(/^Keep .* as SportLots-only$/)).toBeTruthy();

    await confirm();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const cards = confirmedCards(onConfirm);
    expect(cards).toHaveLength(1);
    expect(cards[0].platformData.bsc?.ref).toBe("bsc-5");
    expect(cards[0].platformData.sportlots).toBeUndefined();
    expect(resolve.mock.calls[0][0].map((p: ChecklistPairRequest) => p.cardKey)).toEqual([
      "bsc-5",
    ]);
  });

  test("unlinking a pair with no checklist link behaves as before: both halves wait, nothing is saved", async () => {
    const { onConfirm } = mount({
      data: { autoMatched: [{ card: pairedCard("5", "Pair Card"), confidence: 1 }] },
      checklist: checklistFor([row("1", ["Frank Thomas"])], ["bsc-5"]),
    });
    fireEvent.click(screen.getByLabelText("Unlink #5 Pair Card"));
    expect(screen.queryByLabelText("Remove #5 Pair Card from save list")).toBeNull();
    await confirm();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(confirmedCards(onConfirm)).toHaveLength(0);
  });

  test("a pair the server paired to no row is linkable through either half's ref", () => {
    // The leftover is named by the SportLots half's ref, not the BSC key.
    mount({
      data: { autoMatched: [{ card: pairedCard("5", "Pair Card"), confidence: 1 }] },
      checklist: checklistFor([row("1", ["Frank Thomas"])], ["#A5 Pair Card"]),
    });
    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas"));
    expect(screen.getByLabelText("Link selected checklist row to #5 Pair Card")).toBeTruthy();
  });

  test("cards the server paired to rows still reach onConfirm beside a hand-linked leftover (two marketplaces)", async () => {
    const resolve = vi.fn().mockResolvedValue([]);
    const { onConfirm } = mount({
      data: {
        autoMatched: [
          { card: pairedCard("1", "Server Paired One"), confidence: 1 },
          { card: pairedCard("2", "Server Paired Two"), confidence: 1 },
        ],
        unmatchedBsc: [bscCard("A1", "Card One")],
      },
      // Neither paired card is a leftover: the server settled both.
      checklist: checklistFor([row("7", ["Frank Thomas"])], ["bsc-A1"], {
        alreadyMatched: 2,
      }),
      resolve,
    });
    fireEvent.click(screen.getByLabelText("Select #7 Frank Thomas"));
    fireEvent.click(screen.getByLabelText("Link selected checklist row to #A1 Card One"));

    await confirm();

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(confirmedCards(onConfirm).map((c) => c.cardNumber).sort()).toEqual([
      "1",
      "2",
      "A1",
    ]);
    // Only the hand link is a question.
    expect(resolve.mock.calls[0][0]).toHaveLength(1);
  });

  test("the column subtitle shows only with a checklist", () => {
    const { update } = mount({
      data: { unmatchedBsc: [bscCard("A1", "Card One")] },
    });
    expect(screen.queryByText(CHECKLIST_COLUMN_SUBTITLE)).toBeNull();
    expect(screen.queryByRole("list", { name: "Leftover checklist rows" })).toBeNull();

    update({ checklist: checklistFor([row("1", ["Frank Thomas"])], ["bsc-A1"]) });
    expect(screen.getByText(CHECKLIST_COLUMN_SUBTITLE)).toBeTruthy();
  });
});

describe("CardPairingModal — the checklist arrives late (NEO-490)", () => {
  test("a checklist passed after the dialog opened joins it, and the first one wins", () => {
    const first = checklistFor([row("1", ["Frank Thomas"])], ["bsc-A1"]);
    const second = checklistFor([row("2", ["Jacob Wilson"])], ["bsc-A1"]);
    const { update } = mount({
      data: { unmatchedBsc: [bscCard("A1", "Card One")] },
    });
    expect(screen.queryByRole("list", { name: "Leftover checklist rows" })).toBeNull();

    update({ checklist: first });
    expect(screen.getByLabelText("Select #1 Frank Thomas")).toBeTruthy();

    // A later, different prop does not replace the checklist or reset links.
    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas"));
    fireEvent.click(screen.getByLabelText("Link selected checklist row to #A1 Card One"));
    update({ checklist: second });
    expect(screen.queryByLabelText(/Select #2 /)).toBeNull();
    expect(screen.getByLabelText("Unlink checklist row #1 Frank Thomas from #A1 Card One")).toBeTruthy();
  });
});

describe("CardPairingModal — suggested links (NEO-490)", () => {
  const named = () => [
    bscCard("A1", "Card One", ["Frank Thomas"]),
    bscCard("A2", "Card Two", ["Jacob Wilson"]),
    bscCard("A3", "Card Three", ["Matt Shaw"]),
  ];

  test("unique name pairs are linked once the stream has settled, not before", () => {
    const props: Props = {
      soloSide: "bsc",
      data: { unmatchedBsc: named() },
      checklist: checklistFor(plainRows(), plainKeys),
      isStreaming: true,
      streamSettled: false,
    };
    const { update } = mount(props);

    // Still streaming: a card still to come could turn a unique name into a tie.
    expect(screen.queryByLabelText(/^Unlink checklist row /)).toBeNull();
    expect(screen.getByRole("heading", { name: "Your checklist (3 to link)" })).toBeTruthy();

    update({ isStreaming: false, streamSettled: true, data: { unmatchedBsc: named() } });

    expect(screen.getByLabelText("Unlink checklist row #1 Frank Thomas · Chicago White Sox from #A1 Card One")).toBeTruthy();
    expect(screen.getByLabelText("Unlink checklist row #2 Jacob Wilson from #A2 Card Two")).toBeTruthy();
    expect(screen.getByLabelText("Unlink checklist row #3 Matt Shaw from #A3 Card Three")).toBeTruthy();
  });

  test("seeding runs once: a suggestion the operator took off is not put back", () => {
    const { update } = mount({
      soloSide: "bsc",
      data: { unmatchedBsc: named() },
      checklist: checklistFor(plainRows(), plainKeys),
      isStreaming: false,
      streamSettled: true,
    });
    fireEvent.click(screen.getByLabelText("Unlink checklist row #2 Jacob Wilson from #A2 Card Two"));
    expect(screen.getByLabelText("Select #2 Jacob Wilson")).toBeTruthy();

    // More props, more renders, another settled stream: nothing re-links.
    update({ data: { unmatchedBsc: named() }, streamSettled: true });
    update({ data: { unmatchedBsc: named() }, streamSettled: true });

    expect(screen.getByLabelText("Select #2 Jacob Wilson")).toBeTruthy();
    expect(screen.queryByLabelText("Unlink checklist row #2 Jacob Wilson from #A2 Card Two")).toBeNull();
  });

  test("a name tie stays unlinked for the operator: no row goes to the first candidate", () => {
    mount({
      soloSide: "bsc",
      data: {
        unmatchedBsc: [
          bscCard("A1", "Card One", ["Jacob Wilson"]),
          bscCard("A2", "Card Two", ["Jacob Wilson"]),
          bscCard("A3", "Card Three", ["Matt Shaw"]),
        ],
      },
      checklist: checklistFor(
        [row("1", ["Jacob Wilson"]), row("2", ["Matt Shaw"])],
        plainKeys,
      ),
    });

    // Two cards claim Jacob Wilson: neither is linked, and the row waits.
    expect(screen.getByLabelText("Select #1 Jacob Wilson")).toBeTruthy();
    expect(screen.queryByLabelText(/^Unlink checklist row 1 /)).toBeNull();
    // The unique pair beside the tie still links.
    expect(screen.getByLabelText("Unlink checklist row #2 Matt Shaw from #A3 Card Three")).toBeTruthy();
  });

  test("two rows with one name leave the card and both rows unlinked", () => {
    mount({
      soloSide: "bsc",
      data: { unmatchedBsc: [bscCard("A1", "Card One", ["Jacob Wilson"])] },
      checklist: checklistFor(
        [row("1", ["Jacob Wilson"]), row("2", ["Jacob Wilson"])],
        ["bsc-A1"],
      ),
    });
    expect(screen.queryByLabelText(/^Unlink checklist row /)).toBeNull();
    expect(screen.getByLabelText("Select #1 Jacob Wilson")).toBeTruthy();
    expect(screen.getByLabelText("Select #2 Jacob Wilson")).toBeTruthy();
  });

  test("a card the server paired already is not suggested a row", () => {
    mount({
      soloSide: "bsc",
      data: { unmatchedBsc: [bscCard("A1", "Card One", ["Jacob Wilson"])] },
      // The card is not a leftover, so it cannot be a link target.
      checklist: checklistFor([row("1", ["Jacob Wilson"])], []),
    });
    expect(screen.queryByLabelText(/^Unlink checklist row /)).toBeNull();
  });

  test("suggestions passed by the caller are linked instead of the name rule", () => {
    mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(plainRows(), plainKeys, {
        suggestions: [{ cardKey: "bsc-A2", rowIndex: 0 }],
      }),
    });
    expect(screen.getByLabelText("Unlink checklist row #1 Frank Thomas · Chicago White Sox from #A2 Card Two")).toBeTruthy();
    expect(screen.queryByLabelText(/^Unlink checklist row 2 /)).toBeNull();
  });

  test("a suggested link on an unmatched card keeps it in a two-marketplace set", async () => {
    const resolve = vi.fn().mockResolvedValue([]);
    const { onConfirm } = mount({
      data: { unmatchedBsc: [bscCard("A1", "Card One", ["Frank Thomas"])] },
      checklist: checklistFor([row("1", ["Frank Thomas"])], ["bsc-A1"]),
      resolve,
    });
    expect(screen.getByText(/^Keeping \(1\)$/)).toBeTruthy();
    await confirm();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(confirmedCards(onConfirm)).toHaveLength(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

describe("CardPairingModal — Confirm resolves the links first (NEO-490)", () => {
  const linkOne = () => {
    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas · Chicago White Sox"));
    fireEvent.click(screen.getByLabelText("Link selected checklist row to #A1 Card One"));
  };

  test("Confirm waits for the resolver and saves the merged answer", async () => {
    let answer: (a: ChecklistPairAnswer[]) => void = () => {};
    const resolve = vi.fn(
      () => new Promise<ChecklistPairAnswer[]>((res) => (answer = res)),
    );
    const { onConfirm } = mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(plainRows(), plainKeys),
      resolve,
    });
    linkOne();

    await confirm();

    // Asked, not yet answered: nothing is saved and the button says why.
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Confirm card matches").textContent).toBe("Saving…");

    await act(async () => {
      answer([
        {
          cardKey: "bsc-A1",
          teams: ["Chicago White Sox"],
          teamLookup: "checklist",
          fillPlayers: ["Frank Thomas"],
        },
      ]);
    });

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const [first, second, third] = confirmedCards(onConfirm);
    expect(first.cardNumber).toBe("A1");
    expect(first.teams).toEqual(["Chicago White Sox"]);
    expect(first.teamLookup).toBe("checklist");
    expect(first.players).toEqual(["Frank Thomas"]);
    // The unlinked cards are untouched and still saved.
    expect(second.teams).toBeUndefined();
    expect(third.teams).toBeUndefined();
  });

  test("a disagreement rides on the card and the card's own values stay", async () => {
    const conflict = {
      teams: { marketplace: ["Cubs"], checklist: ["Chicago White Sox"] },
    };
    const resolve = vi.fn().mockResolvedValue([
      {
        cardKey: "bsc-A1",
        teams: ["Chicago White Sox"],
        teamLookup: "checklist",
        checklistConflict: conflict,
      },
    ]);
    const { onConfirm } = mount({
      soloSide: "bsc",
      data: { unmatchedBsc: [{ ...bscCard("A1", "Card One"), teams: ["Cubs"] }] },
      checklist: checklistFor(plainRows(), ["bsc-A1"]),
      resolve,
    });
    linkOne();
    await confirm();

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const [card] = confirmedCards(onConfirm);
    expect(card.checklistConflict).toEqual(conflict);
    expect(card.teams).toEqual(["Cubs"]);
    expect(card.teamLookup).toBeUndefined();
  });

  test("conflictsByIndex still addresses the right card after the answers are merged in", async () => {
    // A matched pair with a name disagreement is index 0; the hand-linked
    // kept card follows. The merge must not reorder or drop either.
    const conflicted = {
      ...pairedCard("7", "Bat Man"),
      nameConflict: { bsc: "Bat Man", sportlots: "Bart Man" },
    } satisfies PairingCard;
    const resolve = vi.fn().mockResolvedValue([
      { cardKey: "bsc-A1", teams: ["Chicago White Sox"], teamLookup: "checklist" },
    ]);
    const { onConfirm } = mount({
      data: {
        autoMatched: [{ card: conflicted, confidence: 1 }],
        unmatchedBsc: [bscCard("A1", "Card One")],
      },
      checklist: checklistFor(plainRows(), ["bsc-A1"]),
      resolve,
    });
    linkOne();
    await confirm();

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const payload = onConfirm.mock.calls[0][0];
    expect(payload.cards.map((c: PairingCard) => c.cardNumber)).toEqual(["7", "A1"]);
    expect(Object.keys(payload.conflictsByIndex)).toEqual(["0"]);
    expect(payload.conflictsByIndex[0].nameConflict).toEqual({
      bsc: "Bat Man",
      sportlots: "Bart Man",
    });
    expect(payload.cards[1].teams).toEqual(["Chicago White Sox"]);
    expect(payload.cards[0].teams).toBeUndefined();
  });

  test("an answer for a card that is no longer saved is ignored", async () => {
    const resolve = vi.fn().mockResolvedValue([
      { cardKey: "bsc-GONE", teams: ["Nobody"], teamLookup: "checklist" },
    ]);
    const { onConfirm } = mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(plainRows(), plainKeys),
      resolve,
    });
    linkOne();
    await confirm();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    for (const card of confirmedCards(onConfirm)) expect(card.teams).toBeUndefined();
  });

  test("a resolver failure shows the alert, confirms nothing, and Confirm can be pressed again", async () => {
    const resolve = vi
      .fn()
      .mockRejectedValueOnce(new Error("server down"))
      .mockResolvedValueOnce([]);
    const { onConfirm } = mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(plainRows(), plainKeys),
      resolve,
    });
    linkOne();

    await confirm();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(CHECKLIST_LINKS_FAILED);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Confirm card matches").textContent).toBe("Confirm");

    await confirm();

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("links with no resolver to ask confirm nothing rather than save them unanswered", async () => {
    const { onConfirm } = mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(plainRows(), plainKeys),
    });
    linkOne();
    await confirm();
    expect((await screen.findByRole("alert")).textContent).toBe(CHECKLIST_LINKS_FAILED);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("CardPairingModal — the discard count with a checklist (NEO-490)", () => {
  const pairingDialog = () => screen.getByRole("dialog", { name: /Match Cards/ });

  test("an untouched solo session closes at once: the cards this screen kept are not the operator's work", () => {
    const { onClose } = mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(plainRows(), plainKeys),
    });
    fireEvent.click(screen.getByLabelText("Cancel card matching"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: /Discard/ })).toBeNull();
  });

  test("seeded suggestions alone are not counted either", () => {
    const { onClose } = mount({
      soloSide: "bsc",
      data: {
        unmatchedBsc: [
          bscCard("A1", "Card One", ["Frank Thomas"]),
          bscCard("A2", "Card Two", ["Jacob Wilson"]),
        ],
      },
      checklist: checklistFor(plainRows(), plainKeys),
    });
    expect(screen.getAllByLabelText(/^Unlink checklist row /)).toHaveLength(2);
    fireEvent.keyDown(pairingDialog(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a hand link counts, and so does taking a suggestion off", () => {
    const { onClose } = mount({
      soloSide: "bsc",
      data: {
        unmatchedBsc: [
          bscCard("A1", "Card One", ["Frank Thomas"]),
          bscCard("A2", "Card Two"),
        ],
      },
      checklist: checklistFor(plainRows(), plainKeys),
    });
    // One suggestion taken off.
    fireEvent.click(screen.getByLabelText("Unlink checklist row #1 Frank Thomas · Chicago White Sox from #A1 Card One"));
    fireEvent.click(screen.getByLabelText("Cancel card matching"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Discard 1 pairing?" })).toBeTruthy();
  });

  test("a new hand link in solo mode is one edit", () => {
    mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(plainRows(), plainKeys),
    });
    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas · Chicago White Sox"));
    fireEvent.click(screen.getByLabelText("Link selected checklist row to #A1 Card One"));
    fireEvent.keyDown(pairingDialog(), { key: "Escape" });
    expect(screen.getByRole("button", { name: "Discard 1 pairing" })).toBeTruthy();
  });

  test("moving a suggestion onto a different row is counted, a plain re-link back to the seed is not", () => {
    const { onClose } = mount({
      soloSide: "bsc",
      data: { unmatchedBsc: [bscCard("A1", "Card One", ["Frank Thomas"])] },
      checklist: checklistFor(plainRows(), ["bsc-A1"]),
    });
    const unlink = () =>
      fireEvent.click(screen.getByLabelText("Unlink checklist row #1 Frank Thomas · Chicago White Sox from #A1 Card One"));
    unlink();
    // Put it back by hand: the same link as the seed made.
    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas · Chicago White Sox"));
    fireEvent.click(screen.getByLabelText("Link selected checklist row to #A1 Card One"));
    fireEvent.click(screen.getByLabelText("Cancel card matching"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/** The checklist's own status region: the one without the stream's id. */
const announcer = () =>
  screen
    .getAllByRole("status")
    .find((el) => !el.id) as HTMLElement;

const TOP = "Frank Thomas · Chicago White Sox";
const selectTop = () => fireEvent.click(screen.getByLabelText(`Select #1 ${TOP}`));
const linkTopTo = (card: string) =>
  fireEvent.click(screen.getByLabelText(`Link selected checklist row to ${card}`));

describe("CardPairingModal — the checklist announcer (NEO-490 a11y)", () => {
  const soloMount = () =>
    mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(plainRows(), plainKeys),
    });

  test("it is a second, always-mounted status region, apart from the stream's", () => {
    soloMount();
    const ids = screen.getAllByRole("status").map((el) => el.id);
    expect(ids).toContain("pairing-streaming-announcer");
    expect(ids).toContain("");
    expect(announcer().textContent).toBe("");
  });

  test("selecting a row says which row and what to press", () => {
    soloMount();
    selectTop();
    expect(announcer().textContent).toBe("Checklist row 1 selected. Press Link on a card.");
  });

  test("pressing the selected row again says the selection is cleared", () => {
    soloMount();
    selectTop();
    fireEvent.click(screen.getByLabelText(`Select #1 ${TOP}`));
    expect(announcer().textContent).toBe("Selection cleared.");
  });

  test("a link says the row, the card and how many rows are left", () => {
    soloMount();
    selectTop();
    linkTopTo("#A1 Card One");
    expect(announcer().textContent).toBe(
      "Linked checklist row 1 to #A1 Card One. 2 rows left to link.",
    );
  });

  test("the count reads in the singular with one row left", () => {
    soloMount();
    selectTop();
    linkTopTo("#A1 Card One");
    fireEvent.click(screen.getByLabelText("Select #2 Jacob Wilson"));
    fireEvent.click(screen.getByLabelText("Link selected checklist row to #A2 Card Two"));
    expect(announcer().textContent).toBe(
      "Linked checklist row 2 to #A2 Card Two. 1 row left to link.",
    );
  });

  test("the last link says every row is linked", () => {
    mount({
      soloSide: "bsc",
      data: { unmatchedBsc: [bscCard("A1", "Card One")] },
      checklist: checklistFor([row("1", ["Frank Thomas"])], ["bsc-A1"]),
    });
    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas"));
    linkTopTo("#A1 Card One");
    expect(announcer().textContent).toBe(
      "Linked checklist row 1 to #A1 Card One. Every checklist row is linked.",
    );
    expect(
      screen.getByRole("heading", { name: "Your checklist (all linked!)" }),
    ).toBeTruthy();
  });

  test("the row's own Unlink says Unlinked", () => {
    soloMount();
    selectTop();
    linkTopTo("#A1 Card One");
    fireEvent.click(screen.getByLabelText(`Unlink checklist row #1 ${TOP} from #A1 Card One`));
    expect(announcer().textContent).toBe("Unlinked.");
  });

  test("a marketplace Remove that takes the link with it says which row went", () => {
    mount({
      data: { unmatchedBsc: [bscCard("A1", "Card One")] },
      checklist: checklistFor([row("1", ["Frank Thomas"])], ["bsc-A1"]),
      resolve: vi.fn().mockResolvedValue([]),
    });
    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas"));
    linkTopTo("#A1 Card One");
    fireEvent.click(screen.getByLabelText("Remove #A1 Card One from save list"));
    expect(announcer().textContent).toBe("Checklist row 1 unlinked too.");
  });

  test("the links the one-time seed makes are not announced", () => {
    mount({
      soloSide: "bsc",
      data: {
        unmatchedBsc: [
          bscCard("A1", "Card One", ["Frank Thomas"]),
          bscCard("A2", "Card Two", ["Jacob Wilson"]),
        ],
      },
      checklist: checklistFor(plainRows(), plainKeys),
    });
    expect(screen.getAllByLabelText(/^Unlink checklist row /)).toHaveLength(2);
    expect(announcer().textContent).toBe("");
  });

  describe("a drop", () => {
    const twoSided = () =>
      mount({
        data: {
          autoMatched: [{ card: pairedCard("5", "Pair Card"), confidence: 1 }],
          unmatchedBsc: [bscCard("A1", "Card One")],
        },
        // The pair was settled by the server: it is not a leftover.
        checklist: checklistFor([row("1", ["Frank Thomas"])], ["bsc-A1"], {
          alreadyMatched: 1,
        }),
        resolve: vi.fn().mockResolvedValue([]),
      });
    const dropOn = async (targetLabel: string) => {
      const toggle = screen.queryByLabelText(/^Expand matched cards/);
      if (toggle) fireEvent.click(toggle);
      const source = screen.getByLabelText("Select #1 Frank Thomas").closest("li")!;
      const target = screen.getByLabelText(targetLabel).closest("li")!;
      const restore = stubLayout(
        new Map([
          [source, { top: 100, left: 0, width: 300, height: 36 }],
          [target, { top: 100, left: 400, width: 300, height: 36 }],
        ]),
      );
      try {
        await keyboardDrag(source, Array(16).fill("ArrowRight"));
      } finally {
        restore();
      }
    };

    test("onto a leftover card links the row and says so", async () => {
      twoSided();
      await dropOn("Keep #A1 Card One as BSC-only");
      expect(announcer().textContent).toBe(
        "Linked checklist row 1 to #A1 Card One. Every checklist row is linked.",
      );
    });

    test("onto a card the reducer refuses links nothing and announces nothing", async () => {
      twoSided();
      await dropOn("Unlink #5 Pair Card");
      expect(screen.queryByLabelText(/^Unlink checklist row /)).toBeNull();
      expect(screen.getByLabelText("Select #1 Frank Thomas")).toBeTruthy();
      expect(announcer().textContent).toBe("");
    });
  });
});

describe("CardPairingModal — the Selected strip (NEO-490 a11y)", () => {
  const soloMount = () =>
    mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(plainRows(), plainKeys),
    });

  test("it shows only while a row is selected, with the row's whole line", () => {
    soloMount();
    expect(screen.queryByText("Selected:")).toBeNull();
    expect(screen.queryByLabelText("Clear selected checklist row")).toBeNull();

    selectTop();
    const strip = screen.getByLabelText("Clear selected checklist row").parentElement!;
    expect(strip.textContent).toContain(`Selected: #1 ${TOP}`);
    expect(screen.getByLabelText("Clear selected checklist row").textContent).toBe("Clear");
  });

  test("Clear drops the selection, says so, and puts focus back on the row's button", async () => {
    soloMount();
    selectTop();
    fireEvent.click(screen.getByLabelText("Clear selected checklist row"));

    expect(screen.queryByLabelText("Clear selected checklist row")).toBeNull();
    expect(screen.queryByLabelText(/^Link selected checklist row to /)).toBeNull();
    expect(announcer().textContent).toBe("Selection cleared.");
    const button = screen.getByLabelText(`Select #1 ${TOP}`);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  test("linking the row takes the strip away", () => {
    soloMount();
    selectTop();
    linkTopTo("#A1 Card One");
    expect(screen.queryByLabelText("Clear selected checklist row")).toBeNull();
  });
});

describe("CardPairingModal — rows that read alike (NEO-490 a11y)", () => {
  const twins = () =>
    mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(
        [row("5", ["Same Guy"]), row("5", ["Same Guy"]), row("9", ["Other Guy"])],
        plainKeys,
      ),
    });

  test("duplicate lines get a row i of n suffix on their Select buttons", () => {
    twins();
    expect(screen.getByLabelText("Select #5 Same Guy, row 1 of 3")).toBeTruthy();
    expect(screen.getByLabelText("Select #5 Same Guy, row 2 of 3")).toBeTruthy();
    // A line that is unique keeps its plain name.
    expect(screen.getByLabelText("Select #9 Other Guy")).toBeTruthy();
  });

  test("the suffix carries to the Unlink name, after the line", () => {
    twins();
    fireEvent.click(screen.getByLabelText("Select #5 Same Guy, row 2 of 3"));
    linkTopTo("#A1 Card One");
    expect(
      screen.getByLabelText("Unlink checklist row #5 Same Guy, row 2 of 3 from #A1 Card One"),
    ).toBeTruthy();
    // The row left alone keeps its suffix, so it is still told apart.
    expect(screen.getByLabelText("Select #5 Same Guy, row 1 of 3")).toBeTruthy();
  });

  test("an NNO row reads NNO, not #NNO, and duplicates are told apart the same way", () => {
    mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(
        [1, 2, 3].map(() => ({ ...row("NNO", ["Same"]), noNumber: true as const })),
        plainKeys,
      ),
    });
    expect(screen.getByLabelText("Select NNO Same, row 2 of 3")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Select NNO Same, row 2 of 3"));
    linkTopTo("#A1 Card One");
    expect(screen.getByText("Checklist NNO")).toBeTruthy();
    expect(screen.queryByText("Checklist #NNO")).toBeNull();
  });

  test("the number chip says what the number is", () => {
    mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(plainRows(), plainKeys),
    });
    selectTop();
    linkTopTo("#A1 Card One");
    expect(screen.getByText("Checklist #1").getAttribute("title")).toBe(
      "Number on your checklist",
    );
  });
});

describe("checklistRowLine (NEO-490)", () => {
  test("prints the number with a hash, the players, and the team when the row names one", () => {
    expect(
      checklistRowLine({ number: "17", players: ["Mike Lowell"], teams: ["Boston Red Sox"] }),
    ).toBe("#17 Mike Lowell · Boston Red Sox");
  });

  test("a card printed with no number reads NNO, never #NNO", () => {
    expect(
      checklistRowLine({ number: "NNO", players: ["Mike Lowell"], teams: [], noNumber: true }),
    ).toBe("NNO Mike Lowell");
  });

  test("a No Team row says so, in the preview's own words (NEO-489)", () => {
    expect(
      checklistRowLine({ number: "9", players: ["Show Card"], teams: [], noTeam: true }),
    ).toBe("#9 Show Card · No team");
    // A row that merely names no team makes no claim and shows none.
    expect(checklistRowLine({ number: "9", players: ["Show Card"], teams: [] })).toBe(
      "#9 Show Card",
    );
  });

  test("without the noNumber flag a number is a number, even one spelled NNO", () => {
    expect(checklistRowLine({ number: "NNO", players: ["Mike Lowell"], teams: [] })).toBe(
      "#NNO Mike Lowell",
    );
  });
});

describe("CardPairingModal — Confirm while the links are asked about (NEO-490 a11y)", () => {
  const confirmButton = () => screen.getByLabelText("Confirm card matches");
  const linkOneAndMount = async (resolve: Props["resolve"]) => {
    const view = mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(plainRows(), plainKeys),
      resolve,
    });
    selectTop();
    linkTopTo("#A1 Card One");
    // The link moves focus on the next frame; let it land before a test
    // puts focus somewhere of its own.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    return view;
  };

  test("it is aria-disabled and still focusable, not natively disabled, and says Saving…", async () => {
    const resolve = vi.fn(() => new Promise<ChecklistPairAnswer[]>(() => {}));
    await linkOneAndMount(resolve);
    confirmButton().focus();

    await confirm();

    const button = confirmButton() as HTMLButtonElement;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Saving…");
    expect(document.activeElement).toBe(button);
  });

  test("pressing it again while it waits does not ask twice", async () => {
    const resolve = vi.fn(() => new Promise<ChecklistPairAnswer[]>(() => {}));
    await linkOneAndMount(resolve);
    await confirm();
    await confirm();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test("on failure the alert is tied to Confirm and focus lands back on it", async () => {
    const resolve = vi.fn().mockRejectedValue(new Error("server down"));
    const { onConfirm } = await linkOneAndMount(resolve);
    // The operator pressed Confirm from elsewhere: focus is on a row's button.
    screen.getByLabelText("Cancel card matching").focus();

    await confirm();

    const alert = await screen.findByRole("alert");
    expect(alert.id).toBe("pairing-checklist-error");
    expect(confirmButton().getAttribute("aria-describedby")).toContain(
      "pairing-checklist-error",
    );
    await waitFor(() => expect(document.activeElement).toBe(confirmButton()));
    expect(confirmButton().getAttribute("aria-disabled")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("with no alert showing, Confirm points at no checklist error", async () => {
    await linkOneAndMount(vi.fn().mockResolvedValue([]));
    expect(document.getElementById("pairing-checklist-error")).toBeNull();
    expect(confirmButton().getAttribute("aria-describedby") ?? "").not.toContain(
      "pairing-checklist-error",
    );
  });
});

describe("CardPairingModal — the checklist filter (NEO-490 a11y)", () => {
  const soloMount = () =>
    mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(plainRows(), plainKeys),
    });
  const filter = () => screen.getByRole("textbox", { name: "Filter checklist rows" });
  const dialog = () => screen.getByRole("dialog", { name: /Match Cards/ });

  test("Escape on a filter with text clears it and does not close the dialog", () => {
    const { onClose } = soloMount();
    fireEvent.change(filter(), { target: { value: "wilson" } });

    const notPrevented = fireEvent.keyDown(filter(), { key: "Escape" });

    expect(notPrevented).toBe(false);
    expect((filter() as HTMLInputElement).value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    expect(
      within(screen.getByRole("list", { name: "Leftover checklist rows" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(3);
  });

  test("Escape on an empty filter is not swallowed: it bubbles on to the dialog", () => {
    const { onClose } = soloMount();
    const reachedDialog = vi.fn();
    dialog().addEventListener("keydown", reachedDialog);
    const notPrevented = fireEvent.keyDown(filter(), { key: "Escape" });
    expect(notPrevented).toBe(true);
    expect(reachedDialog).toHaveBeenCalledTimes(1);
    // A text field with nothing to clear has no local meaning for the key,
    // and the dialog does not close the whole screen from inside a field.
    expect(onClose).not.toHaveBeenCalled();
  });

  test("a filter that hides the selected row clears the selection", () => {
    soloMount();
    selectTop();
    expect(screen.getByLabelText("Clear selected checklist row")).toBeTruthy();

    fireEvent.change(filter(), { target: { value: "wilson" } });

    expect(screen.queryByLabelText("Clear selected checklist row")).toBeNull();
    expect(screen.queryByLabelText(/^Link selected checklist row to /)).toBeNull();
    expect(announcer().textContent).toBe("Selection cleared.");
  });

  test("a filter that still shows the selected row leaves it selected", () => {
    soloMount();
    selectTop();
    fireEvent.change(filter(), { target: { value: "frank" } });
    expect(screen.getByLabelText("Clear selected checklist row")).toBeTruthy();
    expect(announcer().textContent).toBe("Checklist row 1 selected. Press Link on a card.");
  });
});

describe("CardPairingModal — link targets are refs only (NEO-490)", () => {
  test("a card with neither a BSC nor a SportLots ref gets no Link button", () => {
    const refless: PairingCard = {
      cardNumber: "X1",
      cardName: "No Ref",
      platformData: {},
      unmatched: "sl",
    };
    mount({
      soloSide: "bsc",
      data: { unmatchedBsc: [bscCard("A1", "Card One"), refless] },
      // The number-only key a ref-less card would answer to is named a
      // leftover, and still does not make it a target.
      checklist: checklistFor([row("1", ["Frank Thomas"])], ["bsc-A1", "#X1"]),
    });
    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas"));
    expect(
      screen.getAllByRole("button", { name: /^Link selected checklist row to / }),
    ).toHaveLength(1);
    expect(screen.queryByLabelText("Link selected checklist row to #X1 No Ref")).toBeNull();
  });
});

describe("CardPairingModal — the discard count, a hand link in two marketplaces (NEO-490)", () => {
  test("a hand-linked unmatched card is two edits: the keep it earned and the link", () => {
    const { onClose } = mount({
      data: { unmatchedBsc: [bscCard("A1", "Card One")] },
      checklist: checklistFor([row("1", ["Frank Thomas"])], ["bsc-A1"]),
      resolve: vi.fn().mockResolvedValue([]),
    });
    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas"));
    linkTopTo("#A1 Card One");

    fireEvent.click(screen.getByLabelText("Cancel card matching"));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Discard 2 pairings?" })).toBeTruthy();
  });
});

describe("CardPairingModal — the card's own Unlink on the checklist chip (NEO-490)", () => {
  const CHIP_SOLO = `Unlink card #A1 Card One from checklist row #1 ${TOP}`;

  const soloLinked = () => {
    mount({
      soloSide: "bsc",
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(plainRows(), plainKeys),
    });
    selectTop();
    linkTopTo("#A1 Card One");
  };

  test("in the solo column it drops the link and the row returns to the list", () => {
    soloLinked();
    expect(screen.queryByLabelText(`Select #1 ${TOP}`)).toBeNull();

    fireEvent.click(screen.getByLabelText(CHIP_SOLO));

    expect(screen.getByLabelText(`Select #1 ${TOP}`)).toBeTruthy();
    expect(screen.queryByText(/^Checklist #/)).toBeNull();
    expect(screen.queryByLabelText(CHIP_SOLO)).toBeNull();
    expect(screen.getByRole("heading", { name: "Your checklist (3 to link)" })).toBeTruthy();
    // The card is offered a row again.
    selectTop();
    expect(screen.getByLabelText("Link selected checklist row to #A1 Card One")).toBeTruthy();
  });

  test("it says Unlinked", () => {
    soloLinked();
    fireEvent.click(screen.getByLabelText(CHIP_SOLO));
    expect(announcer().textContent).toBe("Unlinked.");
  });

  test("focus lands on the row's Select button", async () => {
    soloLinked();
    fireEvent.click(screen.getByLabelText(CHIP_SOLO));
    const button = screen.getByLabelText(`Select #1 ${TOP}`);
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  test("from a Matched row it drops the checklist link and leaves the pair matched", () => {
    mount({
      data: { autoMatched: [{ card: pairedCard("5", "Pair Card"), confidence: 1 }] },
      checklist: checklistFor([row("1", ["Frank Thomas"])], ["bsc-5"]),
      resolve: vi.fn().mockResolvedValue([]),
    });
    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas"));
    fireEvent.click(screen.getByLabelText("Link selected checklist row to #5 Pair Card"));
    expect(screen.getByText("Checklist #1")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Unlink card #5 Pair Card from checklist row #1 Frank Thomas"));

    expect(screen.queryByText("Checklist #1")).toBeNull();
    expect(screen.getByLabelText("Select #1 Frank Thomas")).toBeTruthy();
    // The marketplace pair is untouched.
    expect(screen.getByLabelText("Unlink #5 Pair Card")).toBeTruthy();
    expect(announcer().textContent).toBe("Unlinked.");
  });

  test("from a keep-shelf card in a two-marketplace set it drops the link", () => {
    mount({
      data: { unmatchedBsc: [bscCard("A1", "Card One")] },
      checklist: checklistFor([row("1", ["Frank Thomas"])], ["bsc-A1"]),
      resolve: vi.fn().mockResolvedValue([]),
    });
    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas"));
    linkTopTo("#A1 Card One");
    // A linked card is kept: it sits on the shelf with its chip.
    expect(screen.getByLabelText("Remove #A1 Card One from save list")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Unlink card #A1 Card One from checklist row #1 Frank Thomas"));

    expect(screen.queryByText("Checklist #1")).toBeNull();
    expect(screen.getByLabelText("Select #1 Frank Thomas")).toBeTruthy();
    expect(announcer().textContent).toBe("Unlinked.");
  });

  test("its name is distinct from the marketplace Unlink and the row's Unlink", () => {
    mount({
      data: { autoMatched: [{ card: pairedCard("5", "Pair Card"), confidence: 1 }] },
      checklist: checklistFor([row("1", ["Frank Thomas"])], ["bsc-5"]),
      resolve: vi.fn().mockResolvedValue([]),
    });
    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas"));
    fireEvent.click(screen.getByLabelText("Link selected checklist row to #5 Pair Card"));

    // Each exact name finds exactly one control.
    expect(screen.getByLabelText("Unlink #5 Pair Card")).toBeTruthy();
    expect(screen.getByLabelText("Unlink checklist row #1 Frank Thomas from #5 Pair Card")).toBeTruthy();
    expect(screen.getByLabelText("Unlink card #5 Pair Card from checklist row #1 Frank Thomas")).toBeTruthy();
    // The three are different controls.
    expect(screen.getAllByRole("button", { name: /^Unlink/ })).toHaveLength(3);
    // The prefixes the other specs match on never reach the chip's button.
    expect(screen.getAllByLabelText(/^Unlink checklist row /)).toHaveLength(1);
  });

  test("the Link button is still found by its name now that it is a NeonButton", () => {
    soloLinked();
    fireEvent.click(screen.getByLabelText("Select #2 Jacob Wilson"));
    const link = screen.getByRole("button", { name: "Link selected checklist row to #A2 Card Two" });
    expect(link.textContent).toBe("Link");
    fireEvent.click(link);
    expect(screen.getByLabelText("Unlink card #A2 Card Two from checklist row #2 Jacob Wilson")).toBeTruthy();
  });
});

/**
 * NEO-490 — the publisher's checklist as a source in Match Cards.
 *
 * What is pinned here, and why it matters:
 *
 *  - NEO-496: the checklist is a full source. One marketplace plus a
 *    checklist is two sources: leftover cards and leftover checklist rows each
 *    need a Keep (Keep all is one click), and a kept row is saved as a card of
 *    its own. A card the server paired with a row is matched and saved.
 *  - A link keeps an unmatched card; taking the card off the save list drops
 *    the link; unlinking a pair keeps the link on the BSC half (and that half
 *    stays saved).
 *  - Rows the server already paired to a card are not listed, and the card
 *    is still SAVED. If that path broke, cards would vanish silently.
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

/**
 * NEO-496 — the rows no card paired arrive as `checklistOnly` candidates
 * now, not as a prop: a row as the server publishes it (number, players and
 * teams; "checklist" answered the team when the row names one or says No
 * Team; no marketplace link), keyed by its candidate id.
 */
const rowCard = (r: ChecklistLinkRow, i: number): PairingCard => ({
  cardNumber: r.number,
  cardName: r.players.length > 0 ? r.players.join(" / ") : `Card #${r.number || "NNO"}`,
  ...(r.players.length > 0 ? { players: [...r.players] } : {}),
  ...(r.teams.length > 0 || r.noTeam
    ? { teams: [...r.teams], teamLookup: "checklist" as const }
    : {}),
  platformData: {},
  checklistRowId: `row-${i}`,
});

/**
 * The NEO-490 checklist shape, translated to what the dialog is sent since
 * NEO-496: the unused rows as checklist-only cards, and every card the
 * server paired with a row (one NOT named in `leftoverCardKeys`) carrying
 * its `checklistLink`.
 */
function toWire(data: Data, checklist: Checklist | undefined) {
  const leftover = new Set(checklist?.leftoverCardKeys ?? []);
  const stamp = (c: PairingCard): PairingCard => {
    if (!checklist) return c;
    const refs = [c.platformData.bsc?.ref, c.platformData.sportlots?.ref].filter(Boolean);
    return refs.some((r) => leftover.has(r as string))
      ? c
      : { ...c, checklistLink: { via: "number" } };
  };
  return {
    autoMatched: (data.autoMatched ?? []).map((m) => ({ ...m, card: stamp(m.card) })),
    unmatchedBsc: (data.unmatchedBsc ?? []).map(stamp),
    unmatchedSl: (data.unmatchedSl ?? []).map(stamp),
    checklistOnly: checklist
      ? checklist.unusedRowIndices.map((i) => rowCard(checklist.rows[i], i))
      : [],
  };
}

type Props = {
  data: Data;
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
      sources={p.checklist ? ["bsc", "sportlots", "checklist"] : undefined}
      resolveChecklistPairs={p.resolve}
      isStreaming={p.isStreaming}
      streamSettled={p.streamSettled}
      streamProgress={
        p.isStreaming || p.streamSettled === false
          ? { ready: 0, total: 1 }
          : undefined
      }
      initialData={toWire(p.data, p.checklist)}
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

/**
 * NEO-496 — the dialog as the fetch sends it now: the marketplace candidates,
 * the checklist-only rows, and the run's `sources`.
 */
function mountWire(initial: {
  sources?: readonly ("bsc" | "sportlots" | "checklist")[];
  unmatchedBsc?: PairingCard[];
  unmatchedSl?: PairingCard[];
  autoMatched?: Array<{ card: PairingCard; confidence: number }>;
  checklistOnly?: PairingCard[];
  resolve?: (pairs: ChecklistPairRequest[]) => Promise<ChecklistPairAnswer[]>;
}) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  type P = typeof initial;
  const ui = (p: P) => (
    <CardPairingModal
      isOpen
      onClose={onClose}
      onConfirm={onConfirm}
      sources={p.sources}
      resolveChecklistPairs={p.resolve}
      initialData={{
        autoMatched: p.autoMatched ?? [],
        unmatchedBsc: p.unmatchedBsc ?? [],
        unmatchedSl: p.unmatchedSl ?? [],
        checklistOnly: p.checklistOnly ?? [],
      }}
    />
  );
  const { rerender } = render(ui(initial));
  return {
    onConfirm,
    onClose,
    update: (next: Partial<P>) => rerender(ui({ ...initial, ...next })),
  };
}

const BSC_AND_CHECKLIST = ["bsc", "checklist"] as const;

/** Open the Matched list when leftovers below collapsed it. */
function expandMatched() {
  const toggle = screen.queryByLabelText(/^Expand matched cards/);
  if (toggle) fireEvent.click(toggle);
}

describe("CardPairingModal — one marketplace + a checklist is two sources (NEO-496 NQ1)", () => {
  test("leftover BSC cards and leftover checklist rows each need a Keep; there is no SportLots column", () => {
    mountWire({
      sources: BSC_AND_CHECKLIST,
      unmatchedBsc: [bscCard("SG-CO", "Chris Olave")],
      checklistOnly: [rowCard(row("101", ["Matt Shaw"], ["Chicago Cubs"]), 0)],
    });

    expect(screen.getByRole("heading", { name: "BSC only (1)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Checklist only (1)" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /^SportLots only/ })).toBeNull();
    expect(screen.getByLabelText("Keep #SG-CO Chris Olave as BSC-only")).toBeTruthy();
    expect(
      screen.getByLabelText("Keep #101 Matt Shaw · Chicago Cubs as checklist-only"),
    ).toBeTruthy();
    expect(screen.getByLabelText("Keep all BSC-only cards")).toBeTruthy();
    expect(screen.getByLabelText("Keep all checklist-only cards")).toBeTruthy();
    expect(screen.getByText(CHECKLIST_COLUMN_SUBTITLE)).toBeTruthy();
  });

  test("nothing kept saves nothing: a BSC card the checklist lacks and an unkept row are both dropped", async () => {
    const resolve = vi.fn().mockResolvedValue([]);
    const { onConfirm } = mountWire({
      sources: BSC_AND_CHECKLIST,
      unmatchedBsc: [bscCard("SG-CO", "Chris Olave")],
      checklistOnly: [rowCard(row("101", ["Matt Shaw"]), 0)],
      resolve,
    });
    await confirm();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(confirmedCards(onConfirm)).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  test("Keep on a checklist row saves it as a card of its own: the row's number, players and teams, no marketplace link", async () => {
    const { onConfirm } = mountWire({
      sources: BSC_AND_CHECKLIST,
      checklistOnly: [
        rowCard(row("101", ["Matt Shaw"], ["Chicago Cubs"]), 0),
        rowCard(row("102", ["Jacob Wilson"]), 1),
      ],
    });

    fireEvent.click(
      screen.getByLabelText("Keep #101 Matt Shaw · Chicago Cubs as checklist-only"),
    );

    expect(screen.getByRole("heading", { name: "Checklist only (1)" })).toBeTruthy();
    expect(screen.getByText("Checklist: #101 Matt Shaw · Chicago Cubs")).toBeTruthy();
    expect(screen.getByText("1 card will be saved")).toBeTruthy();
    expect(
      screen.queryByLabelText("Keep #101 Matt Shaw · Chicago Cubs as checklist-only"),
    ).toBeNull();

    await confirm();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    // Wire-only fields come off: the commit validators are strict.
    expect(confirmedCards(onConfirm)).toEqual([
      {
        cardNumber: "101",
        cardName: "Matt Shaw",
        players: ["Matt Shaw"],
        teams: ["Chicago Cubs"],
        teamLookup: "checklist",
        platformData: {},
      },
    ]);
  });

  test("Keep all keeps every row still listed; a linked row stays linked, not kept twice", async () => {
    const resolve = vi.fn().mockResolvedValue([]);
    const { onConfirm } = mountWire({
      sources: BSC_AND_CHECKLIST,
      unmatchedBsc: [bscCard("A1", "Card One")],
      checklistOnly: [
        rowCard(row("1", ["Frank Thomas"]), 0),
        rowCard(row("2", ["Jacob Wilson"]), 1),
        rowCard(row("3", ["Matt Shaw"]), 2),
      ],
      resolve,
    });

    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas"));
    fireEvent.click(screen.getByLabelText("Link selected checklist row to #A1 Card One"));
    fireEvent.click(screen.getByLabelText("Keep all checklist-only cards"));

    expect(screen.getByRole("heading", { name: "Checklist only (0)" })).toBeTruthy();
    expect(screen.getByLabelText("Keep all checklist-only cards")).toHaveProperty("disabled", true);
    expect(screen.getByText("Checklist: #2 Jacob Wilson")).toBeTruthy();
    expect(screen.getByText("Checklist: #3 Matt Shaw")).toBeTruthy();
    expect(screen.queryByText("Checklist: #1 Frank Thomas")).toBeNull();

    await confirm();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(confirmedCards(onConfirm).map((c) => c.cardNumber)).toEqual(["A1", "2", "3"]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test("Remove on a kept row puts it back in the list, and an unkept row is dropped", async () => {
    const { onConfirm } = mountWire({
      sources: BSC_AND_CHECKLIST,
      checklistOnly: [rowCard(row("101", ["Matt Shaw"]), 0)],
    });

    fireEvent.click(screen.getByLabelText("Keep #101 Matt Shaw as checklist-only"));
    fireEvent.click(
      screen.getByLabelText("Remove checklist row #101 Matt Shaw from save list"),
    );

    expect(screen.getByRole("heading", { name: "Checklist only (1)" })).toBeTruthy();
    expect(screen.getByLabelText("Keep #101 Matt Shaw as checklist-only")).toBeTruthy();

    await confirm();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(confirmedCards(onConfirm)).toEqual([]);
  });

  test("a kept row is no longer a row to link: picking it is cleared, and it offers no Select", () => {
    mountWire({
      sources: BSC_AND_CHECKLIST,
      unmatchedBsc: [bscCard("A1", "Card One")],
      checklistOnly: [rowCard(row("101", ["Matt Shaw"]), 0)],
    });
    fireEvent.click(screen.getByLabelText("Select #101 Matt Shaw"));
    expect(screen.getByLabelText("Link selected checklist row to #A1 Card One")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Keep #101 Matt Shaw as checklist-only"));

    expect(screen.queryByLabelText("Select #101 Matt Shaw")).toBeNull();
    expect(screen.queryByLabelText("Link selected checklist row to #A1 Card One")).toBeNull();
    expect(screen.queryByLabelText("Clear selected checklist row")).toBeNull();
  });

  test("a kept row counts as the operator's work in the discard confirm", () => {
    const { onClose } = mountWire({
      sources: BSC_AND_CHECKLIST,
      checklistOnly: [rowCard(row("101", ["Matt Shaw"]), 0)],
    });
    fireEvent.click(screen.getByLabelText("Keep #101 Matt Shaw as checklist-only"));
    fireEvent.click(screen.getByLabelText("Cancel card matching"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Discard 1 pairing?")).toBeTruthy();
  });

  test("a row that streams in again is not listed twice; a new one joins", () => {
    const first = rowCard(row("101", ["Matt Shaw"]), 0);
    const { update } = mountWire({ sources: BSC_AND_CHECKLIST, checklistOnly: [first] });
    update({ checklistOnly: [first, rowCard(row("102", ["Jacob Wilson"]), 1)] });
    update({ checklistOnly: [first, rowCard(row("102", ["Jacob Wilson"]), 1)] });
    expect(screen.getByRole("heading", { name: "Checklist only (2)" })).toBeTruthy();
    expect(screen.getAllByLabelText("Select #101 Matt Shaw")).toHaveLength(1);
  });

  test("the checklist column joins when the fetch says the checklist is a source, after the dialog opened", () => {
    const { update } = mountWire({
      sources: ["bsc"],
      unmatchedBsc: [bscCard("A1", "Card One")],
    });
    expect(screen.queryByRole("heading", { name: /^Checklist only/ })).toBeNull();
    update({ sources: BSC_AND_CHECKLIST });
    expect(screen.getByRole("heading", { name: "Checklist only (0)" })).toBeTruthy();
    expect(screen.getByText("Every checklist row found its card.")).toBeTruthy();
  });
});

describe("CardPairingModal — the server's checklist pairs (NEO-496 D10)", () => {
  const linked = (
    card: PairingCard,
    link: NonNullable<PairingCard["checklistLink"]>,
  ): PairingCard => ({ ...card, checklistLink: link });

  test("a BSC card paired with a row is matched, says On checklist, offers no Unlink, and is saved without a Keep", async () => {
    const { onConfirm } = mountWire({
      sources: BSC_AND_CHECKLIST,
      unmatchedBsc: [
        linked(bscCard("FS-1", "Jackson Holliday"), { via: "number" }),
        bscCard("SG-CO", "Chris Olave"),
      ],
    });

    expect(screen.getByText(/Matched \(1\)/)).toBeTruthy();
    expandMatched();
    expect(screen.getByText("On checklist")).toBeTruthy();
    expect(screen.queryByLabelText("Unlink #FS-1 Jackson Holliday")).toBeNull();
    expect(screen.queryByLabelText("Keep #FS-1 Jackson Holliday as BSC-only")).toBeNull();
    expect(screen.getByRole("heading", { name: "BSC only (1)" })).toBeTruthy();

    await confirm();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const cards = confirmedCards(onConfirm);
    expect(cards.map((c) => c.cardNumber)).toEqual(["FS-1"]);
    expect(cards[0]).not.toHaveProperty("checklistLink");
  });

  test("a near-name pair shows its % in the chip", () => {
    mountWire({
      sources: BSC_AND_CHECKLIST,
      unmatchedBsc: [
        linked(bscCard("FS-4", "Jackson Merrill"), { via: "playerFuzzy", confidence: 0.937 }),
      ],
    });
    expandMatched();
    expect(screen.getByText("On checklist")).toBeTruthy();
    expect(screen.getByText("94%")).toBeTruthy();
  });

  test("a name pair whose numbers differ shows the row's number beside the card's own, which it keeps", async () => {
    const { onConfirm } = mountWire({
      sources: BSC_AND_CHECKLIST,
      unmatchedBsc: [
        linked(bscCard("3", "Wyatt Langford"), { via: "playerName", checklistNumber: "FS-3" }),
      ],
    });
    expandMatched();
    expect(screen.getByText("#3 Wyatt Langford")).toBeTruthy();
    expect(screen.getByText("Checklist #FS-3")).toBeTruthy();
    expect(screen.queryByText("On checklist")).toBeNull();
    // No conflict, no other note.
    expect(screen.queryByText(/conflict/i)).toBeNull();

    await confirm();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(confirmedCards(onConfirm)[0].cardNumber).toBe("3");
  });

  test("everything linked still opens and reads as lined up; Confirm saves every card", async () => {
    const { onConfirm } = mountWire({
      sources: BSC_AND_CHECKLIST,
      unmatchedBsc: [
        linked(bscCard("1", "Card One"), { via: "number" }),
        linked(bscCard("2", "Card Two"), { via: "number" }),
      ],
    });
    expect(
      screen.getByText(
        "Every card lines up across your sources. Review and confirm — no cards are saved until you do.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /^Checklist only/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^BSC only/ })).toBeNull();

    await confirm();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(confirmedCards(onConfirm).map((c) => c.cardNumber)).toEqual(["1", "2"]);
  });

  test("a checklist-paired card is not a link target for a leftover row", () => {
    mountWire({
      sources: BSC_AND_CHECKLIST,
      unmatchedBsc: [
        linked(bscCard("1", "Card One"), { via: "number" }),
        bscCard("2", "Card Two"),
      ],
      checklistOnly: [rowCard(row("9", ["Somebody"]), 0)],
    });
    fireEvent.click(screen.getByLabelText("Select #9 Somebody"));
    expect(screen.queryByLabelText("Link selected checklist row to #1 Card One")).toBeNull();
    expect(screen.getByLabelText("Link selected checklist row to #2 Card Two")).toBeTruthy();
  });

  test("three sources: unlinking a BSC + SportLots pair the checklist also paired keeps the BSC half saved with its chip", async () => {
    const pair = linked(pairedCard("7", "Seven"), { via: "number" });
    const { onConfirm } = mountWire({
      sources: ["bsc", "sportlots", "checklist"],
      autoMatched: [{ card: pair, confidence: 1 }],
    });

    fireEvent.click(screen.getByLabelText("Unlink #7 Seven"));

    expect(screen.getByRole("heading", { name: "SportLots only (1)" })).toBeTruthy();
    expect(screen.getByText("BSC: #7 Seven")).toBeTruthy();
    await confirm();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const cards = confirmedCards(onConfirm);
    expect(cards).toHaveLength(1);
    expect(cards[0].platformData).toEqual({ bsc: { ref: "bsc-7", setId: "sig-1" } });
  });
});

describe("CardPairingModal — checklist names (NEO-490)", () => {
  test("the list, filter, select, link and unlink controls carry the planned names", () => {
    mount({
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
      screen.getByRole("heading", { name: "Checklist only (2)" }),
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
      screen.getByRole("heading", { name: "Checklist only (1)" }),
    ).toBeTruthy();
  });

  test("the filter narrows the rows by their line", () => {
    mount({
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
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(plainRows(), plainKeys),
    });
    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas · Chicago White Sox"));
    fireEvent.click(screen.getByLabelText("Link selected checklist row to #A1 Card One"));

    fireEvent.click(screen.getByLabelText("Unlink checklist row #1 Frank Thomas · Chicago White Sox from #A1 Card One"));

    expect(screen.getByLabelText("Select #1 Frank Thomas · Chicago White Sox")).toBeTruthy();
    expect(screen.queryByText(/^Checklist #/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Checklist only (3)" })).toBeTruthy();
  });

  test("linking an unmatched card in a two-marketplace set keeps it, and it is saved", async () => {
    const resolve = vi.fn().mockResolvedValue([]);
    const { onConfirm } = mount({
      data: {
        unmatchedBsc: [bscCard("A1", "Card One")],
        unmatchedSl: [slCard("Z9", "Other Side")],
      },
      checklist: checklistFor([row("1", ["Frank Thomas"])], ["bsc-A1", "#Z9 Other Side"]),
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
  test("the checklist joins after the dialog opened, and a row streamed again keeps its first form and its link", () => {
    const first = checklistFor([row("1", ["Frank Thomas"])], ["bsc-A1"]);
    const second = checklistFor([row("2", ["Jacob Wilson"])], ["bsc-A1"]);
    const { update } = mount({
      data: { unmatchedBsc: [bscCard("A1", "Card One")] },
    });
    expect(screen.queryByRole("list", { name: "Leftover checklist rows" })).toBeNull();

    update({ checklist: first });
    expect(screen.getByLabelText("Select #1 Frank Thomas")).toBeTruthy();

    // The same row id arriving again does not replace the row or reset links.
    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas"));
    fireEvent.click(screen.getByLabelText("Link selected checklist row to #A1 Card One"));
    update({ checklist: second });
    expect(screen.queryByLabelText(/Select #2 /)).toBeNull();
    expect(screen.getByLabelText("Unlink checklist row #1 Frank Thomas from #A1 Card One")).toBeTruthy();
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
    const cards = confirmedCards(onConfirm);
    // NEO-496: the leftovers nobody linked or kept are dropped.
    expect(cards).toHaveLength(1);
    const [first] = cards;
    expect(first.cardNumber).toBe("A1");
    expect(first.teams).toEqual(["Chicago White Sox"]);
    expect(first.teamLookup).toBe("checklist");
    expect(first.players).toEqual(["Frank Thomas"]);
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

  test("an untouched session closes at once: the server's pairs are not the operator's work", () => {
    const { onClose } = mount({
      data: { unmatchedBsc: plainCards() },
      checklist: checklistFor(plainRows(), plainKeys),
    });
    fireEvent.click(screen.getByLabelText("Cancel card matching"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: /Discard/ })).toBeNull();
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
      data: { unmatchedBsc: [bscCard("A1", "Card One")] },
      checklist: checklistFor([row("1", ["Frank Thomas"])], ["bsc-A1"]),
    });
    fireEvent.click(screen.getByLabelText("Select #1 Frank Thomas"));
    linkTopTo("#A1 Card One");
    expect(announcer().textContent).toBe(
      "Linked checklist row 1 to #A1 Card One. Every checklist row is linked or kept.",
    );
    expect(
      screen.getByRole("heading", { name: "Checklist only (0)" }),
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
        "Linked checklist row 1 to #A1 Card One. Every checklist row is linked or kept.",
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
    expect(screen.getByRole("heading", { name: "Checklist only (3)" })).toBeTruthy();
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

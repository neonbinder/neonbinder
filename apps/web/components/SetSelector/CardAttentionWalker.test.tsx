/**
 * NEO-102 — coverage for the post-commit "needs attention" pass: the derived
 * rule, the fixer registry, and `CardAttentionWalker`'s queue.
 *
 * The queue is the part worth pinning hardest. There is no queue array in
 * state — the presented card is `remaining.find(currentId) ?? remaining[0]`
 * over a list derived from the live rows — so three behaviours all fall out of
 * one expression and all three have to be asserted separately:
 *
 *   1. fixing a card advances (the row stops satisfying the rule),
 *   2. skipping advances without writing anything,
 *   3. a row APPEARING (the background BSC team pass keeps landing for seconds
 *      after a commit, sometimes with a lower card number) does NOT move the
 *      operator off the card they are answering.
 *
 * --- Mocking strategy ---
 * convex/react is module-mocked and routed by the (string-mocked) reference,
 * mirroring EntityReviewWizard.test.tsx. `./TeamPicker` is stubbed: it has its
 * own test file (TeamPicker.test.tsx) covering the typeahead and the
 * findOrCreate "+ Create" path, so this file only verifies that the fixer
 * routes the picker's value into the write and enforces the cap around it.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    cardChecklist: {
      suggestedTeamsForCard: "cardChecklist.suggestedTeamsForCard",
      confirmCardNoTeam: "cardChecklist.confirmCardNoTeam",
    },
    selectorOptions: { updateCard: "selectorOptions.updateCard" },
    players: { getManyByIds: "players.getManyByIds" },
    teams: { getManyByIds: "teams.getManyByIds", list: "teams.list" },
  },
}));

type Suggestion = {
  teamId: string;
  name: string;
  source: "career";
  playerName: string;
};

let suggestionsByCard: Record<string, Suggestion[]>;
let playerRows: Array<{ _id: string; name: string }> | undefined;
const mockUpdateCard = vi.fn();
const mockConfirmCardNoTeam = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (ref === "cardChecklist.suggestedTeamsForCard") {
      const cardId = (args as { cardId?: string })?.cardId ?? "";
      return suggestionsByCard[cardId] ?? [];
    }
    if (ref === "players.getManyByIds") return args === "skip" ? undefined : playerRows;
    return [];
  },
  useMutation: (ref: string) => {
    if (ref === "selectorOptions.updateCard") return mockUpdateCard;
    if (ref === "cardChecklist.confirmCardNoTeam") return mockConfirmCardNoTeam;
    return vi.fn();
  },
}));

/** The picker's own behaviour lives in TeamPicker.test.tsx — see the note above. */
vi.mock("./TeamPicker", () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string[];
    onChange: (next: string[]) => void;
  }) => (
    <div>
      <span data-testid="picker-value">{value.join(",")}</span>
      <button type="button" onClick={() => onChange([...value, `extra-${value.length}`])}>
        Stub add team
      </button>
    </div>
  ),
}));

import CardAttentionWalker from "./CardAttentionWalker";
import { deriveCardAttention, needsAttention } from "./card-attention";
import {
  attentionFixers,
  pickAttentionFixer,
  unfixableReason,
  type CardChecklistRow,
} from "./cardAttentionRegistry";
import type { AttentionItem } from "./card-attention";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A stored row that needs a team: BSC-linked, its lookup has been and gone,
 * it still has no team, and no operator has answered. This is the shape of the
 * ten real teamless cards in dev's 2026 Topps base.
 */
function needsTeamRow(overrides: Partial<CardChecklistRow> = {}): CardChecklistRow {
  return {
    _id: "card-1" as unknown as Id<"cardChecklist">,
    cardNumber: "1",
    cardName: "American League Leaders ERA LL",
    platformData: { bsc: { ref: "bsc-ref-1" } },
    teamCheckDoneAt: 1_000,
    ...overrides,
  };
}

function renderWalker(cards: CardChecklistRow[], props: Record<string, unknown> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <CardAttentionWalker
      isOpen
      cards={cards}
      sportId={"sport-1" as unknown as Id<"selectorOptions">}
      onClose={onClose}
      {...props}
    />,
  );
  return { ...utils, onClose };
}

const chip = (name: string, from: string) =>
  screen.getByRole("button", { name: `${name} (from ${from}'s career)` }) as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateCard.mockResolvedValue(null);
  mockConfirmCardNoTeam.mockResolvedValue({ confirmed: true, stamped: true });
  suggestionsByCard = {};
  playerRows = undefined;
});

// ---------------------------------------------------------------------------
// The derived rule
// ---------------------------------------------------------------------------

describe("deriveCardAttention", () => {
  it("flags a BSC-linked card whose lookup ran, found no team, and nobody has answered", () => {
    expect(deriveCardAttention(needsTeamRow())).toEqual([{ kind: "missingTeam" }]);
  });

  it("does NOT flag a BSC-linked card whose lookup has not run yet", () => {
    // processBscTeamEnrichmentQueue is one detail request every 300ms, so a
    // freshly-synced 900-card set is minutes from finished. Badging every BSC
    // card during the drain would flood the checklist with items that resolve
    // themselves and train the operator to ignore the badge.
    expect(deriveCardAttention({ ...needsTeamRow(), teamCheckDoneAt: undefined })).toEqual(
      [],
    );
  });

  it("flags a CUSTOM card with no team immediately — there is no lookup to wait for", () => {
    // The case the placeholder rule got wrong: gating on teamCheckDoneAt
    // unconditionally left custom cards permanently unbadged, which is the
    // exact invisibility this ticket exists to fix. A custom card has no
    // platformData.bsc.ref, so nothing will ever stamp teamCheckDoneAt on it
    // and waiting for that stamp means waiting forever.
    const custom: CardChecklistRow = {
      _id: "card-custom" as unknown as Id<"cardChecklist">,
      cardNumber: "301",
      cardName: "Hand-added Card",
      isCustom: true,
    };
    expect(deriveCardAttention(custom)).toEqual([{ kind: "missingTeam" }]);
    expect(needsAttention(custom)).toBe(true);
  });

  it("flags a SportLots-only card immediately, for the same reason", () => {
    // SportLots' checklist scrape never attempts team extraction, so an SL ref
    // is not something to wait on either.
    expect(
      needsAttention({
        ...needsTeamRow(),
        platformData: { sportlots: { ref: "1 AL Leaders ERA LL" } },
        teamCheckDoneAt: undefined,
      }),
    ).toBe(true);
  });

  it("does NOT flag a card that has a team", () => {
    expect(
      needsAttention({
        ...needsTeamRow(),
        teamOnCardIds: ["team-1" as unknown as Id<"teams">],
      }),
    ).toBe(false);
  });

  it("does NOT flag a card an operator said has no team", () => {
    // The field that separates "nobody has answered" from "answered: none",
    // which teamCheckDoneAt alone cannot express — and the reason a re-sync
    // stops asking.
    expect(needsAttention({ ...needsTeamRow(), teamNoneConfirmedAt: 2_000 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The registry contract NEO-101 codes against
// ---------------------------------------------------------------------------

describe("attentionFixers registry", () => {
  it("resolves the missingTeam kind", () => {
    const { item, Fixer } = pickAttentionFixer([{ kind: "missingTeam" }]);
    expect(item).toEqual({ kind: "missingTeam" });
    expect(Fixer).toBe(attentionFixers.missingTeam);
  });

  it("resolves all three of NEO-101's title kinds to the one title fixer", () => {
    // One component for three kinds is the deliberate choice: they are the same
    // field with different reasons, so a card flagged for two of them is asked
    // once. See TitleFixer's own file for the reasoning.
    for (const kind of [
      "titleOverLimit",
      "titleTruncated",
      "aspectValueOverLimit",
    ] as const) {
      const { Fixer } = pickAttentionFixer([{ kind }] as unknown as AttentionItem[]);
      expect(Fixer).toBe(attentionFixers.titleOverLimit);
      expect(Fixer).toBeDefined();
    }
  });

  it("returns no fixer for an unregistered kind, without throwing", () => {
    // A bundle older than the row that carries a kind must degrade, not crash.
    // The stand-in has to be a kind NOTHING registers — this test used
    // `titleOverLimit` until NEO-101 registered it, at which point it passed
    // for the wrong reason. Cast because the kind does not exist in THIS
    // bundle's union, which is precisely the case under test.
    const unknown = [{ kind: "somethingFromTheFuture" }] as unknown as AttentionItem[];
    const { item, Fixer } = pickAttentionFixer(unknown);
    expect(Fixer).toBeUndefined();
    expect(item).toEqual({ kind: "somethingFromTheFuture" });
    expect(unfixableReason(item)).toContain("no fixer for it");
  });

  it("skips past an unregistered kind to one it can fix", () => {
    const mixed = [
      { kind: "somethingFromTheFuture" },
      { kind: "missingTeam" },
    ] as unknown as AttentionItem[];
    const { item, Fixer } = pickAttentionFixer(mixed);
    expect(item).toEqual({ kind: "missingTeam" });
    expect(Fixer).toBe(attentionFixers.missingTeam);
  });

  it("a card flagged for BOTH missingTeam and a title kind picks whichever is FIRST in the row's own item order", () => {
    // Both kinds are registered (to different components), so this is not the
    // "skip past what nothing can fix" case above — it is the tie-break rule
    // itself: `pickAttentionFixer` takes the first item its registry knows,
    // in the order `deriveCardAttention` produced them, never a fixed
    // priority between kinds. `deriveCardAttention` happens to push
    // `missingTeam` before the title kinds (see cardAttention.ts), so this
    // pins the CONSEQUENCE of that ordering as observed through the registry,
    // not the ordering itself (which is cardAttention.test.ts's job).
    const missingTeamFirst = [
      { kind: "missingTeam" },
      { kind: "titleOverLimit", length: 94 },
    ] as AttentionItem[];
    const first = pickAttentionFixer(missingTeamFirst);
    expect(first.item).toEqual({ kind: "missingTeam" });
    expect(first.Fixer).toBe(attentionFixers.missingTeam);

    // Reversing the array (not a real `deriveCardAttention` output today, but
    // the registry itself must not hard-code which kind "wins" — a fixer
    // module reordering a future item list must change this outcome too)
    // proves the choice tracks ARRAY ORDER, not a kind name comparison.
    const titleFirst = [
      { kind: "titleOverLimit", length: 94 },
      { kind: "missingTeam" },
    ] as AttentionItem[];
    const second = pickAttentionFixer(titleFirst);
    expect(second.item).toEqual({ kind: "titleOverLimit", length: 94 });
    expect(second.Fixer).toBe(attentionFixers.titleOverLimit);
  });

  it("end to end: a REAL row missing a team with an over-limit title routes to MissingTeamFixer first", () => {
    // Not a hand-built item array — the actual `deriveCardAttention` output
    // for one row, fed straight into `pickAttentionFixer`. This is the case
    // the walker itself hits: a fresh custom card with no team yet, whose
    // operator also pasted an over-length title before saving.
    const row = {
      teamOnCardIds: [],
      platformData: {},
      listingTitle: "x".repeat(94),
    };
    const items = deriveCardAttention(row);
    expect(items.map((i) => i.kind)).toEqual(["missingTeam", "titleOverLimit"]);

    const { item, Fixer } = pickAttentionFixer(items);
    expect(item).toEqual({ kind: "missingTeam" });
    expect(Fixer).toBe(attentionFixers.missingTeam);
  });
});

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

describe("CardAttentionWalker — presentation", () => {
  it("renders nothing when closed", () => {
    renderWalker([needsTeamRow()], { isOpen: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the card, its players, and the progress line", () => {
    playerRows = [
      { _id: "p1", name: "Tarik Skubal" },
      { _id: "p2", name: "Garrett Crochet" },
    ];
    renderWalker([
      needsTeamRow({ playerIds: ["p1", "p2"] as unknown as Array<Id<"players">> }),
      needsTeamRow({ _id: "card-2" as unknown as Id<"cardChecklist">, cardNumber: "2" }),
    ]);

    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
      "#1 American League Leaders ERA LL",
    );
    expect(screen.getByText(/Tarik Skubal · Garrett Crochet/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "2 cards need attention · 0 fixed",
    );
  });

  it("never renders a marketplace ref, in text or in an attribute", () => {
    // A SportLots ref IS a seller-typed description: untrusted content as well
    // as noise. Asserted against the HTML so a `title` tooltip cannot leak it.
    renderWalker([
      needsTeamRow({
        platformData: {
          bsc: { ref: "bsc-ref-1" },
          sportlots: { ref: "1 AL Leaders ERA LL [ Sliding ]" },
        },
      }),
    ]);
    expect(document.body.innerHTML).not.toContain("bsc-ref-1");
    expect(document.body.innerHTML).not.toContain("Sliding");
  });

  it("shows an all-clear step when nothing needs attention", () => {
    renderWalker([{ ...needsTeamRow(), teamNoneConfirmedAt: 5 }]);
    expect(screen.getByText(/All clear/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Done/ })).toBeTruthy();
  });

  it("preselects the suggested teams and says whose career each came from", () => {
    suggestionsByCard["card-1"] = [
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Tarik Skubal" },
    ];
    renderWalker([needsTeamRow()]);

    expect(chip("Detroit Tigers", "Tarik Skubal").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByTestId("picker-value").textContent).toBe("team-tigers");
  });

  it("renders one chip per team when two players share it", () => {
    suggestionsByCard["card-1"] = [
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Tarik Skubal" },
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Riley Greene" },
    ];
    renderWalker([needsTeamRow()]);

    expect(chip("Detroit Tigers", "Tarik Skubal and Riley Greene")).toBeTruthy();
    expect(screen.getByTestId("picker-value").textContent).toBe("team-tigers");
  });
});

// ---------------------------------------------------------------------------
// Writes + advance
// ---------------------------------------------------------------------------

describe("CardAttentionWalker — fixing a card", () => {
  it("Enter saves the preselected chips and the queue advances to the next card", async () => {
    suggestionsByCard["card-1"] = [
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Tarik Skubal" },
      { teamId: "team-sox", name: "Boston Red Sox", source: "career", playerName: "Garrett Crochet" },
    ];
    const rows = [
      needsTeamRow(),
      needsTeamRow({
        _id: "card-2" as unknown as Id<"cardChecklist">,
        cardNumber: "2",
        cardName: "NL Leaders ERA LL",
      }),
    ];
    const { rerender, onClose } = renderWalker(rows);

    // Enter from inside the panel (not on a button — Enter on a focused button
    // already activates it, and focus starts on a chip).
    fireEvent.keyDown(screen.getByRole("heading", { level: 3 }), { key: "Enter" });

    await waitFor(() =>
      expect(mockUpdateCard).toHaveBeenCalledWith({
        // `id`, not `cardId`: that is what convex/selectorOptions.ts's
        // updateCard declares, and Convex arg validators are strict.
        id: rows[0]._id,
        teamOnCardIds: ["team-tigers", "team-sox"],
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("1 fixed"),
    );

    // The write lands in the database, the row stops satisfying the rule, and
    // THAT is what advances the walker — nothing calls "next".
    rerender(
      <CardAttentionWalker
        isOpen
        cards={[
          { ...rows[0], teamOnCardIds: ["team-tigers"] as unknown as Array<Id<"teams">> },
          rows[1],
        ]}
        sportId={"sport-1" as unknown as Id<"selectorOptions">}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
      "#2 NL Leaders ERA LL",
    );
  });

  it("toggling a chip off keeps it out of the write", async () => {
    suggestionsByCard["card-1"] = [
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Tarik Skubal" },
      { teamId: "team-sox", name: "Boston Red Sox", source: "career", playerName: "Garrett Crochet" },
    ];
    const row = needsTeamRow();
    renderWalker([row]);

    fireEvent.click(chip("Detroit Tigers", "Tarik Skubal"));
    fireEvent.click(screen.getByRole("button", { name: "Save & Next (Enter)" }));

    await waitFor(() =>
      expect(mockUpdateCard).toHaveBeenCalledWith({
        id: row._id,
        teamOnCardIds: ["team-sox"],
      }),
    );
  });

  it("saves a team added through the picker alongside the chips", async () => {
    suggestionsByCard["card-1"] = [
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Tarik Skubal" },
    ];
    const row = needsTeamRow();
    renderWalker([row]);

    fireEvent.click(screen.getByRole("button", { name: "Stub add team" }));
    fireEvent.click(screen.getByRole("button", { name: "Save & Next (Enter)" }));

    await waitFor(() =>
      expect(mockUpdateCard).toHaveBeenCalledWith({
        id: row._id,
        teamOnCardIds: ["team-tigers", "extra-1"],
      }),
    );
  });

  // NEO-102: the picker's popover overlaid "Save & Next (Enter)", so the click
  // meant for Save landed on a typeahead option and added a SECOND team
  // instead of saving. The overlay itself is fixed and pinned in
  // TeamPicker.test.tsx (outside-click close — jsdom has no layout, so it
  // cannot be reproduced from here); this pins the outcome that regressed:
  // one pick, one save, one team.
  it("after picking a team, Save & Next writes exactly that team — once", async () => {
    const row = needsTeamRow();
    renderWalker([row]);

    fireEvent.click(screen.getByRole("button", { name: "Stub add team" }));
    expect(screen.getByTestId("picker-value").textContent).toBe("extra-0");

    fireEvent.click(screen.getByRole("button", { name: "Save & Next (Enter)" }));

    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1));
    expect(mockUpdateCard).toHaveBeenCalledWith({
      id: row._id,
      teamOnCardIds: ["extra-0"],
    });
  });

  it("'No team on this card' records the explicit answer instead of a team list", async () => {
    const row = needsTeamRow();
    renderWalker([row]);

    fireEvent.click(screen.getByRole("button", { name: "No team on this card" }));

    await waitFor(() =>
      expect(mockConfirmCardNoTeam).toHaveBeenCalledWith({ cardId: row._id }),
    );
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  it("'No team on this card' stays in the tab order while its own request is in flight", async () => {
    // NEO-189's audit found a Confirm that natively-disabled itself the
    // instant it went inert, dropping out of the tab order and stranding
    // focus with no route to the reason. This button is the same shape of
    // control (it sets `busy`, which used to natively-disable it too) — the
    // fix is aria-disabled, same as Save.
    let resolveConfirm!: (v: { confirmed: boolean; stamped: boolean }) => void;
    mockConfirmCardNoTeam.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveConfirm = resolve;
      }),
    );
    renderWalker([needsTeamRow()]);

    const noTeamBtn = screen.getByRole("button", {
      name: "No team on this card",
    }) as HTMLButtonElement;
    fireEvent.click(noTeamBtn);

    await waitFor(() => expect(noTeamBtn.textContent).toBe("No team on this card"));
    // Still reachable — not the native `disabled` attribute, which would pull
    // it out of the tab order entirely.
    expect(noTeamBtn.disabled).toBe(false);

    resolveConfirm({ confirmed: true, stamped: true });
    await waitFor(() => expect(mockConfirmCardNoTeam).toHaveBeenCalledTimes(1));
  });

  it("a blocked chip at the cap is described by the cap notice, for a screen-reader user landing on it directly", () => {
    suggestionsByCard["card-1"] = Array.from({ length: 9 }, (_, i) => ({
      teamId: `team-${i + 1}`,
      name: `Team ${i + 1}`,
      source: "career" as const,
      playerName: "Someone",
    }));
    renderWalker([needsTeamRow()]);

    const ninth = chip("Team 9", "Someone");
    expect(ninth.getAttribute("aria-describedby")).toBe("attention-team-cap");
    const cap = document.getElementById("attention-team-cap");
    expect(cap).toBeTruthy();
    expect(cap?.textContent).toContain("limit of 8 teams");

    // A chip that IS chosen is never "blocked" even at the cap — removing one
    // of the eight is always legal, so it carries no such description.
    const first = chip("Team 1", "Someone");
    expect(first.getAttribute("aria-describedby")).toBeNull();
  });

  it("counts an already-confirmed card as answered (confirmed, not stamped)", async () => {
    // Another tab, or a double-press, got there first. Nothing was written by
    // THIS call, but the card is answered — so it still advances.
    mockConfirmCardNoTeam.mockResolvedValueOnce({ confirmed: true, stamped: false });
    renderWalker([
      needsTeamRow(),
      needsTeamRow({
        _id: "card-2" as unknown as Id<"cardChecklist">,
        cardNumber: "2",
        cardName: "NL Leaders ERA LL",
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "No team on this card" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
        "#2 NL Leaders ERA LL",
      ),
    );
    expect(screen.getByRole("status").textContent).toContain("1 fixed");
  });

  it("does NOT count a REFUSED confirmation as fixed, and says why", async () => {
    // The mutation refuses rather than throws when the row has gained teams or
    // is gone — a race against another tab or the background BSC pass.
    // Advancing here would report a card as answered when nothing was written.
    mockConfirmCardNoTeam.mockResolvedValueOnce({ confirmed: false, stamped: false });
    renderWalker([needsTeamRow()]);

    fireEvent.click(screen.getByRole("button", { name: "No team on this card" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("has teams now");
    expect(screen.getByRole("status").textContent).toContain("0 fixed");
    // Still on the same card, still counted as needing attention.
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
      "#1 American League Leaders ERA LL",
    );
    expect(screen.getByRole("status").textContent).toContain("1 card needs attention");
  });

  it("advances the moment the write lands, without waiting for the subscription", async () => {
    // A write and the client's subscription update are not the same instant.
    // Without the session's own record of what it answered, the card would
    // flash back on screen in between.
    suggestionsByCard["card-1"] = [
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Tarik Skubal" },
    ];
    renderWalker([
      needsTeamRow(),
      needsTeamRow({
        _id: "card-2" as unknown as Id<"cardChecklist">,
        cardNumber: "2",
        cardName: "NL Leaders ERA LL",
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Save & Next (Enter)" }));

    // `cards` is unchanged — no rerender with the fixed row.
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
        "#2 NL Leaders ERA LL",
      ),
    );
  });

  it("does not save with nothing chosen, and the primary stays in the tab order", () => {
    renderWalker([needsTeamRow()]);

    const save = screen.getByRole("button", {
      name: "Save & Next (Enter)",
    }) as HTMLButtonElement;
    // NEO-189: a natively-disabled primary leaves the tab order and strands
    // focus with no route to the reason it is inert.
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.disabled).toBe(false);

    fireEvent.click(save);
    fireEvent.keyDown(screen.getByRole("heading", { level: 3 }), { key: "Enter" });
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  it("surfaces a rejected write instead of swallowing it", async () => {
    suggestionsByCard["card-1"] = [
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Tarik Skubal" },
    ];
    mockUpdateCard.mockRejectedValueOnce(new Error("not an admin"));
    renderWalker([needsTeamRow()]);

    fireEvent.click(screen.getByRole("button", { name: "Save & Next (Enter)" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("not an admin");
  });

  it("caps the write at 8 teams and says so", () => {
    suggestionsByCard["card-1"] = Array.from({ length: 9 }, (_, i) => ({
      teamId: `team-${i + 1}`,
      name: `Team ${i + 1}`,
      source: "career" as const,
      playerName: "Someone",
    }));
    renderWalker([needsTeamRow()]);

    // Preselection itself respects the cap.
    expect(screen.getByTestId("picker-value").textContent?.split(",")).toHaveLength(8);
    expect(screen.getByText(/limit of 8 teams on one card/)).toBeTruthy();

    // A ninth is refused, not silently swapped in for one of the eight.
    fireEvent.click(screen.getByRole("button", { name: "Stub add team" }));
    expect(screen.getByTestId("picker-value").textContent?.split(",")).toHaveLength(8);

    // The unchosen chip stays reachable so the notice explaining why is too.
    const ninth = chip("Team 9", "Someone");
    expect(ninth.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(ninth);
    expect(screen.getByTestId("picker-value").textContent?.split(",")).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// Skip, close, and a queue that changes underneath
// ---------------------------------------------------------------------------

describe("CardAttentionWalker — deferring", () => {
  it("Skip advances without writing anything", () => {
    const rows = [
      needsTeamRow(),
      needsTeamRow({
        _id: "card-2" as unknown as Id<"cardChecklist">,
        cardNumber: "2",
        cardName: "NL Leaders ERA LL",
      }),
    ];
    renderWalker(rows);

    fireEvent.click(screen.getByRole("button", { name: "Skip card 1 for now" }));

    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
      "#2 NL Leaders ERA LL",
    );
    expect(mockUpdateCard).not.toHaveBeenCalled();
    expect(mockConfirmCardNoTeam).not.toHaveBeenCalled();
    // Skipping is not a write, so the card still counts as needing attention —
    // it keeps its badge in the grid and comes back next time.
    expect(screen.getByRole("status").textContent).toContain("1 card needs attention");
  });

  it("Escape closes and defers the rest", () => {
    const { onClose } = renderWalker([needsTeamRow()]);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  it("the Close button closes too", () => {
    const { onClose } = renderWalker([needsTeamRow()]);
    fireEvent.click(screen.getByRole("button", { name: /Close/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a row appearing mid-answer does not move the operator off the card on screen", () => {
    // The background BSC team pass keeps landing for seconds after a commit,
    // and a card it flags can sort BEFORE the one being answered. Without the
    // currentId pin the walker would follow remaining[0] and swap the card out
    // from under the operator.
    const onScreen = needsTeamRow({
      _id: "card-5" as unknown as Id<"cardChecklist">,
      cardNumber: "5",
      cardName: "On Screen",
    });
    const { rerender, onClose } = renderWalker([onScreen]);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("#5 On Screen");

    rerender(
      <CardAttentionWalker
        isOpen
        cards={[
          needsTeamRow({
            _id: "card-2" as unknown as Id<"cardChecklist">,
            cardNumber: "2",
            cardName: "Arrived Later",
          }),
          onScreen,
        ]}
        sportId={"sport-1" as unknown as Id<"selectorOptions">}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("#5 On Screen");
    expect(screen.getByRole("status").textContent).toContain("2 cards need attention");
  });

  it("falls through to the all-clear step when the last card is fixed elsewhere, and does not strand focus on <body>", async () => {
    // The chip that had focus (MissingTeamFixer's own control) unmounts along
    // with the whole fixer once `current` has nowhere left to point — nothing
    // else in the all-clear branch is focusable, so without the walker's own
    // advance-time park, focus would blur straight to <body> with the dialog
    // still open. See the audit-fix comment above the effect in
    // CardAttentionWalker.tsx.
    const row = needsTeamRow();
    const { rerender, onClose } = renderWalker([row]);
    expect(screen.getByRole("heading", { level: 3 })).toBeTruthy();
    // Let the fixer's own mount-time focus (and the walker's one-shot open
    // fallback) settle onto the chip first — a real animation frame always
    // elapses before an operator's next action, and collapsing that gap is
    // what let a STALE, already-scheduled fallback from the open effect win
    // the race against this test's own assertion below.
    await waitFor(() => expect(document.activeElement?.tagName).toBe("BUTTON"));

    rerender(
      <CardAttentionWalker
        isOpen
        cards={[{ ...row, teamNoneConfirmedAt: 9 }]}
        sportId={"sport-1" as unknown as Id<"selectorOptions">}
        onClose={onClose}
      />,
    );

    expect(screen.getByText(/All clear/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Skip card/ })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("dialog")));
  });
});

// ---------------------------------------------------------------------------
// Keyboard-only
// ---------------------------------------------------------------------------

describe("CardAttentionWalker — keyboard-only", () => {
  it("lands focus on the first suggestion chip on every advance", async () => {
    suggestionsByCard["card-1"] = [
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Tarik Skubal" },
    ];
    suggestionsByCard["card-2"] = [
      { teamId: "team-sox", name: "Boston Red Sox", source: "career", playerName: "Garrett Crochet" },
    ];
    renderWalker([
      needsTeamRow(),
      needsTeamRow({ _id: "card-2" as unknown as Id<"cardChecklist">, cardNumber: "2" }),
    ]);

    await waitFor(() =>
      expect(document.activeElement).toBe(chip("Detroit Tigers", "Tarik Skubal")),
    );

    fireEvent.click(screen.getByRole("button", { name: "Skip card 1 for now" }));

    // Focus follows the new card rather than staying on a control that
    // belonged to the one just deferred.
    await waitFor(() =>
      expect(document.activeElement).toBe(chip("Boston Red Sox", "Garrett Crochet")),
    );
  });

  it("runs the whole fix from the keyboard: toggle with Enter, save with Enter", async () => {
    suggestionsByCard["card-1"] = [
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Tarik Skubal" },
    ];
    const row = needsTeamRow();
    renderWalker([row]);

    const first = chip("Detroit Tigers", "Tarik Skubal");
    await waitFor(() => expect(document.activeElement).toBe(first));

    // Enter on a focused chip toggles it (native button activation) and must
    // NOT also save — that is what the BUTTON guard in the fixer is for.
    fireEvent.keyDown(first, { key: "Enter" });
    fireEvent.click(first);
    expect(mockUpdateCard).not.toHaveBeenCalled();
    expect(first.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(first);
    fireEvent.keyDown(screen.getByRole("heading", { level: 3 }), { key: "Enter" });

    await waitFor(() =>
      expect(mockUpdateCard).toHaveBeenCalledWith({
        id: row._id,
        teamOnCardIds: ["team-tigers"],
      }),
    );
  });

  it("keeps Tab inside the dialog", () => {
    renderWalker([needsTeamRow()]);
    const dialog = screen.getByRole("dialog");
    const focusable = dialog.querySelectorAll<HTMLElement>("button:not([disabled])");
    const last = focusable[focusable.length - 1];
    last.focus();

    fireEvent.keyDown(dialog, { key: "Tab" });

    expect(document.activeElement).toBe(focusable[0]);
  });
});

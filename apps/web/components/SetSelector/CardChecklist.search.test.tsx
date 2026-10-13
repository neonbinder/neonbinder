/**
 * NEO-343 — the checklist search box.
 *
 * Pinned here: the field's and clear button's names (E2E targets them), that
 * typing filters the rendered rows live, the number prefix rule end to end,
 * team and player names read through `getManyByIds` only once the field has
 * been focused, the count in a polite live region, the empty state, Escape and
 * the clear button, that search ANDs with the source filter and the
 * cross-release toggle, variations, the scroll back to the top, and that every
 * badge and sub-line string the REAL row prints is findable.
 *
 * The matcher's own rule (each field, AND/OR, "#", accents, platform aliases)
 * is pinned in lib/cards/card-search.test.ts.
 *
 * The REAL `CardChecklistItem` renders the rows, so its per-row team read
 * (`teams.getManyByIds`) goes through the same mock — which honours its `ids`
 * argument, so a row only ever shows its own teams.
 */

import {
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import React, { useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import { cardMatchesSearch } from "../../lib/cards/card-search";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getCardChecklist: "getCardChecklist",
      getSelectorOptionById: "getSelectorOptionById",
      getAncestorChain: "getAncestorChain",
      fetchCardChecklist: "fetchCardChecklist",
      diffChecklistAgainstExisting: "diffChecklistAgainstExisting",
      resolveChecklistEntities: "resolveChecklistEntities",
      commitCardChecklist: "commitCardChecklist",
      addCustomCard: "addCustomCard",
      deleteCard: "deleteCard",
      removeCrossListing: "removeCrossListing",
    },
    checklistCandidates: {
      getReadyCandidates: "getReadyCandidates",
      discardCandidates: "discardCandidates",
    },
    marketplacePause: { getPausedPlatforms: "getPausedPlatforms" },
    entityReviewSkips: { listForSet: "entityReviewSkips.listForSet" },
    teams: { getManyByIds: "teams.getManyByIds" },
    players: { getManyByIds: "players.getManyByIds" },
  },
}));

const scrollToIndex = vi.fn();

vi.mock("react-virtuoso", () => ({
  Virtuoso: function VirtuosoStub({
    data,
    itemContent,
    ref,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => React.ReactNode;
    ref?: React.Ref<unknown>;
  }) {
    useImperativeHandle(ref, () => ({ scrollToIndex }));
    return (
      <div data-testid="virtuoso">
        {data.map((item, i) => (
          <div key={i}>{itemContent(i, item)}</div>
        ))}
      </div>
    );
  },
}));

vi.mock("./CardDetailPanel", () => ({ default: () => null }));
vi.mock("./EntityReviewWizard", () => ({ default: () => null }));
vi.mock("./CardPairingModal", () => ({ default: () => null }));
vi.mock("./sync-review-modal", () => ({
  default: () => null,
  needsSyncReview: () => false,
}));
vi.mock("./CrossListingImportModal", () => ({ default: () => null }));
vi.mock("./CardAttentionWalker", () => ({ default: () => null }));
vi.mock("./SkippedNamesPanel", () => ({ default: () => null }));
vi.mock("./TeamPicker", () => ({ default: () => null }));
vi.mock("./PlayerPicker", () => ({ default: () => null }));

type Row = { _id: string; name: string; location?: string };

const state: {
  cards: unknown[];
  teams: Row[];
  players: Row[];
} = { cards: [], teams: [], players: [] };

/** Every `getManyByIds` call the checklist itself made with real args. */
const lookupCalls: Array<{ ref: string; ids: string[] }> = [];

function byIds(rows: Row[], args: unknown) {
  if (args === "skip") return undefined;
  const ids = (args as { ids: string[] }).ids;
  return rows.filter((r) => ids.includes(r._id));
}

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (ref === "getCardChecklist") return state.cards;
    if (ref === "getSelectorOptionById") return { value: "Base" };
    if (ref === "getAncestorChain") return [];
    if (ref === "getReadyCandidates") return null;
    if (ref === "getPausedPlatforms") return [];
    if (ref === "entityReviewSkips.listForSet") return [];
    if (ref === "teams.getManyByIds" || ref === "players.getManyByIds") {
      if (args !== "skip") {
        lookupCalls.push({ ref, ids: (args as { ids: string[] }).ids });
      }
      return byIds(ref === "teams.getManyByIds" ? state.teams : state.players, args);
    }
    return undefined;
  },
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
  useConvex: () => ({ query: vi.fn(), action: vi.fn() }),
}));

import CardChecklist from "./CardChecklist";
import CardChecklistItem from "./CardChecklistItem";

const VARIANT_ID = "variant-1" as unknown as Id<"selectorOptions">;

function card(
  n: string,
  name: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    _id: `card-${n}` as unknown as Id<"cardChecklist">,
    selectorOptionId: VARIANT_ID,
    cardNumber: n,
    cardName: name,
    // Teamed and settled, so no attention row joins the toolbar.
    teamOnCardIds: ["team-sd"],
    platformData: {},
    sortOrder: 0,
    lastUpdated: 1_000,
    ...overrides,
  };
}

function ui(sourceChips = {}) {
  return (
    <CardChecklist
      variantId={VARIANT_ID}
      sourceChips={sourceChips}
      sourceLabelMaps={{ bsc: {}, sportlots: {} }}
    />
  );
}

const searchBox = () => screen.getByRole("searchbox", { name: "Search cards" });
const status = () =>
  document.querySelector<HTMLElement>('[role="status"][data-card-search-status]')!;
/** Card numbers of the rows on screen, read off each row's Edit button. */
const shownNumbers = () =>
  screen
    .queryAllByRole("button", { name: /^Edit card / })
    .map((b) => b.getAttribute("aria-label")!.replace(/^Edit card ([^,]+).*$/, "$1"));

function type(query: string) {
  fireEvent.change(searchBox(), { target: { value: query } });
}

describe("CardChecklist — search (NEO-343)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lookupCalls.length = 0;
    state.teams = [
      { _id: "team-sd", name: "Padres", location: "San Diego" },
      { _id: "team-ne", name: "Patriots", location: "New England" },
    ];
    state.players = [{ _id: "player-tb", name: "Tom Brady" }];
    state.cards = [
      card("1", "Fernando Tatís Jr."),
      card("6", "Manny Machado"),
      card("6a", "Manny Machado SP", { attributes: ["SP"] }),
      card("16a", "Yu Darvish"),
      card("60", "Rob Gronkowski", { teamOnCardIds: ["team-ne"] }),
      card("99", "League Leaders", {
        playerIds: ["player-tb"],
        platformData: { sportlots: { ref: "sl-99" } },
      }),
    ];
  });

  it("is a search field named 'Search cards' with no DOM id, and nothing to clear yet", () => {
    render(ui());
    const box = searchBox();
    expect(box.getAttribute("type")).toBe("search");
    expect(box.getAttribute("aria-label")).toBe("Search cards");
    // maestro-web's resource-id is `node.id || ariaLabel`.
    expect(box.id).toBe("");
    expect(screen.queryByRole("button", { name: "Clear card search" })).toBeNull();
    expect(status().textContent).toBe("");
    expect(shownNumbers()).toEqual(["1", "6", "6a", "16a", "60", "99"]);
  });

  it("filters the rows as you type; the number is a prefix match", async () => {
    render(ui());
    type("6a");
    expect(shownNumbers()).toEqual(["6a"]);
    type("#6");
    // 6, 6a and 60 — never 16a.
    expect(shownNumbers()).toEqual(["6", "6a", "60"]);
    expect(await screen.findByText("3 of 6 cards")).toBe(status());
  });

  it("matches the card name, accent-insensitively, and ANDs the terms", () => {
    render(ui());
    type("tatis");
    expect(shownNumbers()).toEqual(["1"]);
    type("machado sp");
    expect(shownNumbers()).toEqual(["6a"]);
  });

  it("reads team and player names only once the field is focused, then finds by them", () => {
    render(ui());
    const allTeams = ["team-ne", "team-sd"];
    const checklistLevel = () =>
      lookupCalls.filter(
        (c) =>
          (c.ref === "teams.getManyByIds" && c.ids.join() === allTeams.join()) ||
          c.ref === "players.getManyByIds",
      );
    expect(checklistLevel()).toEqual([]);

    fireEvent.focus(searchBox());
    expect(checklistLevel().some((c) => c.ref === "players.getManyByIds")).toBe(true);

    type("new england");
    expect(shownNumbers()).toEqual(["60"]);
    type("brady");
    expect(shownNumbers()).toEqual(["99"]);
  });

  it("finds by platform from the row's own filled slots", () => {
    render(ui());
    type("SportLots");
    expect(shownNumbers()).toEqual(["99"]);
    type("bsc");
    expect(shownNumbers()).toEqual([]);
  });

  it("shows an empty state and a zero count, and keeps the field, when nothing matches", async () => {
    render(ui());
    type("zzz");
    expect(screen.queryByTestId("virtuoso")).toBeNull();
    expect(screen.getByText('No cards match "zzz".')).toBeTruthy();
    expect(searchBox()).toBeTruthy();
    expect(await screen.findByText("0 of 6 cards")).toBe(status());
    // The checklist's own empty state (and its Fetch button) is not shown.
    expect(screen.queryByText("No cards in this checklist yet.")).toBeNull();
  });

  it("singular total: '1 of 1 card'", async () => {
    state.cards = [card("1", "Fernando Tatís Jr.")];
    render(ui());
    type("1");
    expect(await screen.findByText("1 of 1 card")).toBe(status());
  });

  it("Escape clears the query and keeps focus; with nothing to clear it is left alone", () => {
    render(ui());
    const box = searchBox();
    box.focus();
    type("6a");
    const consumed = !fireEvent.keyDown(box, { key: "Escape" });
    expect(consumed).toBe(true);
    expect((box as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(box);
    expect(shownNumbers()).toHaveLength(6);
    expect(status().textContent).toBe("");
    // Empty: not prevented, so a listener above still gets it.
    expect(fireEvent.keyDown(box, { key: "Escape" })).toBe(true);
  });

  it("the clear button empties the query and returns focus to the field", () => {
    render(ui());
    type("gronk");
    fireEvent.click(screen.getByRole("button", { name: "Clear card search" }));
    expect((searchBox() as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(searchBox());
    expect(screen.queryByRole("button", { name: "Clear card search" })).toBeNull();
  });

  it("ANDs with the cross-release toggle", async () => {
    state.cards = [
      ...state.cards,
      card("61", "Gronk Guest", {
        isCrossListed: true,
        crossListingId: "xl-1",
        homeSetLabel: "2021 Topps Update",
      }),
    ];
    render(ui());
    type("gronk");
    expect(shownNumbers()).toEqual(["60", "61"]);
    fireEvent.click(screen.getByRole("button", { name: /^Hide cross-release cards/ }));
    expect(shownNumbers()).toEqual(["60"]);
    // Seven cards, the guest hidden: one match of the six left.
    expect(await screen.findByText("1 of 6 cards")).toBe(status());
  });

  it("ANDs with the source filter, and counts against what the filter left", async () => {
    state.cards = [
      card("6", "Manny Machado", { platformData: { bsc: { ref: "b6", src: "s0" } } }),
      card("6a", "Manny Machado SP", {
        platformData: { bsc: { ref: "b6a", src: "s1" } },
      }),
      card("7", "Juan Soto", { platformData: { bsc: { ref: "b7", src: "s1" } } }),
    ];
    render(
      ui({
        bsc: {
          primaryId: "s0",
          chips: [
            { id: "s0", label: "Base" },
            { id: "s1", label: "Update" },
          ],
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Filter source: Update/ }));
    expect(shownNumbers()).toEqual(["6a", "7"]);
    type("machado");
    expect(shownNumbers()).toEqual(["6a"]);
    expect(await screen.findByText("1 of 2 cards")).toBe(status());
  });

  it("variations: a match under a matching parent is listed open; a lone match stands on its own", () => {
    state.cards = [
      card("6", "Manny Machado"),
      card("6a", "Manny Machado Variation", { variationOfCardId: "card-6" }),
      card("7", "Juan Soto"),
    ];
    render(ui());
    // Collapsed by default: the variation is behind its parent.
    expect(shownNumbers()).toEqual(["6", "7"]);
    type("machado");
    expect(shownNumbers()).toEqual(["6", "6a"]);
    // The disclosure is withdrawn while every match is already showing.
    expect(screen.queryByRole("button", { name: /variations? of card/ })).toBeNull();
    type("6a");
    expect(shownNumbers()).toEqual(["6a"]);
    expect(screen.getByText(/Variation of #6/)).toBeTruthy();
  });

  it("scrolls back to the top on a new query, never on mount", () => {
    render(ui());
    expect(scrollToIndex).not.toHaveBeenCalled();
    type("m");
    expect(scrollToIndex).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 0, align: "start" }),
    );
  });
});

describe("what the row shows is what search finds (NEO-343)", () => {
  // Every attribute token `badgeLabel` in CardChecklistItem.tsx gives its own
  // text. A new one there that the matcher does not know fails here.
  const TOKENS = ["RC", "AU", "RELIC", "SP", "SSP", "NUM", "unmatched-bsc", "unmatched-sl", "VAR"];

  beforeEach(() => {
    state.teams = [{ _id: "team-ne", name: "Patriots", location: "New England" }];
  });

  it.each(TOKENS)("the '%s' badge's text finds its card", (token) => {
    const c = card("1", "Somebody", { attributes: [token], teamOnCardIds: [] });
    const { container } = render(<CardChecklistItem card={c} onEdit={() => {}} />);
    const badges = [...container.querySelectorAll("span.rounded.border")];
    expect(badges).toHaveLength(1);
    const text = badges[0].textContent!;
    expect(cardMatchesSearch(c, text)).toBe(true);
  });

  it("each part of the sub-line, and each platform badge, finds its card", () => {
    const c = card("1", "Rob Gronkowski", {
      teamOnCardIds: ["team-ne"],
      pendingTeamNames: ["Wisconsin Badgers"],
      printRun: 99,
      cardVariation: "Gold Refractor",
      features: { autographed: "On-Card" },
      platformData: { bsc: { ref: "b1" }, sportlots: { ref: "s1" } },
    });
    const { container } = render(<CardChecklistItem card={c} onEdit={() => {}} />);
    const row = within(container as HTMLElement);
    const subLine = row.getByText(/\/99/).textContent!;
    const parts = subLine.split(" · ");
    expect(parts).toEqual([
      "New England Patriots",
      "Wisconsin Badgers (unconfirmed)",
      "/99",
      "Gold Refractor",
      "On-Card auto",
    ]);
    const lookups = {
      teamNames: new Map([["team-ne", "New England Patriots"]]),
      playerNames: new Map<string, string>(),
    };
    for (const part of [...parts, "SL", "BSC"]) {
      expect(cardMatchesSearch(c, part, lookups)).toBe(true);
    }
  });
});

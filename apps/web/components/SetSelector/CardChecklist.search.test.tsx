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
 * The matcher's own rule (each field, AND/OR, "#", accents, platform aliases,
 * the "attention" keyword) is pinned in lib/cards/card-search.test.ts. Here,
 * "attention" is pinned against the checklist's own "N need you" pill.
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

// A visible stand-in, so "the panel is open" is observable.
vi.mock("./CardDetailPanel", () => ({
  default: ({ card }: { card: { cardNumber: string } }) => (
    <div role="dialog" aria-label={`Card detail stand-in ${card.cardNumber}`} />
  ),
}));
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
    // Teamed, its player linked (NEO-339), and settled, so no attention row
    // joins the toolbar.
    teamOnCardIds: ["team-sd"],
    playerIds: ["player-1"],
    platformData: {},
    sortOrder: 0,
    lastUpdated: 1_000,
    ...overrides,
  };
}

/** The fixture as the row's prop type (its ids are plain strings here). */
const asRow = (c: ReturnType<typeof card>) =>
  c as unknown as React.ComponentProps<typeof CardChecklistItem>["card"];

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

  it("'attention' lists exactly the cards the 'need you' pill counts, and ANDs with other terms", async () => {
    state.cards = [
      card("1", "Fernando Tatís Jr."),
      card("6", "Manny Machado"),
      // No team on file and no automatic source for one: the pill's rule
      // (`needsAttention`) flags both.
      card("16a", "Yu Darvish", { teamOnCardIds: [] }),
      card("60", "Rob Gronkowski", { teamOnCardIds: [] }),
      // Its own text says "attention"; it needs nobody.
      card("70", "Attention Grabbers"),
    ];
    render(ui());
    // The set-level pill counts the same two.
    expect(screen.getByRole("button", { name: "2 need you" })).toBeTruthy();

    type("Attention");
    expect(shownNumbers()).toEqual(["16a", "60"]);
    expect(await screen.findByText("2 of 5 cards")).toBe(status());

    type("attention gronk");
    expect(shownNumbers()).toEqual(["60"]);

    // A card that needs attention but does not match the other term.
    type("attention machado");
    expect(shownNumbers()).toEqual([]);
    expect(screen.getByText('No cards match "attention machado".')).toBeTruthy();
  });

  it("'attention' on a set where nothing needs a person is the empty state", async () => {
    render(ui());
    // Every fixture card is teamed and settled: no pill.
    expect(screen.queryByRole("button", { name: /need(s)? you$/ })).toBeNull();
    type("attention");
    expect(screen.queryByTestId("virtuoso")).toBeNull();
    expect(screen.getByText('No cards match "attention".')).toBeTruthy();
    expect(await screen.findByText("0 of 6 cards")).toBe(status());
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

  it("a search that drops the open card closes its panel for good; clearing does not bring it back", () => {
    render(ui());
    const panel = () => screen.queryByRole("dialog", { name: /^Card detail stand-in/ });
    fireEvent.click(screen.getByRole("button", { name: /^Edit card 6a,/ }));
    expect(panel()?.getAttribute("aria-label")).toBe("Card detail stand-in 6a");

    // Still a match: the panel stays.
    searchBox().focus();
    type("6a");
    expect(panel()).not.toBeNull();

    type("gronk");
    expect(panel()).toBeNull();
    // Cleared by the clear button and by an emptied field alike.
    fireEvent.click(screen.getByRole("button", { name: "Clear card search" }));
    expect(shownNumbers()).toContain("6a");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(searchBox());

    type("gronk");
    type("");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(searchBox());
  });

  it("the field is the panel-surface field, with the agreed placeholder", () => {
    render(ui());
    const box = searchBox() as HTMLInputElement;
    expect(box.placeholder).toBe("Number, name, team or feature");
    // Follows the checklist card (`bg-white dark:bg-gray-800`), not the
    // primitive's always-dark default.
    expect(box.classList.contains("bg-white")).toBe(true);
    expect(box.classList.contains("dark:bg-gray-900")).toBe(true);
    expect(box.classList.contains("bg-slate-900")).toBe(false);
  });

  it("sits in a search landmark; the clear button has no tooltip to drift from its name", () => {
    render(ui());
    const landmark = screen.getByRole("search");
    expect(within(landmark).getByRole("searchbox", { name: "Search cards" })).toBe(searchBox());
    expect(landmark.getAttribute("aria-label")).toBeNull();
    type("x");
    const clear = screen.getByRole("button", { name: "Clear card search" });
    expect(clear.getAttribute("title")).toBeNull();
    expect(clear.id).toBe("");
    expect(clear.classList.contains("h-7")).toBe(true);
    expect(clear.classList.contains("w-7")).toBe(true);
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
    // An "SL only" / "BSC only" card is linked on that side, as a synced
    // one always is: an exact "sl" / "bsc" term reads the platform slot.
    const platformData =
      token === "unmatched-bsc"
        ? { sportlots: { ref: "s1" } }
        : token === "unmatched-sl"
          ? { bsc: { ref: "b1" } }
          : {};
    const c = card("1", "Somebody", {
      attributes: [token],
      teamOnCardIds: [],
      platformData,
    });
    const { container } = render(<CardChecklistItem card={asRow(c)} onEdit={() => {}} />);
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
    const { container } = render(<CardChecklistItem card={asRow(c)} onEdit={() => {}} />);
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

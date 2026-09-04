/**
 * NEO-102 — the `missingTeam` derivation in convex/features/cardAttention.ts.
 *
 * Pure function, so these are plain unit tests with no convex-test harness:
 * the whole point of the module is that it runs identically in a Convex query
 * and in the browser, and a test that needed a database would not be testing
 * that.
 *
 * The matrix below is the specification. Read together, the "no team" rows say
 * the thing that is easy to get wrong: empty `teamOnCardIds` is NOT by itself
 * a missing team. It is missing when nobody — not the BSC background lookup,
 * not a human confirming "none", not a human who typed a team name the sync
 * has yet to resolve — has answered the question yet.
 */

import { describe, expect, test } from "vitest";
import { deriveCardAttention, needsAttention } from "./cardAttention";

const MISSING_TEAM = [{ kind: "missingTeam" as const }];

describe("deriveCardAttention — missingTeam", () => {
  test("a custom card with no team and no BSC ref is flagged immediately", () => {
    // Nothing will ever answer this automatically: no BSC ref means no
    // per-card lookup, and SportLots deliberately never scrapes team at all.
    // So there is nothing to wait for.
    expect(deriveCardAttention({ platformData: {} })).toEqual(MISSING_TEAM);
  });

  test("a SportLots-only card with no team is flagged immediately", () => {
    expect(
      deriveCardAttention({
        teamOnCardIds: [],
        platformData: { sportlots: { ref: "some SL description" } },
      }),
    ).toEqual(MISSING_TEAM);
  });

  test("a BSC card whose lookup has NOT run yet is not flagged", () => {
    // The queue drains at one request every 300ms after a commit. Badging
    // during the drain would flood a 900-card checklist with items that
    // resolve themselves, which is how a badge gets trained out of usefulness.
    expect(
      deriveCardAttention({
        teamOnCardIds: [],
        platformData: { bsc: { ref: "bsc-1" } },
      }),
    ).toEqual([]);
  });

  test("a BSC card whose lookup HAS run and found nothing is flagged", () => {
    // `teamCheckDoneAt` means "asked, regardless of outcome". BSC having no
    // team on file is exactly the case a human has to settle — and it is the
    // state every pre-NEO-102 teamless card is already sitting in.
    expect(
      deriveCardAttention({
        teamOnCardIds: [],
        teamCheckDoneAt: 1_700_000_000_000,
        platformData: { bsc: { ref: "bsc-1" } },
      }),
    ).toEqual(MISSING_TEAM);
  });

  test("an operator-confirmed 'no team' card is never flagged", () => {
    expect(
      deriveCardAttention({
        teamOnCardIds: [],
        teamCheckDoneAt: 1_700_000_000_000,
        teamNoneConfirmedAt: 1_700_000_001_000,
        platformData: { bsc: { ref: "bsc-1" } },
      }),
    ).toEqual([]);
  });

  test("a confirmation suppresses the flag even with no lookup ever having run", () => {
    expect(
      deriveCardAttention({
        teamNoneConfirmedAt: 1_700_000_001_000,
        platformData: {},
      }),
    ).toEqual([]);
  });

  test("a card that HAS a team is never flagged, in any lookup state", () => {
    for (const extra of [
      {},
      { teamCheckDoneAt: 1 },
      { teamNoneConfirmedAt: 1 },
      { platformData: { bsc: { ref: "bsc-1" } } },
    ]) {
      expect(
        deriveCardAttention({ teamOnCardIds: ["team_1"], ...extra }),
      ).toEqual([]);
    }
  });

  test("absent and empty teamOnCardIds are the same statement", () => {
    expect(deriveCardAttention({ teamOnCardIds: [] })).toEqual(
      deriveCardAttention({}),
    );
  });

  test("a card with a PENDING team name is not MISSING a team — it gets NEO-221's unreviewedName instead", () => {
    // A typed or unreviewed name lands in `pendingTeamNames` and leaves
    // `teamOnCardIds` empty until something resolves it. Reading only
    // `teamOnCardIds` badged that card "no team" and sent the walker to ask
    // the operator for the team they had just typed.
    //
    // NEO-208 changed the PRODUCER (the quick-add form sends real ids now, so
    // no new row is born pending) and deliberately not the RULE: rows written
    // before that, and an old SPA bundle's `addCustomCard.teams`, still land
    // here and are still answered.
    //
    // NEO-221 gave that state its own item. The card is still NOT
    // `missingTeam` — somebody has said something about the team — but it is
    // now surfaced as a name that links to nothing, which is the actual work
    // left. Exactly ONE item either way: two badges for one gap would just
    // double the count the operator walks through.
    expect(
      deriveCardAttention({
        teamOnCardIds: [],
        pendingTeamNames: ["Savannah Bananas"],
        platformData: {},
      }),
    ).toEqual([{ kind: "unreviewedName", names: ["Savannah Bananas"] }]);
    expect(
      needsAttention({ pendingTeamNames: ["Savannah Bananas"] }),
    ).toBe(true);
  });

  test("an EMPTY pendingTeamNames array is still a missing team", () => {
    // `[]` is not an answer. The resolve pass in selectorOptions.ts strips
    // names as it resolves them and can leave the array behind empty, so this
    // is a real stored shape — and it must read exactly like an absent one.
    expect(
      deriveCardAttention({
        teamOnCardIds: [],
        pendingTeamNames: [],
        platformData: {},
      }),
    ).toEqual(MISSING_TEAM);
  });

  test("an empty-string bsc.ref is treated as no ref — flagged immediately, not held for the lookup", () => {
    // Every other reader of platformData.bsc.ref in this codebase (see
    // selectorOptions.ts's `!!c.platformData.bsc?.ref` checks) treats a falsy
    // ref as "no linkage", not "linked with nothing to say". This pins the
    // same convention here: a card cannot be stuck waiting forever on
    // `teamCheckDoneAt` for a ref that was never a real one.
    expect(
      deriveCardAttention({
        teamOnCardIds: [],
        platformData: { bsc: { ref: "" } },
      }),
    ).toEqual(MISSING_TEAM);
  });
});

// ===========================================================================
// NEO-101 — the listing-length kinds
// ===========================================================================
//
// A row that HAS a team is used throughout, so `missingTeam` stays out of the
// way and each assertion is about exactly one rule.

const HAS_TEAM = { teamOnCardIds: ["team_1"] } as const;

describe("deriveCardAttention — titleOverLimit", () => {
  test("a title at exactly the cap is fine; one character more is not", () => {
    expect(
      deriveCardAttention({ ...HAS_TEAM, listingTitle: "x".repeat(80) }),
    ).toEqual([]);
    expect(
      deriveCardAttention({ ...HAS_TEAM, listingTitle: "x".repeat(81) }),
    ).toEqual([{ kind: "titleOverLimit", length: 81 }]);
  });

  test("carries the measured length so the label need not re-measure", () => {
    expect(
      deriveCardAttention({ ...HAS_TEAM, listingTitle: "x".repeat(94) }),
    ).toEqual([{ kind: "titleOverLimit", length: 94 }]);
  });

  test("an absent or empty title is not over the limit", () => {
    expect(deriveCardAttention({ ...HAS_TEAM })).toEqual([]);
    expect(deriveCardAttention({ ...HAS_TEAM, listingTitle: "" })).toEqual([]);
  });
});

describe("deriveCardAttention — titleTruncated", () => {
  test("fires on the stored flag alone", () => {
    expect(
      deriveCardAttention({
        ...HAS_TEAM,
        listingTitle: "2024 Topps Chrome An Absurdly Long Player Full Name #1",
        listingTitleTruncated: true,
      }),
    ).toEqual([{ kind: "titleTruncated" }]);
  });

  test("clears once the flag is gone — which is what an operator title write does", () => {
    // `updateCard` patches `listingTitleTruncated: undefined` on any title
    // write, so this is the after state of a human rewriting the title. The
    // item clears by construction; nothing has to remember to retract it.
    expect(
      deriveCardAttention({ ...HAS_TEAM, listingTitle: "A hand-written title" }),
    ).toEqual([]);
  });

  test("`false` is the same as absent", () => {
    expect(
      deriveCardAttention({ ...HAS_TEAM, listingTitleTruncated: false }),
    ).toEqual([]);
  });

  test("an over-limit title suppresses it — the two are mutually exclusive", () => {
    // Both true is reachable (an operator pasted an over-long title onto a row
    // whose generated title had been cut, before updateCard gained its cap).
    // "is 94 characters" and "was cut short" read as a contradiction, and
    // rewriting the title fixes both, so only the blocking one is reported.
    expect(
      deriveCardAttention({
        ...HAS_TEAM,
        listingTitle: "x".repeat(94),
        listingTitleTruncated: true,
      }),
    ).toEqual([{ kind: "titleOverLimit", length: 94 }]);
  });
});

describe("deriveCardAttention — aspectValueOverLimit", () => {
  test("a cardVariation at exactly 65 is fine; 66 is flagged", () => {
    expect(
      deriveCardAttention({ ...HAS_TEAM, cardVariation: "v".repeat(65) }),
    ).toEqual([]);
    expect(
      deriveCardAttention({ ...HAS_TEAM, cardVariation: "v".repeat(66) }),
    ).toEqual([
      { kind: "aspectValueOverLimit", field: "cardVariation", length: 66 },
    ]);
  });

  test("names the field, so a future second aspect field does not need a second kind", () => {
    const [item] = deriveCardAttention({
      ...HAS_TEAM,
      cardVariation: "v".repeat(100),
    });
    expect(item).toEqual({
      kind: "aspectValueOverLimit",
      field: "cardVariation",
      length: 100,
    });
  });

  test("warn-only: an over-length variation is a real stored value, not a rejected one", () => {
    // `updateCard` deliberately does NOT cap cardVariation — see the note
    // there. This item existing at all is the whole enforcement.
    expect(
      deriveCardAttention({ ...HAS_TEAM, cardVariation: "v".repeat(200) }),
    ).toHaveLength(1);
  });
});

describe("deriveCardAttention — kinds compose", () => {
  test("one row can owe a human several different things at once", () => {
    expect(
      deriveCardAttention({
        platformData: {},
        listingTitle: "x".repeat(120),
        cardVariation: "v".repeat(90),
      }),
    ).toEqual([
      { kind: "missingTeam" },
      { kind: "titleOverLimit", length: 120 },
      { kind: "aspectValueOverLimit", field: "cardVariation", length: 90 },
    ]);
  });

  test("a fully-settled row owes nothing", () => {
    expect(
      deriveCardAttention({
        ...HAS_TEAM,
        listingTitle: "2024 Topps Chrome Elly De La Cruz #50 RC",
        cardVariation: "Image Variation; Wearing sunglasses",
      }),
    ).toEqual([]);
  });
});

// ===========================================================================
// NEO-221 — unreviewedName
//
// A name the card carries that links to nothing. Two producers with one
// meaning: `addCustomCard` when an operator types a player/team the tables do
// not have yet, and `commitCardChecklist` when a synced card's name reached
// commit with no review decision (the operator dismissed the wizard, or
// committed with rows still open). Either way the card names somebody it does
// not link to, and either way the fix is the same.
// ===========================================================================

describe("deriveCardAttention — unreviewedName", () => {
  test("an unreviewed PLAYER name with no playerIds is flagged, and carries the names", () => {
    expect(
      deriveCardAttention({
        ...HAS_TEAM,
        pendingPlayerNames: ["Elly De La Cruz", "Junior Caminero"],
      }),
    ).toEqual([
      {
        kind: "unreviewedName",
        names: ["Elly De La Cruz", "Junior Caminero"],
      },
    ]);
  });

  test("a card that already LINKS a player is not flagged for its leftover name", () => {
    // The link is the answer; a stale spelling beside it is a duplicate, not a
    // gap. (`updateCard` clears the names when the fixer links a player, so
    // this shape is transient — but it is reachable, and re-asking about a
    // card that already has its player is the badge losing the operator's
    // trust.)
    expect(
      deriveCardAttention({
        ...HAS_TEAM,
        playerIds: ["player_1"],
        pendingPlayerNames: ["Elly De La Cruz"],
      }),
    ).toEqual([]);
  });

  test("an unreviewed TEAM name is flagged, and does NOT also raise missingTeam", () => {
    // Exactly one badge for one gap. `hasTeam` counts a pending team name as
    // having a team, so the card gets the specific item rather than both.
    const items = deriveCardAttention({
      teamOnCardIds: [],
      teamCheckDoneAt: 1_700_000_000_000,
      pendingTeamNames: ["Reno Aces"],
      platformData: { bsc: { ref: "bsc-1" } },
    });
    expect(items).toEqual([{ kind: "unreviewedName", names: ["Reno Aces"] }]);
    expect(items.some((i) => i.kind === "missingTeam")).toBe(false);
  });

  test("a card with a linked team is not flagged for a leftover team name", () => {
    expect(
      deriveCardAttention({
        teamOnCardIds: ["team_1"],
        pendingTeamNames: ["Reno Aces"],
      }),
    ).toEqual([]);
  });

  test("both sides unresolved report as ONE item listing every name", () => {
    expect(
      deriveCardAttention({
        pendingPlayerNames: ["Elly De La Cruz"],
        pendingTeamNames: ["Reno Aces"],
      }),
    ).toEqual([
      { kind: "unreviewedName", names: ["Elly De La Cruz", "Reno Aces"] },
    ]);
  });

  test("no marketplace-ref gate — a card with no refs is flagged exactly like one with them", () => {
    // NB behaviour is never keyed on whether a row carries marketplace ids
    // (the product invariant in the root CLAUDE.md). An earlier draft badged
    // only ref-bearing cards, which is the retired "custom card" concept
    // re-spelled; pinned so it cannot come back.
    const withRef = deriveCardAttention({
      ...HAS_TEAM,
      pendingPlayerNames: ["Nobody Reviewed Me"],
      platformData: { bsc: { ref: "bsc-1" } },
    });
    const withoutRef = deriveCardAttention({
      ...HAS_TEAM,
      pendingPlayerNames: ["Nobody Reviewed Me"],
      platformData: {},
    });
    expect(withoutRef).toEqual(withRef);
    expect(withoutRef).toEqual([
      { kind: "unreviewedName", names: ["Nobody Reviewed Me"] },
    ]);
  });

  test("empty arrays are not an unreviewed name", () => {
    // `[]` is the shape a resolve pass leaves behind after stripping the last
    // name, and it must read exactly like an absent field.
    expect(
      deriveCardAttention({
        ...HAS_TEAM,
        pendingPlayerNames: [],
        pendingTeamNames: [],
      }),
    ).toEqual([]);
  });

  test("stacks with the NEO-101 title items rather than replacing them", () => {
    expect(
      deriveCardAttention({
        ...HAS_TEAM,
        listingTitleTruncated: true,
        pendingPlayerNames: ["Elly De La Cruz"],
      }),
    ).toEqual([
      { kind: "titleTruncated" },
      { kind: "unreviewedName", names: ["Elly De La Cruz"] },
    ]);
  });

  test("the returned names are a COPY — a caller cannot mutate the row through the item", () => {
    const names = ["Elly De La Cruz"];
    const [item] = deriveCardAttention({ ...HAS_TEAM, pendingPlayerNames: names });
    expect(item.kind).toBe("unreviewedName");
    if (item.kind !== "unreviewedName") throw new Error("unreachable");
    item.names.push("Injected");
    expect(names).toEqual(["Elly De La Cruz"]);
  });
});

describe("needsAttention", () => {
  test("agrees with deriveCardAttention", () => {
    const rows: Array<Parameters<typeof deriveCardAttention>[0]> = [
      {},
      { teamOnCardIds: ["team_1"] },
      { platformData: { bsc: { ref: "b" } } },
      { platformData: { bsc: { ref: "b" } }, teamCheckDoneAt: 1 },
      { teamNoneConfirmedAt: 1 },
      { pendingTeamNames: ["Savannah Bananas"] },
      { pendingTeamNames: [] },
      // NEO-221
      { ...HAS_TEAM, pendingPlayerNames: ["Elly De La Cruz"] },
      { ...HAS_TEAM, playerIds: ["player_1"], pendingPlayerNames: ["Elly"] },
      { teamOnCardIds: ["team_1"], pendingTeamNames: ["Reno Aces"] },
      // NEO-101 kinds, on rows that are otherwise settled.
      { ...HAS_TEAM, listingTitle: "x".repeat(81) },
      { ...HAS_TEAM, listingTitleTruncated: true },
      { ...HAS_TEAM, cardVariation: "v".repeat(66) },
      { ...HAS_TEAM, listingTitle: "x".repeat(80), cardVariation: "v".repeat(65) },
    ];
    for (const row of rows) {
      expect(needsAttention(row)).toBe(deriveCardAttention(row).length > 0);
    }
  });
});

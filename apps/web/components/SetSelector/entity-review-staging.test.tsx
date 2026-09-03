/**
 * NEO-212: coverage for `deriveStagedTeamNames`, the pure half of the wizard's
 * duplicate-team defence.
 *
 * The function exists because `teams.search` can only see what is SAVED, and
 * during a review nothing is. Every test below is therefore really one
 * question: "would the career-team typeahead have offered this name?" — the
 * answer being no is how the same franchise got created twice.
 *
 * No mocks: the module is pure by contract (no Convex, no hooks, no I/O), and
 * everything it cannot know arrives as an argument. If this file ever needs a
 * mock, the module has grown a dependency it should not have.
 *
 * `.test.tsx` despite containing no JSX: `vitest.include.mjs` collects
 * `.test.ts` only under convex/ and lib/, and its own docblock names
 * `components/SetSelector/helpers.test.ts` as the exact shape of file that
 * would be collected by nothing. The NEO-164 verifier fails the run for such a
 * file rather than letting it pass silently, so the extension is load-bearing.
 */

import { describe, expect, it } from "vitest";
import {
  deriveStagedTeamNames,
  type StagingRow,
} from "./entity-review-staging";

function teamRow(overrides: Partial<StagingRow> & { _id: string }): StagingRow {
  return { kind: "team", name: "Some Team", ...overrides };
}

function playerRow(overrides: Partial<StagingRow> & { _id: string }): StagingRow {
  return { kind: "player", name: "Some Player", ...overrides };
}

const noExtras = { localChips: [], linkedTeamNames: [] };

describe("deriveStagedTeamNames — sources", () => {
  it("stages an UNDECIDED team row", () => {
    // The operator has not reached it yet, but "Add as New" is the default
    // action and the row right before it is exactly where the suggestion is
    // most useful.
    const rows = [teamRow({ _id: "t1", name: "Toronto Blue Jays" })];

    expect(
      deriveStagedTeamNames({ rows, currentRowId: null, ...noExtras }),
    ).toEqual([{ name: "Toronto Blue Jays", source: "batch-team" }]);
  });

  it("stages a team row decided 'create'", () => {
    const rows = [
      teamRow({ _id: "t1", name: "Tampa Bay Rays", decision: { action: "create" } }),
    ];

    expect(
      deriveStagedTeamNames({ rows, currentRowId: null, ...noExtras }),
    ).toEqual([{ name: "Tampa Bay Rays", source: "batch-team" }]);
  });

  it("stages the LINKED team's canonical name, never the review row's raw name", () => {
    // The whole point: the row says "NY Yankees" (what the checklist called
    // it); the batch will actually use "New York Yankees" (what the linked row
    // is called). Suggesting the raw string walks straight back into the
    // duplicate.
    const rows = [
      teamRow({
        _id: "t1",
        name: "NY Yankees",
        decision: { action: "link", linkedTeamId: "team_abc" },
      }),
    ];

    expect(
      deriveStagedTeamNames({
        rows,
        currentRowId: null,
        localChips: [],
        linkedTeamNames: ["New York Yankees"],
      }),
    ).toEqual([{ name: "New York Yankees", source: "linked-team" }]);
  });

  it("stages a created player's hand-typed manualCareerTeams", () => {
    const rows = [
      playerRow({
        _id: "p1",
        decision: {
          action: "create",
          manualCareerTeams: [{ name: "Arizona Diamondbacks", fromYear: 2020 }],
        },
      }),
    ];

    expect(
      deriveStagedTeamNames({ rows, currentRowId: null, ...noExtras }),
    ).toEqual([{ name: "Arizona Diamondbacks", source: "career" }]);
  });

  it("stages a created player's KEPT Wikidata career teams", () => {
    const rows = [
      playerRow({
        _id: "p1",
        enrichment: {
          careerTeams: [{ name: "Los Angeles Angels", fromYear: 2011 }],
        },
        decision: { action: "create" },
      }),
    ];

    expect(
      deriveStagedTeamNames({ rows, currentRowId: null, ...noExtras }),
    ).toEqual([{ name: "Los Angeles Angels", source: "career" }]);
  });

  it("stages the current row's local chips", () => {
    expect(
      deriveStagedTeamNames({
        rows: [],
        currentRowId: null,
        localChips: [{ name: "Brand New Club" }],
        linkedTeamNames: [],
      }),
    ).toEqual([{ name: "Brand New Club", source: "chip" }]);
  });

  it("orders the sources: batch teams, linked teams, career teams, then chips", () => {
    const rows = [
      teamRow({ _id: "t1", name: "Batch Team" }),
      teamRow({
        _id: "t2",
        name: "Raw Linked Name",
        decision: { action: "link", linkedTeamId: "team_abc" },
      }),
      playerRow({
        _id: "p1",
        decision: {
          action: "create",
          manualCareerTeams: [{ name: "Career Team", fromYear: 2000 }],
        },
      }),
    ];

    expect(
      deriveStagedTeamNames({
        rows,
        currentRowId: null,
        localChips: [{ name: "Chip Team" }],
        linkedTeamNames: ["Linked Team"],
      }),
    ).toEqual([
      { name: "Batch Team", source: "batch-team" },
      { name: "Linked Team", source: "linked-team" },
      { name: "Career Team", source: "career" },
      { name: "Chip Team", source: "chip" },
    ]);
  });
});

describe("deriveStagedTeamNames — exclusions", () => {
  it("ignores a team row decided 'skip'", () => {
    // "Skip" means "not a team". Suggesting back a name the operator has just
    // rejected is the one thing worse than suggesting nothing.
    const rows = [
      teamRow({ _id: "t1", name: "Checklist", decision: { action: "skip" } }),
    ];

    expect(
      deriveStagedTeamNames({ rows, currentRowId: null, ...noExtras }),
    ).toEqual([]);
  });

  it("ignores a linked team row whose id the caller could not resolve", () => {
    // linkedTeamNames is the only source for a link decision, so an empty one
    // must contribute nothing rather than falling back to the raw row name.
    const rows = [
      teamRow({
        _id: "t1",
        name: "NY Yankees",
        decision: { action: "link", linkedTeamId: "team_abc" },
      }),
    ];

    expect(
      deriveStagedTeamNames({ rows, currentRowId: null, ...noExtras }),
    ).toEqual([]);
  });

  it("ignores career teams of a player row that is not decided 'create'", () => {
    const rows = [
      playerRow({
        _id: "p1",
        enrichment: { careerTeams: [{ name: "Los Angeles Angels", fromYear: 2011 }] },
        // Undecided: nothing is committed, so nothing is staged.
      }),
      playerRow({
        _id: "p2",
        enrichment: { careerTeams: [{ name: "Boston Red Sox", fromYear: 2015 }] },
        decision: { action: "link", linkedPlayerId: "player_abc" },
      }),
      playerRow({
        _id: "p3",
        enrichment: { careerTeams: [{ name: "Chicago Cubs", fromYear: 2018 }] },
        decision: { action: "skip" },
      }),
    ];

    expect(
      deriveStagedTeamNames({ rows, currentRowId: null, ...noExtras }),
    ).toEqual([]);
  });

  it("ignores an UNCHECKED Wikidata career team (excludedCareerTeamNames)", () => {
    // The operator said commit must not create it, so it is not in play.
    const rows = [
      playerRow({
        _id: "p1",
        enrichment: {
          careerTeams: [
            { name: "Los Angeles Angels", fromYear: 2011 },
            { name: "Salt Lake Bees", fromYear: 2011, toYear: 2011 },
          ],
        },
        decision: {
          action: "create",
          excludedCareerTeamNames: ["Salt Lake Bees"],
        },
      }),
    ];

    expect(
      deriveStagedTeamNames({ rows, currentRowId: null, ...noExtras }),
    ).toEqual([{ name: "Los Angeles Angels", source: "career" }]);
  });

  it("matches an exclusion by the normalized key, not by raw string", () => {
    const rows = [
      playerRow({
        _id: "p1",
        enrichment: { careerTeams: [{ name: "St. Louis Cardinals", fromYear: 2001 }] },
        decision: {
          action: "create",
          excludedCareerTeamNames: ["st louis cardinals"],
        },
      }),
    ];

    expect(
      deriveStagedTeamNames({ rows, currentRowId: null, ...noExtras }),
    ).toEqual([]);
  });

  it("excludes the CURRENT row's own name when it is a team row", () => {
    // Offering the row you are reviewing as a career team for itself is
    // circular noise.
    const rows = [
      teamRow({ _id: "t1", name: "Toronto Blue Jays" }),
      teamRow({ _id: "t2", name: "Tampa Bay Rays" }),
    ];

    expect(
      deriveStagedTeamNames({ rows, currentRowId: "t1", ...noExtras }),
    ).toEqual([{ name: "Tampa Bay Rays", source: "batch-team" }]);
  });

  it("does NOT exclude the current row's name when it is a player row", () => {
    // A player's name is not a team name; excluding it would silently drop a
    // team that happens to share the string.
    const rows = [
      playerRow({ _id: "p1", name: "Toronto Blue Jays" }),
      teamRow({ _id: "t1", name: "Toronto Blue Jays" }),
    ];

    expect(
      deriveStagedTeamNames({ rows, currentRowId: "p1", ...noExtras }),
    ).toEqual([{ name: "Toronto Blue Jays", source: "batch-team" }]);
  });

  it("drops a name that normalizes to nothing", () => {
    const rows = [teamRow({ _id: "t1", name: "  ...  " })];

    expect(
      deriveStagedTeamNames({ rows, currentRowId: null, ...noExtras }),
    ).toEqual([]);
  });
});

describe("deriveStagedTeamNames — dedupe", () => {
  it("dedupes by the normalized key, keeping the first occurrence's casing", () => {
    // "toronto BLUE jays" normalizes to the same key the commit writes, so the
    // second is the same franchise, not a second one.
    const rows = [
      teamRow({ _id: "t1", name: "Toronto Blue Jays" }),
      teamRow({ _id: "t2", name: "toronto BLUE jays" }),
    ];

    expect(
      deriveStagedTeamNames({ rows, currentRowId: null, ...noExtras }),
    ).toEqual([{ name: "Toronto Blue Jays", source: "batch-team" }]);
  });

  it("first occurrence wins ACROSS sources, so the earlier source keeps the entry", () => {
    const rows = [
      teamRow({ _id: "t1", name: "Toronto Blue Jays" }),
      playerRow({
        _id: "p1",
        decision: {
          action: "create",
          manualCareerTeams: [{ name: "Toronto Blue Jays", fromYear: 2019 }],
        },
      }),
    ];

    expect(
      deriveStagedTeamNames({
        rows,
        currentRowId: null,
        localChips: [{ name: "Toronto Blue Jays" }],
        linkedTeamNames: [],
      }),
    ).toEqual([{ name: "Toronto Blue Jays", source: "batch-team" }]);
  });

  it("dedupes chips against each other", () => {
    expect(
      deriveStagedTeamNames({
        rows: [],
        currentRowId: null,
        localChips: [{ name: "Chicago Cubs" }, { name: "chicago cubs" }],
        linkedTeamNames: [],
      }),
    ).toEqual([{ name: "Chicago Cubs", source: "chip" }]);
  });

  it("treats a token-reordered name as the same key (the commit's own dedup key)", () => {
    // normalizeEntityName token-sorts, exactly as `teams.nameNormalized` does,
    // so the wizard's "N new teams" cannot disagree with what commit inserts.
    const rows = [
      teamRow({ _id: "t1", name: "Blue Jays Toronto" }),
      teamRow({ _id: "t2", name: "Toronto Blue Jays" }),
    ];

    expect(
      deriveStagedTeamNames({ rows, currentRowId: null, ...noExtras }),
    ).toEqual([{ name: "Blue Jays Toronto", source: "batch-team" }]);
  });
});

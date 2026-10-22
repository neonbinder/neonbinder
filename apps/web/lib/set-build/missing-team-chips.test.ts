import { describe, expect, test } from "vitest";
import { MAX_CARD_TEAMS } from "../../convex/features/cardAttention";
import { foldMissingTeamChips, type TeamSuggestion } from "./missing-team-chips";

const sug = (teamId: string, playerName: string, inSetYear: boolean, extra: Partial<TeamSuggestion<string>> = {}) => ({
  teamId,
  name: `Team ${teamId}`,
  label: `Team ${teamId}`,
  playerName,
  inSetYear,
  ...extra,
});
const era = (_id: string, label = `Era ${_id}`) => ({ _id, label });

describe("foldMissingTeamChips — MissingTeamFixer's fold, shared with the tool (NEO-339)", () => {
  test("one chip per team: a team two players share names both, and counts once", () => {
    const out = foldMissingTeamChips({
      suggestions: [sug("t1", "Mike Trout", true), sug("t1", "Shohei Ohtani", false), sug("t2", "Shohei Ohtani", true)],
      listingName: "",
      listingRows: undefined,
    });
    expect(out.careerChips.map((c) => [c.teamId, c.playerNames, c.inSetYear])).toEqual([
      ["t1", ["Mike Trout", "Shohei Ohtani"], true],
      ["t2", ["Shohei Ohtani"], true],
    ]);
    expect(out.preselect).toEqual(["t1", "t2"]);
    expect(out.listingDisagrees).toBe(false);
  });

  test("a career fallback (no set-year stint) is offered and never preselected", () => {
    const out = foldMissingTeamChips({
      suggestions: [sug("a", "Jimmie Foxx", false, { uncoveredSetYear: 2025 }), sug("b", "Jimmie Foxx", false)],
      listingName: "",
      listingRows: undefined,
    });
    expect(out.careerChips).toHaveLength(2);
    expect(out.preselect).toEqual([]);
    expect(out.uncoveredSetYear).toBe(2025);
  });

  test("the listing's rows come first, take a career's provenance, and are not repeated as career chips", () => {
    const out = foldMissingTeamChips({
      suggestions: [sug("ath1", "Jimmie Foxx", true), sug("sox", "Jimmie Foxx", false)],
      listingName: " Athletics ",
      listingRows: [era("ath1", "Athletics · 1901–1954"), era("ath2", "Athletics · 1955–1967")],
    });
    expect(out.listingChips.map((c) => [c.teamId, c.label, c.playerNames, c.inSetYear])).toEqual([
      ["ath1", "Athletics · 1901–1954", ["Jimmie Foxx"], true],
      ["ath2", "Athletics · 1955–1967", [], false],
    ]);
    expect(out.listingChips[0].era).toEqual(era("ath1", "Athletics · 1901–1954"));
    expect(out.careerChips.map((c) => c.teamId)).toEqual(["sox"]);
    // The set-year team IS among the listing's rows: they agree.
    expect(out.listingDisagrees).toBe(false);
    expect(out.preselect).toEqual(["ath1"]);
  });

  test("a set-year team the listing does not name is a disagreement: nothing preselected", () => {
    const out = foldMissingTeamChips({
      suggestions: [sug("cubs", "Jimmie Foxx", true)],
      listingName: "Athletics",
      listingRows: [era("ath1")],
    });
    expect(out.listingDisagrees).toBe(true);
    expect(out.preselect).toEqual([]);
    expect(out.setYearTeamIds).toEqual(["cubs"]);
  });

  test("a listing name that could not be looked up vouches for nothing", () => {
    for (const listingRows of [undefined, null]) {
      const out = foldMissingTeamChips({ suggestions: [sug("t1", "A", true)], listingName: "Somebody", listingRows });
      expect(out.listingChips).toEqual([]);
      expect(out.listingDisagrees).toBe(true);
      expect(out.preselect).toEqual([]);
    }
  });

  test("no listing name: listing rows are ignored", () => {
    const out = foldMissingTeamChips({ suggestions: [sug("t1", "A", true)], listingName: "  ", listingRows: [era("x")] });
    expect(out.listingChips).toEqual([]);
    expect(out.listingDisagrees).toBe(false);
  });

  test("at most MAX_CARD_TEAMS are preselected", () => {
    const suggestions = Array.from({ length: MAX_CARD_TEAMS + 3 }, (_, i) => sug(`t${i}`, `P${i}`, true));
    const out = foldMissingTeamChips({ suggestions, listingName: "", listingRows: undefined });
    expect(out.preselect).toHaveLength(MAX_CARD_TEAMS);
    expect(out.preselect).toEqual(suggestions.slice(0, MAX_CARD_TEAMS).map((s) => s.teamId));
  });

  test("the input suggestions are not mutated", () => {
    const suggestions = [sug("t1", "A", false), sug("t1", "B", true)];
    const snapshot = structuredClone(suggestions);
    foldMissingTeamChips({ suggestions, listingName: "", listingRows: undefined });
    expect(suggestions).toEqual(snapshot);
  });
});

import { describe, expect, it } from "vitest";
import { contrastRatio } from "@/lib/print/contrast";
import { spineFontById } from "@/lib/print/spine-fonts";
import { cards, getSet, getTeam, type Card } from "../../prototypes/_shared/data";
import { initialCollectionState, MAIN_BINDER_ID, TRADE_BINDER_ID, WANT_BINDER_ID, type CollectionBinder } from "../store";
import {
  ALL_LABEL,
  LARGE_TEXT_PX,
  PLAIN_LABEL,
  binderTeamsOnCards,
  defaultLabel,
  defaultLabelForNew,
  labelOf,
  letteringSizeCss,
  shelfColors,
  smallestLetteringPx,
  teamColorsOn,
  teamsOnCards,
  validLabel,
} from "./label";

/**
 * NEO-350 — binder spines in the Print Shop's spine-label look: which label a
 * binder wears, and the shelf never lettering one below WCAG AA.
 */

const binder = (id: string) => initialCollectionState().binders.find((b) => b.id === id)!;
const smart = (rule: Extract<CollectionBinder, { kind: "smart" }>["rule"]): CollectionBinder => ({
  id: "s",
  kind: "smart",
  name: "S",
  rule,
});

describe("which label a binder wears", () => {
  it("system binders by role, never by name", () => {
    expect(defaultLabel(binder(MAIN_BINDER_ID)).text).toBe("#00D558");
    expect(defaultLabel(binder(WANT_BINDER_ID)).text).toBe("#FF2E9A");
    expect(defaultLabel({ ...binder(TRADE_BINDER_ID), name: "Swap pile" }).text).toBe("#FFE600");
  });

  it("a team rule wears that team's livery, alumni or not", () => {
    const team = getTeam("wisconsin");
    expect(defaultLabel(smart({ kind: "teamOnCard", teamId: "wisconsin" }))).toMatchObject({
      background: team.primary,
      text: team.secondary,
    });
    expect(defaultLabel(smart({ kind: "playedFor", teamId: "wisconsin" })).background).toBe(team.primary);
  });

  it("a player rule wears the team on most of the binder's cards, not the longest stint", () => {
    // Reggie White spent longest with the Eagles, but most of his cards are Packers.
    const reggie = smart({ kind: "player", playerId: "reggie-white" });
    expect(binderTeamsOnCards(reggie).map((t) => [t.team.id, t.cards])).toEqual([
      ["packers", 3],
      ["eagles", 1],
      ["panthers", 1],
    ]);
    expect(defaultLabel(reggie)).toMatchObject({
      background: getTeam("packers").primary,
      text: getTeam("packers").secondary,
    });
  });

  it("any other rule that names no team wears the team on most of its cards", () => {
    const hof = smart({ kind: "hallOfFame" });
    const [most] = binderTeamsOnCards(hof);
    expect(defaultLabel(hof).background).toBe(most.team.primary);
  });

  it("a rule with no cards at all starts plain", () => {
    expect(defaultLabel(smart({ kind: "printRunBelow", max: 0 }))).toEqual(PLAIN_LABEL);
    expect(binderTeamsOnCards({ id: "m", kind: "manual", name: "Mine" })).toEqual([]);
  });

  it("a binder you fill yourself starts black with white lettering; All my cards is its own", () => {
    expect(defaultLabel({ id: "m", kind: "manual", name: "Anything" })).toEqual(PLAIN_LABEL);
    expect(defaultLabelForNew({ kind: "manual" })).toEqual(PLAIN_LABEL);
    expect(labelOf("all")).toEqual(ALL_LABEL);
  });

  it("the collector's own label wins over the default", () => {
    const label = { background: "#203731", text: "#FFB612", fontId: "teko" };
    expect(labelOf({ id: "m", kind: "manual", name: "Packers PC", label })).toEqual(label);
  });
});

describe("teams on a binder's cards", () => {
  // Fake cards built from real ones, so only the teams and the set differ.
  const old = cards.find((c) => getSet(c.setId).year === 1996)!;
  const recent = cards.find((c) => getSet(c.setId).year === 2024)!;
  const card = (teamIds: string[], from: Card = old): Card => ({ ...from, teamIds });

  it("counts a card for every team on it", () => {
    const tally = teamsOnCards([card(["red-wings", "whalers"]), card(["red-wings"])]);
    expect(tally.map((t) => [t.team.id, t.cards])).toEqual([
      ["red-wings", 2],
      ["whalers", 1],
    ]);
  });

  it("breaks a tie by the most recent card year, then by team id", () => {
    // One card each: the Whalers' card is newer, so they lead.
    expect(teamsOnCards([card(["red-wings"]), card(["whalers"], recent)]).map((t) => t.team.id)).toEqual([
      "whalers",
      "red-wings",
    ]);
    // Same count, same year: team id order, whatever order the cards came in.
    expect(teamsOnCards([card(["whalers"]), card(["red-wings"])]).map((t) => t.team.id)).toEqual([
      "red-wings",
      "whalers",
    ]);
    expect(teamsOnCards([card(["red-wings"]), card(["whalers"])])[0]).toMatchObject({ cards: 1, latestYear: 1996 });
  });

  it("a team pick sets both colors and keeps the lettering face", () => {
    const packers = getTeam("packers");
    expect(teamColorsOn({ background: "#000000", text: "#ffffff", fontId: "teko" }, packers)).toEqual({
      background: packers.primary,
      text: packers.secondary,
      fontId: "teko",
    });
  });
});

describe("lettering on the shelf never drops below AA", () => {
  it("keeps the collector's pair when it reaches 3:1 at a large size", () => {
    const c = shelfColors({ background: "#203731", text: "#FFB612", fontId: "anton" }, 30);
    expect(c).toMatchObject({ text: "#ffb612", swapped: false, needed: 3 });
  });

  it("swaps the lettering to black or white when the pair falls short, keeping the background", () => {
    // Dodger blue and red: 1.8:1.
    const c = shelfColors({ background: "#005A9C", text: "#EF3E42", fontId: "anton" }, 30);
    expect(c.swapped).toBe(true);
    expect(c.background).toBe("#005a9c");
    expect(c.text).toBe("#FFFFFF");
    expect(contrastRatio(c.text, c.background)).toBeGreaterThanOrEqual(4.5);
  });

  it("asks 4.5:1 of lettering below large-text size", () => {
    // About 3.4:1: fine for big lettering, not for small.
    const pair = { background: "#0B162A", text: "#C83803", fontId: "anton" };
    expect(shelfColors(pair, LARGE_TEXT_PX).swapped).toBe(false);
    expect(shelfColors(pair, 14).swapped).toBe(true);
  });

  it("sizes the lettering with the Print Shop's fitter, in the label's own container units", () => {
    const css = letteringSizeCss("Red Wings", spineFontById("anton"));
    expect(css).toMatch(/^max\(12px, min\([\d.]+cqw, [\d.]+cqh\)\)$/);
    // A longer name is set smaller along the spine.
    const along = (name: string) => Number(/, ([\d.]+)cqh/.exec(letteringSizeCss(name, spineFontById("anton")))![1]);
    expect(along("Score, minus the low numbers")).toBeLessThan(along("Red Wings"));
    expect(smallestLetteringPx("Score, minus the low numbers", spineFontById("anton"), 86)).toBeLessThan(LARGE_TEXT_PX);
  });

  it("saves only real colours, normalised", () => {
    expect(validLabel({ background: "#fff", text: "000", fontId: "nope" })).toEqual({
      background: "#ffffff",
      text: "#000000",
      fontId: "system",
    });
    expect(validLabel({ background: "#12", text: "#000000", fontId: "anton" })).toBeNull();
  });
});

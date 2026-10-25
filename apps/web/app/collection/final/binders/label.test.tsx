import { describe, expect, it } from "vitest";
import { contrastRatio } from "@/lib/print/contrast";
import { spineFontById } from "@/lib/print/spine-fonts";
import { cards as fixtureCards, getTeam } from "../../prototypes/_shared/data";
import { demoCard } from "../data/demoStore";
import type { Card, ContainerRule } from "../data/types";
import {
  ALL_LABEL,
  BOX_LABEL,
  LARGE_TEXT_PX,
  PLAIN_LABEL,
  defaultLabel,
  labelOf,
  letteringSizeCss,
  ruleTeamId,
  sameLabel,
  shelfColors,
  smallestLetteringPx,
  teamColorsOn,
  teamColorsOf,
  teamPicks,
  teamsOnCards,
  validLabel,
  type LabelSubject,
} from "./label";

/**
 * NEO-350 / NEO-359 — container spines in the Print Shop's spine-label look:
 * which label a binder or box wears, and the shelf never lettering one below
 * WCAG AA. Every default is keyed on a container's role or its rule's ids,
 * never its name.
 */

const binder = (over: Partial<LabelSubject> = {}): LabelSubject => ({ kind: "binder", ...over });
const smart = (rule: ContainerRule): LabelSubject => binder({ rule });

/** Real hydrated cards, so the teams carry the colours NB holds. */
const heroCards = (playerId: string): Card[] =>
  fixtureCards.filter((c) => c.playerIds.includes(playerId)).map((c) => demoCard(c.id)!);

const teamOf = (id: string) => {
  const t = getTeam(id);
  return { id, name: t.name, location: t.location, primary: t.primary, secondary: t.secondary };
};

describe("which label a container wears", () => {
  it("system containers by role, never by name", () => {
    expect(defaultLabel(binder({ system: "main" })).text).toBe("#00D558");
    expect(defaultLabel(binder({ system: "want" })).text).toBe("#FF2E9A");
    expect(defaultLabel({ ...binder({ system: "trade" }), name: "Swap pile" } as LabelSubject).text).toBe("#FFE600");
  });

  it("a rule that names a team wears that team's livery, alumni or not", () => {
    const team = teamOf("wisconsin");
    const hints = { ruleTeam: teamColorsOf({ ...team, id: "wisconsin" }) };
    expect(defaultLabel(smart({ kind: "teamOnCard", teamId: "wisconsin" }), hints)).toMatchObject({
      background: team.primary,
      text: team.secondary,
    });
    expect(defaultLabel(smart({ kind: "playedFor", teamId: "wisconsin" }), hints).background).toBe(team.primary);
  });

  it("a player rule wears the team on most of the binder's cards, not the longest stint", () => {
    // Reggie White spent longest with the Eagles, but most of his cards are Packers.
    const teams = teamsOnCards(heroCards("reggie-white"));
    expect(teams[0].team.id).toBe("packers");
    expect(defaultLabel(smart({ kind: "player", playerId: "reggie-white" }), { teams })).toMatchObject({
      background: getTeam("packers").primary,
      text: getTeam("packers").secondary,
    });
  });

  it("a rule that names no team and has no cards at all starts plain", () => {
    expect(defaultLabel(smart({ kind: "printRunBelow", max: 0 }), { teams: [] })).toEqual(PLAIN_LABEL);
    expect(defaultLabel(smart({ kind: "hallOfFame" }))).toEqual(PLAIN_LABEL);
  });

  it("a binder you fill yourself starts black with white lettering; a box is masking tape; All is its own", () => {
    expect(defaultLabel(binder())).toEqual(PLAIN_LABEL);
    expect(defaultLabel({ kind: "box" })).toEqual(BOX_LABEL);
    expect(labelOf("all")).toEqual(ALL_LABEL);
  });

  it("the collector's own label wins over the default, even on a box or a system container", () => {
    const label = { background: "#203731", text: "#FFB612", fontId: "teko" };
    expect(labelOf(binder({ label }))).toEqual(label);
    expect(labelOf({ kind: "box", label })).toEqual(label);
    expect(labelOf(binder({ system: "main", label }))).toEqual(label);
  });

  it("does not key the default on a name: a box named like a system role is still a box", () => {
    expect(defaultLabel({ kind: "box", name: "Want List" } as LabelSubject)).toEqual(BOX_LABEL);
  });
});

describe("the team a rule names", () => {
  it("finds it in a team rule, an alumni rule and the either-or of both", () => {
    expect(ruleTeamId({ kind: "teamOnCard", teamId: "wisconsin" })).toBe("wisconsin");
    expect(ruleTeamId({ kind: "playedFor", teamId: "wisconsin" })).toBe("wisconsin");
    expect(
      ruleTeamId({
        kind: "or",
        rules: [
          { kind: "teamOnCard", teamId: "wisconsin" },
          { kind: "playedFor", teamId: "wisconsin" },
        ],
      }),
    ).toBe("wisconsin");
  });

  it("is null for a rule that names no team, a not, and no rule at all", () => {
    expect(ruleTeamId({ kind: "player", playerId: "reggie-white" })).toBeNull();
    expect(ruleTeamId({ kind: "not", rule: { kind: "teamOnCard", teamId: "wisconsin" } } as ContainerRule)).toBeNull();
    expect(ruleTeamId(undefined)).toBeNull();
  });
});

describe("the label editor's quick picks", () => {
  const wisconsin = teamColorsOf({ ...teamOf("wisconsin") })!;
  const onCards = teamsOnCards(heroCards("reggie-white"));

  it("leads with the rule's team even when no card shows it", () => {
    // Badgers alumni: every card is a pro uniform, so Wisconsin is on none.
    const picks = teamPicks(onCards, wisconsin);
    expect(onCards.some((t) => t.team.id === "wisconsin")).toBe(false);
    expect(picks[0]).toMatchObject({ team: wisconsin, cards: 0, named: true });
    expect(picks.slice(1).map((p) => p.team.id)).toEqual(onCards.map((t) => t.team.id));
    expect(picks.slice(1).every((p) => !p.named)).toBe(true);
  });

  it("moves the rule's team to the front once, keeping its card count", () => {
    const own = onCards.find((t) => t.team.id === "eagles")!;
    const picks = teamPicks(onCards, own.team);
    expect(picks[0]).toMatchObject({ team: own.team, cards: own.cards, named: true });
    expect(picks.filter((p) => p.team.id === "eagles")).toHaveLength(1);
    expect(picks).toHaveLength(onCards.length);
  });

  it("is just the cards' teams for a rule that names no team, and nothing without cards", () => {
    expect(teamPicks(onCards, null).map((p) => [p.team.id, p.named])).toEqual(onCards.map((t) => [t.team.id, false]));
    expect(teamPicks([], null)).toEqual([]);
  });
});

describe("teams on a container's cards", () => {
  // Cards built from real ones, so only the teams and the year differ.
  const base = demoCard(fixtureCards[0].id)!;
  const card = (id: string, teamIds: string[], year = base.set.year): Card => ({
    ...base,
    id,
    set: { ...base.set, year },
    teams: teamIds.map((t) => ({ ...teamOf(t) })),
  });

  it("counts a card for every team on it", () => {
    const tally = teamsOnCards([card("a", ["red-wings", "whalers"]), card("b", ["red-wings"])]);
    expect(tally.map((t) => [t.team.id, t.cards])).toEqual([
      ["red-wings", 2],
      ["whalers", 1],
    ]);
  });

  it("counts a card listed twice once", () => {
    const a = card("a", ["red-wings"]);
    expect(teamsOnCards([a, a])[0].cards).toBe(1);
  });

  it("breaks a tie by the most recent card year, then by team id, whatever order the cards came in", () => {
    expect(teamsOnCards([card("a", ["red-wings"], 1996), card("b", ["whalers"], 2024)]).map((t) => t.team.id)).toEqual([
      "whalers",
      "red-wings",
    ]);
    expect(teamsOnCards([card("a", ["whalers"], 1996), card("b", ["red-wings"], 1996)]).map((t) => t.team.id)).toEqual([
      "red-wings",
      "whalers",
    ]);
    expect(teamsOnCards([card("a", ["red-wings"], 1996)])[0]).toMatchObject({ cards: 1, latestYear: 1996 });
  });

  it("leaves out a team NB has no colours for: never a guess", () => {
    const noColours = { ...card("a", []), teams: [{ id: "t", name: "Expos", location: "Montreal" }] };
    expect(teamsOnCards([noColours])).toEqual([]);
  });

  it("a team pick sets both colors and keeps the lettering face", () => {
    const packers = getTeam("packers");
    expect(teamColorsOn({ background: "#000000", text: "#ffffff", fontId: "teko" }, packers)).toEqual({
      background: packers.primary,
      text: packers.secondary,
      fontId: "teko",
    });
  });

  it("compares labels by colour (either case) and face", () => {
    expect(sameLabel({ background: "#ABCDEF", text: "#000000", fontId: "a" }, { background: "#abcdef", text: "#000000", fontId: "a" })).toBe(true);
    expect(sameLabel(PLAIN_LABEL, { ...PLAIN_LABEL, fontId: "other" })).toBe(false);
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

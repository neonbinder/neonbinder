/**
 * NEO-335 Phase 2 — TeamsOnCardsSection's own controls: the whole-set team
 * hint (C7), "Other team…" (C1), a card's own answer inside a grouped line
 * (C3), the multi-select chips and their cap (C4), and the listing's team
 * claim (invariant 8). The decisions are pinned in teams-on-cards.test.tsx;
 * the wizard wiring in EntityReviewWizard.teamsOnCards.test.tsx.
 *
 * TeamPicker is stubbed: its search and its New Team dialog (which creates
 * the team through `teams.findOrCreate`) have their own suites. What matters
 * here is what the section does with the id the picker hands back.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("../../convex/_generated/api", () => {
  const moduleProxy = (mod: string) =>
    new Proxy({}, { get: (_t, fn) => `${mod}.${String(fn)}` });
  return { api: new Proxy({}, { get: (_t, mod) => moduleProxy(String(mod)) }) };
});

const SPORT = "sport_baseball" as Id<"selectorOptions">;
const OTHER_SPORT = "sport_football" as Id<"selectorOptions">;
const REDS = "team_reds" as Id<"teams">;
const YANKEES = "team_yankees" as Id<"teams">;
const MADE = "team_just_made" as Id<"teams">;

type Team = { teamId: Id<"teams">; name: string };
let playerAnswer: (p: { playerId?: string; name?: string }) => unknown;
let nameAnswer: (name: string) => Team[];
const teamDocs: Record<string, { _id: string; name: string; sportId: string }> = {};

vi.mock("convex/react", () => ({
  useQueries: (
    queries: Record<
      string,
      { args: { players: Array<{ name?: string }>; teamNames?: string[] } }
    >,
  ) => {
    const out: Record<string, unknown> = {};
    for (const [key, { args }] of Object.entries(queries)) {
      out[key] = {
        setYear: 1985,
        sportId: SPORT,
        setLeagueId: null,
        players: args.players.map((p) => playerAnswer(p)),
        teamNames: (args.teamNames ?? []).map((n) => ({ teams: nameAnswer(n) })),
      };
    }
    return out;
  },
  useQuery: (ref: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (ref === "teams.getManyByIds") {
      return (args as { ids: string[] }).ids.flatMap((id) => (teamDocs[id] ? [teamDocs[id]] : []));
    }
    return undefined;
  },
}));

/** The picker, reduced to "the operator found or created this team". */
vi.mock("./TeamPicker", () => ({
  default: function StubTeamPicker({
    onChange,
    labels,
  }: {
    onChange: (ids: string[]) => void;
    labels: { trigger: string };
  }) {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <button type="button" aria-label={labels.trigger} onClick={() => setOpen(true)}>
          + {labels.trigger}
        </button>
        {open && (
          <>
            <button type="button" onClick={() => onChange([MADE])}>
              stub: create Brand New Club
            </button>
            <button type="button" onClick={() => onChange(["team_second"])}>
              stub: create Second Club
            </button>
            <button type="button" onClick={() => onChange(["team_third"])}>
              stub: create Third Club
            </button>
            <button type="button" onClick={() => onChange(["team_jets"])}>
              stub: pick another sport's team
            </button>
          </>
        )}
      </div>
    );
  },
}));

import TeamsOnCardsSection from "./TeamsOnCardsSection";
import type { GroupChoice, PreviewCardForTeams, TeamAnswer } from "./teams-on-cards";

const answers: Array<Array<TeamAnswer | undefined>> = [];

function Harness({
  cards,
  rows = [],
  showSetTeamHint,
}: {
  cards: PreviewCardForTeams[];
  rows?: Parameters<typeof TeamsOnCardsSection>[0]["rows"];
  showSetTeamHint?: boolean;
}) {
  const [choices, setChoices] = useState<Record<string, GroupChoice>>({});
  return (
    <TeamsOnCardsSection
      selectorOptionId={"node_insert" as Id<"selectorOptions">}
      cards={cards}
      rows={rows}
      linkedTeamNameById={new Map()}
      choices={choices}
      onChoose={(key, choice) => setChoices((prev) => ({ ...prev, [key]: choice }))}
      onAnswersChange={(next) => answers.push(next)}
      showSetTeamHint={showSetTeamHint}
    />
  );
}

const last = () => answers[answers.length - 1];
const card = (cardNumber: string, players: string[], teams?: string[]): PreviewCardForTeams => ({
  cardNumber,
  cardName: `Card ${cardNumber}`,
  players,
  ...(teams ? { teams } : {}),
});

beforeEach(() => {
  answers.length = 0;
  playerAnswer = () => ({ answer: null, candidates: [] });
  nameAnswer = () => [];
  for (const key of Object.keys(teamDocs)) delete teamDocs[key];
  teamDocs[MADE] = { _id: MADE, name: "Brand New Club", sportId: SPORT };
  teamDocs.team_second = { _id: "team_second", name: "Second Club", sportId: SPORT };
  teamDocs.team_third = { _id: "team_third", name: "Third Club", sportId: SPORT };
  teamDocs.team_jets = { _id: "team_jets", name: "Jets", sportId: OTHER_SPORT };
});

describe("C7 — the whole-set team hint", () => {
  const HINT =
    "Most of these share one team? Set a whole-set team in Set details and every new card gets it.";

  it("renders the approved hint only when the host asks", () => {
    const { unmount } = render(<Harness cards={[card("1", ["A"])]} showSetTeamHint />);
    expect(screen.getByText(HINT)).toBeTruthy();
    unmount();
    render(<Harness cards={[card("1", ["A"])]} />);
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("draws no heading of its own (the wizard owns the step's title and intro)", () => {
    render(<Harness cards={[card("1", ["A"])]} />);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByText(/no team yet/)).toBeNull();
  });
});

describe("C1 — Other team…", () => {
  it("opens the picker ready to search, and a created team joins the line selected", () => {
    playerAnswer = () => ({ answer: null, candidates: [{ teamId: REDS, name: "Cincinnati Reds" }] });
    render(<Harness cards={[card("1", ["Johnny Bench"])]} />);
    const other = screen.getByRole("button", { name: "Other team… — Johnny Bench" });
    expect(other.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(other);
    expect(other.getAttribute("aria-expanded")).toBe("true");
    // Opened on arrival: the stub's search is showing without a second press.
    act(() => {
      fireEvent.click(screen.getByText("stub: create Brand New Club"));
    });
    const group = screen.getByRole("radiogroup", { name: "Team for Johnny Bench" });
    const made = within(group).getByRole("radio", { name: "Brand New Club — Johnny Bench" });
    expect(made.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(made);
    // The picker closed behind the pick.
    expect(screen.queryByText("stub: create Brand New Club")).toBeNull();
    expect(last()).toEqual([{ teamIds: [MADE] }]);
    // Switching to "No team" and back keeps the found team on the line.
    fireEvent.click(within(group).getByRole("radio", { name: "No team on this card — Johnny Bench" }));
    expect(last()).toEqual([{ teamNone: true }]);
    expect(within(group).getByRole("radio", { name: "Brand New Club — Johnny Bench" })).toBeTruthy();
  });

  it("another sport's team is shown, refused, and never reaches the save", () => {
    render(<Harness cards={[card("1", ["Johnny Bench"])]} />);
    fireEvent.click(screen.getByRole("button", { name: "Other team… — Johnny Bench" }));
    act(() => {
      fireEvent.click(screen.getByText("stub: pick another sport's team"));
    });
    expect(screen.getByText(/from another sport/)).toBeTruthy();
    expect(last()).toEqual([undefined]);
  });
});

describe("C3 — a card's own team inside a grouped line", () => {
  it("one card takes its own answer; Match the others hands it back", () => {
    playerAnswer = () => ({
      answer: { tier: "oneTeamInWindow", teams: [{ teamId: REDS, name: "Cincinnati Reds" }] },
      candidates: [],
    });
    render(
      <Harness cards={[card("1", ["Johnny Bench"]), card("2", ["Johnny Bench"]), card("3", ["Johnny Bench"])]} />,
    );
    expect(last()).toEqual([{ teamIds: [REDS] }, { teamIds: [REDS] }, { teamIds: [REDS] }]);
    fireEvent.click(screen.getByRole("button", { name: "Different team… — #2 Card 2" }));
    const own = screen.getByRole("radiogroup", { name: "Team for #2 Card 2" });
    // Starts from the line's answer, focused, ready to change.
    expect(document.activeElement).toBe(
      within(own).getByRole("radio", { name: "Cincinnati Reds — #2 Card 2" }),
    );
    fireEvent.click(within(own).getByRole("radio", { name: "No team on this card — #2 Card 2" }));
    expect(last()).toEqual([{ teamIds: [REDS] }, { teamNone: true }, { teamIds: [REDS] }]);
    expect(screen.getByText(/with its own team/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Match the others — #2 Card 2" }));
    expect(screen.queryByRole("radiogroup", { name: "Team for #2 Card 2" })).toBeNull();
    expect(last()).toEqual([{ teamIds: [REDS] }, { teamIds: [REDS] }, { teamIds: [REDS] }]);
  });
});

describe("C4 — multi-player cards pick several teams", () => {
  it("team chips are checkboxes; both pre-ticked from two answers; untick one", () => {
    playerAnswer = (p) => ({
      answer: {
        tier: "oneTeamInWindow",
        teams: [p.name === "A" ? { teamId: REDS, name: "Cincinnati Reds" } : { teamId: YANKEES, name: "New York Yankees" }],
      },
      candidates: [],
    });
    render(<Harness cards={[card("1", ["A", "B"])]} />);
    const group = screen.getByRole("group", { name: "Teams for A & B" });
    const boxes = within(group).getAllByRole("checkbox");
    expect(boxes.map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "true"]);
    expect(last()).toEqual([{ teamIds: [REDS, YANKEES] }]);
    fireEvent.click(boxes[1]);
    expect(last()).toEqual([{ teamIds: [REDS] }]);
    // Arrows move focus only; Enter toggles.
    boxes[0].focus();
    fireEvent.keyDown(boxes[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(boxes[1]);
    expect(last()).toEqual([{ teamIds: [REDS] }]);
    fireEvent.keyDown(boxes[1], { key: "Enter" });
    expect(last()).toEqual([{ teamIds: [REDS, YANKEES] }]);
  });

  it("at the cap the unticked chips and Other team… are held, and the line says why", () => {
    const names = Array.from({ length: 9 }, (_, i) => `P${i}`);
    playerAnswer = (p) => {
      const i = Number(p.name!.slice(1));
      return { answer: null, candidates: [{ teamId: `team_${i}`, name: `Team ${i}` }] };
    };
    render(<Harness cards={[card("1", names)]} />);
    const owner = names.join(" & ");
    const group = screen.getByRole("group", { name: `Teams for ${owner}` });
    const other = () => screen.getByRole("button", { name: `Other team… — ${owner}` });
    // Three teams found with Other team… (the same one twice adds nothing)…
    for (const stub of ["Brand New Club", "Second Club", "Brand New Club", "Third Club"]) {
      fireEvent.click(other());
      act(() => {
        fireEvent.click(screen.getByText(`stub: create ${stub}`));
      });
    }
    expect(last()[0]?.teamIds).toHaveLength(3);
    // …then five of the six suggested chips: eight, the cap.
    const evidence = within(group)
      .getAllByRole("checkbox")
      .filter((b) => b.getAttribute("aria-checked") === "false");
    expect(evidence).toHaveLength(6);
    for (const box of evidence.slice(0, 5)) fireEvent.click(box);
    expect(last()[0]?.teamIds).toHaveLength(8);
    expect(screen.getByText(/That is the limit of 8 teams on one card/)).toBeTruthy();
    const held = within(group)
      .getAllByRole("checkbox")
      .filter((b) => b.getAttribute("aria-checked") === "false");
    expect(held.every((b) => b.getAttribute("aria-disabled") === "true")).toBe(true);
    fireEvent.click(held[0]);
    expect(last()[0]?.teamIds).toHaveLength(8);
    expect(
      screen.getByRole("button", { name: `Other team… — ${owner}` }).getAttribute("aria-disabled"),
    ).toBe("true");
  });
});

describe("invariant 8 — the listing's team claim", () => {
  it("shows what was listed, offers its NB match first, and pre-fills nothing", () => {
    const BULLS = "team_bulls" as Id<"teams">;
    playerAnswer = () => ({
      answer: { tier: "oneTeamInWindow", teams: [{ teamId: REDS, name: "Cincinnati Reds" }] },
      candidates: [],
    });
    nameAnswer = (name) => (name === "Durham Bulls" ? [{ teamId: BULLS, name: "Durham Bulls" }] : []);
    render(
      <Harness
        cards={[card("1", ["Johnny Bench"], ["Durham Bulls"])]}
        rows={[{ _id: "r1", kind: "team", name: "Durham Bulls", decision: { action: "skip" } }]}
      />,
    );
    expect(screen.getByText("Marketplace says:")).toBeTruthy();
    const group = screen.getByRole("radiogroup", { name: "Team for Johnny Bench" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual([
      "Durham Bulls — Johnny Bench",
      "Cincinnati Reds — Johnny Bench",
      "No team on this card — Johnny Bench",
      "Leave for later — Johnny Bench",
    ]);
    expect(
      within(group).getByRole("radio", { name: "Leave for later — Johnny Bench" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(last()).toEqual([undefined]);
  });
});

/**
 * NEO-335 Phase 2 — TeamsOnCardsSection's own controls: the whole-set team
 * hint (C7), "Other team…" (C1), a card's own answer inside a grouped line
 * (C3), the multi-select chips and their cap (C4), and the listing's team
 * claim (invariant 8). The decisions are pinned in teams-on-cards.test.tsx;
 * the wizard wiring in EntityReviewWizard.teamsOnCards.test.tsx.
 *
 * The Other-team search is the real `Autocomplete` over a stubbed
 * `teams.search`; the New Team dialog (which creates the team through
 * `teams.findOrCreate`) is stubbed — it has its own suite. What matters here
 * is what the section does with the id it hands back.
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
/** What `teams.search` answers, filtered by the typed text. */
let searchable: Array<{ _id: string; name: string; sportId: string }> = [];
let searchCalls: Array<{ query: string; sportId: string }> = [];

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
    if (ref === "teams.search") {
      const { query, sportId } = args as { query: string; sportId: string };
      searchCalls.push({ query, sportId });
      return searchable.filter((t) => t.name.toLowerCase().includes(query.toLowerCase()));
    }
    if (ref === "teams.getManyByIds") {
      return (args as { ids: string[] }).ids.flatMap((id) => (teamDocs[id] ? [teamDocs[id]] : []));
    }
    return undefined;
  },
}));

/** The New Team dialog, reduced to "the operator created this team". */
vi.mock("./NewTeamDialog", () => ({
  default: function StubNewTeamDialog({
    initialName,
    onCreated,
    onClose,
  }: {
    initialName: string;
    onCreated: (id: string) => void;
    onClose: () => void;
  }) {
    return (
      <div role="dialog" aria-label={`stub new team ${initialName}`}>
        <button type="button" onClick={() => onCreated(MADE)}>
          stub: create {initialName}
        </button>
        <button type="button" onClick={onClose}>
          stub: close
        </button>
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
  hidden,
}: {
  hidden?: boolean;
  cards: PreviewCardForTeams[];
  rows?: Parameters<typeof TeamsOnCardsSection>[0]["rows"];
  showSetTeamHint?: boolean;
}) {
  const [choices, setChoices] = useState<Record<string, GroupChoice>>({});
  return (
    // The wizard is a role="dialog"; the search's list portals into it.
    <div role="dialog" aria-label="test wizard">
    {/* The wizard keeps the section mounted, hidden, on its later steps. */}
    <div hidden={hidden}>
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
    </div>
    </div>
  );
}

const SEARCH = "Team name to find";

/** Type into the open Other-team field and press the option that appears. */
async function typeAndPick(text: string, option: string) {
  const input = screen.getByRole("combobox", { name: SEARCH });
  fireEvent.change(input, { target: { value: text } });
  const row = await screen.findByRole("option", { name: option });
  act(() => {
    fireEvent.mouseDown(row);
  });
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
  searchable = [teamDocs.team_second, teamDocs.team_third];
  searchCalls = [];
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
  it("one press opens the search field, focused; a new name goes through New Team and joins the line selected", async () => {
    playerAnswer = () => ({ answer: null, candidates: [{ teamId: REDS, name: "Cincinnati Reds" }] });
    render(<Harness cards={[card("1", ["Johnny Bench"])]} />);
    const other = screen.getByRole("button", { name: "Other team… — Johnny Bench" });
    expect(other.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(other);
    expect(other.getAttribute("aria-expanded")).toBe("true");
    // The field itself, focused — no second button to press first.
    const input = screen.getByRole("combobox", { name: SEARCH });
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("placeholder")).toBe("Search or add a team…");
    // No second button to press, not even one hidden from sight.
    expect(screen.queryByRole("button", { name: /Look up a team|Add team/, hidden: true })).toBeNull();
    expect(screen.getByRole("group", { name: "Find another team" }).contains(input)).toBe(true);

    await typeAndPick("Brand New Club", "+ New team “Brand New Club”…");
    // Searched in the set's sport only.
    expect(searchCalls.every((c) => c.sportId === SPORT)).toBe(true);
    act(() => {
      fireEvent.click(screen.getByText("stub: create Brand New Club"));
    });
    const group = screen.getByRole("radiogroup", { name: "Team for Johnny Bench" });
    const made = within(group).getByRole("radio", { name: "Brand New Club — Johnny Bench" });
    expect(made.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(made);
    // The field closed behind the pick.
    expect(screen.queryByRole("combobox", { name: SEARCH })).toBeNull();
    expect(last()).toEqual([{ teamIds: [MADE] }]);
    // Switching to "No team" and back keeps the found team on the line.
    fireEvent.click(within(group).getByRole("radio", { name: "No team on this card — Johnny Bench" }));
    expect(last()).toEqual([{ teamNone: true }]);
    expect(within(group).getByRole("radio", { name: "Brand New Club — Johnny Bench" })).toBeTruthy();
  });

  it("an existing team found by the search is picked by keyboard", async () => {
    render(<Harness cards={[card("1", ["Johnny Bench"])]} />);
    fireEvent.click(screen.getByRole("button", { name: "Other team… — Johnny Bench" }));
    const input = screen.getByRole("combobox", { name: SEARCH });
    fireEvent.change(input, { target: { value: "Second" } });
    await screen.findByRole("option", { name: "Second Club" });
    // The first match is highlighted as the list opens; Enter takes it.
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(last()).toEqual([{ teamIds: ["team_second"] }]);
  });

  it("a name nothing matches says No matches., and Enter opens New Team on it (the E2E path)", async () => {
    render(<Harness cards={[card("1", ["Johnny Bench"])]} />);
    fireEvent.click(screen.getByRole("button", { name: "Other team… — Johnny Bench" }));
    const input = screen.getByRole("combobox", { name: SEARCH });
    fireEvent.change(input, { target: { value: "RXO123T" } });
    await screen.findByText("No matches.");
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(screen.getByRole("dialog", { name: "stub new team RXO123T" })).toBeTruthy();
  });

  it("Enter in the field never reaches the wizard", async () => {
    const wizardEnter = vi.fn();
    render(
      <div onKeyDown={(e) => e.key === "Enter" && wizardEnter()}>
        <Harness cards={[card("1", ["Johnny Bench"])]} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Other team… — Johnny Bench" }));
    const input = screen.getByRole("combobox", { name: SEARCH });
    fireEvent.keyDown(input, { key: "Enter" }); // nothing typed
    fireEvent.change(input, { target: { value: "Second" } });
    await screen.findByRole("option", { name: "Second Club" });
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" }); // a pick
    });
    expect(last()).toEqual([{ teamIds: ["team_second"] }]);
    expect(wizardEnter).not.toHaveBeenCalled();
  });

  it("hiding the section (a later wizard step) closes an open field and its New Team dialog", async () => {
    const { rerender } = render(<Harness cards={[card("1", ["Johnny Bench"])]} />);
    fireEvent.click(screen.getByRole("button", { name: "Other team… — Johnny Bench" }));
    await typeAndPick("Brand New Club", "+ New team “Brand New Club”…");
    expect(screen.getByRole("dialog", { name: "stub new team Brand New Club" })).toBeTruthy();
    rerender(<Harness cards={[card("1", ["Johnny Bench"])]} hidden />);
    expect(screen.queryByRole("combobox", { name: SEARCH, hidden: true })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "stub new team Brand New Club", hidden: true })).toBeNull();
    rerender(<Harness cards={[card("1", ["Johnny Bench"])]} />);
    expect(
      screen.getByRole("button", { name: "Other team… — Johnny Bench" }).getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("the list lives in the dialog's own layer, not inside the line (so a scroll box cannot clip it)", async () => {
    render(<Harness cards={[card("1", ["Johnny Bench"])]} />);
    fireEvent.click(screen.getByRole("button", { name: "Other team… — Johnny Bench" }));
    fireEvent.change(screen.getByRole("combobox", { name: SEARCH }), { target: { value: "Club" } });
    const listbox = await screen.findByRole("listbox");
    expect(listbox.closest('[role="dialog"]')).not.toBeNull();
    expect(listbox.closest("li")).toBeNull();
  });

  it("Escape closes the list first, then the field, and focus returns to Other team…", async () => {
    render(<Harness cards={[card("1", ["Johnny Bench"])]} />);
    const other = screen.getByRole("button", { name: "Other team… — Johnny Bench" });
    fireEvent.click(other);
    const input = screen.getByRole("combobox", { name: SEARCH });
    fireEvent.change(input, { target: { value: "Club" } });
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("combobox", { name: SEARCH })).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("combobox", { name: SEARCH })).toBeNull();
    expect(other.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(document.activeElement).toBe(other));
  });
});

describe("keyboard — held chips", () => {
  it("in a radio group the arrows skip a chip that cannot be picked", async () => {
    playerAnswer = () => ({ answer: null, candidates: [{ teamId: REDS, name: "Cincinnati Reds" }] });
    searchable = [teamDocs.team_jets];
    render(<Harness cards={[card("1", ["Johnny Bench"])]} />);
    fireEvent.click(screen.getByRole("button", { name: "Other team… — Johnny Bench" }));
    await typeAndPick("Jets", "Jets");
    const group = screen.getByRole("radiogroup", { name: "Team for Johnny Bench" });
    const jets = within(group).getByRole("radio", { name: "Jets — Johnny Bench" });
    expect(jets.getAttribute("aria-disabled")).toBe("true");
    const reds = within(group).getByRole("radio", { name: "Cincinnati Reds — Johnny Bench" });
    fireEvent.click(reds);
    fireEvent.keyDown(reds, { key: "ArrowRight" });
    const none = within(group).getByRole("radio", { name: "No team on this card — Johnny Bench" });
    expect(document.activeElement).toBe(none);
    expect(none.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(none, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(reds);
  });

  it("a multi line tells a screen reader how its keys work", () => {
    render(<Harness cards={[card("1", ["A", "B"])]} />);
    const group = screen.getByRole("group", { name: "Teams for A & B" });
    const hint = document.getElementById(group.getAttribute("aria-describedby")!);
    expect(hint?.textContent).toBe("Arrow keys move, Space picks");
  });

  it("a one-team line carries no such hint: the radio pattern announces itself", () => {
    render(<Harness cards={[card("1", ["A"])]} />);
    expect(
      screen.getByRole("radiogroup", { name: "Team for A" }).getAttribute("aria-describedby"),
    ).toBeNull();
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
    // The line says which cards it covers, and opens on them.
    const cards = screen.getByRole("button", { name: /^#1 · #2 · #3 · 3 cards/ });
    expect(cards.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Just this card… — #2 Card 2" })).toBeNull();
    fireEvent.click(cards);
    expect(cards.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Just this card… — #2 Card 2" }));
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

  it("at the cap the unticked chips and Other team… are held, and the line says why", async () => {
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
    const find = async (text: string, option: string) => {
      fireEvent.click(other());
      await typeAndPick(text, option);
    };
    await find("Brand New Club", "+ New team “Brand New Club”…");
    act(() => {
      fireEvent.click(screen.getByText("stub: create Brand New Club"));
    });
    await find("Second", "Second Club");
    await find("Second", "Second Club");
    await find("Third", "Third Club");
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
        rows={[{ _id: "r1", kind: "team", name: "Durham Bulls", decision: null }]}
      />,
    );
    expect(screen.getByText("Listed as:")).toBeTruthy();
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

  it("a name ruled \"not a team\" in this sitting neither shows nor blocks the pre-fill", () => {
    playerAnswer = () => ({
      answer: { tier: "oneTeamInWindow", teams: [{ teamId: REDS, name: "Cincinnati Reds" }] },
      candidates: [],
    });
    render(
      <Harness
        cards={[card("1", ["Johnny Bench"], ["Team Card"])]}
        rows={[{ _id: "r1", kind: "team", name: "Team Card", decision: { action: "skip" } }]}
      />,
    );
    expect(screen.queryByText("Listed as:")).toBeNull();
    expect(
      screen.getByRole("radio", { name: "Cincinnati Reds — Johnny Bench" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(last()).toEqual([{ teamIds: [REDS] }]);
  });
});

describe("collector review — playerless cards and the livery", () => {
  it("cards with no players share one line, left for later, each can take its own team", () => {
    render(
      <Harness
        cards={[
          { cardNumber: "1", cardName: "Checklist", players: [] },
          { cardNumber: "99", cardName: "League Leaders", players: [] },
        ]}
      />,
    );
    const owner = "Cards with no players (2)";
    const group = screen.getByRole("radiogroup", { name: `Team for ${owner}` });
    expect(
      within(group).getByRole("radio", { name: `Leave for later — ${owner}` }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /^#1 · #99 · 2 cards/ }));
    fireEvent.click(screen.getByRole("button", { name: "Just this card… — #99 League Leaders" }));
    fireEvent.click(
      screen.getByRole("radio", { name: "No team on this card — #99 League Leaders" }),
    );
    expect(last()).toEqual([undefined, { teamNone: true }]);
  });

  it("a team's name wears its colour only when it reads; there is no colour dot", () => {
    playerAnswer = () => ({
      answer: null,
      candidates: [
        // Reds red on the dark chip fails 4.5:1 → default text colour.
        { teamId: REDS, name: "Cincinnati Reds", colors: { primary: "#C6011F" } },
        // A pale livery clears it → the name is drawn in it.
        { teamId: YANKEES, name: "Pale Club", colors: { primary: "#F5D130" } },
      ],
    });
    render(<Harness cards={[card("1", ["Johnny Bench"])]} />);
    const reds = screen.getByRole("radio", { name: "Cincinnati Reds — Johnny Bench" });
    const pale = screen.getByRole("radio", { name: "Pale Club — Johnny Bench" });
    expect(within(reds).getByText("Cincinnati Reds").getAttribute("style")).toBeNull();
    expect(within(pale).getByText("Pale Club").getAttribute("style")).toContain("color");
    // Nothing round and coloured beside the name: the ✓ is the only selection mark.
    for (const radio of [reds, pale]) {
      expect(radio.querySelector("[style*='background']")).toBeNull();
    }
  });
});

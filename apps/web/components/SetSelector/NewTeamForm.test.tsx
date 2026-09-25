/**
 * NEO-236 — coverage for `NewTeamForm`, the ONE form a team is ever created
 * from.
 *
 * Jason, 2026-09-05, on the review wizard showing three cramped Location/Name
 * pairs under a player's career list: "How does this dialog know which League
 * the new team is in? I think we need to show a new team dialog instead of that
 * inline thing." So the three questions a `teams` row needs — Location, Name,
 * League — are asked in exactly one component, rendered by two hosts
 * (`NewTeamDialog` over a picker, and `EntityReviewWizard`'s New Team step).
 * The hosts have their own files; this one pins the shared half.
 *
 * What is locked in here, and why each matters:
 *
 *  1. **`newTeamPrefill` never guesses.** It splits a Location off the front of
 *     the proposed name ONLY when an enrichment lookup supplied one and
 *     `splitTeamName` finds it as a whole-word prefix. Everything else starts
 *     with the whole name in Name and a blank Location — a component that
 *     guessed "San Diego" out of "San Diego Padres" on its own would be the
 *     first-token heuristic the split was designed to avoid.
 *  2. **The preview composes.** "Shows as: …" is `teamFullName` over the draft,
 *     so the operator reads the row they are about to write, composed the way
 *     it will read everywhere else.
 *  3. **League is a type-ahead combobox named "League" (NEO-307), not a
 *     `<select>`.** Its accessible name and each option's text are the E2E
 *     contract; its options are `<li role="option">`, which Maestro can tap —
 *     a second native `<select>` on a page it cannot.
 *  4. **The two league answers are alternatives.** Picking either clears the
 *     other, so a draft can never carry an id AND a name and leave the server's
 *     resolution order to decide which one the operator meant.
 *  5. **The suggestion is the standing answer while unanswered.** That is not a
 *     pre-selection pretending to be an answer: with nothing recorded the
 *     server falls back to the enrichment's league, so the suggestion IS what
 *     will happen.
 *  6. **"Create {name}" appears only when the sport holds no matching league**,
 *     compared on a normalized name — a false positive would silently file the
 *     team in the wrong league, so the match has to be checked both ways.
 *
 * --- Mocking strategy ---
 * `convex/react`'s `useQuery` is module-mocked and routed by the
 * (string-mocked) query reference, so `leagues.list` resolves to whatever a
 * test sets. Nothing else in this component touches Convex.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    leagues: { list: "leagues.list" },
    // NEO-254: every era this sport holds under the name being typed. The form
    // reads it to say "already exists for 1972–1996" beside a name that is
    // taken — a second era is legitimate, so it states rather than blocks.
    teams: { erasByNameAndSport: "teams.erasByNameAndSport" },
  },
}));

let currentLeagues: unknown;
/** NEO-254 — what `teams.erasByNameAndSport` answers. Empty by default, so the
 *  hint stays out of every test that is not about it. */
let currentEras: Array<{
  _id: string;
  name: string;
  location?: string;
  yearsActive?: { from: number; to?: number };
  label: string;
}> = [];
let queryCalls: Array<{ ref: string; args: unknown }>;

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    queryCalls.push({ ref, args });
    if (ref === "leagues.list") return currentLeagues;
    if (ref === "teams.erasByNameAndSport") return currentEras;
    return undefined;
  },
}));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks
// ---------------------------------------------------------------------------

import NewTeamForm, {
  draftFullName,
  newTeamPrefill,
  type NewTeamDraft,
} from "./NewTeamForm";

const SPORT_ID = "selopt-sport-1" as unknown as Id<"selectorOptions">;

function lid(id: string): Id<"leagues"> {
  return id as unknown as Id<"leagues">;
}

const EMPTY: NewTeamDraft = {
  location: "",
  name: "",
  leagueId: undefined,
  leagueName: undefined,
  aliases: "",
};

/**
 * A stateful host, because `NewTeamForm` is fully controlled: without a parent
 * that applies the patch, every "type then read it back" assertion would be
 * testing the harness rather than the form. `onChangeSpy` exposes the raw patch
 * for the cases that are ABOUT the patch (the league alternatives).
 */
function Harness({
  initial = EMPTY,
  onChangeSpy,
  ...rest
}: {
  initial?: NewTeamDraft;
  onChangeSpy?: (patch: Partial<NewTeamDraft>) => void;
} & Omit<
  React.ComponentProps<typeof NewTeamForm>,
  "sportId" | "draft" | "onChange" | "locationFieldId" | "nameFieldId" | "leagueGroupId"
>) {
  const [draft, setDraft] = React.useState<NewTeamDraft>(initial);
  return (
    <NewTeamForm
      sportId={SPORT_ID}
      draft={draft}
      onChange={(patch) => {
        onChangeSpy?.(patch);
        setDraft((prev) => ({ ...prev, ...patch }));
      }}
      locationFieldId="test-location"
      nameFieldId="test-name"
      leagueGroupId="test-league"
      {...rest}
    />
  );
}

function renderForm(
  props: React.ComponentProps<typeof Harness> = {},
): ReturnType<typeof render> {
  return render(<Harness {...props} />);
}
/**
 * NEO-307 — the League combobox and its list, read the way a flow reads them.
 *
 * `optionLabels` takes each option's DIRECT text nodes only — the label —
 * which is exactly what a Maestro `text:` selector matches. The current
 * answer's check mark is a child `<span>`, so it never joins the label.
 */
const leagueField = () =>
  screen.getByRole("combobox", { name: "League" }) as HTMLInputElement;
/** Focus opens the whole list — no typing needed. */
function openLeagueList(): void {
  fireEvent.focus(leagueField());
}
function typeLeague(text: string): void {
  openLeagueList();
  fireEvent.change(leagueField(), { target: { value: text } });
}
function pickLeague(label: string): void {
  openLeagueList();
  fireEvent.mouseDown(screen.getByRole("option", { name: label }));
}
const directText = (el: Element) =>
  Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent)
    .join("");
const optionLabels = () => screen.queryAllByRole("option").map(directText);
/** The option the arrows are on (`aria-selected`, the combobox's highlight). */
const highlightedLabel = () => {
  const option = screen
    .queryAllByRole("option")
    .find((o) => o.getAttribute("aria-selected") === "true");
  return option ? directText(option) : null;
};
/** The option marked as the field's current answer. */
const currentOptionLabel = () => {
  const option = screen
    .queryAllByRole("option")
    .find((o) => o.querySelector('[aria-hidden="true"]')?.textContent === "✓");
  return option ? directText(option) : null;
};

const locationField = () =>
  screen.getByLabelText("New team location (optional)") as HTMLInputElement;
const nameField = () => screen.getByLabelText("New team name") as HTMLInputElement;

/**
 * The composed-name preview, read as one string.
 *
 * Testing Library's text matcher only sees an element's DIRECT text nodes, and
 * this line is "Shows as: " plus a `<span>` holding the composed name — so
 * `getByText("Shows as: San Diego Padres")` matches nothing. The paragraph is
 * addressed by its own literal text and its full `textContent` is what the
 * operator actually reads.
 */
const previewText = () => screen.getByText("Shows as:").textContent;

beforeEach(() => {
  vi.clearAllMocks();
  currentLeagues = [];
  currentEras = [];
  queryCalls = [];
});

// ---------------------------------------------------------------------------
// newTeamPrefill — the only place a name is ever split, and it never guesses
// ---------------------------------------------------------------------------

describe("newTeamPrefill", () => {
  it("splits the location off the front when it is a whole-word prefix", () => {
    expect(
      newTeamPrefill({ name: "San Diego Padres", location: "San Diego" }),
    ).toEqual({
      location: "San Diego",
      name: "Padres",
      leagueId: undefined,
      leagueName: undefined,
      aliases: "",
    });
  });

  it("does not split on a partial word", () => {
    // "Sa" sits at the front of the string but is not a word in it. Splitting
    // there would produce the team "n Diego Padres".
    expect(newTeamPrefill({ name: "San Diego Padres", location: "Sa" })).toEqual({
      location: "",
      name: "San Diego Padres",
      leagueId: undefined,
      leagueName: undefined,
      aliases: "",
    });
  });

  it("does not split when the lookup's location is not a prefix at all", () => {
    // Anaheim is where the franchise PLAYS, not the front of its name. A form
    // that split on it would offer to create "Anaheim Angels", a team that has
    // not existed since 2005.
    expect(
      newTeamPrefill({ name: "Los Angeles Angels", location: "Anaheim" }),
    ).toMatchObject({ location: "", name: "Los Angeles Angels" });
  });

  it("leaves Location blank, with the whole trimmed name in Name, when no location was found", () => {
    expect(newTeamPrefill({ name: "  Orix Buffaloes  " })).toMatchObject({
      location: "",
      name: "Orix Buffaloes",
    });
  });

  it("starts with the League question unanswered, not with a league picked", () => {
    // `undefined` is "not answered", which the server tells apart from the
    // operator's deliberate `null`. Seeding either here would record an answer
    // nobody gave.
    const draft = newTeamPrefill({ name: "Padres" });
    expect(draft.leagueId).toBeUndefined();
    expect(draft.leagueName).toBeUndefined();
  });
});

describe("draftFullName", () => {
  it("composes location and name with a single space", () => {
    expect(draftFullName({ location: "  San Diego  ", name: "  Padres  " })).toBe(
      "San Diego Padres",
    );
  });

  it("is just the name when there is no location", () => {
    expect(draftFullName({ location: "", name: "Athletics" })).toBe("Athletics");
  });
});

// ---------------------------------------------------------------------------
// The fields, and the composed preview
// ---------------------------------------------------------------------------

describe("NewTeamForm — fields", () => {
  it("renders the draft into the two boxes", () => {
    renderForm({ initial: { ...EMPTY, location: "San Diego", name: "Padres" } });

    expect(locationField().value).toBe("San Diego");
    expect(nameField().value).toBe("Padres");
  });

  it("composes the two boxes into the 'Shows as' preview as they are typed", () => {
    renderForm();

    fireEvent.change(nameField(), { target: { value: "Padres" } });
    expect(previewText()).toBe("Shows as: Padres");

    fireEvent.change(locationField(), { target: { value: "San Diego" } });
    expect(previewText()).toBe("Shows as: San Diego Padres");
  });

  it("shows an em dash rather than an empty preview while both boxes are blank", () => {
    renderForm();
    expect(previewText()).toBe("Shows as: —");
  });

  it("carries the whole visible label in the location field's accessible name", () => {
    // WCAG 2.2 SC 2.5.3 (label in name): the visible label is "Location
    // (optional)", so a voice-control user saying it has to match.
    renderForm();
    expect(locationField().getAttribute("aria-label")).toBe(
      "New team location (optional)",
    );
    expect(screen.getByText("Location (optional)")).toBeTruthy();
  });

  it("spells out what counts as a location, because the split is not obvious", () => {
    renderForm();
    expect(
      screen.getByText(/Location is where they are from/),
    ).toBeTruthy();
  });

  it("shows a 'Needed by' line only when the host supplies one", () => {
    const { unmount } = renderForm({ neededBy: "Travis Bazzana" });
    expect(screen.getByText("Needed by: Travis Bazzana")).toBeTruthy();
    unmount();

    renderForm();

    expect(screen.queryByText(/Needed by:/)).toBeNull();
  });

  it("points both fields at the host's blocked-reason element", () => {
    // Both, deliberately: the reason a create is blocked can be about the
    // composed name, which is what the two boxes make together.
    //
    // `aria-describedby` is a space-separated LIST — each field also points at
    // the preview, and Location at the help line — so this is a containment
    // check, not an equality one.
    renderForm({ describedBy: "why-blocked" });

    expect(locationField().getAttribute("aria-describedby")).toContain(
      "why-blocked",
    );
    expect(nameField().getAttribute("aria-describedby")).toContain("why-blocked");
  });

  it("describes Location by the help line, and both fields by the preview", () => {
    // SC 3.3.2 (Labels or Instructions). Both were plain text nothing pointed
    // at, so tabbing into Location announced "New team location (optional),
    // edit text" and nothing about what a location IS.
    renderForm({ initial: { ...EMPTY, location: "San Diego", name: "Padres" } });

    const help = screen.getByText(/^Location is where they are from/);
    const preview = screen.getByText("Shows as:");

    const locationDescribed = (
      locationField().getAttribute("aria-describedby") ?? ""
    ).split(" ");
    expect(locationDescribed).toContain(help.id);
    expect(locationDescribed).toContain(preview.id);

    const nameDescribed = (
      nameField().getAttribute("aria-describedby") ?? ""
    ).split(" ");
    expect(nameDescribed).toContain(preview.id);
    // The help line is about the Location box specifically; repeating it on
    // Name would announce a rule that does not apply there.
    expect(nameDescribed).not.toContain(help.id);
  });

  it("emits no dangling or empty aria-describedby when the host gives no reason", () => {
    renderForm();

    for (const field of [locationField(), nameField()]) {
      const value = field.getAttribute("aria-describedby");
      expect(value).toBeTruthy();
      for (const id of (value ?? "").split(" ")) {
        expect(document.getElementById(id)).not.toBeNull();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// NEO-284 — the aliases field
// ---------------------------------------------------------------------------

describe("NewTeamForm — aliases field", () => {
  const aliasField = () =>
    screen.getByLabelText("New team aliases (optional)") as HTMLTextAreaElement;

  it("renders the draft's raw text verbatim, unparsed", () => {
    renderForm({ initial: { ...EMPTY, aliases: "Bananas, The Bananas" } });

    expect(aliasField().value).toBe("Bananas, The Bananas");
  });

  it("reports every keystroke to the host as a raw `aliases` patch, not a parsed list", () => {
    const onChangeSpy = vi.fn();
    renderForm({ onChangeSpy });

    fireEvent.change(aliasField(), { target: { value: "Bananas" } });
    expect(onChangeSpy).toHaveBeenCalledWith({ aliases: "Bananas" });
    expect(aliasField().value).toBe("Bananas");
  });

  it("carries the whole visible label in its accessible name (SC 2.5.3)", () => {
    renderForm();
    expect(aliasField().getAttribute("aria-label")).toBe(
      "New team aliases (optional)",
    );
    expect(screen.getByText("Aliases (optional)")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Enter — the dialog submits, the wizard step does not
// ---------------------------------------------------------------------------

describe("NewTeamForm — Enter in a field", () => {
  it("calls onSubmit from either box and swallows the key", () => {
    const onSubmit = vi.fn();
    renderForm({ onSubmit });

    const nameEvent = fireEvent.keyDown(nameField(), { key: "Enter" });
    // `false` from fireEvent means preventDefault was called: the key must not
    // also reach a host that treats Enter as its own confirm.
    expect(nameEvent).toBe(false);
    fireEvent.keyDown(locationField(), { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("leaves Enter alone when the host gave no onSubmit (the wizard step)", () => {
    // The wizard's primary action is a walker button, not a submit, so Enter
    // there belongs to whatever the wizard does with it.
    renderForm();
    expect(fireEvent.keyDown(nameField(), { key: "Enter" })).toBe(true);
  });

  it("ignores other keys", () => {
    const onSubmit = vi.fn();
    renderForm({ onSubmit });

    fireEvent.keyDown(nameField(), { key: "a" });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
// ---------------------------------------------------------------------------
// NEO-307 — the League field is a type-ahead
//
// Jason, 2026-09-25, on the New Team step: "This is a terrible interface for
// selecting a league. It should be a type ahead select like we use for lots of
// other teams and such things." Baseball's bulk-loaded leagues had turned the
// pill row into line after line of buttons behind a "Show all leagues" toggle.
//
// The combobox's accessible name ("League") and its option TEXT are the E2E
// contract, so the labels are asserted exactly — read off the option's own
// direct text nodes, which is what a Maestro `text:` selector matches.
// ---------------------------------------------------------------------------

describe("NewTeamForm — the League field", () => {
  it("is a combobox named exactly 'League' — no radiogroup, no toggle, no select", () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    const { container } = renderForm({ onStageLeague: vi.fn() });

    expect(leagueField().tagName).toBe("INPUT");
    // The pill row's furniture is gone, not hidden.
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show all leagues" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide leagues" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ New league…" })).toBeNull();
    // Maestro can only reach the first native <select> on a page.
    expect(container.querySelector("select")).toBeNull();
  });

  it("never carries the host's id on the input, so 'League' stays its resource-id", () => {
    renderForm();
    expect(leagueField().id).toBe("");
    expect(document.getElementById("test-league")?.contains(leagueField())).toBe(true);
  });

  it("queries the leagues of THIS sport", () => {
    renderForm();
    expect(queryCalls).toContainEqual({
      ref: "leagues.list",
      args: { sportId: SPORT_ID },
    });
  });

  it("says it is still loading, and still offers 'No league'", () => {
    currentLeagues = undefined;
    renderForm();
    openLeagueList();

    // SC 4.1.3: the list changes shape under the operator when the query
    // lands, so the wait is announced rather than only drawn.
    const loading = screen.getByText("Loading leagues…");
    expect(loading.getAttribute("role")).toBe("status");
    // "No league" is always available — it is an answer, not a league row.
    expect(optionLabels()).toEqual(["No league"]);
  });

  it("opens on focus with nothing typed: the suggestion, then staged, then every league, then No league", () => {
    // Sources 1, 2, 3 and 5 in one list, in the order an operator looks.
    currentLeagues = [
      { _id: lid("l1"), name: "Atlantic League" },
      { _id: lid("l2"), name: "MLB" },
    ];
    renderForm({
      leagueSuggestion: "Australian Baseball League",
      stagedLeagueNames: ["United States Hockey League"],
    });
    expect(screen.queryByRole("listbox")).toBeNull();
    openLeagueList();

    expect(leagueField().getAttribute("aria-expanded")).toBe("true");
    expect(optionLabels()).toEqual([
      "Create Australian Baseball League",
      "United States Hockey League (new)",
      "Atlantic League",
      "MLB",
      "No league",
    ]);
  });

  it("lifts an existing suggested league to the top instead of listing it twice", () => {
    currentLeagues = [
      { _id: lid("l1"), name: "Atlantic League" },
      { _id: lid("l2"), name: "MLB" },
    ];
    renderForm({ leagueSuggestion: "MLB" });
    openLeagueList();

    expect(optionLabels()).toEqual(["MLB", "Atlantic League", "No league"]);
  });

  it("caps the list's height and scrolls it, so a long list cannot grow the dialog", () => {
    currentLeagues = Array.from({ length: 40 }, (_, i) => ({
      _id: lid(`l${i}`),
      name: `League ${i}`,
    }));
    renderForm();
    openLeagueList();

    const list = screen.getByRole("listbox");
    expect(list.className).toContain("max-h-40");
    expect(list.className).toContain("overflow-y-auto");
    // Floats over the form rather than pushing what is under it down — in a
    // fixed layer, so a scrolling host cannot clip it (NEO-307, CI 1024x629).
    expect(list.className).toContain("fixed");
    expect(screen.getAllByRole("option")).toHaveLength(41);
  });

  it("records an existing league as leagueId, clears any league NAME, and shows it at rest", () => {
    currentLeagues = [
      { _id: lid("l1"), name: "MLB" },
      { _id: lid("l2"), name: "Australian Baseball League" },
    ];
    const onChangeSpy = vi.fn();
    renderForm({
      initial: { ...EMPTY, leagueName: "Something Else" },
      onChangeSpy,
    });

    pickLeague("MLB");

    // The two answers are alternatives; carrying both would leave which one
    // the server honoured up to its resolution order.
    expect(onChangeSpy).toHaveBeenCalledWith({
      leagueId: lid("l1"),
      leagueName: undefined,
    });
    expect(leagueField().value).toBe("MLB");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("records 'No league' as a deliberate null, distinct from unanswered", () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    const onChangeSpy = vi.fn();
    renderForm({ onChangeSpy });

    pickLeague("No league");

    expect(onChangeSpy).toHaveBeenCalledWith({
      leagueId: null,
      leagueName: undefined,
    });
    expect(leagueField().value).toBe("No league");
  });

  it("reads empty, with a placeholder, when there is no answer and no suggestion", () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    renderForm();

    expect(leagueField().value).toBe("");
    expect(leagueField().placeholder).toBe("Pick a league");
    openLeagueList();
    expect(currentOptionLabel()).toBeNull();
  });

  it("invites typing a new league in its placeholder only when it can create one", () => {
    renderForm({ onStageLeague: vi.fn() });
    expect(leagueField().placeholder).toBe("Pick a league or type a new one");
  });

  it("shows a draft's existing pick at rest, and opens on it rather than on row 0", () => {
    currentLeagues = [
      { _id: lid("l1"), name: "MLB" },
      { _id: lid("l2"), name: "NPB" },
    ];
    renderForm({ initial: { ...EMPTY, leagueId: lid("l2") } });

    expect(leagueField().value).toBe("NPB");
    openLeagueList();
    // Enter on a freshly-focused field re-confirms the answer, not "MLB".
    expect(highlightedLabel()).toBe("NPB");
    expect(currentOptionLabel()).toBe("NPB");
  });

  it("selects the field's text on focus, so typing replaces the label shown", () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    renderForm({ initial: { ...EMPTY, leagueId: lid("l1") } });
    openLeagueList();

    expect(leagueField().selectionStart).toBe(0);
    expect(leagueField().selectionEnd).toBe("MLB".length);
  });

  it("disables the field while the host is busy, and records nothing", () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    const onChangeSpy = vi.fn();
    renderForm({ disabled: true, onChangeSpy });

    expect(leagueField().disabled).toBe(true);
    openLeagueList();
    for (const option of screen.queryAllByRole("option")) {
      fireEvent.mouseDown(option);
    }
    expect(onChangeSpy).not.toHaveBeenCalled();
  });

  it("says the sport has no leagues yet when there is nothing but 'No league'", () => {
    currentLeagues = [];
    renderForm({ onStageLeague: vi.fn() });
    expect(screen.getByText("No leagues in this sport yet.")).toBeTruthy();
  });

  it("says nothing of the kind once a league is offered", () => {
    currentLeagues = [];
    renderForm({ stagedLeagueNames: ["United States Hockey League"] });
    expect(screen.queryByText("No leagues in this sport yet.")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Typing narrows — on name, alias and abbreviation — and never answers
// ---------------------------------------------------------------------------

describe("NewTeamForm — typing in the League field", () => {
  const BASEBALL = [
    {
      _id: lid("l1"),
      name: "American Association of Professional Baseball",
      aliases: ["AA"],
    },
    { _id: lid("l2"), name: "Major League Baseball", abbreviation: "MLB" },
    {
      _id: lid("l3"),
      name: "National League",
      aliases: ["The Senior Circuit"],
    },
  ];

  it("filters on the league name, case-insensitive substring", () => {
    currentLeagues = BASEBALL;
    renderForm();
    typeLeague("LEAGUE");

    expect(optionLabels()).toEqual([
      "Major League Baseball",
      "National League",
      "No league",
    ]);
  });

  it("finds a league by one of its aliases", () => {
    currentLeagues = BASEBALL;
    renderForm();
    typeLeague("senior circ");

    // Listed by its NAME — the alias is how it was found, not what it is.
    expect(optionLabels()).toEqual(["National League", "No league"]);
  });

  it("finds a league by its abbreviation", () => {
    currentLeagues = BASEBALL;
    renderForm();
    typeLeague("mlb");
    expect(optionLabels()).toEqual(["Major League Baseball", "No league"]);
  });

  it("matches through punctuation and accents", () => {
    currentLeagues = [
      { _id: lid("l1"), name: "St. Louis Amateur League" },
      { _id: lid("l2"), name: "Ligue Panaméricaine" },
    ];
    renderForm();
    typeLeague("st louis");
    expect(optionLabels()).toEqual(["St. Louis Amateur League", "No league"]);
    typeLeague("panamer");
    expect(optionLabels()).toEqual(["Ligue Panaméricaine", "No league"]);
  });

  it("filters staged and suggested leagues on their names too", () => {
    currentLeagues = BASEBALL;
    renderForm({
      leagueSuggestion: "Australian Baseball League",
      stagedLeagueNames: ["United States Hockey League"],
    });
    typeLeague("hockey");
    expect(optionLabels()).toEqual(["United States Hockey League (new)", "No league"]);
    typeLeague("australian");
    expect(optionLabels()).toEqual(["Create Australian Baseball League", "No league"]);
  });

  it("keeps 'No league' on offer whatever is typed", () => {
    currentLeagues = BASEBALL;
    renderForm();
    typeLeague("zzzz");
    expect(optionLabels()).toEqual(["No league"]);
  });

  it("does not change the answer while typing, clearing, or walking away", () => {
    currentLeagues = BASEBALL;
    const onChangeSpy = vi.fn();
    renderForm({ initial: { ...EMPTY, leagueId: lid("l2") }, onChangeSpy });

    typeLeague("");
    // Cleared: the whole list again, and nothing recorded.
    expect(optionLabels()).toHaveLength(4);
    typeLeague("Nat");
    expect(onChangeSpy).not.toHaveBeenCalled();

    fireEvent.blur(leagueField());
    // The answer's label comes back; the half-typed text was not an answer.
    expect(leagueField().value).toBe("Major League Baseball");
    expect(onChangeSpy).not.toHaveBeenCalled();
  });

  it("puts the answer's label back on Escape, too", () => {
    currentLeagues = BASEBALL;
    renderForm({ initial: { ...EMPTY, leagueId: null } });
    typeLeague("Nat");

    fireEvent.keyDown(leagueField(), { key: "Escape" });
    expect(leagueField().value).toBe("No league");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("picks the highlighted option with Enter, and Enter does not also submit", () => {
    currentLeagues = BASEBALL;
    const onSubmit = vi.fn();
    const onChangeSpy = vi.fn();
    renderForm({ onSubmit, onChangeSpy });
    typeLeague("national");

    const event = fireEvent.keyDown(leagueField(), { key: "Enter" });
    expect(event).toBe(false);
    expect(onChangeSpy).toHaveBeenCalledWith({
      leagueId: lid("l3"),
      leagueName: undefined,
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(leagueField().value).toBe("National League");
  });

  it("submits the host's form on Enter once the list is closed, like the other fields", () => {
    currentLeagues = BASEBALL;
    const onSubmit = vi.fn();
    renderForm({ onSubmit, initial: { ...EMPTY, leagueId: lid("l2") } });
    openLeagueList();
    fireEvent.keyDown(leagueField(), { key: "Escape" });

    fireEvent.keyDown(leagueField(), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("walks the list with the arrow keys", () => {
    currentLeagues = BASEBALL;
    renderForm();
    openLeagueList();

    expect(highlightedLabel()).toBe("American Association of Professional Baseball");
    fireEvent.keyDown(leagueField(), { key: "ArrowDown" });
    expect(highlightedLabel()).toBe("Major League Baseball");
  });
});

// ---------------------------------------------------------------------------
// The suggestion — the lookup's league, resolved against what we hold
// ---------------------------------------------------------------------------

describe("NewTeamForm — the league suggestion", () => {
  it("is the standing answer while nothing else is answered, when we hold it", () => {
    // With no answer recorded the server falls back to the enrichment's league,
    // so the suggestion IS what will happen — showing it as the answer states
    // the truth rather than pre-selecting on the operator's behalf.
    currentLeagues = [
      { _id: lid("l1"), name: "MLB" },
      { _id: lid("l2"), name: "Australian Baseball League" },
    ];
    const onChangeSpy = vi.fn();
    renderForm({ leagueSuggestion: "Australian Baseball League", onChangeSpy });

    expect(leagueField().value).toBe("Australian Baseball League");
    openLeagueList();
    expect(currentOptionLabel()).toBe("Australian Baseball League");
    expect(highlightedLabel()).toBe("Australian Baseball League");
    // It resolved to a row we hold, so there is nothing to create.
    expect(optionLabels().some((l) => l.startsWith("Create "))).toBe(false);
    // Standing, not recorded: the draft is still unanswered.
    expect(onChangeSpy).not.toHaveBeenCalled();
  });

  it("stops being the answer the moment another is picked", () => {
    currentLeagues = [
      { _id: lid("l1"), name: "MLB" },
      { _id: lid("l2"), name: "Australian Baseball League" },
    ];
    renderForm({ leagueSuggestion: "Australian Baseball League" });

    pickLeague("MLB");
    expect(leagueField().value).toBe("MLB");
    openLeagueList();
    expect(currentOptionLabel()).toBe("MLB");
  });

  it("matches an existing league on a normalized name, so punctuation is not a new league", () => {
    // A false negative costs one option's wording; a false POSITIVE would file
    // the team under the wrong league. The comparison is deliberately cheap
    // and exact-after-normalizing.
    currentLeagues = [{ _id: lid("l1"), name: "St. Louis Amateur League" }];
    renderForm({ leagueSuggestion: "St Louis Amateur League" });

    expect(leagueField().value).toBe("St. Louis Amateur League");
    openLeagueList();
    expect(optionLabels()).toEqual(["St. Louis Amateur League", "No league"]);
  });

  it("matches across accents, so a source's spelling is not a new league (NEO-253)", () => {
    // Before the fold this key dropped every accented character rather than
    // folding it, so "Ligue Panaméricaine" and "Ligue Panamericaine" shared no
    // key at all and the form offered to CREATE a league the sport held.
    currentLeagues = [{ _id: lid("l1"), name: "Ligue Panaméricaine" }];
    renderForm({ leagueSuggestion: "Ligue Panamericaine" });

    expect(leagueField().value).toBe("Ligue Panaméricaine");
    openLeagueList();
    expect(optionLabels()).toEqual(["Ligue Panaméricaine", "No league"]);
  });

  it("offers 'Create {name}' when this sport holds no matching league, and it is the default", () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    renderForm({ leagueSuggestion: "Australian Baseball League" });

    // The label says the commitment: picking it creates a league as well as a
    // team — and until something else is picked, that is what will happen.
    expect(leagueField().value).toBe("Create Australian Baseball League");
    openLeagueList();
    expect(optionLabels()[0]).toBe("Create Australian Baseball League");
    expect(currentOptionLabel()).toBe("Create Australian Baseball League");
  });

  it("records the create-a-league pick as a NAME, clearing any id", () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    const onChangeSpy = vi.fn();
    renderForm({
      initial: { ...EMPTY, leagueId: lid("l1") },
      leagueSuggestion: "Australian Baseball League",
      onChangeSpy,
    });

    pickLeague("Create Australian Baseball League");

    expect(onChangeSpy).toHaveBeenCalledWith({
      leagueId: undefined,
      leagueName: "Australian Baseball League",
    });
    expect(leagueField().value).toBe("Create Australian Baseball League");
  });

  it("offers no suggestion when the lookup proposed nothing", () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    renderForm();
    openLeagueList();
    expect(optionLabels()).toEqual(["MLB", "No league"]);
  });

  it("treats a whitespace-only suggestion as no suggestion", () => {
    currentLeagues = [];
    renderForm({ leagueSuggestion: "   " });
    openLeagueList();
    expect(optionLabels()).toEqual(["No league"]);
    expect(leagueField().value).toBe("");
  });

  it("offers 'Create X' while leagues load, and flips to the held row when they land", () => {
    // `leagues` is undefined until the query answers. Offering "Create X"
    // during that window is the honest answer to "we hold no matching row".
    currentLeagues = undefined;
    const { unmount } = renderForm({ leagueSuggestion: "MLB" });
    expect(leagueField().value).toBe("Create MLB");
    unmount();

    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    renderForm({ leagueSuggestion: "MLB" });
    expect(leagueField().value).toBe("MLB");
    openLeagueList();
    expect(optionLabels()).toEqual(["MLB", "No league"]);
  });
});

// ---------------------------------------------------------------------------
// NEO-254 — a league this batch has already answered
// ---------------------------------------------------------------------------

describe("NewTeamForm — a league the batch has already staged", () => {
  it("states the fact instead of re-offering 'Create'", () => {
    // The reported bug: every hockey team row showed `Create National Hockey
    // League`, because nothing is written until commit so `leagues.list` never
    // saw it. Once the New League step has answered, the option says so.
    renderForm({
      leagueSuggestion: "National Hockey League",
      stagedLeagueNames: ["National Hockey League"],
    });
    openLeagueList();
    expect(optionLabels()).toEqual(["National Hockey League (new)", "No league"]);
    // Still the standing answer: the server's fallback resolves the
    // suggestion's name onto the staged league.
    expect(leagueField().value).toBe("National Hockey League (new)");
  });

  it("still offers Create when nothing has answered for it yet", () => {
    renderForm({ leagueSuggestion: "National Hockey League" });
    openLeagueList();
    expect(optionLabels()).toContain("Create National Hockey League");
  });

  it("matches on the league key, and carries the STAGED spelling", () => {
    // The staged option carries the name the batch will create the league
    // under; offering the suggestion's spelling instead would invite two rows
    // for one league.
    renderForm({
      leagueSuggestion: "National Hockey League",
      stagedLeagueNames: ["  national hockey league  "],
    });
    openLeagueList();
    expect(optionLabels()).toEqual(["national hockey league (new)", "No league"]);
  });

  it("offers it to a team whose enrichment suggested nothing", () => {
    // Jason's addendum: "we should also have a way to select USHL once we've
    // created it." The Lincoln Stars had no suggestion at all.
    currentLeagues = [];
    renderForm({ stagedLeagueNames: ["United States Hockey League"] });
    openLeagueList();
    expect(optionLabels()).toEqual(["United States Hockey League (new)", "No league"]);
  });

  it("selects it, recording the NAME the commit will resolve", () => {
    const onChange = vi.fn();
    currentLeagues = [];
    renderForm({
      stagedLeagueNames: ["United States Hockey League"],
      onChangeSpy: onChange,
    });
    pickLeague("United States Hockey League (new)");
    expect(onChange).toHaveBeenCalledWith({
      leagueName: "United States Hockey League",
      leagueId: undefined,
    });
    expect(leagueField().value).toBe("United States Hockey League (new)");
  });

  it("does not double up when the sport already holds that league", () => {
    currentLeagues = [{ _id: lid("l1"), name: "United States Hockey League" }];
    renderForm({ stagedLeagueNames: ["United States Hockey League"] });
    openLeagueList();
    expect(optionLabels()).toEqual(["United States Hockey League", "No league"]);
  });
});

// ---------------------------------------------------------------------------
// NEO-254 / NEO-307 — creating a league from what was typed
//
// Jason, preview 2026-09-07, on "New Team: Lincoln Stars" (USHL): Wikidata
// carried no league, the sport had none, and the step offered a lone
// `No league` pill. There was nowhere to say what the league IS. The
// "+ New league…" button that answered that is now an option: type the name,
// pick `Create “<typed>”`.
// ---------------------------------------------------------------------------

describe("NewTeamForm — Create “<typed>”", () => {
  it("is not offered when neither context can act on it", () => {
    currentLeagues = [];
    renderForm();
    typeLeague("United States Hockey League");
    expect(optionLabels()).toEqual(["No league"]);
  });

  it("is offered, in curly quotes, for text that names nothing we have", () => {
    currentLeagues = [{ _id: lid("l1"), name: "Western Hockey League" }];
    renderForm({ onStageLeague: vi.fn() });
    typeLeague("  United States Hockey League ");
    expect(optionLabels()).toEqual([
      "Create “United States Hockey League”",
      "No league",
    ]);
    // First, so Enter on a name that matches nothing creates it.
    expect(highlightedLabel()).toBe("Create “United States Hockey League”");
  });

  it("is not offered while anything partially matches — Jason, 2026-09-25", () => {
    // A partial match means the league is probably already here under a
    // longer name; a Create beside it invites the duplicate.
    currentLeagues = [{ _id: lid("l1"), name: "National League Central" }];
    renderForm({ onStageLeague: vi.fn() });
    typeLeague("National League");
    expect(optionLabels()).toEqual(["National League Central", "No league"]);
  });

  it("is not offered for a partial match on an alias, an abbreviation, a staged league or the suggestion", () => {
    currentLeagues = [
      {
        _id: lid("l1"),
        name: "United States Hockey League",
        abbreviation: "USHL",
        aliases: ["U.S. Hockey League"],
      },
    ];
    renderForm({
      onStageLeague: vi.fn(),
      stagedLeagueNames: ["North American Hockey League"],
      leagueSuggestion: "Western Hockey League",
    });
    for (const text of [
      // exact and partial on the held league's name, abbreviation, alias
      "united states hockey league",
      "united states",
      "ushl",
      "USH",
      "US Hockey League",
      "U.S. Hock",
      // staged, exact and partial
      "north american hockey league",
      "north american",
      // the suggestion, exact and partial
      "Western Hockey League",
      "western",
      // matches every hockey option at once
      "hockey",
    ]) {
      typeLeague(text);
      expect(
        optionLabels().some((l) => l.startsWith("Create “")),
        `offered Create for "${text}"`,
      ).toBe(false);
    }
  });

  it("is not offered for 'No league', which is an answer rather than a league", () => {
    currentLeagues = [];
    renderForm({ onStageLeague: vi.fn() });
    typeLeague("no league");
    expect(optionLabels()).toEqual(["No league"]);
  });

  it("comes back the moment the typed text stops matching", () => {
    currentLeagues = [{ _id: lid("l1"), name: "National League Central" }];
    renderForm({ onStageLeague: vi.fn() });
    typeLeague("National League");
    expect(optionLabels()).toEqual(["National League Central", "No league"]);
    typeLeague("National League East");
    expect(optionLabels()).toEqual(["Create “National League East”", "No league"]);
  });

  it("WIZARD: stages the typed name and selects it", async () => {
    const onStageLeague = vi
      .fn()
      .mockResolvedValue({ kind: "staged", name: "United States Hockey League" });
    const onChange = vi.fn();
    const onLeagueStatus = vi.fn();
    currentLeagues = [];
    renderForm({ onStageLeague, onLeagueStatus, onChangeSpy: onChange });

    typeLeague("United States Hockey League");
    fireEvent.mouseDown(
      screen.getByRole("option", { name: "Create “United States Hockey League”" }),
    );

    await waitFor(() =>
      expect(onStageLeague).toHaveBeenCalledWith("United States Hockey League"),
    );
    // Recorded on the TEAM as a name — the commit maps it to the row the
    // league step produces.
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        leagueName: "United States Hockey League",
        leagueId: undefined,
      }),
    );
    expect(onLeagueStatus).toHaveBeenCalledWith({
      text: "United States Hockey League will be added. You'll fill in the details next.",
      isError: false,
    });
    expect(leagueField().value).toBe("United States Hockey League (new)");
  });

  it("WIZARD: an existing name selects that league instead of staging a second", async () => {
    // The alias case is why the SERVER decides this: the client cannot know
    // every alias a league the sport holds answers to.
    const onStageLeague = vi.fn().mockResolvedValue({
      kind: "existing",
      leagueId: "lg-1",
      name: "United States Hockey League",
    });
    const onChange = vi.fn();
    const onLeagueStatus = vi.fn();
    currentLeagues = [];
    renderForm({ onStageLeague, onLeagueStatus, onChangeSpy: onChange });

    typeLeague("USHL");
    fireEvent.mouseDown(screen.getByRole("option", { name: "Create “USHL”" }));

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        leagueId: "lg-1",
        leagueName: undefined,
      }),
    );
    expect(onLeagueStatus).toHaveBeenCalledWith({
      text: "United States Hockey League is already a league here — picked it for you.",
      isError: false,
    });
  });

  it("WIZARD: over the cap says so and changes nothing", async () => {
    const onStageLeague = vi.fn().mockResolvedValue({ kind: "over-cap" });
    const onChange = vi.fn();
    const onLeagueStatus = vi.fn();
    currentLeagues = [];
    renderForm({ onStageLeague, onLeagueStatus, onChangeSpy: onChange });

    typeLeague("WHA");
    fireEvent.mouseDown(screen.getByRole("option", { name: "Create “WHA”" }));

    await waitFor(() =>
      expect(onLeagueStatus).toHaveBeenCalledWith({
        text: "That's the most new leagues this team can raise. Answer one first.",
        isError: true,
      }),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("WIZARD: a failed stage says so and changes nothing", async () => {
    const onStageLeague = vi.fn().mockRejectedValue(new Error("boom"));
    const onChange = vi.fn();
    const onLeagueStatus = vi.fn();
    currentLeagues = [];
    renderForm({ onStageLeague, onLeagueStatus, onChangeSpy: onChange });

    typeLeague("WHA");
    fireEvent.mouseDown(screen.getByRole("option", { name: "Create “WHA”" }));

    await waitFor(() =>
      expect(onLeagueStatus).toHaveBeenCalledWith({
        text: "Could not add that league. Try again.",
        isError: true,
      }),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("PICKER: opens the whole record pre-filled with the typed name, and selects what it created", async () => {
    // No batch and no later step, so this is the only chance to get the
    // record — which is why this shape opens the full NewLeagueForm.
    const onCreateLeague = vi
      .fn()
      .mockResolvedValue({ id: "lg-9", name: "United States Hockey League" });
    const onChange = vi.fn();
    const onLeagueStatus = vi.fn();
    currentLeagues = [];
    renderForm({ onCreateLeague, onLeagueStatus, onChangeSpy: onChange });

    typeLeague("United States Hockey League");
    fireEvent.mouseDown(
      screen.getByRole("option", { name: "Create “United States Hockey League”" }),
    );
    // Opening the form records nothing yet.
    expect(onChange).not.toHaveBeenCalled();

    expect((screen.getByLabelText("New league name") as HTMLInputElement).value).toBe(
      "United States Hockey League",
    );
    // A field the wizard shape does not have — proof the full form is here.
    // Collapsed by default in the picker (NEO-307), so it is opened first.
    fireEvent.click(
      screen.getByRole("button", { name: "Add abbreviation, years and aliases" }),
    );
    fireEvent.change(screen.getByLabelText("New league abbreviation"), {
      target: { value: "USHL" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add league" }));

    await waitFor(() => expect(onCreateLeague).toHaveBeenCalled());
    expect(onCreateLeague.mock.calls[0][0]).toMatchObject({
      name: "United States Hockey League",
      abbreviation: "USHL",
    });
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        leagueId: "lg-9",
        leagueName: undefined,
      }),
    );
    expect(onLeagueStatus).toHaveBeenCalledWith({
      text: "Added United States Hockey League. It is this team's league.",
      isError: false,
    });
    // The form closed, and the field reads the new league even before the
    // reactive list reports it.
    expect(screen.queryByLabelText("New league name")).toBeNull();
    expect(leagueField().value).toBe("United States Hockey League");
  });

  it("PICKER: brings the form and then its ACTIONS row into view, then focuses the name without scrolling again", async () => {
    // CI, 1024x629: `nearest` on a form taller than the dialog body aligns its
    // TOP, so "Add league" stayed under the footer and a tap landed on
    // "Create team". The actions row is scrolled into view last, so the button
    // that finishes the form is on screen whatever the form's height.
    const calls: string[] = [];
    const originalScroll = Element.prototype.scrollIntoView;
    const originalFocus = HTMLElement.prototype.focus;
    const scrollArgs: unknown[] = [];
    const focusArgs: unknown[] = [];
    Element.prototype.scrollIntoView = function (this: Element, arg?: unknown) {
      if (this.hasAttribute?.("data-new-league-actions")) {
        calls.push("scroll-actions");
        scrollArgs.push(arg);
      } else if (this.querySelector?.('[aria-label="New league name"]')) {
        calls.push("scroll-form");
        scrollArgs.push(arg);
      }
    };
    HTMLElement.prototype.focus = function (this: HTMLElement, arg?: FocusOptions) {
      if (this.getAttribute("aria-label") === "New league name") {
        calls.push("focus-name");
        focusArgs.push(arg);
      }
      return originalFocus.call(this, arg);
    };
    try {
      currentLeagues = [];
      renderForm({ onCreateLeague: vi.fn() });
      typeLeague("WHA");
      fireEvent.mouseDown(screen.getByRole("option", { name: "Create “WHA”" }));

      await waitFor(() =>
        expect(calls).toEqual(["scroll-form", "scroll-actions", "focus-name"]),
      );
      expect(scrollArgs).toEqual([{ block: "nearest" }, { block: "nearest" }]);
      expect(focusArgs).toEqual([{ preventScroll: true }]);
      expect(document.activeElement).toBe(screen.getByLabelText("New league name"));
      // The row scrolled is the one holding the button that must be reachable.
      expect(
        document
          .querySelector("[data-new-league-actions]")
          ?.contains(screen.getByRole("button", { name: "Add league" })),
      ).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = originalScroll;
      HTMLElement.prototype.focus = originalFocus;
    }
  });

  it("PICKER: drops the wizard's 'whole batch' help line, and the name field describes nothing missing", () => {
    currentLeagues = [];
    renderForm({ onCreateLeague: vi.fn() });
    typeLeague("WHA");
    fireEvent.mouseDown(screen.getByRole("option", { name: "Create “WHA”" }));

    expect(screen.queryByText(/One league, asked once for the whole batch/)).toBeNull();
    const described = screen.getByLabelText("New league name").getAttribute("aria-describedby");
    for (const id of (described ?? "").split(" ").filter(Boolean)) {
      expect(document.getElementById(id)).not.toBeNull();
    }
  });

  it("PICKER: opens the league form with its details COLLAPSED, one tap away", () => {
    // A typed name is all the prefill there is, and the form's own default
    // would open every detail field — taller than the dialog body at 629px.
    currentLeagues = [];
    renderForm({ onCreateLeague: vi.fn() });
    typeLeague("WHA");
    fireEvent.mouseDown(screen.getByRole("option", { name: "Create “WHA”" }));

    expect(screen.queryByLabelText("New league abbreviation")).toBeNull();
    const disclosure = screen.getByRole("button", {
      name: "Add abbreviation, years and aliases",
    });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    // Add league is usable straight away: the name is the only required field.
    expect(
      (screen.getByRole("button", { name: "Add league" }) as HTMLButtonElement).disabled,
    ).toBe(false);

    fireEvent.click(disclosure);
    expect(screen.getByLabelText("New league abbreviation")).toBeTruthy();
  });

  it("PICKER: Escape closes the form and hands focus back to the League field", () => {
    currentLeagues = [];
    renderForm({ onCreateLeague: vi.fn() });
    typeLeague("WHA");
    fireEvent.mouseDown(screen.getByRole("option", { name: "Create “WHA”" }));

    fireEvent.keyDown(screen.getByLabelText("New league name"), { key: "Escape" });

    expect(screen.queryByLabelText("New league name")).toBeNull();
    // Not `<body>`: closing unmounts the focused field.
    expect(document.activeElement).toBe(leagueField());
  });

  it("uses no <select> anywhere, the league form included", () => {
    currentLeagues = [];
    const { container } = renderForm({ onCreateLeague: vi.fn() });
    typeLeague("WHA");
    fireEvent.mouseDown(screen.getByRole("option", { name: "Create “WHA”" }));
    expect(container.querySelectorAll("select")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// NEO-254 — the era
// ---------------------------------------------------------------------------

/**
 * A team's identity gained its years, so the form that creates teams has to ask
 * for them.
 *
 * There are two Winnipeg Jets: 1972-1996, which became the Coyotes and then
 * Utah, and 2011-, the revived name on the old Atlanta Thrashers. Under the old
 * key they were one row, so a 1985 card and a 2015 card pointed at the same
 * team. Creating the second one has to be POSSIBLE here — and has to be
 * deliberate, because it is also exactly what a typo looks like.
 */
describe("NewTeamForm — active years", () => {
  it("collects the era and hands it back on the draft", () => {
    const onChangeSpy = vi.fn();
    renderForm({ onChangeSpy });

    fireEvent.change(screen.getByLabelText("New team active from (optional)"), {
      target: { value: "1972" },
    });
    expect(onChangeSpy).toHaveBeenLastCalledWith({ yearsActive: { from: 1972 } });
  });

  it("keeps the closing year unavailable until there is an opening one", () => {
    // A closing year with no opening one is not a span, and storing it would
    // make an era nothing can compare against. The box says so by being
    // unavailable rather than by refusing after the fact.
    renderForm();
    expect(
      (screen.getByLabelText("New team active to") as HTMLInputElement).disabled,
    ).toBe(true);

    fireEvent.change(screen.getByLabelText("New team active from (optional)"), {
      target: { value: "1972" },
    });
    expect(
      (screen.getByLabelText("New team active to") as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it("clears the era when the opening year is emptied", () => {
    const onChangeSpy = vi.fn();
    renderForm({ initial: { ...EMPTY, yearsActive: { from: 1972, to: 1996 } }, onChangeSpy });

    fireEvent.change(screen.getByLabelText("New team active from (optional)"), {
      target: { value: "" },
    });
    expect(onChangeSpy).toHaveBeenLastCalledWith({ yearsActive: undefined });
  });

  it("says which eras the name already has, without blocking", () => {
    // A statement, not a warning: a second era is a legitimate thing to create,
    // and only the operator knows whether this is the 2011 Jets or a typo of
    // the 1972 ones. The refusal that makes them confirm lives on the server.
    currentEras = [
      {
        _id: "t1",
        name: "Jets",
        location: "Winnipeg",
        yearsActive: { from: 1972, to: 1996 },
        label: "Winnipeg Jets · 1972–1996",
      },
    ];
    renderForm({ initial: { ...EMPTY, location: "Winnipeg", name: "Jets" } });

    expect(screen.getByText(/Winnipeg Jets already exists for/)).toBeTruthy();
    expect(screen.getByText("1972–1996")).toBeTruthy();
    // Nothing is disabled by it — the operator can still create.
    expect(screen.getByLabelText("New team name")).toBeTruthy();
  });

  it("names an undated rival as such rather than leaving a gap", () => {
    currentEras = [
      { _id: "t1", name: "Jets", location: "Winnipeg", label: "Winnipeg Jets" },
    ];
    renderForm({ initial: { ...EMPTY, location: "Winnipeg", name: "Jets" } });
    expect(screen.getByText("no years yet")).toBeTruthy();
  });

  it("says nothing when the name is free", () => {
    renderForm({ initial: { ...EMPTY, location: "Winnipeg", name: "Jets" } });
    expect(screen.queryByText(/already exists for/)).toBeNull();
  });
});

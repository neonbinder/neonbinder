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
 *  3. **League is a RADIOGROUP of pills, not a `<select>`.** Maestro's web
 *     driver can only reach the first `<select>` on a page and both hosts
 *     render over pages that already have one — a dropdown here would be
 *     untappable by every flow that has to use it. So the group's role, its
 *     accessible name, and each pill's `aria-checked` are contracts, not
 *     styling.
 *  4. **The two league answers are alternatives.** Picking either clears the
 *     other, so a draft can never carry an id AND a name and leave the server's
 *     resolution order to decide which one the operator meant.
 *  5. **The suggestion reads as checked while unanswered.** That is not a
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
 * Reveal the whole league list.
 *
 * NEO-236 (CI run 8): the picker collapses to the standing answer plus a
 * "Change league" disclosure whenever there IS one, because rendering every
 * league in the sport measured 250px and pushed the review wizard's primary
 * action off the bottom of its dialog. With no standing answer there is nothing
 * to summarise and the list is already open, so this is a no-op then — which is
 * why it probes rather than asserts.
 */
function openLeagueList(): void {
  // NEO-254 renamed it: "Show all leagues" says what it does, where "Change
  // league" read as "the one you want is not here" to an operator hunting for
  // a league they had just created.
  const toggle = screen.queryByRole("button", { name: "Show all leagues" });
  if (toggle) fireEvent.click(toggle);
}

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
    openLeagueList();

    expect(locationField().value).toBe("San Diego");
    expect(nameField().value).toBe("Padres");
  });

  it("composes the two boxes into the 'Shows as' preview as they are typed", () => {
    renderForm();
    openLeagueList();

    fireEvent.change(nameField(), { target: { value: "Padres" } });
    expect(previewText()).toBe("Shows as: Padres");

    fireEvent.change(locationField(), { target: { value: "San Diego" } });
    expect(previewText()).toBe("Shows as: San Diego Padres");
  });

  it("shows an em dash rather than an empty preview while both boxes are blank", () => {
    renderForm();
    openLeagueList();
    expect(previewText()).toBe("Shows as: —");
  });

  it("carries the whole visible label in the location field's accessible name", () => {
    // WCAG 2.2 SC 2.5.3 (label in name): the visible label is "Location
    // (optional)", so a voice-control user saying it has to match.
    renderForm();
    openLeagueList();
    expect(locationField().getAttribute("aria-label")).toBe(
      "New team location (optional)",
    );
    expect(screen.getByText("Location (optional)")).toBeTruthy();
  });

  it("spells out what counts as a location, because the split is not obvious", () => {
    renderForm();
    openLeagueList();
    expect(
      screen.getByText(/Location is where they are from/),
    ).toBeTruthy();
  });

  it("shows a 'Needed by' line only when the host supplies one", () => {
    const { unmount } = renderForm({ neededBy: "Travis Bazzana" });
    expect(screen.getByText("Needed by: Travis Bazzana")).toBeTruthy();
    unmount();

    renderForm();

    openLeagueList();
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
    openLeagueList();

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
    openLeagueList();

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
    openLeagueList();

    for (const field of [locationField(), nameField()]) {
      const value = field.getAttribute("aria-describedby");
      expect(value).toBeTruthy();
      for (const id of (value ?? "").split(" ")) {
        expect(document.getElementById(id)).not.toBeNull();
      }
    }
  });

  it("disables every control while the host is busy", () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    renderForm({ disabled: true });
    openLeagueList();

    expect(locationField().disabled).toBe(true);
    expect(nameField().disabled).toBe(true);
    expect(
      (screen.getByRole("radio", { name: "MLB" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("radio", { name: "No league" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("does not record a league pick while disabled", () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    const onChangeSpy = vi.fn();
    renderForm({ disabled: true, onChangeSpy });
    openLeagueList();

    fireEvent.click(screen.getByRole("radio", { name: "MLB" }));
    expect(onChangeSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Enter — the dialog submits, the wizard step does not
// ---------------------------------------------------------------------------

describe("NewTeamForm — Enter in a field", () => {
  it("calls onSubmit from either box and swallows the key", () => {
    const onSubmit = vi.fn();
    renderForm({ onSubmit });
    openLeagueList();

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
    openLeagueList();
    expect(fireEvent.keyDown(nameField(), { key: "Enter" })).toBe(true);
  });

  it("ignores other keys", () => {
    const onSubmit = vi.fn();
    renderForm({ onSubmit });
    openLeagueList();

    fireEvent.keyDown(nameField(), { key: "a" });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The League pills
// ---------------------------------------------------------------------------

describe("NewTeamForm — the League control", () => {
  it("is a named radiogroup of pills, never a select", () => {
    // Maestro's web driver resolves an <option> tap by scanning every <option>
    // on the page and taking the first bounds match, so with more than one
    // <select> on screen only the first is reachable. Both hosts render over a
    // page that already has selects.
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    const { container } = renderForm();

    const group = screen.getByRole("radiogroup", { name: "New team league" });
    expect(group).toBeTruthy();
    expect(container.querySelector("select")).toBeNull();
    expect(screen.getByRole("radio", { name: "MLB" })).toBeTruthy();
  });

  it("queries the leagues of THIS sport", () => {
    renderForm();
    openLeagueList();
    expect(queryCalls).toContainEqual({
      ref: "leagues.list",
      args: { sportId: SPORT_ID },
    });
  });

  it("says it is still loading rather than rendering an empty group", () => {
    currentLeagues = undefined;
    renderForm();
    openLeagueList();

    // SC 4.1.3: the group changes shape under the operator when the query
    // lands, so the wait is announced rather than only drawn.
    const loading = screen.getByText("Loading leagues…");
    expect(loading.getAttribute("role")).toBe("status");
    // "No league" is always available — it is an answer, not a league row.
    expect(screen.getByRole("radio", { name: "No league" })).toBeTruthy();
  });

  it("records an existing league as leagueId and clears any league NAME answer", () => {
    currentLeagues = [
      { _id: lid("l1"), name: "MLB" },
      { _id: lid("l2"), name: "Australian Baseball League" },
    ];
    const onChangeSpy = vi.fn();
    renderForm({
      initial: { ...EMPTY, leagueName: "Something Else" },
      onChangeSpy,
    });
    openLeagueList();

    fireEvent.click(screen.getByRole("radio", { name: "MLB" }));

    // The two answers are alternatives; carrying both would leave which one
    // the server honoured up to its resolution order.
    expect(onChangeSpy).toHaveBeenCalledWith({
      leagueId: lid("l1"),
      leagueName: undefined,
    });
    expect(
      screen.getByRole("radio", { name: "MLB" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("records 'No league' as a deliberate null, distinct from unanswered", () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    const onChangeSpy = vi.fn();
    renderForm({ onChangeSpy });
    openLeagueList();

    fireEvent.click(screen.getByRole("radio", { name: "No league" }));

    expect(onChangeSpy).toHaveBeenCalledWith({
      leagueId: null,
      leagueName: undefined,
    });
    expect(
      screen.getByRole("radio", { name: "No league" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("checks nothing by default when there is no suggestion to fall back on", () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    renderForm();
    openLeagueList();

    expect(
      screen.getByRole("radio", { name: "MLB" }).getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen.getByRole("radio", { name: "No league" }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("marks the row it already picked, from a draft that carries one", () => {
    currentLeagues = [
      { _id: lid("l1"), name: "MLB" },
      { _id: lid("l2"), name: "NPB" },
    ];
    renderForm({ initial: { ...EMPTY, leagueId: lid("l2") } });
    openLeagueList();

    expect(
      screen.getByRole("radio", { name: "NPB" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("radio", { name: "MLB" }).getAttribute("aria-checked"),
    ).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// The League group is a REAL radio group, not a row of buttons
//
// SC 2.1.1 / 4.1.2: `role="radiogroup"` of `role="radio"` is a promise about
// the keyboard, not only about the announcement. A native radio group is ONE
// Tab stop and moves between its options with the arrow keys. Before this,
// every pill was an ordinary button — a keyboard operator paid one Tab stop per
// league (a sport with a dozen of them buried the Create button behind twelve
// stops) and the arrows did nothing at all.
// ---------------------------------------------------------------------------

describe("NewTeamForm — the League group's keyboard", () => {
  const pillTabIndexes = () =>
    screen.getAllByRole("radio").map((el) => ({
      label: el.textContent,
      tabIndex: (el as HTMLButtonElement).tabIndex,
    }));

  it("is a single Tab stop, on the first pill while nothing is checked", () => {
    currentLeagues = [
      { _id: lid("l1"), name: "MLB" },
      { _id: lid("l2"), name: "NPB" },
    ];
    renderForm();
    openLeagueList();

    expect(pillTabIndexes()).toEqual([
      { label: "MLB", tabIndex: 0 },
      { label: "NPB", tabIndex: -1 },
      { label: "No league", tabIndex: -1 },
    ]);
  });

  it("moves the Tab stop onto whichever pill is checked", () => {
    currentLeagues = [
      { _id: lid("l1"), name: "MLB" },
      { _id: lid("l2"), name: "NPB" },
    ];
    renderForm({ initial: { ...EMPTY, leagueId: lid("l2") } });
    openLeagueList();

    expect(pillTabIndexes()).toEqual([
      { label: "MLB", tabIndex: -1 },
      { label: "NPB", tabIndex: 0 },
      { label: "No league", tabIndex: -1 },
    ]);
  });

  it("puts the Tab stop on the suggestion while it is the standing answer", () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    renderForm({ leagueSuggestion: "Australian Baseball League" });
    openLeagueList();

    expect(pillTabIndexes()).toEqual([
      { label: "Create Australian Baseball League", tabIndex: 0 },
      { label: "MLB", tabIndex: -1 },
      { label: "No league", tabIndex: -1 },
    ]);
  });

  it("moves selection with ArrowRight/ArrowDown", () => {
    currentLeagues = [
      { _id: lid("l1"), name: "MLB" },
      { _id: lid("l2"), name: "NPB" },
    ];
    renderForm();
    openLeagueList();

    const group = screen.getByRole("radiogroup", { name: "New team league" });
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(
      screen.getByRole("radio", { name: "NPB" }).getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(
      screen
        .getByRole("radio", { name: "No league" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("moves selection with ArrowLeft/ArrowUp", () => {
    currentLeagues = [
      { _id: lid("l1"), name: "MLB" },
      { _id: lid("l2"), name: "NPB" },
    ];
    renderForm({ initial: { ...EMPTY, leagueId: lid("l2") } });
    openLeagueList();

    const group = screen.getByRole("radiogroup", { name: "New team league" });
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(
      screen.getByRole("radio", { name: "MLB" }).getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.keyDown(group, { key: "ArrowUp" });
    // Wrapped backwards off the front onto the last pill.
    expect(
      screen
        .getByRole("radio", { name: "No league" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("wraps forward off the end", () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    renderForm({ initial: { ...EMPTY, leagueId: null } });
    openLeagueList();

    const group = screen.getByRole("radiogroup", { name: "New team league" });
    expect(
      screen
        .getByRole("radio", { name: "No league" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(
      screen.getByRole("radio", { name: "MLB" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("takes focus with the selection, as the APG pattern requires", async () => {
    // The pill that becomes checked is the one that becomes the Tab stop, so
    // it has to end up focused too — otherwise the next arrow press starts
    // from a control the operator can no longer see they are on.
    currentLeagues = [
      { _id: lid("l1"), name: "MLB" },
      { _id: lid("l2"), name: "NPB" },
    ];
    renderForm();
    openLeagueList();

    const group = screen.getByRole("radiogroup", { name: "New team league" });
    screen.getByRole("radio", { name: "MLB" }).focus();
    fireEvent.keyDown(group, { key: "ArrowRight" });

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("radio", { name: "NPB" })),
    );
  });

  it("swallows the arrow key so it cannot scroll the host out from under the group", () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    renderForm();
    openLeagueList();

    const group = screen.getByRole("radiogroup", { name: "New team league" });
    // `false` from fireEvent means preventDefault was called.
    expect(fireEvent.keyDown(group, { key: "ArrowRight" })).toBe(false);
    // Anything else is left alone.
    expect(fireEvent.keyDown(group, { key: "a" })).toBe(true);
  });

  it("ignores the arrows entirely while disabled", () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    const onChangeSpy = vi.fn();
    renderForm({ disabled: true, onChangeSpy });
    openLeagueList();

    fireEvent.keyDown(
      screen.getByRole("radiogroup", { name: "New team league" }),
      { key: "ArrowRight" },
    );
    expect(onChangeSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The suggestion pill — the lookup's league, resolved against what we hold
// ---------------------------------------------------------------------------

describe("NewTeamForm — the league suggestion", () => {
  it("selects the existing row and reads as checked while nothing else is answered", () => {
    // With no answer recorded the server falls back to the enrichment's league,
    // so the suggestion IS what will happen — showing it checked states the
    // truth rather than pre-selecting on the operator's behalf.
    currentLeagues = [
      { _id: lid("l1"), name: "MLB" },
      { _id: lid("l2"), name: "Australian Baseball League" },
    ];
    renderForm({ leagueSuggestion: "Australian Baseball League" });
    openLeagueList();

    expect(
      screen
        .getByRole("radio", { name: "Australian Baseball League" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    // It resolved to a row we hold, so there is nothing to create.
    expect(screen.queryByRole("radio", { name: /^Create / })).toBeNull();
  });

  it("stops reading as checked the moment another answer is given", () => {
    currentLeagues = [
      { _id: lid("l1"), name: "MLB" },
      { _id: lid("l2"), name: "Australian Baseball League" },
    ];
    renderForm({ leagueSuggestion: "Australian Baseball League" });
    openLeagueList();

    fireEvent.click(screen.getByRole("radio", { name: "MLB" }));

    expect(
      screen
        .getByRole("radio", { name: "Australian Baseball League" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen.getByRole("radio", { name: "MLB" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("matches an existing league on a normalized name, so punctuation is not a new league", () => {
    // A false negative costs one pill's wording; a false POSITIVE would file
    // the team under the wrong league. The comparison is deliberately cheap
    // and exact-after-normalizing.
    currentLeagues = [{ _id: lid("l1"), name: "St. Louis Amateur League" }];
    renderForm({ leagueSuggestion: "St Louis Amateur League" });
    openLeagueList();

    expect(screen.queryByRole("radio", { name: /^Create / })).toBeNull();
    expect(
      screen
        .getByRole("radio", { name: "St. Louis Amateur League" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("matches across accents, so a source's spelling is not a new league (NEO-253)", () => {
    // The comparison here is between a name a SOURCE supplied and a name NB
    // stores, which is exactly where the two spellings disagree. Before the
    // fold this key dropped every accented character rather than folding it,
    // so "Ligue Panaméricaine" and "Ligue Panamericaine" shared no key at all
    // and the pill offered to CREATE a league the sport already held — the
    // duplicate-league failure this comparison exists to prevent, arrived at
    // from the other direction.
    currentLeagues = [{ _id: lid("l1"), name: "Ligue Panaméricaine" }];
    renderForm({ leagueSuggestion: "Ligue Panamericaine" });
    openLeagueList();

    expect(screen.queryByRole("radio", { name: /^Create / })).toBeNull();
    expect(
      screen
        .getByRole("radio", { name: "Ligue Panaméricaine" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("offers 'Create {name}' only when this sport holds no matching league", () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    renderForm({ leagueSuggestion: "Australian Baseball League" });
    openLeagueList();

    const create = screen.getByRole("radio", {
      name: "Create Australian Baseball League",
    });
    // The label says the commitment: pressing it creates a league as well as a
    // team.
    expect(create.textContent).toBe("Create Australian Baseball League");
    expect(create.getAttribute("aria-checked")).toBe("true");
  });

  it("records the create-a-league pick as a NAME, clearing any id", () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    const onChangeSpy = vi.fn();
    renderForm({
      initial: { ...EMPTY, leagueId: lid("l1") },
      leagueSuggestion: "Australian Baseball League",
      onChangeSpy,
    });
    openLeagueList();

    fireEvent.click(
      screen.getByRole("radio", { name: "Create Australian Baseball League" }),
    );

    expect(onChangeSpy).toHaveBeenCalledWith({
      leagueId: undefined,
      leagueName: "Australian Baseball League",
    });
  });

  it("offers no suggestion pill when the lookup proposed nothing", () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    renderForm();
    openLeagueList();

    expect(screen.queryByRole("radio", { name: /^Create / })).toBeNull();
    expect(screen.getAllByRole("radio").map((el) => el.textContent)).toEqual([
      "MLB",
      "No league",
    ]);
  });

  it("treats a whitespace-only suggestion as no suggestion", () => {
    currentLeagues = [];
    renderForm({ leagueSuggestion: "   " });
    openLeagueList();

    expect(screen.getAllByRole("radio").map((el) => el.textContent)).toEqual([
      "No league",
    ]);
  });

  it("does not resolve a suggestion against another sport's rows while leagues load", () => {
    // `leagues` is undefined until the query answers. Offering "Create X"
    // during that window is right — it is the honest answer to "we hold no
    // matching row" — and it flips to the existing row when the list lands.
    currentLeagues = undefined;
    const { unmount } = renderForm({ leagueSuggestion: "MLB" });
    expect(screen.getByRole("radio", { name: "Create MLB" })).toBeTruthy();
    unmount();

    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    renderForm({ leagueSuggestion: "MLB" });
    openLeagueList();
    expect(screen.queryByRole("radio", { name: "Create MLB" })).toBeNull();
    expect(
      screen.getByRole("radio", { name: "MLB" }).getAttribute("aria-checked"),
    ).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// NEO-254 — a league this batch has already answered
// ---------------------------------------------------------------------------

describe("NewTeamForm — a league the batch has already staged", () => {
  it("states the fact instead of re-offering 'Create'", () => {
    // The reported bug: every hockey team row showed `Create National Hockey
    // League`, because nothing is written until commit so `leagues.list` never
    // saw it. Once the New League step has answered, the pill says so.
    renderForm({
      leagueSuggestion: "National Hockey League",
      stagedLeagueNames: ["National Hockey League"],
    });
    expect(
      screen.getByRole("radio", { name: "National Hockey League (new)" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("radio", { name: "Create National Hockey League" }),
    ).toBeNull();
  });

  it("still offers Create when nothing has answered for it yet", () => {
    renderForm({ leagueSuggestion: "National Hockey League" });
    expect(
      screen.getByRole("radio", { name: "Create National Hockey League" }),
    ).toBeTruthy();
  });

  it("matches on the league key, not the raw string", () => {
    // The staged pill carries the STAGED spelling — that is the name the batch
    // will create the league under, and offering the suggestion's spelling
    // instead would invite two rows for one league.
    renderForm({
      leagueSuggestion: "National Hockey League",
      stagedLeagueNames: ["  national hockey league  "],
    });
    expect(
      screen.getByRole("radio", { name: "national hockey league (new)" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("radio", { name: "Create National Hockey League" }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NEO-254 — naming a league that does not exist yet
//
// Jason, preview 2026-09-07, on "New Team: Lincoln Stars" (USHL): Wikidata
// carried no league, the sport had none, and the step offered a lone
// `No league` pill. There was nowhere to say what the league IS, so an
// operator who knew the answer could not record it.
// ---------------------------------------------------------------------------

describe("NewTeamForm — the + New league… control", () => {
  it("is absent when neither context can act on it", () => {
    renderForm();
    expect(screen.queryByRole("button", { name: "+ New league…" })).toBeNull();
  });

  it("is present even when the sport has no leagues at all, and says so", () => {
    // The case it exists for. An empty row is an invitation to act, not a
    // dead end.
    currentLeagues = [];
    renderForm({ onStageLeague: vi.fn() });
    expect(screen.getByRole("button", { name: "+ New league…" })).toBeTruthy();
    expect(screen.getByText("No leagues in this sport yet.")).toBeTruthy();
  });

  it("is a disclosure outside the radiogroup, never an option", () => {
    // A non-radio child of a radiogroup is a shape assistive tech cannot read.
    currentLeagues = [];
    renderForm({ onStageLeague: vi.fn() });
    const trigger = screen.getByRole("button", { name: "+ New league…" });
    expect(trigger.getAttribute("role")).not.toBe("radio");
    expect(trigger.getAttribute("aria-checked")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.getByRole("radiogroup", { name: "New team league" }).contains(trigger),
    ).toBe(false);
  });

  it("WIZARD: stages the typed name and selects it", async () => {
    const onStageLeague = vi
      .fn()
      .mockResolvedValue({ kind: "staged", name: "United States Hockey League" });
    const onChange = vi.fn();
    const onLeagueStatus = vi.fn();
    currentLeagues = [];
    render(<Harness onStageLeague={onStageLeague} onLeagueStatus={onLeagueStatus} onChangeSpy={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "+ New league…" }));
    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "United States Hockey League" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Stage" }));

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
  });

  it("WIZARD: an existing name selects that league instead of staging a second", async () => {
    // The alias case is why the SERVER decides this: the client cannot know
    // that "USHL" is an alias of a league the sport already holds.
    const onStageLeague = vi.fn().mockResolvedValue({
      kind: "existing",
      leagueId: "lg-1",
      name: "United States Hockey League",
    });
    const onChange = vi.fn();
    const onLeagueStatus = vi.fn();
    currentLeagues = [];
    render(<Harness onStageLeague={onStageLeague} onLeagueStatus={onLeagueStatus} onChangeSpy={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "+ New league…" }));
    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "USHL" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Stage" }));

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
    render(<Harness onStageLeague={onStageLeague} onLeagueStatus={onLeagueStatus} onChangeSpy={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "+ New league…" }));
    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "WHA" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Stage" }));

    await waitFor(() =>
      expect(onLeagueStatus).toHaveBeenCalledWith({
        text: "That's the most new leagues this team can raise. Answer one first.",
        isError: true,
      }),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("PICKER: collects the whole record and selects what it created", async () => {
    // No batch and no later step, so this is the only chance to get the
    // record — which is why this shape opens the full NewLeagueForm.
    const onCreateLeague = vi
      .fn()
      .mockResolvedValue({ id: "lg-9", name: "United States Hockey League" });
    const onChange = vi.fn();
    currentLeagues = [];
    render(<Harness onCreateLeague={onCreateLeague} onChangeSpy={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "+ New league…" }));
    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "United States Hockey League" },
    });
    // A field the wizard shape does not have — proof the full form is here.
    expect(screen.getByLabelText("New league abbreviation")).toBeTruthy();
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
  });

  it("Escape closes and hands focus back to the trigger", () => {
    currentLeagues = [];
    renderForm({ onStageLeague: vi.fn() });
    const trigger = screen.getByRole("button", { name: "+ New league…" });
    fireEvent.click(trigger);
    const input = screen.getByLabelText("New league name");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByLabelText("New league name")).toBeNull();
    // Not `<body>`: closing unmounts the focused field.
    expect(document.activeElement).toBe(trigger);
  });

  it("uses no <select> anywhere — Maestro can only reach the first one on a page", () => {
    currentLeagues = [];
    const { container } = render(<Harness onCreateLeague={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "+ New league…" }));
    expect(container.querySelectorAll("select")).toHaveLength(0);
  });
});

describe("NewTeamForm — a league staged earlier in the batch is selectable", () => {
  it("offers it to a team whose enrichment suggested nothing", () => {
    // Jason's addendum: "we should also have a way to select USHL once we've
    // created it." The Lincoln Stars had no suggestion at all, so a pill that
    // only appeared alongside a matching suggestion would never reach them.
    currentLeagues = [];
    renderForm({ stagedLeagueNames: ["United States Hockey League"] });
    expect(
      screen.getByRole("radio", { name: "United States Hockey League (new)" }),
    ).toBeTruthy();
  });

  it("selects it, recording the NAME the commit will resolve", () => {
    const onChange = vi.fn();
    currentLeagues = [];
    render(
      <Harness
        stagedLeagueNames={["United States Hockey League"]}
        onChangeSpy={onChange}
      />,
    );
    fireEvent.click(
      screen.getByRole("radio", { name: "United States Hockey League (new)" }),
    );
    expect(onChange).toHaveBeenCalledWith({
      leagueName: "United States Hockey League",
      leagueId: undefined,
    });
  });

  it("does not double up when the sport already holds that league", () => {
    // A staged name the sport already answers to is that league, not a second
    // option beside it.
    currentLeagues = [{ _id: lid("l1"), name: "United States Hockey League" }];
    renderForm({ stagedLeagueNames: ["United States Hockey League"] });
    openLeagueList();
    expect(
      screen.queryByRole("radio", { name: "United States Hockey League (new)" }),
    ).toBeNull();
    expect(
      screen.getByRole("radio", { name: "United States Hockey League" }),
    ).toBeTruthy();
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

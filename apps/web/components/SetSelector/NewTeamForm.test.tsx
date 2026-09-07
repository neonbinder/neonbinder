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
  api: { leagues: { list: "leagues.list" } },
}));

let currentLeagues: unknown;
let queryCalls: Array<{ ref: string; args: unknown }>;

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    queryCalls.push({ ref, args });
    if (ref === "leagues.list") return currentLeagues;
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
  const toggle = screen.queryByRole("button", { name: "Change league" });
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
    renderForm({
      leagueSuggestion: "National Hockey League",
      stagedLeagueNames: ["  national hockey league  "],
    });
    expect(
      screen.getByRole("radio", { name: "National Hockey League (new)" }),
    ).toBeTruthy();
  });
});

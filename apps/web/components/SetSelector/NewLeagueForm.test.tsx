/**
 * NEO-254 — the New League step's fields.
 *
 * Two things are worth pinning here and nothing else is: the TWO-TIER layout
 * (seven fields cannot stack on CI's 1024x629 viewport, and this ticket has
 * already lost two CI runs to a wizard step outgrowing its scroll box), and
 * the client-side bounds, which have to say the same thing `convex/leagues.ts`
 * says or an operator learns two vocabularies for one limit.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import NewLeagueForm, {
  leagueDetailSummary,
  leagueDraftError,
  newLeaguePrefill,
  parseAliases,
  type NewLeagueDraft,
} from "./NewLeagueForm";

const EMPTY: NewLeagueDraft = {
  name: "",
  abbreviation: "",
  level: null,
  fromYear: "",
  toYear: "",
  aliases: "",
  wikidataId: "",
};

const NHL: NewLeagueDraft = {
  ...EMPTY,
  name: "National Hockey League",
  abbreviation: "NHL",
  fromYear: "1917",
  wikidataId: "Q1215892",
};

function renderForm(draft: NewLeagueDraft) {
  const onChange = vi.fn();
  const utils = render(<NewLeagueForm draft={draft} onChange={onChange} />);
  return { ...utils, onChange };
}

describe("newLeaguePrefill", () => {
  it("takes the whole record the lookup found", () => {
    expect(
      newLeaguePrefill({
        name: "National Hockey League",
        enrichment: {
          abbreviation: "NHL",
          wikidataId: "Q1215892",
          yearsActive: { from: 1917 },
        },
      }),
    ).toEqual({
      name: "National Hockey League",
      abbreviation: "NHL",
      level: null,
      fromYear: "1917",
      toYear: "",
      aliases: "",
      wikidataId: "Q1215892",
    });
  });

  it("leaves everything but the name blank when the lookup found nothing", () => {
    expect(newLeaguePrefill({ name: "World Hockey Association" })).toEqual({
      ...EMPTY,
      name: "World Hockey Association",
    });
  });
});

describe("parseAliases", () => {
  it("splits on commas, trims, drops blanks and dedupes case-insensitively", () => {
    expect(parseAliases(" NHL , , nhl ,National Hockey Lg ")).toEqual([
      "NHL",
      "National Hockey Lg",
    ]);
  });
});

describe("leagueDraftError — the same bounds convex/leagues.ts refuses", () => {
  const maxYear = 2027;

  it("requires a name", () => {
    expect(leagueDraftError(EMPTY, maxYear)).toBe("A league name is required.");
  });

  it("caps the name at 120 and says by how much", () => {
    expect(leagueDraftError({ ...EMPTY, name: "x".repeat(121) }, maxYear)).toBe(
      "A league name is 121 characters; the limit is 120.",
    );
  });

  it("caps the abbreviation at 16", () => {
    expect(
      leagueDraftError({ ...NHL, abbreviation: "x".repeat(17) }, maxYear),
    ).toBe("An abbreviation is 17 characters; the limit is 16.");
  });

  it("refuses a year below 1850 or above next year", () => {
    expect(leagueDraftError({ ...NHL, fromYear: "1700" }, maxYear)).toMatch(
      /between 1850 and 2027/,
    );
    expect(leagueDraftError({ ...NHL, fromYear: "3000" }, maxYear)).toMatch(
      /between 1850 and 2027/,
    );
  });

  it("refuses an end before the start", () => {
    expect(
      leagueDraftError({ ...NHL, fromYear: "2000", toYear: "1999" }, maxYear),
    ).toBe("A league cannot end before it starts.");
  });

  it("refuses an end year with no start — half a span is not a span", () => {
    expect(leagueDraftError({ ...NHL, fromYear: "", toYear: "1999" }, maxYear)).toBe(
      "Add the year this league started before the year it ended.",
    );
  });

  it("caps the alias list and each alias", () => {
    const many = Array.from({ length: 33 }, (_, i) => `A${i}`).join(",");
    expect(leagueDraftError({ ...NHL, aliases: many }, maxYear)).toBe(
      "That is 33 aliases; the limit is 32.",
    );
    expect(
      leagueDraftError({ ...NHL, aliases: "x".repeat(65) }, maxYear),
    ).toBe("An alias is 65 characters; the limit is 64.");
  });

  it("refuses a Wikidata id that is not Q<digits>, and allows a real one", () => {
    expect(
      leagueDraftError({ ...NHL, wikidataId: "javascript:alert(1)" }, maxYear),
    ).toMatch(/Not a Wikidata entity id/);
    expect(leagueDraftError(NHL, maxYear)).toBeNull();
  });
});

describe("leagueDetailSummary", () => {
  it("names what is already known, so the collapsed row hides nothing", () => {
    expect(leagueDetailSummary(NHL)).toBe("NHL · 1917–present · Q1215892");
  });

  it("counts aliases rather than listing them", () => {
    expect(leagueDetailSummary({ ...EMPTY, aliases: "NHL, N.H.L." })).toBe("2 aliases");
  });

  it("is null when the lookup found nothing to show", () => {
    expect(leagueDetailSummary({ ...EMPTY, name: "WHA" })).toBeNull();
  });
});

describe("NewLeagueForm — the two tiers", () => {
  it("shows the name and level without any interaction", () => {
    renderForm(NHL);
    expect(screen.getByLabelText("New league name")).toHaveProperty(
      "value",
      "National Hockey League",
    );
    expect(screen.getByRole("group", { name: "Level" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Major" })).toBeTruthy();
  });

  it("starts COLLAPSED when the lookup pre-filled the details, and names them", () => {
    // The common case: Wikidata got it right, so the step costs zero taps —
    // and the summary means nothing is hidden from the operator.
    renderForm(NHL);
    expect(
      screen
        .getByRole("button", { name: "Add abbreviation, years and aliases" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(screen.getByText("NHL · 1917–present · Q1215892")).toBeTruthy();
    expect(screen.queryByLabelText("New league abbreviation")).toBeNull();
  });

  it("starts OPEN when there is nothing to show, because there is work to do", () => {
    renderForm({ ...EMPTY, name: "World Hockey Association" });
    expect(screen.getByLabelText("New league abbreviation")).toBeTruthy();
    expect(screen.getByLabelText("New league active from")).toBeTruthy();
    expect(screen.getByLabelText("New league aliases")).toBeTruthy();
    expect(screen.getByLabelText("New league Wikidata id")).toBeTruthy();
  });

  it("opens on the operator's own tap and stays open", () => {
    renderForm(NHL);
    fireEvent.click(
      screen.getByRole("button", { name: "Add abbreviation, years and aliases" }),
    );
    expect(screen.getByLabelText("New league abbreviation")).toHaveProperty(
      "value",
      "NHL",
    );
    expect(screen.getByRole("button", { name: "Hide details" })).toBeTruthy();
  });

  it("reports a bound as an alert, so it is announced off screen too", () => {
    renderForm({ ...NHL, abbreviation: "x".repeat(17) });
    expect(screen.getByRole("alert").textContent).toBe(
      "An abbreviation is 17 characters; the limit is 16.",
    );
  });

  it("names the team the step was raised for", () => {
    render(
      <NewLeagueForm draft={NHL} onChange={vi.fn()} neededBy="Vancouver Canucks" />,
    );
    expect(screen.getByText("Needed by: Vancouver Canucks")).toBeTruthy();
  });

  it("reports each edit as a patch, never a whole draft", () => {
    const { onChange } = renderForm(NHL);
    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "NHL " },
    });
    expect(onChange).toHaveBeenCalledWith({ name: "NHL " });
  });
});

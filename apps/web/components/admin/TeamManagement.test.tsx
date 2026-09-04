/**
 * NEO-235 — the deep link into `/admin/teams`.
 *
 * The Players screen links every career stint at a team to that team's row
 * here, so this file covers the two halves of that contract and nothing else:
 * arriving with `?team=<id>` opens that team, and picking a different one
 * writes the URL back so the screen the operator is looking at is the screen
 * they can send someone.
 *
 * Both are silent when they break — a link that lands on an unselected list
 * still renders a perfectly correct screen, and a selection that never reaches
 * the URL only shows up when a shared link opens the wrong thing.
 *
 * The last test covers where those two halves MEET: a click writes the param,
 * so the screen has to be able to tell a param it wrote itself from a link it
 * was sent. Getting that wrong wipes the operator's filter mid-click.
 *
 * Mocking mirrors PlayerManagement.test.tsx: convex/react's hooks are module
 * mocked and routed by the (string-mocked) function reference.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    teams: {
      listForManagement: "teams.listForManagement",
      saveTeamFields: "teams.saveTeamFields",
      enrichFromWikidata: "teams.enrichFromWikidata",
    },
    leagues: { list: "leagues.list", create: "leagues.create" },
    teamColorSources: { chooseColorSource: "teamColorSources.chooseColorSource" },
  },
}));

const TEAMS = [
  {
    _id: "t-yankees",
    _creationTime: 0,
    name: "New York Yankees",
    nameNormalized: "new york yankees",
    sportId: "sport-baseball",
    colors: { primary: "#0c2340" },
  },
  {
    _id: "t-mariners",
    _creationTime: 0,
    name: "Seattle Mariners",
    nameNormalized: "seattle mariners",
    sportId: "sport-baseball",
    colors: { primary: "#0c2c56" },
  },
];

vi.mock("convex/react", () => ({
  useQuery: (ref: string) => {
    if (ref === "teams.listForManagement") {
      return { teams: TEAMS, truncated: false };
    }
    if (ref === "leagues.list") return [];
    return undefined;
  },
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}));

import TeamManagement from "./TeamManagement";

// The URL is the thing under test in half of these, so it is rendered.
function LocationProbe() {
  return <span data-testid="search">{useLocation().search}</span>;
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TeamManagement />
      <LocationProbe />
    </MemoryRouter>,
  );
}

const row = (name: string) => screen.getByRole("button", { name: new RegExp(name) });

describe("TeamManagement — the ?team deep link", () => {
  it("opens the team named in the URL and scrolls its row into view", () => {
    // The scroll matters as much as the selection: the list is a 32rem
    // scroller over every team, so a selected row can easily land off-screen
    // and the link would look like it did nothing.
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});

    renderAt("/admin/teams?team=t-mariners");

    expect(row("Seattle Mariners").getAttribute("aria-current")).toBe("true");
    expect(row("New York Yankees").getAttribute("aria-current")).toBeNull();
    // The detail panel, not just the row highlight.
    expect(screen.getByLabelText("Name")).toHaveProperty(
      "value",
      "Seattle Mariners",
    );
    expect(scrollIntoView).toHaveBeenCalled();

    scrollIntoView.mockRestore();
  });

  it("leaves the screen alone for an id this deployment does not have", () => {
    // A stale link is not an error state — there is nothing an operator could
    // do about it here, so the screen opens as it always does.
    renderAt("/admin/teams?team=t-gone");
    expect(row("Seattle Mariners").getAttribute("aria-current")).toBeNull();
    expect(row("New York Yankees").getAttribute("aria-current")).toBeNull();
  });

  it("writes the param back when another team is picked", () => {
    renderAt("/admin/teams?team=t-mariners");
    fireEvent.click(row("New York Yankees"));

    expect(row("New York Yankees").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("search").textContent).toBe("?team=t-yankees");
  });

  it("leaves the operator's filter alone when they click a different row", () => {
    // The one-slot regression, and the reason the marker holds TWO ids.
    //
    // React Router applies location updates inside `startTransition`, so the
    // render that commits this click is a render in which `searchParams` still
    // says `t-mariners` — the id the operator ARRIVED on. A marker that
    // remembers only the last id it followed cannot tell that stale value apart
    // from a fresh link back to the Mariners, so it follows it: it re-selects
    // them, and because following a link clears the filters (a linked row has
    // to be reachable), the word the operator typed a second ago empties itself
    // under their own click.
    //
    // The three assertions above all pass with that bug — the URL and the
    // final selection both catch up once the transition lands. The filter is
    // what does not come back, so it is what this test watches.
    renderAt("/admin/teams?team=t-mariners");

    fireEvent.change(screen.getByLabelText("Filter teams"), {
      target: { value: "New" },
    });

    fireEvent.click(row("New York Yankees"));

    expect(screen.getByLabelText("Filter teams")).toHaveProperty("value", "New");
    expect(row("New York Yankees").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("search").textContent).toBe("?team=t-yankees");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { Theme } from "@radix-ui/themes";
import { getDashboard } from "../fake-data";
import DashboardScreen from "./DashboardScreen";
import { checklistsQuery, suggestionTarget } from "./CardPanelHost";
import { cardPanelSearch, panelSide } from "./panelLink";

/**
 * NEO-464 — a card on the dashboard opens its card panel OVER the dashboard,
 * on the dashboard's own URL (`detail=<card>`, `side=inventory` for stock):
 * a click pushes and Back closes it, the keyboard back on the card; a shared
 * link opens it; Close and Escape behave as on Collection. Drawn on the demo
 * dashboard, whose panel runs on the demo store (no server).
 */
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));
vi.mock("convex/react", () => ({}));

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("the panel's URL", () => {
  it("opens a card over the view as it is, naming the inventory side only", () => {
    expect(cardPanelSearch("?binder=b1&pg=2", "c1", "inventory")).toBe("?binder=b1&pg=2&detail=c1&side=inventory");
    expect(cardPanelSearch("", "c 1", "collection")).toBe("?detail=c+1");
    // Another card, or another side, replaces what was there; an add form's mode never rides along.
    expect(cardPanelSearch("?detail=old&mode=add&side=inventory", "c2", "collection")).toBe("?detail=c2");
  });

  it("reads the side back: inventory, else the collection", () => {
    expect(panelSide(new URLSearchParams("side=inventory"))).toBe("inventory");
    expect(panelSide(new URLSearchParams("side=elsewhere"))).toBe("collection");
    expect(panelSide(new URLSearchParams(""))).toBe("collection");
  });
});

describe("the panel's ways out to Checklists, on Collection", () => {
  it("builds each target's params", () => {
    expect(checklistsQuery({})).toEqual({ tab: "checklists" });
    expect(checklistsQuery({ q: "trout" })).toEqual({ tab: "checklists", q: "trout" });
    expect(checklistsQuery({ cardId: "c1" })).toEqual({ tab: "checklists", card: "c1" });
    expect(checklistsQuery({ setId: "s1" })).toEqual({ tab: "checklists", set: "s1" });
    expect(checklistsQuery({ entity: { kind: "player", id: "p1" } })).toEqual({ tab: "checklists", player: "p1" });
    const card = getDashboard().additions[0].cards[0].card;
    const jump = checklistsQuery({ card });
    expect(jump).toMatchObject({ tab: "checklists", card: card.id, set: card.set.id });
  });

  it("turns a search pick into a target", () => {
    expect(suggestionTarget({ kind: "player", id: "p1" } as never)).toEqual({ entity: { kind: "player", id: "p1" } });
    expect(suggestionTarget({ kind: "team", id: "t1", franchise: { id: "f1" } } as never)).toEqual({
      entity: { kind: "team", id: "t1", franchiseId: "f1", wholeFranchise: false },
    });
    expect(suggestionTarget({ kind: "set", id: "s1" } as never)).toEqual({ setId: "s1" });
  });
});

function LocationProbe() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="Page URL">{pathname + search}</output>
      <button type="button" onClick={() => void navigate(-1)}>
        Browser Back
      </button>
    </>
  );
}

function renderDashboard(entry: string) {
  const data = getDashboard();
  render(
    <Theme>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route
            path="/demo"
            element={
              <>
                <DashboardScreen data={data} />
                <LocationProbe />
              </>
            }
          />
          <Route path="/demo/collection" element={<p>Collection page</p>} />
        </Routes>
      </MemoryRouter>
    </Theme>,
  );
  return data;
}

const pageUrl = () => screen.getByRole("status", { name: "Page URL" }).textContent ?? "";
/** Lets the panel's lazy code and its focus moves land. */
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 40)));

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
});

describe("a card opens its panel over the dashboard", () => {
  it("a Fresh Pull: the click pushes, the panel opens on the collection side, Back closes it with the keyboard on the pull", async () => {
    const data = renderDashboard("/demo");
    const pull = data.additions[0].cards[0];
    const pulls = screen.getByRole("region", { name: "Fresh Pulls" });
    const link = within(pulls).getAllByRole("link", { name: new RegExp(`^${escape(pull.title)}`) })[0];
    expect(link.getAttribute("href")).toBe(`/demo?detail=${encodeURIComponent(pull.id)}`);
    link.focus();
    fireEvent.click(link);
    const panel = await screen.findByRole("dialog");
    expect(pageUrl()).toBe(`/demo?detail=${encodeURIComponent(pull.id)}`);
    // The dashboard stays under it, as it was.
    expect(screen.getByRole("heading", { level: 1, name: "Welcome back, slugger.", hidden: true })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Close card detail" })).toBeTruthy();
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Browser Back", hidden: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(pageUrl()).toBe("/demo");
    expect(document.activeElement).toBe(link);
  });

  it("a held-back card opens as stock; Close steps Back off the entry it pushed", async () => {
    const data = renderDashboard("/demo");
    const held = data.syncStatus!.problems[0].cards[0];
    const sync = screen.getByRole("region", { name: "Sync status" });
    const link = within(sync).getByRole("link", { name: new RegExp(`^${escape(held.card.title)}`) });
    fireEvent.click(link);
    const panel = await screen.findByRole("dialog");
    expect(pageUrl()).toBe(`/demo?detail=${encodeURIComponent(held.card.id)}&side=inventory`);
    await settle();
    fireEvent.click(within(panel).getByRole("button", { name: "Close card detail" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(pageUrl()).toBe("/demo");
  });

  it("a shared link opens the panel; Escape takes it off in place, side and all, and the dashboard's own params stay", async () => {
    const data = renderDashboard("/demo");
    cleanup();
    const card = data.newListings[0];
    renderDashboard(`/demo?open=listings&detail=${encodeURIComponent(card.id)}&side=inventory`);
    const panel = await screen.findByRole("dialog");
    await settle();
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(pageUrl()).toBe("/demo?open=listings");
  });

  it("a plain visit mounts no panel at all", () => {
    renderDashboard("/demo");
    expect(screen.queryByRole("dialog")).toBeNull();
    // The panel's status line only comes with the panel.
    expect(screen.getAllByRole("status").map((s) => s.getAttribute("aria-label"))).toEqual(["Page URL"]);
  });
});

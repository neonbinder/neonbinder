import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { Theme } from "@radix-ui/themes";
import FinalCollectionPage from "./FinalCollectionPage";
import { demoCard } from "./data/demoStore";
import { cardLabel, shortCardName } from "./data/labels";
import { initialCollectionState, SHOW_BOX_ID } from "./store";

// NEO-356: the demo bar's theme switch asks Clerk who is looking (signed in here).
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true }) }));

/**
 * My Binders on the consolidated page, through the page itself (real store,
 * real drawer, no Convex): the special shelf, opening a binder scopes the
 * page, the Want List opens to its wants, the pack's Enter never guesses
 * between two cards, and Share shows a readable link.
 */

/** The URL, and the browser's Back, for the history tests. */
function HistoryProbe() {
  const { search } = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="Page search">{search}</output>
      <button type="button" onClick={() => void navigate(-1)}>
        Browser Back
      </button>
    </>
  );
}

function renderBinders(start = "/collection?tab=binders") {
  return render(
    <Theme>
      <MemoryRouter initialEntries={[start]}>
        <Routes>
          <Route
            path="/collection"
            element={
              <>
                <FinalCollectionPage />
                <HistoryProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </Theme>,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("My Binders", () => {
  it("puts All my cards, Want List, Up for Trade and the Inventory long box on their own shelf", () => {
    renderBinders();
    const special = screen.getByRole("list", { name: "Special places" });
    const specials = within(special).getAllByRole("button");
    expect(specials.map((b) => b.getAttribute("aria-label")?.split(",")[0])).toEqual([
      "All my cards",
      "Want List",
      "Up for Trade",
    ]);
    // The demo store has Inventory, so its door is the Inventory tab.
    const box = within(special).getByRole("link", { name: "Inventory, 5 cards for sale" });
    expect(box.getAttribute("href")).toBe("/collection?tab=inventory");

    const mine = screen.getByRole("list", { name: "Your binders" });
    const spines = within(mine).getAllByRole("button");
    expect(spines[0].getAttribute("aria-label")).toMatch(/^Main,/);
    expect(within(mine).queryByRole("button", { name: /^All my cards,/ })).toBeNull();
    expect(within(mine).queryByRole("button", { name: /^Want List,/ })).toBeNull();
  });

  it("All my cards holds the binders' cards only: no For sale filter, no card that lives in a box (NEO-359)", () => {
    const seed = initialCollectionState().copies;
    const inBinders = new Set(seed.filter((c) => c.homeId !== SHOW_BOX_ID).map((c) => c.cardId));
    const onlyBoxed = seed.filter((c) => c.homeId === SHOW_BOX_ID && !inBinders.has(c.cardId)).map((c) => demoCard(c.cardId)!);
    expect(onlyBoxed.length).toBeGreaterThan(0);
    renderBinders("/collection?tab=binders&all=1");
    expect(screen.getByRole("heading", { level: 2, name: "All my cards" })).toBeTruthy();
    expect(screen.getByText("Every card in your binders, one pocket per copy.")).toBeTruthy();
    expect(screen.queryByText(/yellow tag/)).toBeNull();
    const only = screen.getByRole("group", { name: "Only show" });
    expect(within(only).getAllByRole("button").map((b) => b.textContent)).toEqual(["Graded", "Rookies"]);
    for (const card of onlyBoxed) {
      expect(screen.queryAllByRole("button", { name: new RegExp(`^${cardLabel(card).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) })).toHaveLength(0);
    }
    expect(screen.queryAllByRole("button", { name: /, for sale/ })).toHaveLength(0);
  });

  it("All my cards still opens everything and scopes the page to All", () => {
    renderBinders("/collection?tab=binders&b=binder-contenders-96");
    fireEvent.click(screen.getByRole("button", { name: "Back to the shelf" }));
    fireEvent.click(screen.getByRole("button", { name: /^All my cards,/ }));
    expect(screen.getByRole("heading", { level: 2, name: "All my cards" })).toBeTruthy();
    expect(screen.getByText("Checklists and My Cards are looking through everything.")).toBeTruthy();
  });

  it("opening a binder scopes the page to it, and the shelf shows it", () => {
    renderBinders();
    fireEvent.click(screen.getByRole("button", { name: /^'96 Contenders,/ }));
    expect(screen.getByRole("heading", { level: 2, name: "'96 Contenders" })).toBeTruthy();
    expect(screen.getByText("Checklists and My Cards are looking through '96 Contenders.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back to the shelf" }));
    const spine = screen.getByRole("button", { name: /^'96 Contenders,/ });
    expect(spine.getAttribute("aria-current")).toBe("true");
  });

  it("opens the Want List to its wants, unscoped first, and a want opens the drawer to add it", () => {
    renderBinders();
    fireEvent.click(screen.getByRole("button", { name: /^Want List,/ }));
    expect(screen.getByRole("heading", { level: 2, name: "Want List" })).toBeTruthy();
    expect(screen.getByRole("group", { name: /^Page 1, Just want it/ })).toBeTruthy();

    const need = screen.getAllByRole("button", { name: /, need\. Add it$/ })[0];
    act(() => {
      fireEvent.click(need);
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("a want for a binder opens the add form living in that binder, not Main", () => {
    renderBinders("/collection?tab=binders&b=binder-want");
    fireEvent.click(screen.getByRole("button", { name: /^Next pages?$/ }));
    expect(screen.getByRole("group", { name: /^Page 2, For Ohtani rainbow/ })).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: /, need\. Add it$/ })[0]);
    });
    const home = within(screen.getByRole("dialog")).getByRole("combobox", { name: "Where it lives" }) as HTMLSelectElement;
    expect(home.value).toBe("binder-ohtani-rainbow");
  });

  it("an unscoped want still opens the add form on Main", () => {
    renderBinders("/collection?tab=binders&b=binder-want");
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: /, need\. Add it$/ })[0]);
    });
    const home = within(screen.getByRole("dialog")).getByRole("combobox", { name: "Where it lives" }) as HTMLSelectElement;
    expect(home.value).toBe("binder-main");
  });

  it("while the Want List is open, the hunt adds a want, never a filed copy", async () => {
    renderBinders("/collection?tab=binders&b=binder-want");
    const search = screen.getByRole("searchbox", { name: "Hunt for a card you want" });
    fireEvent.change(search, { target: { value: "96 contenders reggie white" } });
    const want = screen.getAllByRole("button", { name: /^Want / })[0];
    fireEvent.click(want);
    // Writes are async: the line speaks once the store answers.
    await waitFor(() =>
      expect(screen.getAllByRole("status").some((s) => /is on your Want List/.test(s.textContent ?? ""))).toBe(true),
    );
    expect(screen.queryByRole("group", { name: /^Where should/ })).toBeNull();
  });

  it("Enter in the hunt asks when two cards fit instead of taking the first", () => {
    renderBinders("/collection?tab=binders&all=1");
    const search = screen.getByRole("searchbox", { name: "Hunt for one of your cards" });
    // A card number is not unique: #13 is in many sets and parallels.
    fireEvent.change(search, { target: { value: "13" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getAllByRole("status").some((s) => /we won't guess/.test(s.textContent ?? ""))).toBe(true);
    expect(screen.queryByRole("group", { name: /^Where should/ })).toBeNull();
  });

  it("a single character is below the search minimum: the hunt says nothing and guesses nothing", () => {
    renderBinders("/collection?tab=binders&all=1");
    const search = screen.getByRole("searchbox", { name: "Hunt for one of your cards" });
    fireEvent.change(search, { target: { value: "1" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getAllByRole("status").some((s) => /we won't guess/.test(s.textContent ?? ""))).toBe(false);
    expect(screen.queryByRole("group", { name: /^Where should/ })).toBeNull();
    expect(screen.queryByRole("list", { name: "In your binders" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Not in your binders yet" })).toBeNull();
  });

  it("Share shows a human-readable link at the neutral @you handle, and says it is an example", () => {
    renderBinders("/collection?tab=binders&b=binder-ohtani-rainbow");
    fireEvent.click(screen.getByRole("button", { name: "Share Ohtani rainbow" }));
    expect(screen.getByText("neonbinder.io/@you/binders/ohtani-rainbow")).toBeTruthy();
    expect(
      screen.getByText("Just an example: share links arrive when your real collection does."),
    ).toBeTruthy();
    // Signed in is still the demo: no real collector's handle, no promise of a real page.
    expect(screen.queryByText(/@jason/)).toBeNull();
    expect(screen.queryByText("Anyone with the link can see it. Only you can change it.")).toBeNull();
  });
});

describe("the hunt tray", () => {
  const hunt = () => screen.getByRole("searchbox", { name: "Hunt for one of your cards" });
  const statusSays = (re: RegExp) => screen.getAllByRole("status").some((s) => re.test(s.textContent ?? ""));

  it("shows your own copies first, with where each lives, then the catalog", () => {
    renderBinders();
    fireEvent.change(hunt(), { target: { value: "96 contenders reggie white" } });
    const mine = screen.getByRole("list", { name: "In your binders" });
    const catalog = screen.getByRole("list", { name: "Not in your binders yet" });
    expect(within(mine).getByRole("button", { name: "Find #4 Reggie White in '96 Contenders, page 1, pocket 4" })).toBeTruthy();
    expect(within(mine).getByRole("button", { name: "Find #4 Reggie White in Slab case" })).toBeTruthy();
    expect(within(catalog).getAllByRole("button", { name: /^Slot in / }).length).toBeGreaterThan(0);
    // On the shelf no binder is open, so there is nothing to move into.
    expect(within(mine).queryByRole("button", { name: /^Move here/ })).toBeNull();
    expect(within(mine).getAllByRole("button", { name: /^Add another / }).length).toBeGreaterThan(0);
  });

  it("a place with a pocket opens that binder there and rings the pocket", () => {
    renderBinders();
    fireEvent.change(hunt(), { target: { value: "96 contenders reggie white" } });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Find #4 Reggie White in '96 Contenders, page 1, pocket 4" }));
    });
    expect(screen.getByRole("heading", { level: 2, name: "'96 Contenders" })).toBeTruthy();
    const ringed = document.querySelector<HTMLElement>('[data-found="true"]');
    expect(ringed?.getAttribute("aria-label")).toMatch(/^1996 Playoff Contenders #4 Reggie White/);
    expect(document.activeElement).toBe(ringed);
    expect(statusSays(/^Found #4 Reggie White: '96 Contenders, page 1, pocket 4\.$/)).toBe(true);
    // The results fold away so the pocket is in view.
    expect(screen.queryByRole("list", { name: "In your binders" })).toBeNull();
  });

  it("a place in a binder without pages opens the card drawer", () => {
    renderBinders();
    fireEvent.change(hunt(), { target: { value: "96 contenders reggie white" } });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Find #4 Reggie White in Slab case" }));
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("Move here moves your one copy into the open binder's next pocket, naming both, and Undo puts it back in its own", async () => {
    renderBinders("/collection?tab=binders&b=binder-slab-case");
    fireEvent.change(hunt(), { target: { value: "jim kelly" } });
    fireEvent.click(screen.getByRole("button", { name: /^Move here: 1996 Playoff Contenders #12 Jim Kelly/ }));
    await waitFor(() => expect(statusSays(/^Moved #12 Jim Kelly from '96 Contenders to Slab case, page 1, pocket 1\.$/)).toBe(true));
    expect(screen.getByRole("button", { name: "Find #12 Jim Kelly in Slab case, page 1, pocket 1" })).toBeTruthy();
    // It left its old pocket: one home, never two.
    expect(screen.queryByRole("button", { name: /^Find #12 Jim Kelly in '96 Contenders/ })).toBeNull();
    // Nothing left to move here, so only Add another is offered.
    expect(screen.queryByRole("button", { name: /^Move here: .*#12 Jim Kelly/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Find #12 Jim Kelly in '96 Contenders, page 2, pocket 3" })).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: /^Find #12 Jim Kelly in Slab case/ })).toBeNull();
  });

  it("never lists a copy in a box: a card for sale is Inventory's, and taking it off sale is the drawer's (NEO-359)", async () => {
    // A seed card with a copy in a binder and a copy in the Show box.
    const seed = initialCollectionState().copies;
    const both = seed.find(
      (c) => c.homeId === SHOW_BOX_ID && seed.some((o) => o.cardId === c.cardId && o.homeId !== SHOW_BOX_ID),
    )!;
    const card = demoCard(both.cardId)!;
    const short = shortCardName(card);
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    renderBinders("/collection?tab=binders&b=binder-slab-case");
    fireEvent.change(hunt(), { target: { value: `${card.set.name} ${card.players[0].name}` } });
    await waitFor(() => expect(screen.getAllByRole("button", { name: new RegExp(`^Find ${escape(short)} in `) }).length).toBeGreaterThan(0));
    expect(screen.queryAllByRole("button", { name: /in Show box/ })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: /, for sale$/ })).toHaveLength(0);
    // Only the binder's copy is there to move, so it moves straight away.
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^Move here: ${escape(cardLabel(card))}`) }));
    expect(screen.queryByRole("group", { name: new RegExp(`^Which ${escape(short)} moves`) })).toBeNull();
    await waitFor(() =>
      expect(statusSays(new RegExp(`^Moved ${escape(short)} from (?!Show box).+ to Slab case, page 1, pocket \\d+\\.$`))).toBe(true),
    );
  });

  it("Add another still adds a new copy", () => {
    renderBinders("/collection?tab=binders&b=binder-slab-case");
    fireEvent.change(hunt(), { target: { value: "jim kelly" } });
    fireEvent.click(screen.getByRole("button", { name: /^Add another 1996 Playoff Contenders #12 Jim Kelly/ }));
    expect(screen.getByRole("group", { name: "Where should #12 Jim Kelly go?" })).toBeTruthy();
  });
});

describe("spine labels", () => {
  it("keeps every spine's accessible name plain text", () => {
    renderBinders();
    expect(screen.getByRole("button", { name: /^Red Wings, smart binder, \d+ cards?$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Slab case, \d+ cards?$/ })).toBeTruthy();
    // The system containers read by role.
    expect(screen.getByRole("button", { name: /^Up for Trade, \d+ cards? up for trade$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Want List, \d+ cards? wanted$/ })).toBeTruthy();
  });

  it("Edit label saves the collector's colours, and a faint pair letters in white on the shelf", () => {
    renderBinders("/collection?tab=binders&b=binder-contenders-96");
    fireEvent.click(screen.getByRole("button", { name: "Edit label for '96 Contenders" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Background"), { target: { value: "#005A9C" } });
    fireEvent.change(within(dialog).getByLabelText("Lettering"), { target: { value: "#EF3E42" } });
    expect(within(dialog).getByText(/hard to read on a shelf\. Try a lighter or darker lettering color\./)).toBeTruthy();
    expect(within(dialog).getByText(/the shelf letters it in white/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save label" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to the shelf" }));
    const spine = screen.getByRole("button", { name: /^'96 Contenders,/ });
    const label = spine.querySelector<HTMLElement>(".nb-label")!;
    expect(label.dataset.inkSwapped).toBe("true");
    expect(label.style.color).toMatch(/255, 255, 255|#ffffff/i);
  });
});

describe("a smart binder's label follows the team on most of its cards", () => {
  const color = (el: Element | null) => (el as HTMLElement).style.background;

  it("dresses All Reggie White in Packers colors, and offers his teams as quick picks", () => {
    renderBinders();
    const spine = screen.getByRole("button", { name: /^All Reggie White,/ });
    // Packers green (#203731), not the Eagles he played longest for.
    expect(color(spine.querySelector(".nb-label"))).toMatch(/32, 55, 49|#203731/i);

    fireEvent.click(spine);
    fireEvent.click(screen.getByRole("button", { name: "Edit label for All Reggie White" }));
    const dialog = screen.getByRole("dialog");
    const picks = within(dialog).getByRole("group", { name: "Teams on its cards" });
    const names = within(picks).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Packers, 3 cards", "Eagles, 1 card", "Panthers, 1 card"]);
    expect(within(picks).getByRole("button", { name: "Packers, 3 cards" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(within(picks).getByRole("button", { name: "Eagles, 1 card" }));
    expect((within(dialog).getByLabelText("Background") as HTMLInputElement).value).toBe("#004C54");
    expect((within(dialog).getByLabelText("Lettering") as HTMLInputElement).value).toBe("#A5ACAF");
    expect(within(picks).getByRole("button", { name: "Eagles, 1 card" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(within(dialog).getByRole("button", { name: "Back to the default" }));
    expect((within(dialog).getByLabelText("Background") as HTMLInputElement).value).toBe("#203731");
  });

  it("stores the collector's pick, and Back to the default goes back to following the cards", () => {
    renderBinders("/collection?tab=binders&b=smart-reggie-white");
    fireEvent.click(screen.getByRole("button", { name: "Edit label for All Reggie White" }));
    fireEvent.click(screen.getByRole("button", { name: "Eagles, 1 card" }));
    fireEvent.click(screen.getByRole("button", { name: "Save label" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to the shelf" }));
    const spine = () => screen.getByRole("button", { name: /^All Reggie White,/ }).querySelector(".nb-label");
    expect(color(spine())).toMatch(/0, 76, 84|#004c54/i);

    fireEvent.click(screen.getByRole("button", { name: /^All Reggie White,/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit label for All Reggie White" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to the default" }));
    fireEvent.click(screen.getByRole("button", { name: "Save label" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to the shelf" }));
    expect(color(spine())).toMatch(/32, 55, 49|#203731/i);
  });
});

/** A Print Shop link that opens a new tab, and says so without renaming itself. */
function expectNewTab(link: HTMLElement) {
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener");
  const hint = document.getElementById(link.getAttribute("aria-describedby") ?? "");
  expect(hint?.textContent).toBe("Opens in a new tab");
}

describe("a team-rule smart binder's quick picks", () => {
  it("offers the rule's own team first, even when no card shows it", () => {
    renderBinders("/collection?tab=binders&b=smart-badgers-alumni");
    fireEvent.click(screen.getByRole("button", { name: "Edit label for Badgers alumni" }));
    const dialog = screen.getByRole("dialog");
    const picks = within(within(dialog).getByRole("group", { name: "Teams on its cards" })).getAllByRole("button");
    expect(picks[0].getAttribute("aria-label")).toBe("Wisconsin Badgers, the binder's team");
    expect(picks[0].textContent).toBe("Wisconsin Badgers· the binder's team");
    // It is the binder's default, so it starts pressed; the rest are the pro teams on its cards.
    expect(picks[0].getAttribute("aria-pressed")).toBe("true");
    expect(picks.slice(1).every((b) => / cards?$/.test(b.getAttribute("aria-label") ?? ""))).toBe(true);

    fireEvent.click(picks[1]);
    expect(picks[0].getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(picks[0]);
    expect((within(dialog).getByLabelText("Background") as HTMLInputElement).value).toBe("#C5050C");
    expect(picks[0].getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Print this label", () => {
  it("links the cover to the Print Shop with the binder's name, colors and face", () => {
    renderBinders("/collection?tab=binders&b=smart-reggie-white");
    const links = screen.getAllByRole("link", { name: "Print label for All Reggie White" });
    expect(links[0].getAttribute("href")).toBe(
      "/print/spine-label?name=All+Reggie+White&bg=203731&fg=ffb612&font=anton",
    );
    // A new tab, so the open binder is still here when the collector comes back.
    links.forEach(expectNewTab);
  });

  it("opens the Print Shop in a new tab from the label editor, so the unsaved edits survive", () => {
    renderBinders("/collection?tab=binders&b=binder-contenders-96");
    fireEvent.click(screen.getByRole("button", { name: "Edit label for '96 Contenders" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Background"), { target: { value: "#005A9C" } });
    const link = within(dialog).getByRole("link", { name: "Print this label" });
    expectNewTab(link);
    // Following it in a new tab leaves this page alone: the dialog and its draft are still here.
    // (The click's default, a new happy-dom window fetching the URL, is held back here.)
    const holdBack = (e: Event) => e.preventDefault();
    document.addEventListener("click", holdBack);
    try {
      fireEvent.click(link);
    } finally {
      document.removeEventListener("click", holdBack);
    }
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect((within(dialog).getByLabelText("Background") as HTMLInputElement).value).toBe("#005A9C");
  });

  it("links from the label editor with the label as it stands there", () => {
    renderBinders("/collection?tab=binders&b=binder-contenders-96");
    fireEvent.click(screen.getByRole("button", { name: "Edit label for '96 Contenders" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Background"), { target: { value: "#005A9C" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Teko" }));
    expect(within(dialog).getByRole("link", { name: "Print this label" }).getAttribute("href")).toBe(
      "/print/spine-label?name=%2796+Contenders&bg=005a9c&fg=ffffff&font=teko",
    );
  });
});

describe("Browse a set's filters", () => {
  it("narrows by sport and name, says how many, and offers a way back from an empty shelf", () => {
    renderBinders();
    const sets = () => screen.getByRole("list", { name: "Sets to browse" });
    expect(screen.getByText("6 of 6 sets")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hockey" }));
    expect(screen.getByText("1 of 6 sets")).toBeTruthy();
    expect(within(sets()).getAllByRole("button")).toHaveLength(1);

    fireEvent.change(screen.getByRole("searchbox", { name: "Find a set by name" }), { target: { value: "zzz" } });
    expect(screen.getByText("No sets on this shelf fit those filters.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("6 of 6 sets")).toBeTruthy();
  });

  it("keeps the filters when you leave the tab and come back", () => {
    renderBinders();
    fireEvent.change(screen.getByRole("combobox", { name: "From year" }), { target: { value: "2000" } });
    expect(screen.getByText("3 of 6 sets")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Checklists" }));
    fireEvent.click(screen.getByRole("link", { name: "My Binders" }));
    expect((screen.getByRole("combobox", { name: "From year" }) as HTMLSelectElement).value).toBe("2000");
    expect(screen.getByText("3 of 6 sets")).toBeTruthy();
  });
});

describe("identity slips on the shelf", () => {
  const tip = () => screen.queryByRole("tooltip");

  it("focusing a cut-short Browse spine shows the full season and set, and Escape puts it away", async () => {
    renderBinders();
    fireEvent.change(screen.getByRole("searchbox", { name: "Find a set by name" }), { target: { value: "playoff" } });
    fireEvent.change(screen.getByRole("combobox", { name: "From year" }), { target: { value: "1993" } });
    fireEvent.change(screen.getByRole("combobox", { name: "To year" }), { target: { value: "1996" } });
    const spine = within(screen.getByRole("list", { name: "Sets to browse" })).getByRole("button", {
      name: /^Browse 1996 Playoff Contenders, you have \d+ of \d+$/,
    });

    act(() => spine.focus());
    await waitFor(() => expect(tip()?.textContent).toMatch(/^1996 Playoff ContendersYou have \d+ of \d+$/));
    // The name already says it all: the slip is not read a second time.
    expect(spine.getAttribute("aria-describedby")).toBeNull();

    fireEvent.keyDown(spine, { key: "Escape" });
    await waitFor(() => expect(tip()).toBeNull());
  });

  it("a binder spine's slip gives its full name, its own words and its count; only the words are announced", async () => {
    renderBinders();
    const spine = screen.getByRole("button", { name: /^All Reggie White, smart binder,/ });
    act(() => spine.focus());
    await waitFor(() => expect(tip()).not.toBeNull());
    expect(tip()?.textContent).toBe("Every Reggie White card, any team, any year.");
    expect(spine.getAttribute("aria-describedby")).toBe(tip()?.id);
    const shown = screen.getAllByText("All Reggie White").find((el) => el.classList.contains("nb-idtip-title"));
    expect(shown).toBeTruthy();
  });

  it("a card in a pocket shows its set, insert or parallel, number and player", async () => {
    renderBinders("/collection?tab=binders&b=binder-contenders-96");
    const pocket = screen.getAllByRole("button", { name: /^1996 Playoff Contenders .*#\d+ /, hidden: false })[0];
    act(() => pocket.focus());
    await waitFor(() => expect(tip()?.textContent).toMatch(/^1996 Playoff Contenders.*#\d+ \S+/));
    expect(pocket.getAttribute("aria-describedby")).toBeNull();
  });
});

describe("the views on the URL (app mode)", () => {
  it("each tab, set wall and binder is a step, and Back walks back through them", () => {
    renderBinders("/collection");
    const search = () => screen.getByRole("status", { name: "Page search" }).textContent;
    const back = () => fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
    const tabs = () => screen.getByRole("navigation", { name: "Collection sections" });

    fireEvent.click(within(tabs()).getByRole("link", { name: "My Cards" }));
    fireEvent.click(screen.getByRole("link", { name: "1996-97 Upper Deck" }));
    expect(search()).toBe("?tab=cards&set=1996-97-upper-deck-hockey");
    fireEvent.click(within(tabs()).getByRole("link", { name: "My Binders" }));
    fireEvent.click(screen.getByRole("button", { name: /^All Reggie White,/ }));
    expect(screen.getByRole("heading", { level: 2, name: "All Reggie White" })).toBeTruthy();

    back();
    expect(search()).toBe("?tab=binders");
    back();
    expect(screen.getByRole("group", { name: "1996-97 Upper Deck checklist wall" })).toBeTruthy();
    back();
    expect(search()).toBe("?tab=cards");
    back();
    expect(search()).toBe("");
  });

  it("the Binder scope rides on the URL: a pick replaces, opening a binder pushes its scope, Back restores", () => {
    renderBinders("/collection?tab=cards");
    const search = () => screen.getByRole("status", { name: "Page search" }).textContent;
    const back = () => fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
    const picker = () => screen.getByRole("combobox", { name: "Binder" }) as HTMLSelectElement;
    // Only homes are offered: a binder, a box or Main. Never the Want List or Up for Trade.
    expect(within(picker()).queryByRole("option", { name: "Up for Trade" })).toBeNull();
    expect(within(picker()).queryByRole("option", { name: "Want List" })).toBeNull();
    const slab = (within(picker()).getByRole("option", { name: "Slab case" }) as HTMLOptionElement).value;

    fireEvent.change(picker(), { target: { value: slab } });
    expect(search()).toBe(`?tab=cards&scope=${slab}`);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Collection sections" })).getByRole("link", { name: "My Binders" }));
    expect(search()).toBe(`?tab=binders&scope=${slab}`);
    fireEvent.click(screen.getByRole("button", { name: /^'96 Contenders,/ }));
    expect(search()).toBe("?tab=binders&b=binder-contenders-96&scope=binder-contenders-96");

    back();
    expect(screen.getByText("Slab case", { selector: "strong" })).toBeTruthy();
    back();
    expect(search()).toBe(`?tab=cards&scope=${slab}`);
    expect(picker().value).toBe(slab);
  });
});

describe("one open-binder view for binders and browsed sets", () => {
  const header = (title: string) => {
    const heading = screen.getByRole("heading", { level: 2, name: title });
    return heading.closest("div")!.parentElement!;
  };

  it("a browsed set gets the binder's Share and layout toggle, from the same view, and no label controls", () => {
    renderBinders("/collection?tab=binders&b=binder-contenders-96");
    const binderControls = within(header("'96 Contenders"))
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(binderControls).toEqual([
      "Back to the shelf",
      "Share '96 Contenders",
      "Lay out like my real binder",
      "Just a stack",
    ]);
    expect(screen.getAllByRole("button", { name: "Edit label for '96 Contenders" }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Back to the shelf" }));
    fireEvent.click(screen.getByRole("button", { name: /^Browse 2000 Topps,/ }));
    const setControls = within(header("2000 Topps"))
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(setControls).toEqual([
      "Back to the shelf",
      "Share 2000 Topps",
      "Lay out like my real binder",
      "Just a stack",
    ]);
    expect(within(header("2000 Topps")).getByText("Browsing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Edit label for/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /^Print label for/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Share 2000 Topps" }));
    expect(screen.getByText("neonbinder.io/@you/sets/2000-topps")).toBeTruthy();
  });

  it("Just a stack packs a browsed set tight, and the toggle is not a history step", () => {
    renderBinders("/collection?tab=binders&set=2000-topps-football");
    const search = () => screen.getByRole("status", { name: "Page search" }).textContent;
    const before = search();
    const pockets = screen.getByRole("button", { name: "Lay out like my real binder" });
    const stack = screen.getByRole("button", { name: "Just a stack" });
    expect(pockets.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getAllByText("Every card in the set, in checklist order. Each insert starts a fresh page.").length).toBeGreaterThan(0);

    fireEvent.click(stack);
    expect(stack.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getAllByText("Every card in the set, in checklist order, packed tight.").length).toBeGreaterThan(0);
    expect(search()).toBe(before);
    expect(screen.getAllByRole("button", { name: /^Add / }).length).toBeGreaterThan(0);
  });
});


describe("boxes and binders you make", () => {
  const statusSays = (re: RegExp) => screen.getAllByRole("status").some((s) => re.test(s.textContent ?? ""));

  it("My Binders makes binders only: no box to pick", () => {
    renderBinders();
    fireEvent.click(screen.getByRole("button", { name: "New binder" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "New binder" })).toBeTruthy();
    expect(within(dialog).queryByRole("radio", { name: /box/i })).toBeNull();
    expect(within(dialog).getByLabelText("Binder name")).toBeTruthy();
  });

  it("Inventory makes a box, and opens it without narrowing the collection", async () => {
    renderBinders("/collection?tab=inventory");
    fireEvent.click(screen.getByRole("button", { name: "New box" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "New box" })).toBeTruthy();
    expect(within(dialog).queryByRole("radio")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Box name"), { target: { value: "Dime box" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Put it on the shelf" }));
    await waitFor(() => expect(statusSays(/^Dime box is on the shelf\. Hunt for a card below and drop it in a row\.$/)).toBe(true));
    expect(await screen.findByRole("region", { name: "Dime box, open" })).toBeTruthy();
    expect(screen.getByLabelText("Page search").textContent).toMatch(/^\?tab=inventory&b=[\w-]+$/);
    expect(screen.queryByText(/looking through Dime box/)).toBeNull();
  });

  it("refuses a nameless one with words, and makes nothing", () => {
    renderBinders();
    fireEvent.click(screen.getByRole("button", { name: "New binder" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Put it on the shelf" }));
    expect(within(dialog).getByText("Give the binder a name.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: /, open$/ })).toBeNull();
  });

  it("deleting a box with cards in it sends them to Main and says it can't be undone", async () => {
    renderBinders("/collection?tab=inventory&b=box-show");
    fireEvent.click(screen.getByRole("button", { name: "Rename or delete Show box" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete this box" }));
    expect(screen.getByRole("heading", { name: "Delete Show box?" })).toBeTruthy();
    expect(screen.getByText(/go back to Main\. You can't undo this\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete it" }));
    await waitFor(() => expect(statusSays(/^Show box is off the shelf\. Its \d+ cards? went? back to Main\.$|^Show box is off the shelf\. Its \d+ cards go back to Main\.$/)).toBe(true));
    expect(screen.queryByRole("button", { name: /^Show box, box,/ })).toBeNull();
  });

  it("'Keep it' backs out of the delete confirm without deleting", () => {
    renderBinders("/collection?tab=inventory&b=box-show");
    fireEvent.click(screen.getByRole("button", { name: "Rename or delete Show box" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete this box" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.getByRole("heading", { name: "Rename or delete Show box" })).toBeTruthy();
  });

  it("offers no rename or delete on a system container", () => {
    renderBinders("/collection?tab=binders&b=binder-main");
    expect(screen.queryByRole("button", { name: /^Rename or delete/ })).toBeNull();
    // Its label can still be set.
    expect(screen.getAllByRole("button", { name: "Edit label for Main" }).length).toBeGreaterThan(0);
  });
});

describe("Up for Trade is a flag: the pile lists flagged copies where they live", () => {
  const hunt = () => screen.getByRole("searchbox", { name: "Hunt for a card to trade" });
  const statusSays = (re: RegExp) => screen.getAllByRole("status").some((s) => re.test(s.textContent ?? ""));

  /**
   * The demo with exactly two copies up for trade: one in a binder, one in
   * the Show box (Jason, 2026-10-24: Up for Trade crosses collection and
   * inventory).
   */
  function seedMixedTrade() {
    const seed = initialCollectionState();
    const inBox = seed.copies.find((c) => c.homeId === SHOW_BOX_ID)!;
    const inBinder = seed.copies.find((c) => c.homeId !== SHOW_BOX_ID && c.cardId !== inBox.cardId)!;
    const state = {
      ...seed,
      copies: seed.copies.map((c) => ({ ...c, upForTrade: c.id === inBox.id || c.id === inBinder.id })),
    };
    window.sessionStorage.setItem("nb-collection-final", JSON.stringify(state));
    return { boxCard: demoCard(inBox.cardId)!, binderCard: demoCard(inBinder.cardId)!, copies: inBox.quantity + inBinder.quantity };
  }
  const startsWith = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

  it("lists a box copy flagged up for trade, wearing a For sale tag; a binder copy wears none", () => {
    const { boxCard, binderCard, copies } = seedMixedTrade();
    renderBinders("/collection?tab=binders");
    // The spine counts both, the box copy too.
    fireEvent.click(screen.getByRole("button", { name: `Up for Trade, ${copies} cards up for trade` }));
    const pile = screen.getByRole("region", { name: "Up for Trade, open" });
    const boxPocket = within(pile).getByRole("button", { name: startsWith(cardLabel(boxCard)) });
    expect(boxPocket.getAttribute("aria-label")).toMatch(/, for sale, up for trade$/);
    const tag = within(boxPocket).getByText("For sale");
    expect(tag.getAttribute("aria-hidden")).toBe("true");
    const binderPocket = within(pile).getByRole("button", { name: startsWith(cardLabel(binderCard)) });
    expect(binderPocket.getAttribute("aria-label")).not.toMatch(/for sale/);
    expect(within(binderPocket).queryByText("For sale")).toBeNull();
  });

  it("the box copy on the trade pile stays off All my cards", () => {
    const { boxCard } = seedMixedTrade();
    renderBinders("/collection?tab=binders&all=1");
    expect(screen.getByRole("heading", { level: 2, name: "All my cards" })).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /, for sale/ })).toHaveLength(0);
    expect(screen.queryByText("For sale")).toBeNull();
    const held = initialCollectionState().copies.some((c) => c.cardId === boxCard.id && c.homeId !== SHOW_BOX_ID);
    if (!held) expect(screen.queryAllByRole("button", { name: startsWith(cardLabel(boxCard)) })).toHaveLength(0);
  });

  it("flagging from the trade tray says the copy stays where it lives", async () => {
    renderBinders("/collection?tab=binders&b=binder-trade-bait");
    fireEvent.change(hunt(), { target: { value: "jim kelly" } });
    fireEvent.click(screen.getByRole("button", { name: /^Put .*#12 Jim Kelly.* up for trade$/ }));
    await waitFor(() => expect(statusSays(/^#12 Jim Kelly is up for trade\. It stays in '96 Contenders\.$/)).toBe(true));
  });
});

describe("the scope files new cards into the scoped home", () => {
  it("a Have on a checklist row under a scoped binder lands in that binder, and the status names it", async () => {
    renderBinders("/collection?tab=checklists&set=2024-topps-chrome-baseball&type=Base&scope=binder-slab-case");
    const have = screen.getAllByRole("button", { name: /^Have #/ }).find((b) => b.getAttribute("aria-pressed") === "false")!;
    fireEvent.click(have);
    await waitFor(() =>
      expect(screen.getAllByRole("status").some((s) => /^Added .+ to Slab case$/.test(s.textContent ?? ""))).toBe(true),
    );
  });

  it("a box is never the collection's scope: scope=<box> reads as All, and a Have lands in Main", async () => {
    renderBinders("/collection?tab=checklists&set=2024-topps-chrome-baseball&type=Base&scope=box-show");
    expect((screen.getByRole("combobox", { name: "Binder" }) as HTMLSelectElement).value).toBe("all");
    const have = screen.getAllByRole("button", { name: /^Have #/ }).find((b) => b.getAttribute("aria-pressed") === "false")!;
    fireEvent.click(have);
    await waitFor(() =>
      expect(screen.getAllByRole("status").some((s) => /^Added .+ to Main$/.test(s.textContent ?? ""))).toBe(true),
    );
  });

  it("under All it lands in Main", async () => {
    renderBinders("/collection?tab=checklists&set=2024-topps-chrome-baseball&type=Base");
    const have = screen.getAllByRole("button", { name: /^Have #/ }).find((b) => b.getAttribute("aria-pressed") === "false")!;
    fireEvent.click(have);
    await waitFor(() =>
      expect(screen.getAllByRole("status").some((s) => /^Added .+ to Main$/.test(s.textContent ?? ""))).toBe(true),
    );
  });

  it("Want under a scope is for that home, and under All is a plain want; one per card", async () => {
    renderBinders("/collection?tab=checklists&set=2024-topps-chrome-baseball&type=Base&scope=binder-slab-case");
    const want = screen.getAllByRole("button", { name: /^Want #/ }).find((b) => b.getAttribute("aria-pressed") === "false")!;
    fireEvent.click(want);
    await waitFor(() =>
      expect(screen.getAllByRole("status").some((s) => /is on your Want List for Slab case$/.test(s.textContent ?? ""))).toBe(true),
    );
    expect(want.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("the collection and Inventory never mix (NEO-359)", () => {
  const search = () => screen.getByLabelText("Page search").textContent;

  it("My Binders shows binders only: no box on the shelf, in the headline, the picker or the My Cards rail", () => {
    renderBinders();
    const mine = screen.getByRole("list", { name: "Your binders" });
    expect(within(mine).queryByRole("button", { name: /Show box|, box,/ })).toBeNull();
    expect(screen.getByRole("heading", { level: 3, name: "Your binders" })).toBeTruthy();
    expect(screen.getByText(/^\d+ cards, \d+ binders\.$/)).toBeTruthy();
    // The long box is still the door to Inventory, and counts what is for sale.
    expect(screen.getByRole("link", { name: /^Inventory, \d+ cards? for sale$/ }).getAttribute("href")).toBe("/collection?tab=inventory");

    fireEvent.click(within(screen.getByRole("navigation", { name: "Collection sections" })).getByRole("link", { name: "My Cards" }));
    const picker = screen.getByRole("combobox", { name: "Binder" });
    expect(within(picker).getAllByRole("option").map((o) => o.textContent)).not.toContain("Show box");
    expect(within(picker).queryByRole("option", { name: /box/i })).toBeNull();
    const rail = screen.getByRole("navigation", { name: "Shelves and binders" });
    expect(within(rail).queryByRole("button", { name: /Show box/ })).toBeNull();
  });

  const current = () =>
    within(screen.getByRole("navigation", { name: "Collection sections" }))
      .getAllByRole("link")
      .find((l) => l.getAttribute("aria-current") === "page")?.textContent;

  it("a box on My Binders' URL opens on the Inventory tab instead, in place of the entry", async () => {
    renderBinders("/collection?tab=binders&b=box-show");
    expect(await screen.findByRole("region", { name: "Show box, open" })).toBeTruthy();
    expect(search()).toBe("?tab=inventory&b=box-show");
    expect(current()).toBe("Inventory");
  });

  it("the old combined for-sale view goes to Inventory's", async () => {
    renderBinders("/collection?tab=binders&sale=1");
    expect(await screen.findByRole("heading", { level: 2, name: "For sale" })).toBeTruthy();
    expect(search()).toBe("?tab=inventory&sale=1");
  });

  it("a binder on Inventory's URL opens in My Binders", async () => {
    renderBinders("/collection?tab=inventory&b=binder-contenders-96");
    expect(await screen.findByRole("heading", { level: 2, name: "'96 Contenders" })).toBeTruthy();
    expect(search()).toBe("?tab=binders&b=binder-contenders-96");
  });
});

describe("Inventory", () => {
  const search = () => screen.getByLabelText("Page search").textContent;
  const back = () => fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));

  it("is a tab of its own: the boxes only, the whole stock, and no Binder picker", () => {
    renderBinders();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Collection sections" })).getByRole("link", { name: "Inventory" }));
    expect(search()).toBe("?tab=inventory");
    expect(document.title).toBe("Inventory · Collection");
    expect(screen.queryByRole("combobox", { name: "Binder" })).toBeNull();
    const boxes = screen.getByRole("list", { name: "Your boxes" });
    expect(within(boxes).getByRole("button", { name: /^Show box, box, \d+ cards? for sale$/ })).toBeTruthy();
    expect(within(boxes).queryByRole("button", { name: /^Main,|^'96 Contenders,/ })).toBeNull();
    expect(screen.queryByRole("list", { name: "Special places" })).toBeNull();
    expect(screen.getByText(/^\d+ cards? for sale in 1 box\.$/)).toBeTruthy();
    back();
    expect(search()).toBe("?tab=binders");
  });

  it("opening a box and the whole stock are Back steps; the hunt tray shows only with a box open", () => {
    renderBinders("/collection?tab=inventory");
    expect(screen.queryByRole("region", { name: "Card hunt" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Show box, box,/ }));
    expect(search()).toBe("?tab=inventory&b=box-show");
    expect(screen.getByRole("region", { name: "Show box, open" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Card hunt" })).toBeTruthy();
    expect(document.title).toBe("Inventory · Show box · Collection");
    back();
    expect(search()).toBe("?tab=inventory");
    fireEvent.click(screen.getByRole("button", { name: /^Everything for sale, \d+ cards? for sale$/ }));
    expect(search()).toBe("?tab=inventory&sale=1");
    expect(screen.getByRole("region", { name: "Show box, for sale" })).toBeTruthy();
    back();
    expect(screen.getByRole("list", { name: "Your boxes" })).toBeTruthy();
  });

  it("a box's hunt moves a card in from a binder, and says it is for sale there", async () => {
    renderBinders("/collection?tab=inventory&b=box-show");
    fireEvent.change(screen.getByRole("searchbox", { name: "Hunt for one of your cards" }), { target: { value: "jim kelly" } });
    fireEvent.click(screen.getByRole("button", { name: /^Move here: / }));
    await waitFor(() =>
      expect(screen.getAllByRole("status").some((s) => /^Moved #12 Jim Kelly from '96 Contenders to Show box\.$/.test(s.textContent ?? ""))).toBe(true),
    );
  });
});

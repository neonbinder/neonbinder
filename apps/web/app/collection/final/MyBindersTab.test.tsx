import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { Theme } from "@radix-ui/themes";
import FinalCollectionPage from "./FinalCollectionPage";

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
          <Route path="/inventory" element={<p>Inventory page</p>} />
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
    const box = within(special).getByRole("link", { name: "Inventory, 6 cards for sale" });
    expect(box.getAttribute("href")).toBe("/inventory");

    const mine = screen.getByRole("list", { name: "Your binders" });
    const spines = within(mine).getAllByRole("button");
    expect(spines[0].getAttribute("aria-label")).toMatch(/^Main,/);
    expect(within(mine).queryByRole("button", { name: /^All my cards,/ })).toBeNull();
    expect(within(mine).queryByRole("button", { name: /^Want List,/ })).toBeNull();
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

  it("a want for a binder opens the add form with that binder ticked, not Main", () => {
    renderBinders("/collection?tab=binders&b=binder-want");
    fireEvent.click(screen.getByRole("button", { name: /^Next pages?$/ }));
    expect(screen.getByRole("group", { name: /^Page 2, For Ohtani rainbow/ })).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: /, need\. Add it$/ })[0]);
    });
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByRole("checkbox", { name: "Ohtani rainbow" }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole("checkbox", { name: "Main" }) as HTMLInputElement).checked).toBe(false);
  });

  it("an unscoped want still opens the add form on Main", () => {
    renderBinders("/collection?tab=binders&b=binder-want");
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: /, need\. Add it$/ })[0]);
    });
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByRole("checkbox", { name: "Main" }) as HTMLInputElement).checked).toBe(true);
  });

  it("while the Want List is open, the hunt adds a want, never a filed copy", () => {
    renderBinders("/collection?tab=binders&b=binder-want");
    const search = screen.getByRole("searchbox", { name: "Hunt for a card you want" });
    fireEvent.change(search, { target: { value: "96 contenders reggie white" } });
    const want = screen.getAllByRole("button", { name: /^Want / })[0];
    fireEvent.click(want);
    expect(
      screen.getAllByRole("status").some((s) => /is on your Want List/.test(s.textContent ?? "")),
    ).toBe(true);
  });

  it("Enter in the hunt asks when two cards fit instead of taking the first", () => {
    renderBinders("/collection?tab=binders&all=1");
    const search = screen.getByRole("searchbox", { name: "Hunt for one of your cards" });
    fireEvent.change(search, { target: { value: "1" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getAllByRole("status").some((s) => /we won't guess/.test(s.textContent ?? ""))).toBe(true);
    expect(screen.queryByRole("group", { name: /^Where should/ })).toBeNull();
  });

  it("Share shows a human-readable link and who can see it", () => {
    renderBinders("/collection?tab=binders&b=binder-ohtani-rainbow");
    fireEvent.click(screen.getByRole("button", { name: "Share Ohtani rainbow" }));
    expect(screen.getByText("neonbinder.io/@jason/binders/ohtani-rainbow")).toBeTruthy();
    expect(screen.getByText("Anyone with the link can see it. Only you can change it.")).toBeTruthy();
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

  it("Move here moves your one copy into the open binder, naming both, with Undo", () => {
    renderBinders("/collection?tab=binders&b=binder-slab-case");
    fireEvent.change(hunt(), { target: { value: "jim kelly" } });
    fireEvent.click(screen.getByRole("button", { name: /^Move here: 1996 Playoff Contenders #12 Jim Kelly/ }));
    expect(statusSays(/^Moved #12 Jim Kelly from '96 Contenders to Slab case\.$/)).toBe(true);
    expect(screen.getByRole("button", { name: "Find #12 Jim Kelly in Slab case" })).toBeTruthy();
    // Nothing left to move here, so only Add another is offered.
    expect(screen.queryByRole("button", { name: /^Move here: .*#12 Jim Kelly/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Find #12 Jim Kelly in '96 Contenders, page 2, pocket 3" })).toBeTruthy();
  });

  it("with more than one copy, Move here asks which", () => {
    renderBinders("/collection?tab=binders&b=binder-slab-case");
    fireEvent.change(hunt(), { target: { value: "96 contenders favre" } });
    fireEvent.click(screen.getByRole("button", { name: /^Move here: 1996 Playoff Contenders #1 Brett Favre/ }));
    const which = screen.getByRole("group", { name: "Which #1 Brett Favre moves to Slab case?" });
    const choices = within(which).getAllByRole("button", { name: /^Move .* to Slab case$/ });
    expect(choices).toHaveLength(2);
    fireEvent.click(within(which).getByRole("button", { name: /Up for Trade to Slab case$/ }));
    expect(statusSays(/^Moved #1 Brett Favre from Up for Trade to Slab case\.$/)).toBe(true);
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
    expect(screen.getByRole("button", { name: "Red Wings, smart binder, 12 have, 8 need" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Slab case, 4 cards" })).toBeTruthy();
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

describe("Print this label", () => {
  it("links the cover to the Print Shop with the binder's name, colors and face", () => {
    renderBinders("/collection?tab=binders&b=smart-reggie-white");
    const link = screen.getAllByRole("link", { name: "Print label for All Reggie White" })[0];
    expect(link.getAttribute("href")).toBe("/print/spine-label?name=All+Reggie+White&bg=203731&fg=ffb612&font=anton");
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
});


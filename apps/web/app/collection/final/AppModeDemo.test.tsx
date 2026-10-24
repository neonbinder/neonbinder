import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Theme } from "@radix-ui/themes";
import CollectionPage from "../page";
import FinalCollectionPage from "./FinalCollectionPage";

// NEO-356: the demo bar's theme switch asks Clerk who is looking (signed in here).
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true }) }));

/**
 * NEO-358 — the Convex client, standing in for a signed-in collector whose
 * reads are still loading. Every query answers `undefined`; every mutation is
 * a spy that carries `withOptimisticUpdate`. No test here reaches a server.
 */
vi.mock("convex/react", () => {
  const mutation = () => {
    const fn = Object.assign(vi.fn(async () => null), {
      withOptimisticUpdate: () => fn,
    });
    return fn;
  };
  return {
    useQuery: () => undefined,
    useQueries: () => ({}),
    usePaginatedQuery: () => ({ results: [], status: "LoadingFirstPage", isLoading: true, loadMore: () => {} }),
    useMutation: () => mutation(),
  };
});

function renderAt(start: string, element = <CollectionPage />) {
  return render(
    <Theme>
      <MemoryRouter initialEntries={[start]}>
        <Routes>
          <Route path="/collection" element={element} />
        </Routes>
      </MemoryRouter>
    </Theme>,
  );
}

const sections = () => screen.getByRole("navigation", { name: "Collection sections" });

beforeEach(() => {
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("signed-in /collection runs on the real collection", () => {
  it("shows My Cards, My Binders and Checklists, and none of the demo's chrome", () => {
    renderAt("/collection");
    const tabs = within(sections()).getAllByRole("link").map((l) => l.textContent);
    expect(tabs).toEqual(["My Cards", "My Binders", "Checklists"]);
    expect(screen.queryByRole("region", { name: "About this demo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset demo data" })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Demo theme" })).toBeNull();
    expect(document.title).toBe("My Cards · Collection");
  });

  it("offers the Binder picker, waiting (disabled) while the shelf loads", () => {
    renderAt("/collection");
    expect((screen.getByRole("combobox", { name: "Binder" }) as HTMLSelectElement).disabled).toBe(true);
  });

  it("opens My Binders for a My Binders link", () => {
    renderAt("/collection?tab=binders");
    expect(within(sections()).getByRole("link", { name: "My Binders" }).getAttribute("aria-current")).toBe("page");
    expect(within(sections()).getByRole("link", { name: "My Cards" }).getAttribute("aria-current")).toBeNull();
  });
});

/**
 * The demo store mounted in app mode: what a unit test gets from
 * `<FinalCollectionPage />` with no provider. Production never shows this
 * (the demo is public-only), but the app-mode copy paths stay covered.
 */
describe("the demo store in app mode", () => {
  it("shows the demo bar with Reset, and no sign-up or tour exits", () => {
    renderAt("/collection", <FinalCollectionPage />);
    const bar = screen.getByRole("region", { name: "About this demo" });
    expect(within(bar).getByText("Demo binder")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Reset demo data" })).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "Sign up free" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to the tour" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Leave the demo" })).toBeNull();
    // An ordinary page of the app: the bar does not grab focus.
    expect(document.activeElement).not.toBe(bar);
    expect(bar.hasAttribute("tabindex")).toBe(false);
    expect(within(sections()).getAllByRole("link").map((l) => l.textContent)).toEqual([
      "My Cards",
      "My Binders",
      "Checklists",
    ]);
  });

  it("Reset in the bar puts the starting stack back", () => {
    renderAt("/collection?tab=binders", <FinalCollectionPage />);
    fireEvent.click(screen.getByRole("button", { name: "Reset demo data" }));
    expect(screen.getAllByRole("status").some((s) => s.textContent === "Back to the starting stack.")).toBe(true);
  });

  it("a card request says it stays on the page, never that an admin will review it", () => {
    renderAt("/collection?tab=checklists", <FinalCollectionPage />);
    fireEvent.click(screen.getByRole("button", { name: "Can't find it? Ask us to add it" }));
    const dialog = screen.getByRole("dialog", { name: "Ask us to add a card" });
    expect(
      within(dialog).getByText(
        "Tell us what you've got. These binders are a demo, so for now your request stays on the list below.",
      ),
    ).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("Player"), { target: { value: "Reggie White" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
    expect(
      within(dialog).getByText("Got it! This is the demo, so it stays right here on the list."),
    ).toBeTruthy();
    expect(within(dialog).getByText("Demo request · only you can see it")).toBeTruthy();
    expect(within(dialog).queryByText(/admin|review/i)).toBeNull();
  });
});

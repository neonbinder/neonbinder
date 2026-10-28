import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Theme } from "@radix-ui/themes";
import PublicCollectionDemo from "./PublicCollectionDemo";
import { initialCollectionState } from "./store";

/**
 * NEO-377 — a copy line's photos in the drawer, on the public demo (fixture
 * data; the Convex client is mocked EMPTY). Photos opens a panel under the
 * line; Add front / Add back take a file, resized in the browser (mocked
 * here: jsdom has no canvas), and show on the line; Remove takes one off;
 * Escape and Done hand the keyboard back to the line's Photos button.
 */
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));
vi.mock("convex/react", () => ({}));
vi.mock("@/lib/collection/copy-photo-resize", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resizeCopyPhoto: vi.fn(async (file: File) => {
    if (file.type === "text/plain") throw new Error("That file isn't a photo this browser can open. Try a JPG or PNG.");
    return {
      contentType: "image/jpeg",
      image: new Blob(["image"], { type: "image/jpeg" }),
      thumb: new Blob(["thumb"], { type: "image/jpeg" }),
    };
  }),
}));

const DEMO = "/binder-tracking?demo=on";
const STACK = initialCollectionState().copies.find((c) => c.quantity === 3)!;

function renderDrawer() {
  render(
    <Theme>
      <MemoryRouter initialEntries={[`${DEMO}&tab=cards&detail=${STACK.cardId}`]}>
        <Routes>
          <Route path="/binder-tracking" element={<PublicCollectionDemo onExit={vi.fn()} keepParams={{ demo: "on" }} />} />
        </Routes>
      </MemoryRouter>
    </Theme>,
  );
  return screen.getByRole("dialog");
}

const photosButton = (drawer: HTMLElement) =>
  within(drawer)
    .getAllByRole("button", { name: /^Photos, / })
    .find((b) => b.getAttribute("data-copy-photos") === STACK.id)!;
const panelOf = (drawer: HTMLElement) => within(drawer).getByRole("region", { name: /^Photos of / });
const pickFile = (drawer: HTMLElement, side: "front" | "back", file: File) => {
  const input = drawer.querySelector<HTMLInputElement>(`[data-copy-photo-input="${side}"]`)!;
  fireEvent.change(input, { target: { files: [file] } });
};
const jpeg = () => new File(["x"], "card.jpg", { type: "image/jpeg" });

let n = 0;
beforeEach(() => {
  window.sessionStorage.clear();
  n = 0;
  URL.createObjectURL = vi.fn(() => `blob:demo-${++n}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("a copy line's photos", () => {
  it("adds a front, shows it on the line, replaces it, and removes it", async () => {
    const drawer = renderDrawer();
    const button = photosButton(drawer);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const panel = panelOf(drawer);
    // The keyboard lands on the first control.
    expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "Add front" }));
    expect(within(panel).getByText("No front photo yet")).toBeTruthy();

    await act(async () => pickFile(drawer, "front", jpeg()));
    await waitFor(() => expect(within(panel).getByRole("status").textContent).toBe("Front photo saved."));
    expect(within(panel).getByRole("link", { name: /^Front of .+, full size/ }).getAttribute("href")).toBe("blob:demo-1");
    expect(within(drawer).getByRole("img", { name: /^Front of / }).getAttribute("src")).toBe("blob:demo-2");

    await act(async () => pickFile(drawer, "front", jpeg()));
    await waitFor(() =>
      expect(within(panel).getByRole("link", { name: /^Front of / }).getAttribute("href")).toBe("blob:demo-3"),
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:demo-1");

    fireEvent.click(within(panel).getByRole("button", { name: "Remove front" }));
    await waitFor(() => expect(within(panel).getByRole("status").textContent).toBe("Front photo removed."));
    expect(within(drawer).queryByRole("img", { name: /^Front of / })).toBeNull();
    // Remove unmounts itself; the keyboard lands on Add front, still inside the panel.
    expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "Add front" }));
  });

  it("a back alone shows on the line, and a file that isn't a photo says so", async () => {
    const drawer = renderDrawer();
    fireEvent.click(photosButton(drawer));
    const panel = panelOf(drawer);
    await act(async () => pickFile(drawer, "back", new File(["x"], "notes.txt", { type: "text/plain" })));
    await waitFor(() => expect(within(panel).getByRole("alert").textContent).toMatch(/isn't a photo/));
    await act(async () => pickFile(drawer, "back", jpeg()));
    await waitFor(() => expect(within(drawer).getByRole("img", { name: /^Back of / })).toBeTruthy());
    expect(within(panel).queryByRole("alert")).toBeNull();
  });

  it("Escape and Done close the panel and give the keyboard back to Photos", async () => {
    const drawer = renderDrawer();
    fireEvent.click(photosButton(drawer));
    fireEvent.keyDown(panelOf(drawer), { key: "Escape" });
    expect(within(drawer).queryByRole("region", { name: /^Photos of / })).toBeNull();
    expect(document.activeElement).toBe(photosButton(drawer));
    fireEvent.click(photosButton(drawer));
    fireEvent.click(within(panelOf(drawer)).getByRole("button", { name: "Done" }));
    expect(document.activeElement).toBe(photosButton(drawer));
  });

  it("Photos and Move never stand open under a line together", () => {
    const drawer = renderDrawer();
    const move = within(drawer)
      .getAllByRole("button", { name: /^Move / })
      .find((b) => b.getAttribute("data-copy-move") === STACK.id);
    if (!move) throw new Error("the fixture line has no Move button");
    fireEvent.click(move);
    fireEvent.click(photosButton(drawer));
    expect(move.getAttribute("aria-expanded")).toBe("false");
    expect(photosButton(drawer).getAttribute("aria-controls")).toBe(panelOf(drawer).id);
    fireEvent.click(move);
    expect(within(drawer).queryByRole("region", { name: /^Photos of / })).toBeNull();
  });
});

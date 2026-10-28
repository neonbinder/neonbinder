import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Theme } from "@radix-ui/themes";
import PublicCollectionDemo from "./PublicCollectionDemo";
import { initialCollectionState } from "./store";
import { sidesForDrop } from "./CopyPhotosField";

/**
 * NEO-377 — a copy line's photos live in the line's Edit form, on the public
 * demo (fixture data; the Convex client is mocked EMPTY). Add front / Add
 * back take a file, resized in the browser (mocked here: jsdom has no
 * canvas), and show on the line and on the card itself; Remove takes one
 * off; Swap trades them; dropped files go front first, then back.
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

/** Opens the stack's Edit form and returns its photo box. */
function openPhotos(drawer: HTMLElement) {
  const edit = drawer.querySelector<HTMLButtonElement>(`[data-copy-edit="${STACK.id}"]`)!;
  fireEvent.click(edit);
  return within(drawer).getByRole("region", { name: "Photos" });
}
const pickFile = (drawer: HTMLElement, side: "front" | "back", file: File) => {
  const input = drawer.querySelector<HTMLInputElement>(`[data-copy-photo-input="${side}"]`)!;
  fireEvent.change(input, { target: { files: [file] } });
};
const jpeg = (name = "card.jpg") => new File(["x"], name, { type: "image/jpeg" });

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

describe("a copy line's photos, in its Edit form", () => {
  it("adds a front, shows it on the line and as the card, replaces it, and removes it", async () => {
    const drawer = renderDrawer();
    const box = openPhotos(drawer);
    expect(within(box).getByText("No front photo yet")).toBeTruthy();

    await act(async () => pickFile(drawer, "front", jpeg()));
    await waitFor(() => expect(within(box).getByRole("status").textContent).toBe("Front photo saved."));
    expect(within(box).getByRole("link", { name: /^Front of .+, full size/ }).getAttribute("href")).toBe("blob:demo-1");
    // The card itself is drawn from the photo now (its thumbnail).
    const face = drawer.querySelector(".nb-card img");
    expect(face?.getAttribute("src")).toBe("blob:demo-2");

    await act(async () => pickFile(drawer, "front", jpeg()));
    await waitFor(() =>
      expect(within(box).getByRole("link", { name: /^Front of / }).getAttribute("href")).toBe("blob:demo-3"),
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:demo-1");

    fireEvent.click(within(box).getByRole("button", { name: "Remove front" }));
    await waitFor(() => expect(within(box).getByRole("status").textContent).toBe("Front photo removed."));
    // Remove unmounts itself; the keyboard lands on Add front, still in the form.
    expect(document.activeElement).toBe(within(box).getByRole("button", { name: "Add front" }));
    expect(drawer.querySelector(".nb-card img")).toBeNull();
  });

  it("a file that isn't a photo says so; Swap trades front and back", async () => {
    const drawer = renderDrawer();
    const box = openPhotos(drawer);
    await act(async () => pickFile(drawer, "back", new File(["x"], "notes.txt", { type: "text/plain" })));
    await waitFor(() => expect(within(box).getByRole("alert").textContent).toMatch(/isn't a photo/));
    await act(async () => pickFile(drawer, "back", jpeg()));
    await waitFor(() => expect(within(box).getByRole("link", { name: /^Back of / })).toBeTruthy());
    expect(within(box).queryByRole("alert")).toBeNull();

    fireEvent.click(within(box).getByRole("button", { name: "Swap front and back" }));
    await waitFor(() => expect(within(box).getByRole("status").textContent).toBe("Front and back swapped."));
    expect(within(box).getByRole("link", { name: /^Front of / })).toBeTruthy();
    expect(within(box).queryByRole("link", { name: /^Back of / })).toBeNull();
  });

  it("two files dropped on the box become the front and the back", async () => {
    const drawer = renderDrawer();
    const box = openPhotos(drawer);
    await act(async () => {
      fireEvent.drop(box, { dataTransfer: { files: [jpeg("a.jpg"), jpeg("b.jpg")], types: ["Files"], getData: () => "" } });
    });
    await waitFor(() => expect(within(box).getByRole("status").textContent).toBe("Front and back photos saved."));
    expect(within(box).getByRole("link", { name: /^Front of / })).toBeTruthy();
    expect(within(box).getByRole("link", { name: /^Back of / })).toBeTruthy();
  });
});

describe("sidesForDrop", () => {
  it("one file goes where it lands, else to the empty side; two go front then back", () => {
    expect(sidesForDrop(1, "back", undefined)).toEqual(["back"]);
    expect(sidesForDrop(1, null, undefined)).toEqual(["front"]);
    expect(sidesForDrop(1, null, { front: { imageUrl: "a", thumbUrl: "b" } })).toEqual(["back"]);
    expect(sidesForDrop(2, "back", undefined)).toEqual(["front", "back"]);
    expect(sidesForDrop(0, null, undefined)).toEqual([]);
  });
});

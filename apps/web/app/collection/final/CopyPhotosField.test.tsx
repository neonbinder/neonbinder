import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Theme } from "@radix-ui/themes";
import PublicCollectionDemo from "./PublicCollectionDemo";
import { initialCollectionState } from "./store";
import { HeldPhotosField, sidesForDrop, type HeldPhotos } from "./CopyPhotosField";

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
    if (file.type === "text/plain" || file.name.startsWith("unreadable")) {
      throw new Error("That file isn't a photo this browser can open. Try a JPG or PNG.");
    }
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

describe("files that can't be added", () => {
  it("a dropped file that isn't a photo is refused out loud, not lost", async () => {
    const drawer = renderDrawer();
    const box = openPhotos(drawer);
    const pdf = new File(["%PDF"], "list.pdf", { type: "application/pdf" });
    fireEvent.drop(box, { dataTransfer: { files: [pdf], types: ["Files"], getData: () => "" } });
    expect(within(box).getByRole("alert").textContent).toBe("Only photos can be added here.");
    expect(within(box).getByText("No front photo yet")).toBeTruthy();
  });

  it("a third photo dropped is left out, and says so", async () => {
    const drawer = renderDrawer();
    const box = openPhotos(drawer);
    await act(async () => {
      fireEvent.drop(box, {
        dataTransfer: { files: [jpeg("a.jpg"), jpeg("b.jpg"), jpeg("c.jpg")], types: ["Files"], getData: () => "" },
      });
    });
    await waitFor(() => expect(within(box).getByRole("link", { name: /^Back of / })).toBeTruthy());
    expect(within(box).getByRole("alert").textContent).toMatch(/Two photos at most/);
  });
});

/** The held box with its parent's state, and a window on what the parent holds. */
function renderHeld(props: Partial<React.ComponentProps<typeof HeldPhotosField>> = {}) {
  let held: HeldPhotos = {};
  function Parent() {
    const [files, setFiles] = useState<HeldPhotos>({});
    held = files;
    return (
      <HeldPhotosField
        files={files}
        onChange={setFiles}
        line="your new copy"
        accept="image/jpeg"
        help="Stashed here until you add the copy."
        {...props}
      />
    );
  }
  const view = render(<Parent />);
  const box = screen.getByRole("region", { name: "Photos" });
  const pick = (side: "front" | "back", file: File) =>
    fireEvent.change(box.querySelector<HTMLInputElement>(`[data-copy-photo-input="${side}"]`)!, {
      target: { files: [file] },
    });
  return { ...view, box, pick, held: () => held };
}

describe("held photos (NEO-431): nothing to save against yet", () => {
  it("says when they go up, never that they are already saved", () => {
    const { box } = renderHeld();
    expect(box.textContent).toContain("Stashed here until you add the copy.");
    expect(box.textContent).not.toContain("Saved as soon as");
    expect(box.querySelector<HTMLInputElement>('[data-copy-photo-input="front"]')?.accept).toBe("image/jpeg");
  });

  it("adds, replaces and removes from the parent's files, previews by object URL, and revokes each one", async () => {
    const { box, pick, held } = renderHeld();
    const first = jpeg("first.jpg");
    await act(async () => pick("front", first));
    expect(held().front).toBe(first);
    expect(within(box).getByRole("status").textContent).toBe("Front photo picked.");
    const link = within(box).getByRole("link", { name: "Front of your new copy, full size (opens a new tab)" });
    expect(link.getAttribute("href")).toBe("blob:demo-1");
    expect(link.querySelector("img")?.getAttribute("src")).toBe("blob:demo-1");

    const second = jpeg("second.jpg");
    await act(async () => pick("front", second));
    expect(held().front).toBe(second);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:demo-1");
    expect(within(box).getByRole("link", { name: /^Front of / }).getAttribute("href")).toBe("blob:demo-2");

    await act(async () => fireEvent.click(within(box).getByRole("button", { name: "Remove front" })));
    expect(held().front).toBeUndefined();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:demo-2");
    expect(within(box).getByText("No front photo yet")).toBeTruthy();
    expect(within(box).getByRole("status").textContent).toBe("Front photo removed.");
    // Remove unmounts itself; the keyboard lands on Add front.
    expect(document.activeElement).toBe(within(box).getByRole("button", { name: "Add front" }));
  });

  it("revokes what it still shows when it goes away", async () => {
    const { pick, unmount } = renderHeld();
    await act(async () => pick("back", jpeg()));
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:demo-1");
  });

  it("swaps from the keyboard and by dragging one photo onto the other", async () => {
    const { box, pick, held } = renderHeld();
    const a = jpeg("a.jpg");
    await act(async () => pick("front", a));
    await act(async () => fireEvent.click(within(box).getByRole("button", { name: "Swap front and back" })));
    expect(held()).toEqual({ back: a });
    expect(within(box).getByRole("status").textContent).toBe("Front and back swapped.");

    const b = jpeg("b.jpg");
    await act(async () => pick("front", b));
    const back = box.querySelector('[data-copy-photo-side="back"]')!;
    const front = box.querySelector('[data-copy-photo-side="front"]')!;
    let payload = "";
    const dataTransfer = {
      clearData: () => {},
      setData: (_type: string, value: string) => {
        payload = value;
      },
      getData: () => payload,
      types: ["application/x-neonbinder-photo-side"],
      files: [],
    };
    fireEvent.dragStart(within(box).getByRole("link", { name: /^Front of / }), { dataTransfer });
    await act(async () => fireEvent.drop(back, { dataTransfer }));
    expect(held()).toEqual({ front: a, back: b });
    // A drop on its own side does nothing.
    fireEvent.dragStart(within(box).getByRole("link", { name: /^Front of / }), { dataTransfer });
    await act(async () => fireEvent.drop(front, { dataTransfer }));
    expect(held()).toEqual({ front: a, back: b });
  });

  it("two dropped files become the front and the back; a third is left out out loud; one fills the empty side", async () => {
    const { box, held, pick } = renderHeld();
    const [a, b, c] = [jpeg("a.jpg"), jpeg("b.jpg"), jpeg("c.jpg")];
    await act(async () => {
      fireEvent.drop(box, { dataTransfer: { files: [a, b, c], types: ["Files"], getData: () => "" } });
    });
    expect(held()).toEqual({ front: a, back: b });
    expect(within(box).getByRole("alert").textContent).toMatch(/Two photos at most/);

    await act(async () => fireEvent.click(within(box).getByRole("button", { name: "Remove back" })));
    expect(within(box).queryByRole("alert")).toBeNull();
    await act(async () => {
      fireEvent.drop(box, { dataTransfer: { files: [c], types: ["Files"], getData: () => "" } });
    });
    expect(held()).toEqual({ front: a, back: c });
    await act(async () => pick("front", c));
    expect(held()).toEqual({ front: c, back: c });
  });

  it("refuses what isn't a photo, in its own alert, holding nothing", async () => {
    const { box, pick, held } = renderHeld();
    await act(async () => pick("front", new File(["x"], "notes.txt", { type: "text/plain" })));
    expect(within(box).getByRole("alert").textContent).toBe("Only photos can be added here.");
    expect(held()).toEqual({});
    await act(async () => {
      fireEvent.drop(box, {
        dataTransfer: { files: [new File(["%PDF"], "list.pdf", { type: "application/pdf" })], types: ["Files"], getData: () => "" },
      });
    });
    expect(within(box).getByRole("alert").textContent).toBe("Only photos can be added here.");
    expect(held()).toEqual({});
  });

  it("a caller's check turns away one file of two, saying why through onProblem; the other stays on its side", async () => {
    const onProblem = vi.fn();
    const check = (file: File) => (file.name.startsWith("big") ? "That photo is over 10 MB." : null);
    const { box, held } = renderHeld({ check, onProblem });
    const good = jpeg("good.jpg");
    await act(async () => {
      fireEvent.drop(box, { dataTransfer: { files: [jpeg("big.jpg"), good], types: ["Files"], getData: () => "" } });
    });
    expect(held()).toEqual({ back: good });
    expect(onProblem).toHaveBeenLastCalledWith("That photo is over 10 MB.");
    // The form's alert says it, not a second one in the box.
    expect(within(box).queryByRole("alert")).toBeNull();
  });

  it("takes no changes while the form uploads them", async () => {
    const onChange = vi.fn();
    const a = jpeg("a.jpg");
    render(
      <HeldPhotosField
        files={{ front: a }}
        onChange={onChange}
        line="your new copy"
        accept="image/jpeg"
        help="Stashed."
        saving="Saving your photos…"
      />,
    );
    const box = screen.getByRole("region", { name: "Photos" });
    await within(box).findByRole("link", { name: /^Front of / });
    expect(within(box).getByRole("status").textContent).toBe("Saving your photos…");
    const remove = within(box).getByRole("button", { name: "Remove front" });
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(remove);
    fireEvent.click(within(box).getByRole("button", { name: "Swap front and back" }));
    fireEvent.change(box.querySelector('[data-copy-photo-input="back"]')!, { target: { files: [jpeg("b.jpg")] } });
    expect(onChange).not.toHaveBeenCalled();
    expect(within(box).getByRole("alert").textContent).toMatch(/Still saving/);
  });
});

describe("the drawer's Add form holds photos (NEO-431)", () => {
  /** Opens the Add form under the stack's line. */
  function openAdd(drawer: HTMLElement) {
    fireEvent.click(within(drawer).getByRole("button", { name: /^Add another copy of / }));
    const form = within(drawer).getByRole("form", { name: "Add another copy" });
    return { form, box: within(form).getByRole("region", { name: "Photos" }) };
  }
  const pickIn = (box: HTMLElement, side: "front" | "back", file: File) =>
    fireEvent.change(box.querySelector<HTMLInputElement>(`[data-copy-photo-input="${side}"]`)!, { target: { files: [file] } });
  const lineCount = (drawer: HTMLElement) =>
    Number(/\((\d+) line/.exec(within(drawer).getByRole("heading", { name: /^Your copies/ }).textContent ?? "")?.[1] ?? 0);

  it("puts the keyboard on Quantity, never a file input, and says the photos wait", async () => {
    const drawer = renderDrawer();
    const { form, box } = openAdd(drawer);
    await waitFor(() => expect(document.activeElement).toBe(within(form).getByRole("spinbutton", { name: /^Quantity/ })));
    expect(box.textContent).toContain("Stashed here until you add the copy.");
  });

  it("an add with photos saves them on a new line, never stacked on its twin, and Undo takes the line away", async () => {
    const drawer = renderDrawer();
    const before = lineCount(drawer);
    // A plain add first: the twin the photo add must not stack on.
    const plain = openAdd(drawer);
    fireEvent.click(within(plain.form).getByRole("button", { name: "Add to collection" }));
    await waitFor(() => expect(lineCount(drawer)).toBe(before + 1));

    const { form, box } = openAdd(drawer);
    await act(async () => pickIn(box, "front", jpeg()));
    await act(async () => pickIn(box, "back", jpeg()));
    fireEvent.click(within(form).getByRole("button", { name: "Add to collection" }));
    await waitFor(() => expect(lineCount(drawer)).toBe(before + 2));
    await waitFor(() => expect(within(drawer).queryByRole("form", { name: "Add another copy" })).toBeNull());
    // The keyboard is back on Add, and the notice says the photos came with it.
    await waitFor(() =>
      expect(document.activeElement).toBe(within(drawer).getByRole("button", { name: /^Add another copy of / })),
    );
    expect(
      screen.getAllByRole("status").some((s) => /^Added .*, with its front and back photos\.$/.test(s.textContent ?? "")),
    ).toBe(true);
    // Its photos are on the new line.
    expect(within(drawer).getByRole("img", { name: /^Front of Raw/ })).toBeTruthy();

    // The form starts empty next time.
    const again = openAdd(drawer);
    expect(within(again.box).getByText("No front photo yet")).toBeTruthy();
    fireEvent.click(within(again.form).getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(lineCount(drawer)).toBe(before + 1));
    expect(within(drawer).queryByRole("img", { name: /^Front of Raw/ })).toBeNull();
  });

  it("the copy saves but a photo fails: the copy stays, its Edit form opens on the failure, the good photo stays", async () => {
    const drawer = renderDrawer();
    const before = lineCount(drawer);
    const { form, box } = openAdd(drawer);
    await act(async () => pickIn(box, "front", jpeg()));
    await act(async () => pickIn(box, "back", jpeg("unreadable.jpg")));
    fireEvent.click(within(form).getByRole("button", { name: "Add to collection" }));

    const edit = await within(drawer).findByRole("form", { name: /^Edit Raw/ });
    expect(lineCount(drawer)).toBe(before + 1);
    expect(within(drawer).queryByRole("form", { name: "Add another copy" })).toBeNull();
    const field = within(edit).getByRole("region", { name: "Photos" });
    expect(within(field).getByRole("alert").textContent).toMatch(/^Your copy is in, but the back photo didn't save\. .*Add it again here\.$/);
    expect(within(field).getByRole("link", { name: /^Front of / })).toBeTruthy();
    expect(within(field).getByText("No back photo yet")).toBeTruthy();
    expect(screen.getAllByRole("status").some((s) => /Its back photo didn't save\. Try again under Edit\.$/.test(s.textContent ?? ""))).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(within(field).getByRole("button", { name: "Add back" })));

    // Trying again there works, and clears the failure.
    await act(async () => pickIn(field, "back", jpeg()));
    await waitFor(() => expect(within(field).getByRole("status").textContent).toBe("Back photo saved."));
    expect(within(field).queryByRole("alert")).toBeNull();

    // Reopening the form later doesn't bring an old failure back.
    fireEvent.click(within(edit).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(within(drawer).queryByRole("form", { name: /^Edit Raw/ })).toBeNull());
    const lineEdit = within(drawer).getAllByRole("button", { name: /^Edit / }).at(-1)!;
    fireEvent.click(lineEdit);
    const reopened = await within(drawer).findByRole("form", { name: /^Edit Raw/ });
    expect(within(reopened).queryByRole("alert")).toBeNull();
  });

  it("Cancel throws the held photos away", async () => {
    const drawer = renderDrawer();
    const { form, box } = openAdd(drawer);
    await act(async () => pickIn(box, "front", jpeg()));
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    const again = openAdd(drawer);
    expect(within(again.box).getByText("No front photo yet")).toBeTruthy();
    expect(within(again.box).getByRole("status").textContent).toBe("");
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

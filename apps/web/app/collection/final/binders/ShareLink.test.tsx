/**
 * NEO-360 — the Share panel's states: the demo's example, and the real
 * collection's link with its Private / Public choice (and no public name yet).
 */

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";
import ShareLink from "./ShareLink";
import { containerShareTarget } from "./model";
import {
  CollectionStoreContext,
  type CollectionStoreValue,
  type Container,
  type ShareProfile,
  type SharingExtension,
} from "../data/store";
import { REAL_CAPABILITIES } from "../data/types";

const BINDER: Container = {
  id: "c1",
  kind: "binder",
  name: "Ohtani rainbow",
  count: { copies: 1, lines: 1 },
  slug: "ohtani-rainbow",
};

function sharingWith(profile: ShareProfile | undefined): SharingExtension {
  return {
    useShareProfile: () => profile,
    ensureLink: vi.fn(async () => ({ slug: "ohtani-rainbow" })),
    setSlug: vi.fn(async (_c, slug: string) => ({ slug })),
    setVisibility: vi.fn(async () => undefined),
    setShelfVisibility: vi.fn(async () => undefined),
  };
}

function renderWith(container: Container, sharing?: SharingExtension) {
  const store = {
    kind: sharing ? "convex" : "demo",
    capabilities: REAL_CAPABILITIES,
    data: {},
    actions: {},
    sharing,
  } as unknown as CollectionStoreValue;
  const wrap = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>
      <CollectionStoreContext.Provider value={store}>{children}</CollectionStoreContext.Provider>
    </MemoryRouter>
  );
  const target = containerShareTarget(container)!;
  render(<ShareLink target={target} />, { wrapper: wrap });
  fireEvent.click(screen.getByRole("button", { name: `Share ${target.what}` }));
}

const choice = (name: "Private" | "Public") => screen.getByRole("radio", { name: new RegExp(`^${name}`) }) as HTMLInputElement;

const ME: ShareProfile = { username: "ace", tradePublic: true, forSalePublic: true };

describe("ShareLink", () => {
  it("demo: an example link at /u/you, and says it is an example", () => {
    renderWith(BINDER);
    expect(screen.getByText("neonbinder.io/u/you/binders/ohtani-rainbow")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("a private binder: Private is picked, and the link is plain, the username and the link name", () => {
    const sharing = sharingWith(ME);
    renderWith(BINDER, sharing);
    expect(screen.getByRole("group", { name: "Who can see this binder" })).toBeTruthy();
    expect(choice("Private").checked).toBe(true);
    expect(choice("Public").checked).toBe(false);
    expect(screen.getByText(/Nobody else can open the link below/)).toBeTruthy();
    expect(screen.getByText(`${window.location.origin}/u/ace/binders/ohtani-rainbow`)).toBeTruthy();
    fireEvent.click(choice("Public"));
    expect(sharing.setVisibility).toHaveBeenCalledWith(BINDER, true);
    // It moves on the press, before the server answers.
    expect(choice("Public").checked).toBe(true);
  });

  it("a public binder: Public is picked, and says what visitors never see", () => {
    renderWith({ ...BINDER, isPublic: true }, sharingWith(ME));
    expect(choice("Public").checked).toBe(true);
    expect(screen.getByText(/Never what you paid/)).toBeTruthy();
  });

  it("edits the readable part; Enter saves it", async () => {
    const sharing = sharingWith(ME);
    renderWith(BINDER, sharing);
    const input = screen.getByLabelText("Link name");
    fireEvent.change(input, { target: { value: "shohei gold" } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });
    expect(sharing.setSlug).toHaveBeenCalledWith(BINDER, "shohei gold");
    expect(screen.getByRole("status").textContent).toBe("Link name saved. The old link no longer works.");
    // The field shows what was saved, in place: no remount, so focus stays.
    expect((input as HTMLInputElement).value).toBe("shohei-gold");
    expect(screen.getByLabelText("Link name")).toBe(input);
  });

  it("a link name already in use: the refusal is announced and the field points at it", async () => {
    const sharing = sharingWith(ME);
    sharing.setSlug = vi.fn(async () => {
      throw new Error("Another of your binders already uses taken. Pick a different link name.");
    });
    renderWith(BINDER, sharing);
    const input = screen.getByLabelText("Link name");
    fireEvent.change(input, { target: { value: "taken" } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Another of your binders already uses taken. Pick a different link name.");
    expect(input.getAttribute("aria-describedby")).toContain(alert.id);
    expect((input as HTMLInputElement).value).toBe("taken");
  });

  it("a refused Private / Public press puts the choice back and says why", async () => {
    const sharing = sharingWith(ME);
    sharing.setVisibility = vi.fn(async () => {
      throw new Error("Couldn't save that. Try again.");
    });
    renderWith(BINDER, sharing);
    await act(async () => {
      fireEvent.click(choice("Public"));
    });
    await waitFor(() => expect(choice("Private").checked).toBe(true));
    expect(screen.getByRole("alert").textContent).toBe("Couldn't save that. Try again.");
  });

  it("a press while a write is out is ignored, and the choices stay focusable", async () => {
    const sharing = sharingWith(ME);
    let settle: () => void = () => {};
    sharing.setVisibility = vi.fn(() => new Promise<undefined>((resolve) => (settle = () => resolve(undefined))));
    renderWith(BINDER, sharing);
    fireEvent.click(choice("Public"));
    const group = screen.getByRole("group", { name: "Who can see this binder" });
    expect(group.getAttribute("aria-disabled")).toBe("true");
    expect(choice("Private").disabled).toBe(false);
    fireEvent.click(choice("Private"));
    expect(sharing.setVisibility).toHaveBeenCalledTimes(1);
    await act(async () => settle());
  });

  it("refuses a malformed readable part before asking the server", () => {
    const sharing = sharingWith(ME);
    renderWith(BINDER, sharing);
    fireEvent.change(screen.getByLabelText("Link name"), { target: { value: "no/slashes" } });
    expect(screen.getByText(/lowercase letters, numbers and single hyphens/)).toBeTruthy();
    // Off but focusable, so focus is never dropped.
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("a binder made before share links gets its link minted on open", () => {
    const sharing = sharingWith(ME);
    const old = { ...BINDER, slug: undefined };
    renderWith(old, sharing);
    expect(sharing.ensureLink).toHaveBeenCalledWith(old);
  });

  it("a link that can't be minted says why", async () => {
    const sharing = sharingWith(ME);
    sharing.ensureLink = vi.fn(async () => {
      throw new Error("Couldn't make the link.");
    });
    renderWith({ ...BINDER, slug: undefined }, sharing);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Couldn't make the link."));
    expect(screen.getByText("Making your link…")).toBeTruthy();
  });

  it("tabbing out of the panel closes it", () => {
    renderWith(BINDER, sharingWith(ME));
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const share = screen.getByRole("button", { name: "Share Ohtani rainbow" });
    expect(share.getAttribute("aria-expanded")).toBe("true");
    fireEvent.blur(screen.getByLabelText("Link name"), { relatedTarget: outside });
    expect(share.getAttribute("aria-expanded")).toBe("false");
    outside.remove();
  });

  it("no public name yet: says so and links to the profile", () => {
    renderWith(BINDER, sharingWith({ username: null, tradePublic: true, forSalePublic: true }));
    expect(screen.getByText(/needs a public name/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Pick a public name" }).getAttribute("href")).toBe("/profile");
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("Up for Trade is public by default; its choice is the profile's", () => {
    const sharing = sharingWith(ME);
    renderWith({ id: "t", kind: "binder", system: "trade", name: "Up for Trade", count: null }, sharing);
    expect(choice("Public").checked).toBe(true);
    expect(screen.getByText(`${window.location.origin}/u/ace/up-for-trade`)).toBeTruthy();
    fireEvent.click(choice("Private"));
    expect(sharing.setShelfVisibility).toHaveBeenCalledWith("trade", false);
    expect(screen.queryByLabelText("Link name")).toBeNull();
  });

  it("the Want List starts private and has no link name to edit", () => {
    renderWith({ id: "w", kind: "binder", system: "want", name: "Want List", count: null }, sharingWith(ME));
    expect(choice("Private").checked).toBe(true);
    expect(screen.getByText(`${window.location.origin}/u/ace/want-list`)).toBeTruthy();
    expect(screen.queryByLabelText("Link name")).toBeNull();
  });
});

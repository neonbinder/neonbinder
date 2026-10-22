/**
 * The mobile menu is a modal dialog (ui-audit 2026-10). It used to be a bare
 * fixed `<div>`: focus stayed on the header toggle underneath the panel,
 * Escape did nothing, and Tab walked into the page behind it. These cases pin
 * the keyboard contract the component header describes.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("@clerk/clerk-react", () => ({
  useUser: () => ({ user: { publicMetadata: {} }, isLoaded: true }),
}));

import MobileNav from "./mobile-nav";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <MemoryRouter initialEntries={["/collection"]}>
      <button type="button" onClick={() => setOpen(true)}>
        Open menu
      </button>
      {open && <MobileNav onClose={() => setOpen(false)} />}
    </MemoryRouter>
  );
}

function openMenu() {
  render(<Harness />);
  const toggle = screen.getByRole("button", { name: "Open menu" });
  toggle.focus();
  fireEvent.click(toggle);
  return toggle;
}

describe("MobileNav", () => {
  it("opens as a named modal dialog with focus on the current page's link", () => {
    openMenu();
    const dialog = screen.getByRole("dialog", { name: "Menu" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(
      screen.getByRole("link", { name: "Collection" }),
    );
  });

  it("makes the page behind it inert while open, and releases it on close", () => {
    const toggle = openMenu();
    expect(toggle.closest("[inert]")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(toggle.closest("[inert]")).toBeNull();
  });

  it("closes on Escape and returns focus to the toggle", () => {
    const toggle = openMenu();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it("traps Tab inside the panel", () => {
    openMenu();
    const dialog = screen.getByRole("dialog");
    const close = screen.getByRole("button", { name: "Close menu" });
    const links = screen.getAllByRole("link");
    const last = links[links.length - 1];

    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

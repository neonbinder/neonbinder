/**
 * NEO-172 — the account menu's custom items.
 *
 * `<UserButton.Link>` is configuration, not markup: Clerk reads the children of
 * `<UserButton>` and renders the menu itself, inside a popover that only opens
 * after a click on Clerk's own avatar. So no unit render and no Maestro flow
 * sees this link unless Clerk is live, and deleting it (or fat-fingering the
 * href) fails nothing anywhere.
 *
 * These cases assert the DECLARATION instead — that the header still asks Clerk
 * for an "API Keys" item pointing at /profile/api-keys. That is the whole of
 * what this file controls; whether Clerk then draws it is Clerk's contract.
 */

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

// Clerk's real components need a provider and a network. These stubs mirror
// only the shape the header uses: <SignedIn> renders its children (the signed
// -in branch is the one with the menu), <UserButton> renders its children so
// the declared menu items land in the tree, and <UserButton.Link> renders as an
// anchor so the assertions can read the label and href the way Clerk will.
vi.mock("@clerk/clerk-react", () => {
  const UserButton = ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="user-button">{children}</div>
  );
  UserButton.MenuItems = ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="user-button-menu">{children}</div>
  );
  UserButton.Link = ({
    label,
    href,
    labelIcon,
  }: {
    label: string;
    href: string;
    labelIcon?: React.ReactNode;
  }) => (
    <a href={href}>
      {labelIcon}
      {label}
    </a>
  );
  return {
    UserButton,
    SignedIn: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    SignedOut: () => null,
    SignInButton: () => null,
    useAuth: () => ({ isSignedIn: true, signOut: vi.fn() }),
  };
});

import BinderHeader from "./binder-header";

function renderHeader() {
  render(
    <MemoryRouter>
      <BinderHeader isMobileMenuOpen={false} onMobileMenuToggle={() => {}} />
    </MemoryRouter>,
  );
}

describe("BinderHeader account menu", () => {
  it("offers API Keys in the account menu, pointing at the page", () => {
    renderHeader();
    const link = screen.getByRole("link", { name: "API Keys" });
    expect(link.getAttribute("href")).toBe("/profile/api-keys");
  });

  it("hides the item's icon from assistive tech", () => {
    renderHeader();
    // Clerk requires `labelIcon` and renders it beside the label. Exposed, it
    // would be read as part of the item's name.
    const icon = screen
      .getByRole("link", { name: "API Keys" })
      .querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import PrivacyPage, { PRIVACY_CONTACT_EMAIL } from "./page";

/**
 * NEO-421 — the public privacy policy renders signed out with no backend.
 * Convex and Clerk are mocked empty, so any use of either would throw.
 */
vi.mock("convex/react", () => ({}));
vi.mock("@clerk/clerk-react", () => ({}));

afterEach(cleanup);

function renderPrivacy() {
  render(
    <MemoryRouter initialEntries={["/privacy"]}>
      <Routes>
        <Route path="/privacy" element={<PrivacyPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("PrivacyPage", () => {
  it("renders without Convex, with a single h1 'Privacy Policy'", () => {
    renderPrivacy();
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe("Privacy Policy");
  });

  it("names the contact address and links to it by email", () => {
    expect(PRIVACY_CONTACT_EMAIL).toBe("support@neonbinder.io");
    renderPrivacy();
    const contact = within(screen.getByRole("region", { name: "Contact us" }));
    const link = contact.getByRole("link", { name: "support@neonbinder.io" });
    expect(link.getAttribute("href")).toBe("mailto:support@neonbinder.io");
  });

  it("shows the last-updated date", () => {
    renderPrivacy();
    expect(screen.getByText("November 2, 2026").getAttribute("datetime")).toBe("2026-11-02");
  });

  it("covers eBay and lets the visitor jump to each section", () => {
    renderPrivacy();
    screen.getByRole("heading", { level: 2, name: "eBay" });
    const nav = within(screen.getByRole("navigation", { name: "Policy sections" }));
    expect(nav.getByRole("link", { name: "eBay" }).getAttribute("href")).toBe("#ebay");
  });
});

/**
 * NEO-128 — /profile's section nav.
 *
 * The nav is the whole reason the sections can live on separate routes, and it
 * is the one part of the split that no Maestro flow exercises: the flows all
 * deep-link straight to a sub-route (that being the point — a page-height-
 * independent path to "Test Credentials"), so nothing else would catch the nav
 * losing a link or ceasing to mark the current section.
 *
 * `aria-current="page"` is the assertion that matters. It is the only thing
 * telling a screen reader user which of the four sections they are on — the
 * colour change carries that information for everyone else.
 */

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

// The layout holds every section's query open to keep them warm across section
// changes (see useWarmProfileQueries). Those subscriptions need a Convex
// provider that does not exist in a unit render, so stub the hook — the warming
// behaviour is a runtime concern, not what these cases are about.
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}));

import ProfileLayout from "./profile-layout";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/profile" element={<ProfileLayout />}>
          <Route path="public" element={<div>public panel</div>} />
          <Route path="credentials" element={<div>credentials panel</div>} />
          <Route path="shipping" element={<div>shipping panel</div>} />
          <Route path="postage" element={<div>postage panel</div>} />
          <Route path="prizes" element={<div>prizes panel</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProfileLayout", () => {
  it("links to every section", () => {
    renderAt("/profile/public");
    const nav = screen.getByRole("navigation", { name: "Profile sections" });
    expect(
      Array.from(nav.querySelectorAll("a")).map((a) => [
        a.textContent,
        a.getAttribute("href"),
      ]),
    ).toEqual([
      ["Public Profile", "/profile/public"],
      ["Credentials", "/profile/credentials"],
      ["Shipping", "/profile/shipping"],
      ["Postage", "/profile/postage"],
      ["Prize Pool", "/profile/prizes"],
    ]);
  });

  it.each([
    ["/profile/public", "Public Profile"],
    ["/profile/credentials", "Credentials"],
    ["/profile/shipping", "Shipping"],
    ["/profile/postage", "Postage"],
    ["/profile/prizes", "Prize Pool"],
  ])("marks %s as the current page", (path, label) => {
    renderAt(path);
    expect(
      screen.getByRole("link", { name: label }).getAttribute("aria-current"),
    ).toBe("page");
    // Exactly one — two current sections is as wrong as none.
    const nav = screen.getByRole("navigation", { name: "Profile sections" });
    expect(nav.querySelectorAll("[aria-current='page']").length).toBe(1);
  });

  it("keeps the heading every Maestro flow gates on", () => {
    renderAt("/profile/credentials");
    expect(
      screen.getByRole("heading", { level: 1 }).textContent,
    ).toBe("Profile Settings");
  });

  it("renders only the active section's panel", () => {
    renderAt("/profile/shipping");
    expect(screen.queryByText("shipping panel")).not.toBeNull();
    expect(screen.queryByText("credentials panel")).toBeNull();
  });
});

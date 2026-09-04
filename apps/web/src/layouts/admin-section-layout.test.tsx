/**
 * NEO-155 — the Admin section's nav and hub.
 *
 * Same reasoning as print-layout.test.tsx: no Maestro flow exercises this nav.
 * The ~48 set-selector flows deep-link straight to the tool by URL, so nothing
 * else would catch the nav losing a link, forgetting to mark the current tool,
 * or the hub and the sub-tabs drifting out of sync.
 *
 * `aria-current="page"` is the assertion that matters — it is the only thing
 * telling a screen reader user which tool they are on; the colour change
 * carries that for everyone else.
 */

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

// The hub and layout render without Convex, but the Teams page underneath
// needs a provider. These cases stub the sub-routes, so the mock only has to
// satisfy imports.
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}));

import AdminSectionLayout from "./admin-section-layout";
import AdminHub from "@/app/admin/page";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin" element={<AdminSectionLayout />}>
          <Route index element={<AdminHub />} />
          <Route path="set-builder" element={<div>set builder tool</div>} />
          <Route path="players" element={<div>players tool</div>} />
          <Route path="teams" element={<div>teams tool</div>} />
          <Route path="pipeline-runs" element={<div>pipeline runs tool</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("AdminSectionLayout", () => {
  it("links to every tool", () => {
    renderAt("/admin");
    const nav = screen.getByRole("navigation", { name: "Admin sections" });
    expect(
      Array.from(nav.querySelectorAll("a")).map((a) => [
        a.textContent,
        a.getAttribute("href"),
      ]),
    ).toEqual([
      ["Set Builder", "/admin/set-builder"],
      ["Players", "/admin/players"],
      ["Teams", "/admin/teams"],
      ["Pipeline Runs", "/admin/pipeline-runs"],
    ]);
  });

  it.each([
    ["/admin/set-builder", "Set Builder"],
    ["/admin/players", "Players"],
    ["/admin/teams", "Teams"],
    ["/admin/pipeline-runs", "Pipeline Runs"],
  ])("marks %s as the current page", (path, label) => {
    renderAt(path);
    const nav = screen.getByRole("navigation", { name: "Admin sections" });
    expect(
      screen.getByRole("link", { name: label }).getAttribute("aria-current"),
    ).toBe("page");
    // Exactly one — two current tools is as wrong as none.
    expect(nav.querySelectorAll("[aria-current='page']").length).toBe(1);
  });

  it("heads the section with the one h1 on the page", () => {
    renderAt("/admin/set-builder");
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s.map((h) => h.textContent)).toEqual(["Admin"]);
  });

  it("renders only the active tool", () => {
    renderAt("/admin/set-builder");
    expect(screen.queryByText("set builder tool")).not.toBeNull();
    expect(screen.queryByText("teams tool")).toBeNull();
  });
});

describe("AdminHub", () => {
  /**
   * The hub cards and the sub-tabs are both driven by SECTIONS. A tool added to
   * one and missing from the other is the failure this catches — the hub skips
   * any section with no entry in its own TOOL_DETAILS map, so a new section
   * would silently not appear.
   */
  it("gives every section a card", () => {
    renderAt("/admin");
    const nav = screen.getByRole("navigation", { name: "Admin sections" });
    const navLabels = Array.from(nav.querySelectorAll("a")).map(
      (a) => a.textContent,
    );
    const cardLabels = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent);
    expect(cardLabels).toEqual(navLabels);
  });

  it("describes what each tool does", () => {
    renderAt("/admin");
    // The reason the hub exists rather than redirecting to the first tool: the
    // sub-tab strip is names only, with no room to say what a tool is for.
    expect(screen.getByText(/Build set parameters/i)).toBeTruthy();
    expect(screen.getByText(/Search every player we know/i)).toBeTruthy();
    expect(screen.getByText(/Resolve team colors/i)).toBeTruthy();
  });
});

/**
 * NEO-522 — the binder frame's width: a spacious Pick List (signed in, or the
 * demo's at /demo/inventory) takes the wide page; a condensed one, and every
 * other page, keeps the 6xl column.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { resetPickDensityForTests, setPickDensity } from "@/src/hooks/usePickDensity";

// The header, tabs and phone nav reach Clerk and Convex; the width is all this tests.
vi.mock("@/components/modules/binder-header", () => ({ default: () => null }));
vi.mock("@/components/modules/binder-tabs", () => ({ default: () => null }));
vi.mock("@/components/modules/mobile-nav", () => ({ default: () => null }));

import BinderLayout from "./binder-layout";

function renderAt(url: string) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route element={<BinderLayout />}>
          <Route path="/inventory" element={<p>page body</p>} />
          <Route path="/demo/inventory" element={<p>page body</p>} />
          <Route path="/collection" element={<p>page body</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  return () => screen.getByText("page body").parentElement!;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetPickDensityForTests();
});

describe("BinderLayout's width", () => {
  it.each(["/inventory?tab=pick", "/demo/inventory?tab=pick"])("opens %s to the wide page while Spacious", (url) => {
    const frame = renderAt(url);
    expect(frame().className).toContain("max-w-[1600px]");
    expect(frame().className).not.toContain("max-w-6xl");
  });

  it("keeps the 6xl column for a condensed Pick List, and widens again on Spacious", () => {
    const frame = renderAt("/demo/inventory?tab=pick");
    act(() => setPickDensity("condensed"));
    expect(frame().className).toContain("max-w-6xl");
    act(() => setPickDensity("spacious"));
    expect(frame().className).toContain("max-w-[1600px]");
  });

  it.each(["/inventory?tab=sales", "/collection?tab=pick"])("keeps the 6xl column on %s", (url) => {
    const frame = renderAt(url);
    expect(frame().className).toContain("max-w-6xl");
  });
});

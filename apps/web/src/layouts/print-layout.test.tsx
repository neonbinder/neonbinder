/**
 * NEO-145 — the Print Shop's section nav and hub.
 *
 * Same reasoning as profile-layout.test.tsx: no Maestro flow exercises this nav,
 * because the flows deep-link straight to a tool (/print/shipping, /print/qr) —
 * so nothing else would catch the nav losing a link, forgetting to mark the
 * current tool, or the hub and the sub-tabs drifting out of sync.
 *
 * `aria-current="page"` is the assertion that matters. It is the only thing
 * telling a screen reader user which tool they are on; the colour change carries
 * that for everyone else.
 */

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

// The layout holds both tools' queries open to keep them warm across sub-tab
// changes (see useWarmPrintQueries). Those subscriptions need a Convex provider
// that does not exist in a unit render, so stub the hook — the warming is a
// runtime concern, not what these cases are about.
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}));

import PrintLayout from "./print-layout";
import PrintHub from "@/app/print/page";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/print" element={<PrintLayout />}>
          <Route index element={<PrintHub />} />
          <Route path="shipping" element={<div>shipping tool</div>} />
          <Route path="qr" element={<div>qr tool</div>} />
          <Route path="placeholders" element={<div>placeholders tool</div>} />
          <Route path="spine-label" element={<div>spine label tool</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("PrintLayout", () => {
  it("links to every tool", () => {
    renderAt("/print");
    const nav = screen.getByRole("navigation", { name: "Print Shop sections" });
    expect(
      Array.from(nav.querySelectorAll("a")).map((a) => [
        a.textContent,
        a.getAttribute("href"),
      ]),
    ).toEqual([
      ["Shipping", "/print/shipping"],
      ["QR Code", "/print/qr"],
      ["Placeholders", "/print/placeholders"],
      ["Spine Labels", "/print/spine-label"],
    ]);
  });

  it.each([
    ["/print/shipping", "Shipping"],
    ["/print/qr", "QR Code"],
    ["/print/placeholders", "Placeholders"],
    ["/print/spine-label", "Spine Labels"],
  ])("marks %s as the current page", (path, label) => {
    renderAt(path);
    const nav = screen.getByRole("navigation", { name: "Print Shop sections" });
    expect(
      screen.getByRole("link", { name: label }).getAttribute("aria-current"),
    ).toBe("page");
    // Exactly one — two current tools is as wrong as none.
    expect(nav.querySelectorAll("[aria-current='page']").length).toBe(1);
  });

  it("heads the section with the one h1 on the page", () => {
    renderAt("/print/shipping");
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s.map((h) => h.textContent)).toEqual(["Print Shop"]);
  });

  it("renders only the active tool", () => {
    renderAt("/print/shipping");
    expect(screen.queryByText("shipping tool")).not.toBeNull();
    expect(screen.queryByText("qr tool")).toBeNull();
  });
});

describe("PrintHub", () => {
  /**
   * The hub is what bare /print renders, and it is the page a user lands on from
   * the binder tab — a hub that lists fewer tools than the nav does is a tool
   * nobody discovers.
   */
  it("gives every tool in the nav a card", () => {
    renderAt("/print");
    const nav = screen.getByRole("navigation", { name: "Print Shop sections" });
    const navHrefs = Array.from(nav.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    // Every link on the page that is not one of the sub-tabs is a hub card.
    const cardHrefs = screen
      .getAllByRole("link")
      .filter((link) => !nav.contains(link))
      .map((link) => link.getAttribute("href"));
    expect(cardHrefs).toEqual(navHrefs);
  });

  it("says what each tool does — the sub-tabs only have room for a name", () => {
    renderAt("/print");
    expect(screen.getByText(/4″ × 6″ label/)).toBeTruthy();
    expect(screen.getByText(/in-person sale/)).toBeTruthy();
  });
});

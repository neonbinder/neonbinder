/**
 * NEO-145 — the binder tab staircase.
 *
 * The stagger used to be a hardcoded `STAGGER_OFFSETS = [0, 6, 12, …]` with one
 * entry per nav item, read positionally with a `?? 0` fallback. A list longer
 * than the array flattened the extra tabs against the edge and nothing failed:
 * no error, no warning, just a nav that stopped looking like a staircase. It is
 * derived from the index now, and these cases are what keeps that true — a
 * regression here is invisible to every other test we have, including Maestro,
 * which reads text and never geometry.
 */

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

let role: string | undefined;

vi.mock("@clerk/clerk-react", () => ({
  useUser: () => ({
    user: { publicMetadata: { role } },
    isLoaded: true,
  }),
}));

import BinderTabs, { NAV_ITEMS } from "./binder-tabs";

// The first tab has no offset, and the browser normalises its "-0px" to "0px".
const staircase = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    index === 0 ? "margin-right: 0px;" : `margin-right: -${index * 6}px;`,
  );

function renderTabs() {
  render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <BinderTabs />
    </MemoryRouter>,
  );
  return screen.getByRole("navigation").querySelectorAll("a");
}

describe("BinderTabs", () => {
  beforeEach(() => {
    role = "admin";
  });

  it("staggers every tab, however many there are", () => {
    const tabs = renderTabs();
    expect(tabs.length).toBe(NAV_ITEMS.length);
    expect(Array.from(tabs).map((tab) => tab.getAttribute("style"))).toEqual(
      staircase(NAV_ITEMS.length),
    );
  });

  it("keeps the staircase when the list is filtered", () => {
    // A non-admin loses Set Builder from the MIDDLE of the list. The offsets
    // must follow the rendered position, not the position in NAV_ITEMS, or the
    // staircase gains a gap where the hidden tab used to be.
    role = undefined;
    const tabs = renderTabs();
    expect(tabs.length).toBe(NAV_ITEMS.length - 1);
    expect(Array.from(tabs).map((tab) => tab.getAttribute("style"))).toEqual(
      staircase(tabs.length),
    );
  });

  it("routes the print tools through one Print Shop tab", () => {
    const hrefs = Array.from(renderTabs()).map((tab) =>
      tab.getAttribute("href"),
    );
    // The consolidation itself: /print is a top-level tab, and the two tools it
    // absorbed are not (they are sub-tabs inside it now).
    expect(hrefs).toContain("/print");
    expect(hrefs).not.toContain("/labels");
    expect(hrefs).not.toContain("/qr-code");
  });
});

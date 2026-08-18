/**
 * NEO-172 — the /profile/api-keys shell.
 *
 * Clerk's `<APIKeys />` owns the key lifecycle and is mounted from a CDN bundle
 * at runtime, so there is nothing here to test about creating or revoking a key
 * — that is Clerk's code, and a unit test that stubbed it would only be
 * asserting the stub. What IS ours, and what these cases hold:
 *
 * 1. **The warnings render above the component.** They are the only place a
 *    person is told that the secret appears exactly once and that a leaked key
 *    has to be revoked. Losing them is silent: the page still "works".
 * 2. **The shell survives the component.** API keys are a per-instance Clerk
 *    setting, so an instance with the feature off is a normal state. If
 *    `<APIKeys />` throws, the route must degrade to an explanation, not a
 *    blank screen.
 * 3. **The route exists.** A page nothing routes to is unreachable, and
 *    src/main.tsx cannot be imported here to check — importing it mounts the
 *    whole app into a real DOM root. So the route table is read as source.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  apiKeysProps: undefined as Record<string, unknown> | undefined,
  apiKeysThrows: false,
}));

// `<APIKeys />` mounts clerk-js into a portal — it needs a live Clerk instance
// and a network. Stub it, and keep the props it was given so the fallback and
// appearance wiring can be asserted without rendering Clerk's real UI.
vi.mock("@clerk/clerk-react", () => ({
  APIKeys: (props: Record<string, unknown>) => {
    mocks.apiKeysProps = props;
    if (mocks.apiKeysThrows) {
      throw new Error("api keys are not enabled for this instance");
    }
    return <div data-testid="clerk-api-keys" />;
  },
}));

// `?raw` gives the route table as text. Importing src/main.tsx for real would
// run it, and it calls createRoot(...).render() on module load.
import mainSource from "@/src/main.tsx?raw";

import ApiKeysPanel from "./page";

describe("ApiKeysPanel", () => {
  beforeEach(() => {
    mocks.apiKeysProps = undefined;
    mocks.apiKeysThrows = false;
  });

  it("heads the page with API Keys, below the shell's h1", () => {
    render(<ApiKeysPanel />);
    const heading = screen.getByRole("heading", { name: "API Keys" });
    // ProfileLayout owns the h1 ("Profile Settings"); a second h1 here would
    // give the document two top-level headings.
    expect(heading.tagName).toBe("H2");
    // The section is named by its heading, so the landmark is announced as
    // "API Keys" rather than an anonymous region.
    expect(
      screen.getByRole("region", { name: "API Keys" }),
    ).not.toBeNull();
  });

  it("states the three things that make a key dangerous", () => {
    render(<ApiKeysPanel />);
    const points = screen
      .getAllByRole("listitem")
      .map((item) => item.textContent ?? "");
    expect(points.length).toBe(3);
    // Acts as you / shown once / revoke on leak. Matched loosely so the copy
    // can be reworded without a test edit, but not dropped.
    expect(points.some((text) => /acts as your account/i.test(text))).toBe(true);
    expect(points.some((text) => /shown once/i.test(text))).toBe(true);
    expect(points.some((text) => /revoke/i.test(text))).toBe(true);
  });

  it("renders Clerk's component with a fallback for the loading gap", () => {
    render(<ApiKeysPanel />);
    expect(screen.getByTestId("clerk-api-keys")).not.toBeNull();
    // Without `fallback`, the slot is an unexplained blank while clerk-js
    // downloads; without `appearance`, it paints in Clerk's stock palette.
    expect(mocks.apiKeysProps?.fallback).toBeTruthy();
    expect(mocks.apiKeysProps?.appearance).toBeTruthy();
  });

  it("keeps the explanation when Clerk's component throws", () => {
    mocks.apiKeysThrows = true;
    // React logs a caught render error; the boundary is the behaviour under
    // test, so the log is expected output, not a failure.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      render(<ApiKeysPanel />);
    } finally {
      consoleError.mockRestore();
    }

    expect(screen.getByRole("heading", { name: "API Keys" })).not.toBeNull();
    expect(screen.getAllByRole("listitem").length).toBe(3);
    expect(screen.queryByTestId("clerk-api-keys")).toBeNull();
    expect(screen.getByText(/API keys are unavailable right now/i)).not.toBeNull();
  });

  it("titles the tab while mounted and puts the title back on the way out", () => {
    document.title = "Neon Binder";
    const view = render(<ApiKeysPanel />);
    expect(document.title).toBe("API Keys | Neon Binder");
    view.unmount();
    expect(document.title).toBe("Neon Binder");
  });

  it("is reachable — src/main.tsx routes /profile/api-keys to this page", () => {
    expect(mainSource).toContain('from "@/app/profile/api-keys/page"');
    expect(mainSource).toMatch(
      /path="api-keys"\s+element=\{<ProfileApiKeys \/>\}/,
    );
    // Nested inside the /profile route, which sits under <ProtectedLayout> —
    // that nesting is what makes the page signed-in only.
    const profileBlock = mainSource.slice(
      mainSource.indexOf('<Route path="/profile"'),
      mainSource.indexOf('<Route path="/print"'),
    );
    expect(profileBlock).toContain('path="api-keys"');
  });
});

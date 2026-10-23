/**
 * NEO-356 — ProfileThemeSync against the REAL ThemeProvider.
 *
 * The sibling test stubs the provider; this one holds the hand-off end to end,
 * because the case that matters lives in the provider's precedence: after
 * sign-out the page must stay in the mode the collector saved (now mirrored to
 * this device), not snap back to whatever the device held at page load.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY } from "./theme-mode";
import { ThemeProvider, useTheme } from "./ThemeProvider";

const auth = { isAuthenticated: true, isLoading: false };
let profile: unknown = undefined;

vi.mock("convex/react", () => ({
  useConvexAuth: () => auth,
  useQuery: (_fn: unknown, args: unknown) => (args === "skip" ? undefined : profile),
}));

import { ProfileThemeSync } from "./ProfileThemeSync";

function Readout() {
  const { preference, mode } = useTheme();
  return <output aria-label="theme">{`${preference}/${mode}`}</output>;
}

function App() {
  return (
    <ThemeProvider>
      <ProfileThemeSync />
      <Readout />
    </ThemeProvider>
  );
}

const readout = () => screen.getByRole("status", { name: "theme" }).textContent;

beforeEach(() => {
  auth.isAuthenticated = true;
  auth.isLoading = false;
  profile = undefined;
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("ProfileThemeSync + ThemeProvider", () => {
  it("keeps the device's choice while the profile loads, then takes the saved one", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const { rerender } = render(<App />);
    expect(readout()).toBe("dark/dark");

    profile = "light";
    rerender(<App />);
    expect(readout()).toBe("light/light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("stays in the saved mode after sign-out", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    profile = "light";
    const { rerender } = render(<App />);
    expect(readout()).toBe("light/light");

    auth.isAuthenticated = false;
    rerender(<App />);
    expect(readout()).toBe("light/light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

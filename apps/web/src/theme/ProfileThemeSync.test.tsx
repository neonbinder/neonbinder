/**
 * NEO-356 — ProfileThemeSync hands the saved theme to the ThemeProvider.
 *
 * Pinned: a missing value (the query's null) means "system"; loading pushes nothing (so the
 * localStorage mirror keeps the first paint stable); the saved value is
 * mirrored to localStorage; signing out clears the profile slot.
 */

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, writeStoredPreference, type ThemePreference } from "./theme-mode";

const auth = { isAuthenticated: true, isLoading: false };
let profile: unknown = undefined;
const queryArgs: unknown[] = [];
const setProfilePreference = vi.fn();
// The real device write, so the localStorage assertions below hold the
// component to the provider's own setter rather than to a bare write.
const setPreference = vi.fn((p: ThemePreference) => writeStoredPreference(p));

vi.mock("convex/react", () => ({
  useConvexAuth: () => auth,
  useQuery: (_fn: unknown, args: unknown) => {
    queryArgs.push(args);
    return args === "skip" ? undefined : profile;
  },
}));

vi.mock("./ThemeProvider", () => ({
  useTheme: () => ({ setPreference, setProfilePreference }),
}));

import { ProfileThemeSync } from "./ProfileThemeSync";

beforeEach(() => {
  auth.isAuthenticated = true;
  auth.isLoading = false;
  profile = undefined;
  queryArgs.length = 0;
  setProfilePreference.mockClear();
  setPreference.mockClear();
  localStorage.clear();
});

describe("ProfileThemeSync", () => {
  it("pushes the saved theme and mirrors it to localStorage", () => {
    profile = "light";
    render(<ProfileThemeSync />);
    expect(setProfilePreference).toHaveBeenLastCalledWith("light");
    // Through the provider, so its fallback for after sign-out moves too.
    expect(setPreference).toHaveBeenLastCalledWith("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  // getThemePreference answers null for no row, a row with no preferences
  // and preferences with no theme alike.
  it("treats a null saved theme as system", () => {
    profile = null;
    render(<ProfileThemeSync />);
    expect(setProfilePreference).toHaveBeenLastCalledWith("system");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });

  it("pushes nothing while the profile is still loading", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    render(<ProfileThemeSync />);
    expect(setProfilePreference).not.toHaveBeenCalled();
    expect(setPreference).not.toHaveBeenCalled();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("pushes nothing while auth is still resolving", () => {
    auth.isAuthenticated = false;
    auth.isLoading = true;
    render(<ProfileThemeSync />);
    expect(setProfilePreference).not.toHaveBeenCalled();
  });

  it("clears the profile slot when signed out, skips the query, and keeps localStorage", () => {
    auth.isAuthenticated = false;
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    render(<ProfileThemeSync />);
    expect(queryArgs.every((a) => a === "skip")).toBe(true);
    expect(setProfilePreference).toHaveBeenLastCalledWith(null);
    expect(setPreference).not.toHaveBeenCalled();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("re-pushes when the saved value changes, and not on a re-render with the same value", () => {
    profile = "dark";
    const { rerender } = render(<ProfileThemeSync />);
    expect(setProfilePreference).toHaveBeenCalledTimes(1);

    rerender(<ProfileThemeSync />);
    expect(setProfilePreference).toHaveBeenCalledTimes(1);

    profile = "light";
    rerender(<ProfileThemeSync />);
    expect(setProfilePreference).toHaveBeenLastCalledWith("light");
    expect(setProfilePreference).toHaveBeenCalledTimes(2);
  });
});

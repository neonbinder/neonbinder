/**
 * NEO-356 — a failing theme query must never take the app down.
 *
 * A Convex `useQuery` whose function errors (a deployment without
 * `getThemePreference`, a server error) throws during render. Without its own
 * boundary that throw unmounted every signed-in page to a blank screen about a
 * second after load. ProfileThemeSync now catches it: the rest of the app
 * keeps rendering, the page keeps the mode it already had, and Sentry hears
 * about it once.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_DARK_QUERY, THEME_STORAGE_KEY } from "./theme-mode";
import { ThemeProvider, useTheme } from "./ThemeProvider";

const captureException = vi.hoisted(() => vi.fn());
vi.mock("@sentry/react", () => ({ captureException }));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: () => {
    throw new Error("[CONVEX Q(userProfile:getThemePreference)] Server Error");
  },
}));

import { ProfileThemeSync } from "./ProfileThemeSync";

function Page() {
  const { preference, mode } = useTheme();
  return <main aria-label="page">{`${preference}/${mode}`}</main>;
}

function App() {
  return (
    <ThemeProvider>
      <ProfileThemeSync />
      <Page />
    </ThemeProvider>
  );
}

beforeEach(() => {
  captureException.mockClear();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query === SYSTEM_DARK_QUERY,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  // React logs the caught render error; it is expected here.
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProfileThemeSync when the theme query throws", () => {
  it("leaves the app rendered and keeps the device's mode", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    render(<App />);
    expect(screen.getByRole("main", { name: "page" }).textContent).toBe("light/light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("keeps the system's mode when the device has no choice", () => {
    render(<App />);
    expect(screen.getByRole("main", { name: "page" }).textContent).toBe("system/dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("reports the failure to Sentry once, however often the app re-renders", () => {
    const { rerender } = render(<App />);
    rerender(<App />);
    rerender(<App />);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(String(captureException.mock.calls[0][0])).toMatch(/getThemePreference/);
  });
});

/**
 * NEO-356 adversarial pass — ThemeProvider and ProfileThemeSync under the
 * conditions the happy-path files skip: junk or throwing storage, the system
 * flipping under an explicit choice, another tab clearing storage, two
 * override owners at once, and a profile row with no theme in it.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForceDark } from "@/components/primitives/ForceDark";
import { ProfileThemeSync } from "./ProfileThemeSync";
import { ThemeProvider, useTheme, type ThemeContextValue } from "./ThemeProvider";
import { SYSTEM_DARK_QUERY, THEME_STORAGE_KEY } from "./theme-mode";

const auth = { isAuthenticated: true, isLoading: false };
let profile: unknown = undefined;
vi.mock("convex/react", () => ({
  useConvexAuth: () => auth,
  useQuery: (_fn: unknown, args: unknown) => (args === "skip" ? undefined : profile),
}));

function mockSystem(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<() => void>();
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        get matches() {
          return query === SYSTEM_DARK_QUERY && dark;
        },
        media: query,
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      }) as unknown as MediaQueryList,
  );
  return {
    listeners,
    set(next: boolean) {
      dark = next;
      act(() => listeners.forEach((fn) => fn()));
    },
  };
}

const latest: { current: ThemeContextValue | null } = { current: null };
const api = new Proxy({} as ThemeContextValue, {
  get: (_, key: keyof ThemeContextValue) => latest.current![key],
});
function Probe() {
  const theme = useTheme();
  useEffect(() => {
    latest.current = theme;
  });
  return (
    <p>
      {theme.preference}/{theme.mode}
    </p>
  );
}
const html = () => document.documentElement.dataset.theme;
const storageEvent = (key: string | null, newValue: string | null) =>
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
  });

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  auth.isAuthenticated = true;
  auth.isLoading = false;
  profile = undefined;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("storage that is junk or blocked", () => {
  it.each(["banana", "", "Dark", "null", "undefined"])(
    "a stored %j reads as no choice and the page follows the system",
    (junk) => {
      mockSystem(true);
      localStorage.setItem(THEME_STORAGE_KEY, junk);
      render(<ThemeProvider><Probe /></ThemeProvider>);
      expect(screen.getByText("system/dark")).toBeTruthy();
      expect(html()).toBe("dark");
    },
  );

  it("a throwing getItem does not crash the provider", () => {
    mockSystem(false);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByText("system/light")).toBeTruthy();
  });

  it("a throwing setItem still applies the pick for this page", () => {
    mockSystem(false);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    render(<ThemeProvider><Probe /></ThemeProvider>);
    act(() => api.setPreference("dark"));
    expect(screen.getByText("dark/dark")).toBeTruthy();
    expect(html()).toBe("dark");
  });

  it("without matchMedia the system reads as light and nothing throws", () => {
    vi.stubGlobal("matchMedia", undefined);
    Object.defineProperty(window, "matchMedia", { value: undefined, configurable: true, writable: true });
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByText("system/light")).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

describe("the system changing mid-session", () => {
  it("does not move an explicit Light or Dark", () => {
    const system = mockSystem(false);
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    render(<ThemeProvider><Probe /></ThemeProvider>);
    system.set(true);
    expect(screen.getByText("light/light")).toBeTruthy();
    expect(html()).toBe("light");
  });

  it("does not move an override, and the system's latest value shows once it is released", () => {
    const system = mockSystem(false);
    render(<ThemeProvider><Probe /></ThemeProvider>);
    act(() => api.setOverride("light"));
    system.set(true);
    expect(html()).toBe("light");
    act(() => api.setOverride(null));
    expect(html()).toBe("dark");
  });

  it("stops listening when the provider unmounts", () => {
    const system = mockSystem(false);
    const { unmount } = render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(system.listeners.size).toBe(1);
    unmount();
    expect(system.listeners.size).toBe(0);
  });
});

describe("another tab's storage events", () => {
  it("ignores a different key", () => {
    mockSystem(false);
    render(<ThemeProvider><Probe /></ThemeProvider>);
    storageEvent("something-else", "dark");
    expect(screen.getByText("system/light")).toBeTruthy();
  });

  it("a junk value from another tab reads as no choice", () => {
    mockSystem(false);
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    render(<ThemeProvider><Probe /></ThemeProvider>);
    storageEvent(THEME_STORAGE_KEY, "banana");
    expect(screen.getByText("system/light")).toBeTruthy();
  });

  it("a removed key from another tab falls back to the system", () => {
    mockSystem(false);
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    render(<ThemeProvider><Probe /></ThemeProvider>);
    storageEvent(THEME_STORAGE_KEY, null);
    expect(screen.getByText("system/light")).toBeTruthy();
  });

  it("another tab calling localStorage.clear() (event key null) drops the device choice", () => {
    mockSystem(false);
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    render(<ThemeProvider><Probe /></ThemeProvider>);
    storageEvent(null, null);
    expect(screen.getByText("system/light")).toBeTruthy();
  });

  it("does not outrank the signed-in profile", () => {
    mockSystem(false);
    render(<ThemeProvider><Probe /></ThemeProvider>);
    act(() => api.setProfilePreference("light"));
    storageEvent(THEME_STORAGE_KEY, "dark");
    expect(screen.getByText("light/light")).toBeTruthy();
  });
});

describe("two override owners", () => {
  it("one of two mounted ForceDark pages leaving does not release the other's override", () => {
    mockSystem(false);
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    function Pages({ a, b }: { a: boolean; b: boolean }) {
      return (
        <>
          <Probe />
          {a && <ForceDark />}
          {b && <ForceDark />}
        </>
      );
    }
    const { rerender } = render(<ThemeProvider><Pages a b /></ThemeProvider>);
    expect(html()).toBe("dark");
    rerender(<ThemeProvider><Pages a={false} b /></ThemeProvider>);
    expect(html()).toBe("dark");
  });

  it("swapping one ForceDark page for another in the same commit stays dark", () => {
    mockSystem(false);
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    function Route({ page }: { page: "a" | "b" }) {
      return page === "a" ? <ForceDark key="a" /> : <ForceDark key="b" />;
    }
    const { rerender } = render(<ThemeProvider><Route page="a" /></ThemeProvider>);
    rerender(<ThemeProvider><Route page="b" /></ThemeProvider>);
    expect(html()).toBe("dark");
  });

  it("stays dark under StrictMode's mount, unmount, mount", () => {
    mockSystem(false);
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    render(<StrictMode><ThemeProvider><ForceDark /></ThemeProvider></StrictMode>);
    expect(html()).toBe("dark");
  });
});

describe("ProfileThemeSync against a profile with no theme in it", () => {
  function App({ show = true }: { show?: boolean }) {
    return (
      <ThemeProvider>
        {show && <ProfileThemeSync />}
        <Probe />
      </ThemeProvider>
    );
  }

  // getThemePreference answers null for all three: no row, a row with no
  // preferences, and preferences that only hold defaultYear.
  it.each([
    ["no row at all", null],
    ["a row with no preferences", null],
    ["preferences that only hold defaultYear", null],
  ])("%s means System", (_label, row) => {
    mockSystem(true);
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    profile = row;
    render(<App />);
    expect(screen.getByText("system/dark")).toBeTruthy();
  });

  it("signing out after a saved Light leaves the page Light and the device mirror at Light", () => {
    mockSystem(true);
    profile = "light";
    const { rerender } = render(<App />);
    expect(screen.getByText("light/light")).toBeTruthy();
    auth.isAuthenticated = false;
    rerender(<App />);
    expect(screen.getByText("light/light")).toBeTruthy();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("a signed-out visitor with junk in storage lands on the system", () => {
    mockSystem(false);
    auth.isAuthenticated = false;
    localStorage.setItem(THEME_STORAGE_KEY, "banana");
    render(<App />);
    expect(screen.getByText("system/light")).toBeTruthy();
  });
});

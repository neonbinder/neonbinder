/**
 * NEO-356 — ThemeProvider's precedence (override > profile > device > system),
 * the attribute it keeps on <html>, and ForceDark's use of the override slot.
 */
import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForceDark } from "@/components/primitives/ForceDark";
import { ThemeProvider, useTheme, type ThemeContextValue } from "./ThemeProvider";
import { SYSTEM_DARK_QUERY, THEME_STORAGE_KEY } from "./theme-mode";

/** A controllable prefers-color-scheme. */
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
    set(next: boolean) {
      dark = next;
      act(() => listeners.forEach((fn) => fn()));
    },
  };
}

// The latest context value, for driving the setters from a test.
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

function renderProvider(children: React.ReactNode = <Probe />) {
  return render(<ThemeProvider>{children}</ThemeProvider>);
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ThemeProvider", () => {
  it("with nothing chosen, follows the system, live", () => {
    const system = mockSystem(true);
    renderProvider();
    expect(screen.getByText("system/dark")).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe("dark");

    system.set(false);
    expect(screen.getByText("system/light")).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("starts from the device's stored choice", () => {
    mockSystem(true);
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    renderProvider();
    expect(screen.getByText("light/light")).toBeTruthy();
  });

  it("setPreference applies at once and stores the choice on the device", () => {
    mockSystem(false);
    renderProvider();
    act(() => api.setPreference("dark"));
    expect(screen.getByText("dark/dark")).toBeTruthy();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("a profile value outranks the device; clearing it hands back to the device", () => {
    mockSystem(true);
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    renderProvider();
    act(() => api.setProfilePreference("light"));
    expect(screen.getByText("light/light")).toBeTruthy();
    act(() => api.setProfilePreference(null));
    expect(screen.getByText("dark/dark")).toBeTruthy();
  });

  it("an override outranks everything and is never reported as the preference", () => {
    mockSystem(false);
    renderProvider();
    act(() => api.setProfilePreference("light"));
    act(() => api.setOverride("dark"));
    expect(screen.getByText("light/dark")).toBeTruthy();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    act(() => api.setOverride(null));
    expect(screen.getByText("light/light")).toBeTruthy();
  });

  it("follows another tab's change to the stored choice", () => {
    mockSystem(false);
    renderProvider();
    act(() => {
      localStorage.setItem(THEME_STORAGE_KEY, "dark");
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "dark" }));
    });
    expect(screen.getByText("dark/dark")).toBeTruthy();
  });
});

describe("ForceDark", () => {
  it("forces dark while mounted and restores the collector's mode after", () => {
    mockSystem(false);
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    function Page({ forced }: { forced: boolean }) {
      return (
        <>
          <Probe />
          {forced && <ForceDark />}
        </>
      );
    }
    const { rerender } = render(
      <ThemeProvider>
        <Page forced />
      </ThemeProvider>,
    );
    expect(screen.getByText("light/dark")).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe("dark");

    rerender(
      <ThemeProvider>
        <Page forced={false} />
      </ThemeProvider>,
    );
    expect(screen.getByText("light/light")).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

describe("useTheme outside a provider", () => {
  it("reads <html data-theme>, dark by default, with inert setters", () => {
    render(<Probe />);
    expect(screen.getByText("system/dark")).toBeTruthy();
    expect(() => api.setPreference("light")).not.toThrow();
  });

  it("reports light when the page is light", () => {
    document.documentElement.dataset.theme = "light";
    render(<Probe />);
    expect(screen.getByText("system/light")).toBeTruthy();
  });
});

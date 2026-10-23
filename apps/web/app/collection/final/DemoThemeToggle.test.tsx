/**
 * NEO-356 — the collection demo's Light / Dark switch: it flips the whole page
 * through the ThemeProvider's override, never saves a preference, gives the
 * collector's own mode back when the demo goes away, and only shows to someone
 * who has not chosen a mode (signed out, or on System).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme, type ThemeContextValue } from "@/src/theme/ThemeProvider";
import { SYSTEM_DARK_QUERY, THEME_STORAGE_KEY } from "@/src/theme/theme-mode";
import DemoThemeToggle, { showDemoThemeToggle } from "./DemoThemeToggle";

const auth = vi.hoisted(() => ({ isLoaded: true, isSignedIn: false as boolean | undefined }));
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => auth }));

function systemIs(dark: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query === SYSTEM_DARK_QUERY && dark,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

const latest: { current: ThemeContextValue | null } = { current: null };
function Probe() {
  const theme = useTheme();
  useEffect(() => {
    latest.current = theme;
  });
  return null;
}

/** The demo, with a way to leave it (as any route change would unmount it). */
function Harness() {
  const [inDemo, setInDemo] = useState(true);
  return (
    <>
      <Probe />
      {inDemo && <DemoThemeToggle />}
      <button type="button" onClick={() => setInDemo(false)}>
        Leave the demo
      </button>
    </>
  );
}

function renderDemo() {
  return render(
    <ThemeProvider>
      <Harness />
    </ThemeProvider>,
  );
}

const theme = () => document.documentElement.dataset.theme;
const group = () => screen.queryByRole("radiogroup", { name: "Demo theme" });

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  auth.isLoaded = true;
  auth.isSignedIn = false;
  systemIs(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("who sees the demo theme switch", () => {
  it("shows to signed-out visitors, whatever this device has saved", () => {
    expect(showDemoThemeToggle(false, "system")).toBe(true);
    expect(showDemoThemeToggle(false, "light")).toBe(true);
    expect(showDemoThemeToggle(false, "dark")).toBe(true);
  });

  it("while Clerk is still loading, follows the device's stored choice, so it never shows and then vanishes", () => {
    expect(showDemoThemeToggle(undefined, "system")).toBe(true);
    expect(showDemoThemeToggle(undefined, "dark")).toBe(false);
    expect(showDemoThemeToggle(undefined, "light")).toBe(false);
  });

  it("a keyboard user's focus is never pulled: a signed-in collector with a mirrored saved mode never sees it mount", () => {
    auth.isLoaded = false;
    auth.isSignedIn = undefined;
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    const { rerender } = renderDemo();
    expect(group()).toBeNull();
    auth.isLoaded = true;
    auth.isSignedIn = true;
    rerender(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );
    expect(group()).toBeNull();
  });

  it("shows to a signed-in collector on System", () => {
    expect(showDemoThemeToggle(true, "system")).toBe(true);
  });

  it("hides from a signed-in collector who saved Light or Dark", () => {
    expect(showDemoThemeToggle(true, "light")).toBe(false);
    expect(showDemoThemeToggle(true, "dark")).toBe(false);
  });

  it("renders nothing for a signed-in collector with a saved mode", () => {
    auth.isSignedIn = true;
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    renderDemo();
    expect(group()).toBeNull();
    expect(theme()).toBe("light");
  });

  it("renders for a signed-in collector on System", () => {
    auth.isSignedIn = true;
    renderDemo();
    expect(group()).not.toBeNull();
  });
});

describe("flipping the demo", () => {
  it("starts at the page's current mode", () => {
    renderDemo();
    expect(theme()).toBe("dark");
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("false");
  });

  it("flips the whole page through the override and never saves a preference", () => {
    renderDemo();
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(theme()).toBe("light");
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
    expect(latest.current?.preference).toBe("system");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("is keyboard operable: arrows move and choose", () => {
    renderDemo();
    const dark = screen.getByRole("radio", { name: "Dark" });
    dark.focus();
    fireEvent.keyDown(dark, { key: "ArrowLeft" });
    expect(theme()).toBe("light");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Light" }));
  });

  it("gives the collector's own mode back when the demo goes away", () => {
    renderDemo();
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(theme()).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: "Leave the demo" }));
    expect(theme()).toBe("dark");
  });

  it("leaves an override it did not set alone (a ForceDark page's)", () => {
    renderDemo();
    act(() => latest.current?.setOverride("light"));
    fireEvent.click(screen.getByRole("button", { name: "Leave the demo" }));
    expect(theme()).toBe("light");
  });

  it("releases its override if the switch hides after a pick (the collector's saved mode arrived)", () => {
    auth.isSignedIn = true;
    renderDemo();
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(theme()).toBe("light");
    // ProfileThemeSync pushing a saved Dark from another device.
    act(() => latest.current?.setProfilePreference("dark"));
    expect(group()).toBeNull();
    expect(theme()).toBe("dark");
  });
});

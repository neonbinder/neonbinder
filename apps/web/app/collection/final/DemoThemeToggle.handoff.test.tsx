/**
 * NEO-356 adversarial pass — the demo's Light / Dark switch beside a ForceDark
 * page. Both write the provider's single override slot, so the hand-off
 * between them is where a stale release would show.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForceDark } from "@/components/primitives/ForceDark";
import { ThemeProvider } from "@/src/theme/ThemeProvider";
import { SYSTEM_DARK_QUERY, THEME_STORAGE_KEY } from "@/src/theme/theme-mode";
import DemoThemeToggle from "./DemoThemeToggle";

vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));

const html = () => document.documentElement.dataset.theme;

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query === SYSTEM_DARK_QUERY && false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("route change from the demo to a ForceDark page", () => {
  it("lands dark: the demo's release runs before the new page forces its mode", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    function Routes({ page }: { page: "demo" | "prototype" }) {
      return page === "demo" ? <DemoThemeToggle /> : <ForceDark />;
    }
    const { rerender } = render(<ThemeProvider><Routes page="demo" /></ThemeProvider>);
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    rerender(<ThemeProvider><Routes page="prototype" /></ThemeProvider>);
    expect(html()).toBe("dark");
  });

  it("and back to the collector's own mode when the prototype goes", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    function Routes({ page }: { page: "demo" | "prototype" | "none" }) {
      return page === "demo" ? <DemoThemeToggle /> : page === "prototype" ? <ForceDark /> : null;
    }
    const { rerender } = render(<ThemeProvider><Routes page="demo" /></ThemeProvider>);
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    rerender(<ThemeProvider><Routes page="prototype" /></ThemeProvider>);
    rerender(<ThemeProvider><Routes page="none" /></ThemeProvider>);
    expect(html()).toBe("light");
  });
});

describe("the switch mounted at the same time as a ForceDark page", () => {
  it("leaving the demo after a flip does not release the ForceDark page's override", () => {
    function Page({ demo }: { demo: boolean }) {
      return (
        <>
          <ForceDark />
          {demo && <DemoThemeToggle />}
        </>
      );
    }
    const { rerender } = render(<ThemeProvider><Page demo /></ThemeProvider>);
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    rerender(<ThemeProvider><Page demo={false} /></ThemeProvider>);
    expect(html()).toBe("dark");
  });
});

/**
 * NEO-356 adversarial pass — Settings → Appearance with overlapping saves,
 * against the REAL ThemeProvider. Each save is a deferred promise the test
 * settles by hand, so the order they land in is the test's choice.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "@/src/theme/ThemeProvider";
import { THEME_STORAGE_KEY } from "@/src/theme/theme-mode";

interface Pending {
  theme: string;
  resolve: () => void;
  reject: () => void;
}
const pending: Pending[] = [];
vi.mock("convex/react", () => ({
  useMutation: () => (args: { theme: string }) =>
    new Promise<null>((resolve, reject) => {
      pending.push({ theme: args.theme, resolve: () => resolve(null), reject: () => reject(new Error("offline")) });
    }),
  useQuery: () => undefined,
}));

// The Collection section (NEO-380) has its own test.
vi.mock("./DefaultConditionSection", () => ({ default: () => null }));

import SettingsPanel from "./page";

function Readout() {
  const { preference } = useTheme();
  return <output aria-label="pref">{preference}</output>;
}
const pref = () => screen.getByLabelText("pref").textContent;
const pick = (label: string) => fireEvent.click(screen.getByRole("radio", { name: label }));
const settle = async (i: number, how: "resolve" | "reject") => {
  await act(async () => pending[i][how]());
};
// The page's own live region: a status while saving, an alert once a save fails.
const message = () => {
  const appearance = within(screen.getByRole("region", { name: "Appearance" }));
  return [...appearance.queryAllByRole("status"), ...appearance.queryAllByRole("alert")].find((el) => el.tagName === "P")!
    .textContent;
};

beforeEach(() => {
  pending.length = 0;
  localStorage.clear();
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
  localStorage.setItem(THEME_STORAGE_KEY, "dark");
  render(
    <ThemeProvider>
      <SettingsPanel />
      <Readout />
    </ThemeProvider>,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("overlapping theme saves", () => {
  it("an older save failing after a newer one succeeded leaves the newer pick", async () => {
    pick("Light");
    pick("System");
    await settle(1, "resolve");
    await settle(0, "reject");
    expect(pref()).toBe("system");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });

  it("the newest failing after an older one succeeded rolls back to the older pick", async () => {
    pick("Light");
    pick("System");
    await settle(0, "resolve");
    await settle(1, "reject");
    expect(pref()).toBe("light");
  });

  it("both failing rolls back to the theme that is actually saved, not to the first unsaved pick", async () => {
    // The profile holds "dark". Light's save fails, then System's fails: the
    // page must not be left showing Light, which was never saved.
    pick("Light");
    pick("System");
    await settle(0, "reject");
    await settle(1, "reject");
    expect(pref()).toBe("dark");
  });

  it("a stale success does not clear a newer save's failure message", async () => {
    pick("Light");
    pick("System");
    await settle(1, "reject");
    await settle(0, "resolve");
    expect(message()).toMatch(/didn't save/);
  });
});

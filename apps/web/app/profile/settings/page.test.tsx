/**
 * NEO-356 — Profile → Settings → Appearance.
 *
 * What is pinned here is the page's own logic, through the real
 * ModeRadioGroup (its keyboard behaviour is that primitive's own test's job):
 *   - a pick applies first (provider + localStorage mirror) and saves second;
 *   - a failed save puts the old theme back and says so;
 *   - System names the mode the device is giving right now.
 * And Binders (NEO-374): where My Collection opens, saved to the profile.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemePreference } from "@/src/theme/theme-mode";

const calls: string[] = [];
const saveTheme = vi.fn();
const saveBinderOpen = vi.fn();
let binderPreference: { open: "all" | "last"; lastBinder: string | null } | undefined;
const theme = {
  preference: "system" as ThemePreference,
  mode: "dark" as "light" | "dark",
  setPreference: vi.fn((p: ThemePreference) => calls.push(`setPreference:${p}`)),
  setProfilePreference: vi.fn((p: ThemePreference | null) =>
    calls.push(`setProfilePreference:${p}`),
  ),
  setOverride: vi.fn(),
};

vi.mock("convex/react", () => ({
  useMutation: (ref: Parameters<typeof getFunctionName>[0]) =>
    getFunctionName(ref) === "userProfile:setBinderOpenPreference" ? saveBinderOpen : saveTheme,
  useQuery: () => binderPreference,
}));

// The Collection section (NEO-380) has its own test.
vi.mock("./DefaultConditionSection", () => ({ default: () => null }));

vi.mock("@/src/theme/ThemeProvider", () => ({
  useTheme: () => theme,
}));

import SettingsPanel from "./page";

const radio = (label: string) => screen.getByRole("radio", { name: label });
const section = (name: string) => within(screen.getByRole("region", { name }));
const appearance = () => section("Appearance");
const binders = () => section("Binders");

beforeEach(() => {
  calls.length = 0;
  saveTheme.mockReset();
  saveTheme.mockImplementation(async (args: { theme: string }) => {
    calls.push(`save:${args.theme}`);
    return null;
  });
  theme.preference = "system";
  theme.mode = "dark";
  theme.setPreference.mockClear();
  theme.setProfilePreference.mockClear();
  saveBinderOpen.mockReset();
  binderPreference = undefined;
});

describe("Settings → Appearance", () => {
  it("has the Appearance heading and a Theme group with Light, Dark and System", () => {
    render(<SettingsPanel />);
    expect(screen.getByRole("heading", { level: 2, name: "Appearance" })).toBeTruthy();
    const group = screen.getByRole("radiogroup", { name: "Theme" });
    expect(
      Array.from(group.querySelectorAll("[role=radio]")).map((r) => r.getAttribute("aria-checked")),
    ).toHaveLength(3);
    for (const label of ["Light", "Dark", "System"]) expect(radio(label)).toBeTruthy();
    // System is the default the provider hands a collector with no choice.
    expect(radio("System").getAttribute("aria-checked")).toBe("true");
  });

  it("applies a pick before saving it", async () => {
    render(<SettingsPanel />);
    await act(async () => {
      fireEvent.click(radio("Light"));
    });
    expect(calls).toEqual([
      "setPreference:light",
      "setProfilePreference:light",
      "save:light",
    ]);
    expect(appearance().getByRole("status").textContent).toBe("Saved.");
  });

  it("puts the old theme back and says so when the save fails", async () => {
    theme.preference = "dark";
    saveTheme.mockImplementation(async () => {
      throw new Error("offline");
    });
    render(<SettingsPanel />);
    await act(async () => {
      fireEvent.click(radio("Light"));
    });
    expect(theme.setPreference.mock.calls.map((c) => c[0])).toEqual(["light", "dark"]);
    expect(theme.setProfilePreference.mock.calls.map((c) => c[0])).toEqual(["light", "dark"]);
    // An alert, not a polite status: a failed save is news the collector must hear.
    expect(appearance().getByRole("alert").textContent).toMatch(/didn't save/);
    expect(appearance().queryByRole("status")).toBeNull();
  });

  it("moves focus back to the restored option when the save fails", async () => {
    theme.preference = "dark";
    saveTheme.mockImplementation(async () => {
      throw new Error("offline");
    });
    render(<SettingsPanel />);
    await act(async () => {
      fireEvent.click(radio("Light"));
    });
    expect(document.activeElement).toBe(radio("Dark"));
  });

  it("leaves focus alone on a failed save once the collector has moved on", async () => {
    theme.preference = "dark";
    let fail: () => void = () => {};
    saveTheme.mockImplementation(
      () => new Promise((_, reject) => (fail = () => reject(new Error("offline")))),
    );
    render(<SettingsPanel />);
    fireEvent.click(radio("Light"));
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    await act(async () => fail());
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("does nothing when the current pick is chosen again", async () => {
    theme.preference = "dark";
    render(<SettingsPanel />);
    await act(async () => {
      fireEvent.click(radio("Dark"));
    });
    expect(calls).toEqual([]);
  });

  it("names the device's current mode only while System is chosen", () => {
    theme.mode = "light";
    const { rerender } = render(<SettingsPanel />);
    expect(screen.getByText("Your device is on light right now.")).toBeTruthy();

    theme.preference = "dark";
    theme.mode = "dark";
    rerender(<SettingsPanel />);
    expect(screen.queryByText(/Your device is on/)).toBeNull();
  });
});

describe("Settings → Binders (NEO-374)", () => {
  it("offers Open on All and Remember the last binder, on All by default", () => {
    binderPreference = { open: "all", lastBinder: null };
    render(<SettingsPanel />);
    const group = binders().getByRole("radiogroup", { name: "When you open your collection" });
    expect(within(group).getByRole("radio", { name: /Open on All/ }).getAttribute("aria-checked")).toBe("true");
    expect(within(group).getByRole("radio", { name: /Remember the last binder/ }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("waits for the saved choice before offering one", () => {
    render(<SettingsPanel />);
    expect(binders().queryByRole("radiogroup")).toBeNull();
    expect(binders().getByText("Loading…")).toBeTruthy();
  });

  it("saves a pick and says so", async () => {
    binderPreference = { open: "all", lastBinder: null };
    saveBinderOpen.mockResolvedValue(null);
    render(<SettingsPanel />);
    await act(async () => {
      fireEvent.click(binders().getByRole("radio", { name: /Remember the last binder/ }));
    });
    expect(saveBinderOpen).toHaveBeenCalledWith({ open: "last" });
    expect(binders().getByRole("status").textContent).toBe("Saved.");
  });

  it("shows the saved choice again and says so when the save fails", async () => {
    binderPreference = { open: "all", lastBinder: null };
    saveBinderOpen.mockRejectedValue(new Error("offline"));
    render(<SettingsPanel />);
    await act(async () => {
      fireEvent.click(binders().getByRole("radio", { name: /Remember the last binder/ }));
    });
    expect(binders().getByRole("alert").textContent).toMatch(/didn't save/);
    expect(binders().getByRole("radio", { name: /Open on All/ }).getAttribute("aria-checked")).toBe("true");
  });
});

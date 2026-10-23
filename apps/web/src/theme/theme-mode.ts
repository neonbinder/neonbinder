/**
 * NEO-356 — the light/dark mode, as pure data. No React here: index.html's
 * pre-paint script repeats `resolveMode` by hand (it runs before any module
 * loads), and theme-mode.test.tsx holds the two to the same key and query.
 */

/** What a collector picks in Settings. "system" follows the device. */
export type ThemePreference = "light" | "dark" | "system";

/** What the page actually renders. `<html data-theme>` is always one of these. */
export type ThemeMode = "light" | "dark";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"];

/** localStorage key for the device's copy of the choice (also read pre-paint). */
export const THEME_STORAGE_KEY = "nb-theme";

/** The media query that says the device is in dark mode. */
export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

/** An explicit choice wins; "system" takes the device's setting. */
export function resolveMode(preference: ThemePreference, systemDark: boolean): ThemeMode {
  if (preference === "light" || preference === "dark") return preference;
  return systemDark ? "dark" : "light";
}

/** The stored choice, or null when there is none, it is junk, or storage is blocked. */
export function readStoredPreference(): ThemePreference | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : null;
  } catch {
    return null;
  }
}

/** Best effort: a private window or blocked storage keeps the choice for this page only. */
export function writeStoredPreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Nothing to do: the mode still applies; the next cold load follows the system.
  }
}

/** Whether the device is in dark mode right now. False where matchMedia is missing. */
export function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(SYSTEM_DARK_QUERY).matches
    : false;
}

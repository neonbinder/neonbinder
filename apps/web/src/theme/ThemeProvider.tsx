import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  readStoredPreference,
  resolveMode,
  SYSTEM_DARK_QUERY,
  systemPrefersDark,
  THEME_STORAGE_KEY,
  isThemePreference,
  writeStoredPreference,
  type ThemeMode,
  type ThemePreference,
} from "./theme-mode";

/**
 * NEO-356 — which mode the page is in, and who decided it.
 *
 * Precedence, highest first:
 *   1. an OVERRIDE: a page that forces a mode while it is mounted (ForceDark on
 *      the NEO-350 prototypes, the collection demo's Light/Dark toggle). It is
 *      never saved and never shows up as `preference`.
 *   2. the PROFILE value, pushed in by ProfileThemeSync while signed in.
 *   3. the device's stored choice (localStorage "nb-theme").
 *   4. the system setting, followed live.
 *
 * The provider sits outside Clerk and Convex because both Radix `<Theme>` and
 * `<ClerkProvider appearance>` take its mode; it writes `<html data-theme>`
 * itself, so portals to <body> follow too. index.html set the same attribute
 * before the first paint, from the same inputs, so mounting does not flash.
 */
export interface ThemeContextValue {
  /** The collector's choice (profile, else this device, else "system"). Never the override. */
  preference: ThemePreference;
  /** Apply a choice now and keep it on this device. Saving it to the profile is the caller's job. */
  setPreference: (preference: ThemePreference) => void;
  /** The mode the page renders: override, else the preference resolved against the system. */
  mode: ThemeMode;
  /** Force a mode while a page is mounted; `null` releases it. */
  setOverride: (mode: ThemeMode | null) => void;
  /** The signed-in collector's saved choice, from ProfileThemeSync; `null` when signed out. */
  setProfilePreference: (preference: ThemePreference | null) => void;
}

function subscribeSystem(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const query = window.matchMedia(SYSTEM_DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Outside a provider (a unit test rendering one component): whatever <html> says, dark by default. */
function fallbackMode(): ThemeMode {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "light"
    ? "light"
    : "dark";
}

const noop = () => {};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<ThemePreference | null>(readStoredPreference);
  const [profile, setProfile] = useState<ThemePreference | null>(null);
  const [override, setOverrideState] = useState<ThemeMode | null>(null);
  const systemDark = useSyncExternalStore(subscribeSystem, systemPrefersDark, () => false);

  const preference: ThemePreference = profile ?? stored ?? "system";
  const mode: ThemeMode = override ?? resolveMode(preference, systemDark);

  // Layout effect: the attribute changes in the same frame React commits, so a
  // switch never paints one frame of the old mode under the new components.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);

  // Another tab changed the device's choice: follow it.
  useLayoutEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      setStored(isThemePreference(event.newValue) ? event.newValue : null);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    writeStoredPreference(next);
    setStored(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      setPreference,
      mode,
      setOverride: setOverrideState,
      setProfilePreference: setProfile,
    }),
    [preference, setPreference, mode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * The current mode and the ways to change it. Outside a ThemeProvider it reads
 * `<html data-theme>` (dark when unset) and every setter is a no-op, so a
 * component under test renders without wrapping.
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context) return context;
  return {
    preference: "system",
    setPreference: noop,
    mode: fallbackMode(),
    setOverride: noop,
    setProfilePreference: noop,
  };
}

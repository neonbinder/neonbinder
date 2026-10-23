import {
  createContext,
  useCallback,
  useContext,
  useId,
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
 *      never saved and never shows up as `preference`. Each forcer holds its
 *      own entry, keyed by owner: the most recent claim wins, and an owner
 *      releasing touches only its own entry, so two forcers mounted at once
 *      (or one route swapping for another in a single commit) never clear
 *      each other. Components claim through `useThemeOverride()`.
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
  /**
   * Force a mode while a page is mounted; `null` releases it. `owner` names
   * whose entry this is (see `useThemeOverride`, which supplies one per
   * component); calls without one share a single default entry.
   */
  setOverride: (mode: ThemeMode | null, owner?: OverrideOwner) => void;
  /** The signed-in collector's saved choice, from ProfileThemeSync; `null` when signed out. */
  setProfilePreference: (preference: ThemePreference | null) => void;
}

/** Who holds an override entry. */
export type OverrideOwner = string;

const DEFAULT_OWNER: OverrideOwner = "default";

interface OverrideEntry {
  owner: OverrideOwner;
  mode: ThemeMode;
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
  // Oldest claim first; the last entry is the one in force.
  const [overrides, setOverrides] = useState<readonly OverrideEntry[]>([]);
  const systemDark = useSyncExternalStore(subscribeSystem, systemPrefersDark, () => false);

  const preference: ThemePreference = profile ?? stored ?? "system";
  const override = overrides.length > 0 ? overrides[overrides.length - 1].mode : null;
  const mode: ThemeMode = override ?? resolveMode(preference, systemDark);

  // Layout effect: the attribute changes in the same frame React commits, so a
  // switch never paints one frame of the old mode under the new components.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);

  // Another tab changed the device's choice: follow it. A `null` key is
  // that tab calling localStorage.clear(), which drops the choice too.
  useLayoutEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null) {
        setStored(null);
        return;
      }
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

  const setOverride = useCallback((next: ThemeMode | null, owner: OverrideOwner = DEFAULT_OWNER) => {
    setOverrides((current) => {
      const others = current.filter((entry) => entry.owner !== owner);
      if (next === null) return others.length === current.length ? current : others;
      // A fresh claim (or a change of mind) moves the owner to the top.
      return [...others, { owner, mode: next }];
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      setPreference,
      mode,
      setOverride,
      setProfilePreference: setProfile,
    }),
    [preference, setPreference, mode, setOverride],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * A setter for this component's own override entry: `force("dark")` claims
 * it (or moves it to the top), `force(null)` releases it. It never touches
 * another component's entry, so a forcer can release on unmount without
 * checking whether it was the one in force. Stable across renders.
 */
export function useThemeOverride(): (mode: ThemeMode | null) => void {
  const owner = useId();
  const { setOverride } = useTheme();
  return useCallback((mode: ThemeMode | null) => setOverride(mode, owner), [setOverride, owner]);
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

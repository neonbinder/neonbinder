/**
 * NEO-356 — the pure mode logic, and the pre-paint script in index.html that
 * repeats it by hand. The script cannot import the module (it runs before any
 * module loads), so these cases run its actual text against the same inputs
 * and hold the two to the same answers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import indexHtml from "@/index.html?raw";
import {
  isThemePreference,
  readStoredPreference,
  resolveMode,
  SYSTEM_DARK_QUERY,
  THEME_STORAGE_KEY,
  writeStoredPreference,
  type ThemePreference,
} from "./theme-mode";

describe("resolveMode", () => {
  it("an explicit choice wins over the system", () => {
    expect(resolveMode("light", true)).toBe("light");
    expect(resolveMode("dark", false)).toBe("dark");
  });

  it("system follows the device", () => {
    expect(resolveMode("system", true)).toBe("dark");
    expect(resolveMode("system", false)).toBe("light");
  });
});

describe("isThemePreference", () => {
  it("accepts the three choices and nothing else", () => {
    for (const ok of ["light", "dark", "system"]) expect(isThemePreference(ok)).toBe(true);
    for (const bad of [null, undefined, "", "Light", "auto", 1]) {
      expect(isThemePreference(bad)).toBe(false);
    }
  });
});

describe("stored preference", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("round-trips through localStorage under the shared key", () => {
    writeStoredPreference("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(readStoredPreference()).toBe("light");
  });

  it("reads junk as no choice", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    expect(readStoredPreference()).toBeNull();
  });

  it("survives blocked storage (private windows)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readStoredPreference()).toBeNull();
    expect(() => writeStoredPreference("dark")).not.toThrow();
  });
});

describe("index.html pre-paint script", () => {
  const script = (() => {
    const match = /<script>([\s\S]*?)<\/script>/.exec(indexHtml);
    if (!match) throw new Error("index.html has no inline pre-paint script");
    return match[1];
  })();

  /** Runs the script's text against a stored value and a system setting. */
  function run(stored: string | null | "throws", systemDark: boolean): string | null {
    const attrs: Record<string, string> = {};
    const fakeWindow = {
      localStorage: {
        getItem: (key: string) => {
          if (stored === "throws") throw new Error("SecurityError");
          return key === THEME_STORAGE_KEY ? stored : null;
        },
      },
      matchMedia: (query: string) => ({ matches: query === SYSTEM_DARK_QUERY && systemDark }),
    };
    const fakeDocument = {
      documentElement: { setAttribute: (name: string, value: string) => (attrs[name] = value) },
    };
    new Function("window", "document", script)(fakeWindow, fakeDocument);
    return attrs["data-theme"] ?? null;
  }

  it("uses the same storage key and media query as the module", () => {
    expect(script).toContain(`"${THEME_STORAGE_KEY}"`);
    expect(script).toContain(`"${SYSTEM_DARK_QUERY}"`);
  });

  it("runs before any stylesheet or module script", () => {
    const at = indexHtml.indexOf(script);
    expect(at).toBeLessThan(indexHtml.indexOf("<link"));
    expect(at).toBeLessThan(indexHtml.indexOf('type="module"'));
  });

  it("agrees with resolveMode for every stored value and system setting", () => {
    const stored: Array<ThemePreference | null> = ["light", "dark", "system", null];
    for (const value of stored) {
      for (const systemDark of [true, false]) {
        expect(run(value, systemDark)).toBe(resolveMode(value ?? "system", systemDark));
      }
    }
  });

  it("follows the system when storage is blocked", () => {
    expect(run("throws", true)).toBe("dark");
    expect(run("throws", false)).toBe("light");
  });

  it("no longer puts the retired `dark` class on <html>", () => {
    expect(indexHtml).not.toMatch(/<html[^>]*class="dark"/);
  });
});

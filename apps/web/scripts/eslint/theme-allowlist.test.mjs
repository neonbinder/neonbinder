/**
 * NEO-356 — the theme lint's allowlists stay honest:
 * - PENDING only names files that exist and still need it, so the list can
 *   only shrink, and a migrated file cannot stay excused by accident;
 * - SHARED_PROTOTYPE_FILES is exactly the set of prototype modules the shipped
 *   demo imports, so a new import cannot hide a light-mode screen behind the
 *   forced-dark prototypes' PERMANENT entry.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WEB_ROOT } from "./no-raw-palette.mjs";
import { lintedFiles, scanFile, sharedPrototypeFiles } from "./scan-theme.mjs";
import { isPermanent, PENDING, PERMANENT, SHARED_PROTOTYPE_FILES } from "./theme-allowlist.mjs";

describe("theme allowlists", () => {
  it("PENDING has no duplicates and no permanent file", () => {
    expect(new Set(PENDING).size).toBe(PENDING.length);
    expect(PENDING.filter(isPermanent)).toEqual([]);
  });

  it("every PENDING file exists", () => {
    expect(PENDING.filter((rel) => !fs.existsSync(path.join(WEB_ROOT, rel)))).toEqual([]);
  });

  it("every PENDING file still has palette classes (delete the line once migrated)", () => {
    expect(PENDING.filter((rel) => scanFile(rel).length === 0)).toEqual([]);
  });

  it("every PERMANENT entry still matches something", () => {
    const files = lintedFiles();
    const dead = PERMANENT.filter((pattern) =>
      pattern.endsWith("/**")
        ? !files.some((f) => f.startsWith(pattern.slice(0, -2)))
        : !files.includes(pattern),
    );
    expect(dead).toEqual([]);
  });

  it("SHARED_PROTOTYPE_FILES is exactly what the shipped demo imports from the prototypes", () => {
    expect([...SHARED_PROTOTYPE_FILES].sort()).toEqual(sharedPrototypeFiles());
  });
});

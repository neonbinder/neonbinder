/**
 * NEO-356 — the theme lint's allowlists stay honest:
 * - nothing outside PERMANENT carries a palette class (the same check the
 *   lint rule makes, run over every file at once);
 * - SHARED_PROTOTYPE_FILES is exactly the set of prototype modules the shipped
 *   demo imports, so a new import cannot hide a light-mode screen behind the
 *   forced-dark prototypes' PERMANENT entry.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WEB_ROOT } from "./no-raw-palette.mjs";
import { lintedFiles, scanFile, sharedPrototypeFiles } from "./scan-theme.mjs";
import { isPermanent, PERMANENT, SHARED_PROTOTYPE_FILES } from "./theme-allowlist.mjs";

describe("theme allowlists", () => {
  it("no file outside PERMANENT carries a palette class", () => {
    expect(lintedFiles().filter((rel) => !isPermanent(rel) && scanFile(rel).length > 0)).toEqual([]);
  });

  it("every PERMANENT entry names something on disk", () => {
    expect(
      PERMANENT.filter((pattern) => !fs.existsSync(path.join(WEB_ROOT, pattern.replace(/\/\*\*$/, "")))),
    ).toEqual([]);
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

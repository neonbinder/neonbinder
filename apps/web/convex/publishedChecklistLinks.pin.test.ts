/**
 * NEO-496 D2 — one writer for `publishedChecklistLinks`.
 *
 * A link says "this variant row uses that section of its set's publisher
 * checklist". Rule 5: a link stays until the operator changes it, so the
 * only code that inserts one is `setRowChecklistSections`
 * (`convex/lib/publishedChecklistSections.ts`), and a replace or remove of
 * the checklist never deletes one. Deletes are allowed only where the row or
 * the set itself goes: the row-delete sweep (`publishedChecklists.ts`,
 * called from `deleteSelectorOption`), the variant-subtree wipe, and the
 * reset's drain. Same shape as `cardPlayerLinks.pin.test.ts`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const CONVEX_DIR = __dirname;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "_generated" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

const rel = (file: string) => file.slice(CONVEX_DIR.length + 1);
const WRITER = "lib/publishedChecklistSections.ts";

describe("NEO-496: only setRowChecklistSections writes publishedChecklistLinks", () => {
  test("no other module inserts a link", () => {
    const offenders = sourceFiles(CONVEX_DIR)
      .filter((file) => rel(file) !== WRITER)
      .filter((file) => /insert\(\s*"publishedChecklistLinks"/.test(readFileSync(file, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
    const writer = readFileSync(join(CONVEX_DIR, WRITER), "utf8");
    expect(writer.match(/insert\(\s*"publishedChecklistLinks"/g)).toHaveLength(1);
    const start = writer.indexOf("export async function setRowChecklistSections(");
    expect(start).toBeGreaterThan(-1);
    expect(writer.indexOf('insert("publishedChecklistLinks"')).toBeGreaterThan(start);
  });

  test("only the sanctioned modules read the table (and so can delete from it)", () => {
    /*
     * - lib/publishedChecklistSections.ts: the writer and its readers.
     * - publishedChecklists.ts: the reads and the row-delete sweep.
     * - wipeVariantTypeSubtree.ts: a wiped row's links go with it.
     * - selectorOptions.ts: the reset drain `resetPublishedChecklistLinksBatch`
     *   only, by NAME and POSITION, so a second query there is still flagged.
     */
    const allowed = new Set([WRITER, "publishedChecklists.ts", "wipeVariantTypeSubtree.ts"]);
    const offenders: string[] = [];
    for (const file of sourceFiles(CONVEX_DIR)) {
      const src = readFileSync(file, "utf8");
      const queries = src.match(/query\(\s*"publishedChecklistLinks"/g) ?? [];
      if (queries.length === 0 || allowed.has(rel(file))) continue;
      if (rel(file) === "selectorOptions.ts") {
        const drain = src.indexOf("export const resetPublishedChecklistLinksBatch");
        if (
          drain !== -1 &&
          queries.length === 1 &&
          src.indexOf('query("publishedChecklistLinks")') > drain
        ) {
          continue;
        }
      }
      offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });

  test("replace and remove never touch the links", () => {
    const src = readFileSync(join(CONVEX_DIR, "publishedChecklists.ts"), "utf8");
    for (const name of ["start", "addSections", "finish", "remove"]) {
      const begin = src.indexOf(`export const ${name} = mutation({`);
      expect(begin, name).toBeGreaterThan(-1);
      const end = src.indexOf("\n});", begin);
      expect(src.slice(begin, end), name).not.toContain("publishedChecklistLinks");
    }
  });
});

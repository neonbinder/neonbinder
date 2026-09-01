/**
 * A Maestro flow's `name:` becomes a DIRECTORY NAME, and that directory gets
 * uploaded as a CI artifact.
 *
 * `maestro test --debug-output` writes each flow's `commands.json`,
 * screenshots and hierarchy dumps into a folder named after the flow's `name:`
 * field. `actions/upload-artifact` then rejects the whole upload if any path
 * contains a character it disallows — so one badly-named flow fails the E2E
 * job **after every flow has already passed**.
 *
 * That is a genuinely confusing failure. It presents as infrastructure ("Upload
 * Maestro report: failure") with a green "Drain the work-queue" step right
 * above it, and the actual cause — a colon someone typed in a flow title — is
 * buried in the upload step's log. It cost a full CI round trip to find:
 *
 *   ##[error]The path for one of the files in artifact is not valid:
 *   /debug/set-selector_checklist-pairing-dialog-cancel/Checklist — the
 *   card-pairing dialog: it opens instead of committing, …/commands.json.
 *   Contains the following character:  Colon :
 *
 * This test moves that discovery into the fast unit lane, which runs long
 * before E2E, and names the cause directly.
 *
 * The convention was already universal — every one of the suite's ~90 flows
 * complied — it was simply never written down or enforced, so the first person
 * to type a colon in a sentence-shaped title broke CI without any way to know.
 */

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FLOWS_DIR = join(APP_ROOT, ".maestro", "flows");

/**
 * Characters `actions/upload-artifact` refuses in a path.
 * Source: its own validation error, which names them one at a time.
 */
const FORBIDDEN = ['"', ":", "<", ">", "|", "*", "?", "\r", "\n"];

/**
 * Every flow that can BE a directory, with its declared `name:` (unquoted).
 *
 * `util`-tagged flows are excluded, and the exclusion is load-bearing rather
 * than cosmetic: they are reusable fragments invoked via `runFlow`, and both
 * schedulers skip them (`flow_has_tag "$f" util && continue` in
 * run-e2e-smoke.sh; "non-util/wip/setup" in e2e.yml's queue seeding). They
 * never run top-level, so they never get a debug directory of their own and
 * their names never reach a path.
 *
 * That distinction is not hypothetical — `util-drill-to-custom-set.yaml` is
 * named "… → 2026 → Topps → <SET_NAME> (custom set) …", which contains angle
 * brackets. Checking it would fail this test for a file that cannot cause the
 * failure, and a guard that flags safe things gets suppressed rather than
 * heeded.
 *
 * `setup.yaml` IS checked: it is excluded from the work queue but runs in the
 * seed job, with debug output, so its name does become a path.
 */
function flowNames() {
  const files = globSync("**/*.yaml", { cwd: FLOWS_DIR });
  return files
    .map((rel) => {
      const text = readFileSync(join(FLOWS_DIR, rel), "utf8");
      // The flow's own `name:` is a top-level key — column 0. Nested `name:`
      // keys inside commands are indented and are not directory names.
      const match = text.match(/^name:\s*(.+)$/m);
      if (!match) return null;
      // Tags live in the leading YAML doc, one per line under `tags:`.
      const header = text.split(/^---$/m)[0];
      const isUtil = /^tags:\s*(?:\n\s*-\s*\S+)*\n\s*-\s*util\s*$/m.test(header)
        || /^\s*-\s*util\s*$/m.test(header);
      if (isUtil) return null;
      const raw = match[1].trim();
      const name = raw.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
      return { rel, name };
    })
    .filter(Boolean);
}

describe("Maestro flow names are usable as artifact paths", () => {
  test("the suite has flows to check (guards against a broken glob)", () => {
    // Without this, a wrong FLOWS_DIR would make every assertion below vacuous
    // and the suite would go green while checking nothing.
    expect(flowNames().length).toBeGreaterThan(50);
  });

  test("no flow name contains a character upload-artifact rejects", () => {
    const offenders = flowNames()
      .map(({ rel, name }) => {
        const bad = FORBIDDEN.filter((c) => name.includes(c));
        return bad.length ? { rel, name, bad } : null;
      })
      .filter(Boolean);

    expect(
      offenders,
      offenders.length
        ? `These flow names become artifact directory names and would fail the ` +
          `E2E upload AFTER every flow passes:\n` +
          offenders
            .map(
              (o) =>
                `  ${o.rel}\n    name: ${o.name}\n    forbidden: ${o.bad
                  .map((c) => JSON.stringify(c))
                  .join(" ")}`,
            )
            .join("\n")
        : "",
    ).toEqual([]);
  });
});

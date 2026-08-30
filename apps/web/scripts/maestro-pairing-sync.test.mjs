/**
 * A flow that drives the card-pairing dialog must wait for the FETCH to finish,
 * not just for the DIALOG to appear.
 *
 * Since NEO-195 the fetch streams: `CardPairingModal` opens on the first
 * reconciled candidates (~6s) rather than on the action's return (~80s). So
 * `Match Cards` becoming visible no longer means the data is complete, and two
 * different things go wrong if a flow assumes it does:
 *
 *   1. **Confirm is inert.** It is gated on `isStreaming`, and `handleConfirm`
 *      returns early while that is true. Tapping it changes nothing, produces
 *      no error, and the failure surfaces on the NEXT assertion — usually a
 *      `notVisible: "Match Cards.*"` that times out, blaming the modal for not
 *      closing when the truth is that Confirm did nothing.
 *   2. **Assertions read a half-filled screen.** Row counts, "N cards will be
 *      saved", and whether a column is empty are all still changing.
 *
 * Both failures cost a CI round trip each on PR #205 — `setup.yaml` hit (1) and
 * `inserts-1996-score-one-nb-set-two-bsc-sources.yaml` hit (2) — and neither is
 * visible to any local gate, because local E2E runs against a different backend
 * and these flows are slow enough that nobody runs them casually.
 *
 * The sync point is the Confirm button's own text, which is what a person would
 * look at: "Loading…" while streaming, "Confirm" once the action resolves.
 *
 *     - extendedWaitUntil:
 *         visible:
 *           text: "^Confirm$"
 *         timeout: 120000
 *
 * ## Opting out
 *
 * A flow that deliberately asserts on the STREAMING state (a progress
 * indicator, a disabled Confirm, a row arriving mid-review) legitimately must
 * not wait for the fetch to finish. Such a flow declares itself:
 *
 *     # maestro-lint: streaming-ok — <why this flow wants the streaming state>
 *
 * The marker is required to carry a reason, so the opt-out cannot become a
 * reflex.
 */

import { describe, expect, test } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FLOWS_DIR = join(APP_ROOT, ".maestro", "flows");

/** Waits on the Confirm button's settled text. */
const SYNC_POINT = /text:\s*"\^Confirm\$"/;
/** `# maestro-lint: streaming-ok — reason` (an em dash or a hyphen, then text). */
const OPT_OUT = /#\s*maestro-lint:\s*streaming-ok\s*[—-]\s*\S+/;
/** The dialog this is about. */
const DRIVES_DIALOG = /Match Cards/;

function flowsDrivingTheDialog() {
  return globSync("**/*.yaml", { cwd: FLOWS_DIR })
    .map((rel) => ({ rel, text: readFileSync(join(FLOWS_DIR, rel), "utf8") }))
    .filter(({ text }) => DRIVES_DIALOG.test(text));
}

describe("flows driving the pairing dialog wait for the fetch, not the dialog", () => {
  test("the glob finds the flows (guards against a vacuous pass)", () => {
    // If FLOWS_DIR or the pattern were wrong this suite would check nothing and
    // still go green — the exact shape of bug it exists to prevent.
    expect(flowsDrivingTheDialog().length).toBeGreaterThanOrEqual(4);
  });

  test("each one waits on Confirm's settled text, or says why it does not", () => {
    const offenders = flowsDrivingTheDialog()
      .filter(({ text }) => !SYNC_POINT.test(text) && !OPT_OUT.test(text))
      .map(({ rel }) => rel);

    expect(
      offenders,
      offenders.length
        ? `These flows open the pairing dialog but never wait for the fetch to ` +
          `finish. Confirm is inert while streaming and the contents are still ` +
          `changing, so they will fail intermittently and blame the wrong step:\n` +
          offenders.map((o) => `  ${o}`).join("\n") +
          `\n\nAdd:\n` +
          `  - extendedWaitUntil:\n      visible:\n        text: "^Confirm$"\n      timeout: 120000\n` +
          `\nOr, if the flow genuinely tests the streaming state, declare it:\n` +
          `  # maestro-lint: streaming-ok — <reason>`
        : "",
    ).toEqual([]);
  });
});

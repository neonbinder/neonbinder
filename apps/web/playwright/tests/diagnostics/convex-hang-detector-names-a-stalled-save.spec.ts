// NEO-409 (R1): when a Convex call never returns, the E2E build names it.
// A save whose server never answers leaves a `[nb-hang]` record naming the
// mutation, with the socket state around it, and the failure snapshot lists
// it as still open.
//
// This proves the harness, not a product feature, so it runs under the
// NEO-409 hang-detector exception (GUIDE rule 9, support/convex-stall.ts):
// the stall is made by swallowing one client frame on the Convex socket, and
// the proof is read from the page console and `window.__NB_HANG`, because a
// hang has no role, label or text handle.
//
// Nothing is written: the swallowed Theme save never reaches the server, so
// the account stays on System for every later spec on this worker (R7).
// expectAccessible is not called: the screen is the theme spec's, checked
// there, and this spec's subject (an open call) is not on screen.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { openCallsSnapshot, stallFirstMutation, waitForHangRecord } from "../../support/convex-stall";

// Lower than the app's 5 s default so the record lands inside the 7 s budget.
test.use({ hangAfterMs: 2_000 });

test(
  "Hang detector: a save the server never answers is named with the socket state",
  { tag: ["@diagnostics"] },
  async ({ page, signIn }) => {
    const stall = await stallFirstMutation(page, "setThemePreference");

    await signIn("/profile/settings");
    const theme = page.getByRole("radiogroup", { name: "Theme" });
    await expect(theme).toBeVisible({ timeout: LAUNCH_GATE });
    const system = theme.getByRole("radio", { name: "System", exact: true });
    await expect(system).toBeChecked();

    const record = waitForHangRecord(page, "setThemePreference", 7_000);
    await theme.getByRole("radio", { name: "Dark", exact: true }).click();
    expect(await stall.swallowed).toContain("setThemePreference");

    // The record names the call, says it is a mutation that has been open at
    // least the threshold, and carries the client's state at that moment.
    const hang = await record;
    expect(hang).toMatchObject({
      kind: "mutation",
      name: expect.stringContaining("setThemePreference"),
      argsHash: expect.stringMatching(/^[0-9a-f]{8}$/),
      state: {
        authPaused: expect.any(Boolean),
        connection: { isWebSocketConnected: true },
      },
    });
    expect(hang.openForMs).toBeGreaterThanOrEqual(2_000);
    const state = hang.state as { connection: { inflightMutations: number } };
    expect(state.connection.inflightMutations).toBeGreaterThanOrEqual(1);

    // What a failing test would attach: the same call, still open.
    const snapshot = (await openCallsSnapshot(page)) as {
      openCalls: Array<{ kind: string; name: string }>;
      recentLines: string[];
    };
    expect(snapshot.openCalls).toContainEqual(
      expect.objectContaining({ kind: "mutation", name: expect.stringContaining("setThemePreference") }),
    );
    expect(snapshot.recentLines.length).toBeGreaterThan(0);

    // The UI never confirmed a save it never got.
    await expect(page.getByRole("main").getByRole("status").filter({ hasText: "Saved." })).toHaveCount(0);
  },
);

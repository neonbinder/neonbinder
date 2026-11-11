/**
 * The arming check for the Set Builder reset (NEO-214), in a module of its own
 * so every reset step can assert it: the batch mutations in `selectorOptions.ts`
 * and, since PR 451 (NEO-482), `bscTeamPool.cancelAllBscTeamChecks`, which the
 * reset calls to empty the BSC team lane.
 *
 * Asserted at BOTH layers of the reset: the entry point and every step it runs.
 *
 * The duplication is the point (NEO-214 security review). There is no identity
 * check anywhere under the reset's entry point, because a CLI run carries no
 * identity (see `resetSetBuilderDataFromCli`), so the flag is the ONLY thing
 * standing between a call and a drained table. Asserting it solely at the entry
 * point would mean a future internal caller (a migration, a cron, a
 * well-meaning `ctx.runMutation`) could empty a table by going straight to a
 * batch. So the check lives next to each delete, which is exactly where the old
 * `requireAdmin` used to sit and for the same defence-in-depth reason.
 *
 * `ConvexError` rather than `Error`: production Convex REDACTS a plain `Error`
 * message, and the whole point of this refusal is to name the flag you have to
 * set.
 */
import { ConvexError } from "convex/values";

export function assertResetArmed(): void {
  if (process.env.ALLOW_RESET_SET_BUILDER_DATA !== "true") {
    throw new ConvexError(
      "Set Builder reset is not armed on this deployment. Set " +
        "ALLOW_RESET_SET_BUILDER_DATA=true on it first " +
        "(`npx convex env set ALLOW_RESET_SET_BUILDER_DATA true`), and " +
        "unset it again afterwards on production.",
    );
  }
}

/**
 * NEO-386 — the scanner script joins an intake run by a short code.
 *
 * The intake screen opens a run over a scanner (stream) placeholder job. The
 * scanner script, signed in as the same collector with their API key (NEO-172),
 * needs that run's job id to upload into. Typing a job UUID at a terminal is
 * hopeless, so the screen shows a six-character code and the script trades it
 * for the run here.
 *
 * SECURITY: the code is not a credential. It is looked up only under the
 * caller's own verified user id, so a guessed code can never reach anyone
 * else's run; all it saves is typing. Everything the script does after the
 * join (sign an upload, confirm it) goes through the placeholder stream
 * functions, which check job ownership themselves.
 */

import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { requireSignedIn } from "./auth";
import { collectionContainerKindValidator } from "./schema";

/** No 0/O, 1/I/L: the code is read off a screen and typed by hand. */
export const SCANNER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const SCANNER_CODE_LENGTH = 6;
/** Fresh codes tried before giving up; a clash is already one in ~10^9. */
const MINT_ATTEMPTS = 5;

/** Upper-case, drop spaces and dashes, so "abc-123" and "ABC123" both join. */
export function normalizeScannerCode(raw: string): string {
  return raw.slice(0, 32).toUpperCase().replace(/[\s-]/g, "");
}

function randomScannerCode(): string {
  const bytes = new Uint8Array(SCANNER_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const b of bytes) code += SCANNER_CODE_ALPHABET[b % SCANNER_CODE_ALPHABET.length];
  return code;
}

async function runByCode(
  ctx: QueryCtx,
  userId: string,
  code: string,
): Promise<Doc<"intakeRuns"> | null> {
  return await ctx.db
    .query("intakeRuns")
    .withIndex("by_user_and_scanner_code", (q) => q.eq("userId", userId).eq("scannerCode", code))
    .first();
}

/**
 * The run's scanner code, minted on first ask. The screen calls this when the
 * collector chooses "Use a scanner".
 */
export const scannerCodeForIntakeRun = mutation({
  args: { runId: v.id("intakeRuns") },
  returns: v.string(),
  handler: async (ctx, args) => {
    const userId = await requireSignedIn(ctx);
    const run = await ctx.db.get(args.runId);
    if (!run || run.userId !== userId) throw new Error("Intake run not found");
    if (run.scannerCode) return run.scannerCode;
    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
      const code = randomScannerCode();
      if (await runByCode(ctx, userId, code)) continue;
      await ctx.db.patch(run._id, { scannerCode: code });
      return code;
    }
    throw new Error("Couldn't make a scanner code. Try again.");
  },
});

const joinedRunValidator = v.object({
  runId: v.id("intakeRuns"),
  jobId: v.string(),
  homeName: v.string(),
  homeKind: collectionContainerKindValidator,
  variantName: v.optional(v.string()),
  // False once the run stops taking cards: the collector pressed done, or the
  // stream went idle and was closed. The script then asks for a new run.
  collecting: v.boolean(),
});

/**
 * The caller's run with this code, for the scanner script. Null when the
 * caller has no run with that code.
 */
export const joinIntakeRunByScannerCode = query({
  args: { code: v.string() },
  returns: v.union(joinedRunValidator, v.null()),
  handler: async (ctx, args) => {
    const userId = await requireSignedIn(ctx);
    const code = normalizeScannerCode(args.code);
    if (code.length !== SCANNER_CODE_LENGTH) return null;
    const run = await runByCode(ctx, userId, code);
    if (!run) return null;
    const home = await ctx.db.get(run.homeId);
    if (!home) return null;
    const variant = run.variantId ? await ctx.db.get(run.variantId) : null;
    const job = await ctx.db
      .query("placeholderJobs")
      .withIndex("by_job", (q) => q.eq("jobId", run.jobId))
      .unique();
    return {
      runId: run._id,
      jobId: run.jobId,
      homeName: home.name,
      homeKind: home.kind,
      variantName: variant?.value,
      collecting: job?.mode === "stream" && job.status === "collecting",
    };
  },
});

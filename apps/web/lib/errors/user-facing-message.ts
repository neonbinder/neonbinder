import { ConvexError } from "convex/values";

/**
 * The message a USER should see for a failed Convex call.
 *
 * Two things make this necessary, and both have bitten this codebase:
 *
 * 1. **Production redacts plain Errors.** A `throw new Error("…")` in a Convex
 *    function reaches the client as "Server Error" on prod, while dev and
 *    preview pass the text straight through. So an actionable message written
 *    as an Error reads perfectly all through testing and flattens the moment it
 *    matters. Found live on a real postage purchase, where EasyPost's
 *    "Insufficient funds… check your billing settings" reached the seller as
 *    "Server Error".
 *
 * 2. **`.message` is operator noise even when it survives.** The client wrapper
 *    prefixes it — the literal string a seller saw was
 *    "[CONVEX A(postage:buyLetterLabel)] [Request ID: …] Server Error…". Only a
 *    ConvexError's `data` crosses intact and clean.
 *
 * So: a ConvexError carrying a string is the message the backend deliberately
 * chose to send a person, and is used verbatim. Anything else — a plain Error,
 * a network failure, a thrown non-Error — gets the caller's fallback. `.message`
 * is never shown.
 *
 * `lib/shipping/postage-error.ts` is the seller-facing wrapper over this and
 * predates it; the logic lives here once so a third caller does not copy it a
 * third time.
 */
export function userFacingMessage(error: unknown, fallback: string): string {
  if (error instanceof ConvexError && typeof error.data === "string") {
    return error.data;
  }
  return fallback;
}

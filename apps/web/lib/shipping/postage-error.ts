import { userFacingMessage } from "../errors/user-facing-message";

/**
 * The seller-facing message for a failed postage/credential action.
 *
 * Only a ConvexError's data crosses the prod boundary intact: production
 * Convex redacts thrown plain-Error messages to "Server Error", and the
 * client-side wrapper's `.message` is operator noise either way
 * ("[CONVEX A(postage:buyLetterLabel)] [Request ID: …] Server Error…" — the
 * literal string a seller saw on the first real purchase attempt). So: a
 * ConvexError with string data is the actionable message the backend chose to
 * send; anything else gets the caller's fallback, never `.message`.
 */
export function sellerMessage(error: unknown, fallback: string): string {
  // The rule is not postage-specific — see lib/errors/user-facing-message.ts.
  // This stays as the seller-facing name the shipping code reads better with.
  return userFacingMessage(error, fallback);
}

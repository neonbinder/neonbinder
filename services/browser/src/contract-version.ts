/**
 * The version of the HTTP contract this browser service speaks with Convex.
 *
 * WHY THIS EXISTS (NEO-143)
 *
 * Convex and this service deploy from the same commit but not at the same
 * moment, so every release passes through a window where one side is new and
 * the other is old. Merging NEO-141 turned that window into a production
 * outage: NEO-141 moved the marketplace password from a stored secret onto a
 * transient field of the login request, and for ~5.5 minutes new Convex sent
 * the new shape to the OLD service. The old service did not know the field,
 * ignored it, read the secret that had just been cleared, and failed.
 *
 * The dangerous half was not the loud failure. It was this: when a stored
 * secret still held a password, the old service logged in with THAT instead of
 * what the user had just typed — a credential change that appears to succeed
 * while silently using the old password. No error anywhere.
 *
 * This number makes that impossible. Convex checks it before it speaks a shape
 * the live service may not understand, and fails loudly instead of letting the
 * service guess.
 *
 * WHEN TO BUMP
 *
 * Bump when you change the request or response shape of any endpoint Convex
 * calls in a way an older Convex or an older service would misinterpret:
 *   - adding a field the service must ACT on (not merely tolerate)
 *   - changing the meaning of an existing field
 *   - removing or renaming a field Convex sends or reads
 *   - changing status-code semantics Convex branches on
 *
 * Do NOT bump for additive fields that an older peer can safely ignore, or for
 * internal refactors that leave the wire shape identical.
 *
 * HOW TO SHIP A BUMP (expand/contract — this is not optional)
 *
 * The service must be able to speak the new shape BEFORE Convex starts using
 * it, because release.yml promotes this service to 100% before it pushes
 * Convex. So:
 *   1. Release N:   teach this service the new shape while it still accepts the
 *                   old one, and bump CONTRACT_VERSION here.
 *   2. Release N+1: raise REQUIRED_CONTRACT_VERSION in
 *                   apps/web/convex/credentials.ts to match, and switch Convex
 *                   to the new shape.
 *
 * Doing both in one release only works because of the deploy ordering, and it
 * leaves no room for error if the ordering ever changes — prefer two releases
 * for anything where the silent-fallback mode above is possible.
 *
 * See services/browser/README.md ("Release contract") for the full rule.
 */
export const CONTRACT_VERSION = 1;

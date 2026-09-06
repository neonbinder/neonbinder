/**
 * NEO-251 — the bound on a single player name, in the one place every side of
 * the wire can read it.
 *
 * It lives in `lib/` rather than in `convex/players.ts` because the number now
 * has three enforcement points and they must not be able to disagree:
 *
 *  1. `convex/players.ts` — the write path, where an over-length name is
 *     refused rather than trimmed (silently storing something other than what
 *     was typed is how a mangled name becomes canonical for every listing
 *     title and spine label downstream).
 *  2. `convex/adapters/sportlots.ts` — the parse path, so an adapter cannot
 *     mint a subject the mutations would reject.
 *  3. `components/SetSelector/CardPairingModal.tsx` — the operator's own
 *     custom-roster field, so they find out while the field is still in front
 *     of them rather than at the end of a 900-card commit.
 *
 * The modal is a browser bundle and `convex/players.ts` pulls in
 * `./_generated/server`, so the constant could not have stayed there and been
 * shared with (3). Same value and same reasoning as
 * `teams.MAX_TEAM_NAME_LENGTH`.
 */
export const MAX_PLAYER_NAME_LENGTH = 120;

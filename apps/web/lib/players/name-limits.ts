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

/**
 * NEO-254 — how many same-name rows any lookup reads before it stops counting.
 *
 * Not a page size: the server only ever branches on "none / exactly one / more
 * than one", and the third answer is settled by the second row. Reading a
 * bounded window rather than collecting keeps a pathological name — a
 * checklist header that normalizes to something a thousand rows share — from
 * turning a per-name lookup inside a commit into an unbounded read. Eight
 * leaves room for the candidate list the review wizard renders while staying
 * trivially cheap.
 *
 * In `lib/` for the same reason `MAX_PLAYER_NAME_LENGTH` is, and it is the
 * same kind of fact: the wizard's candidate panel has to know the number too,
 * because a list exactly this long means "at least eight" and it has to say
 * so rather than imply the operator has seen everyone.
 */
export const PLAYER_AMBIGUITY_SCAN_LIMIT = 8;

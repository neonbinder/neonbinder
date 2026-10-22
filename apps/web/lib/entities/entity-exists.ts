/**
 * NEO-339 — "Create" never links to a row that is already on file.
 *
 * `players.findOrCreate` and `teams.findOrCreate` are find-OR-create: hand
 * them a name the sport already holds and they return that row. That is right
 * for a caller that means "link this card to whoever this is", and wrong for
 * one whose control says "+ Create": the operator asked for a new row and got
 * an old one, with nothing on screen saying so.
 *
 * So both mutations take `createOnly: true`. With it they never return an
 * existing row; they refuse with one of the two structured refusals below,
 * naming the rows already on file so the caller can offer "use that one"
 * instead. The rule (`playerCreateRefusal`) and the refusal's shape live here,
 * in one pure module, because three surfaces must agree on them: the server
 * (which enforces), the web pickers (which render the refusal) and the
 * set-building tool (which plans against the rule before it writes).
 *
 * Pure and env-free: no React, no `convex/react`, only relative imports, so a
 * Node script and the Convex runtime can both load it.
 */

import { ConvexError } from "convex/values";

/** The most rows a refusal names. Enough to pick from; never a dump. */
export const MAX_EXISTING_NAMED = 5;

export type ExistingPlayer = {
  id: string;
  name: string;
  birthYear?: number;
};

/**
 * Why a player create was refused.
 *
 *  - `sameName`: one player already answers to the name, whatever year was given.
 *  - `noBirthYear`: several do, and nothing tells a new one apart from them.
 *  - `sameBirthYear`: one of them was born in the year given.
 *  - `undatedRival`: one of them has no birth year, so it could be this man.
 *  - `tooMany`: the name matches more rows than the check can read.
 */
export type PlayerCreateRefusalReason =
  | "sameName"
  | "noBirthYear"
  | "sameBirthYear"
  | "undatedRival"
  | "tooMany";

export type PlayerExistsRefusal = {
  code: "PLAYER_EXISTS";
  reason: PlayerCreateRefusalReason;
  /** The name as the caller typed it (trimmed). */
  name: string;
  birthYear?: number;
  /** How many rows answer to the name (at most the scan limit). */
  count: number;
  /** The rows on file, at most `MAX_EXISTING_NAMED`. */
  players: ExistingPlayer[];
};

export type ExistingTeam = {
  id: string;
  /** The FULL name ("Kansas City Monarchs"). */
  name: string;
  /** `eraLabel`'s "1920–1965", or "" for an undated row. */
  years: string;
};

export type TeamExistsRefusal = {
  code: "TEAM_EXISTS";
  /** The full name the create would have written. */
  name: string;
  teams: ExistingTeam[];
};

/**
 * The create-only rule for a player: may a NEW row be inserted beside these
 * same-name candidates, or is the create refused (and why)?
 *
 * `candidates` are the rows that answer to the name in the sport (primary
 * name, alias, or sport membership — `sameNamePlayers`). `scanLimit` is the
 * cap that read was taken under: a full window means rows past it were never
 * seen, so a fork cannot be proven safe.
 *
 * A create is allowed only when nothing answers to the name, or when several
 * do, every one of them is dated, and none was born in `birthYear`. One
 * same-name player is always a refusal, because a picker cannot tell "the man
 * we have" from "a second man of that name" and adopting either way is a
 * guess; Player Management is where a second same-name player is added.
 */
export function playerCreateRefusal(
  candidates: ReadonlyArray<{ birthYear?: number }>,
  birthYear: number | undefined,
  scanLimit: number,
): PlayerCreateRefusalReason | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return "sameName";
  if (birthYear === undefined) return "noBirthYear";
  if (candidates.length >= scanLimit) return "tooMany";
  if (candidates.some((c) => c.birthYear === birthYear)) return "sameBirthYear";
  if (candidates.some((c) => c.birthYear === undefined)) return "undatedRival";
  return null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The structured "already on file" refusal an error carries, or null.
 *
 * Narrowed field by field rather than trusted: `data` crosses a network
 * boundary, and a malformed payload must read as "not this refusal", never as
 * a render crash on the screen the operator is already being refused on.
 */
export function entityExistsRefusal(
  err: unknown,
): PlayerExistsRefusal | TeamExistsRefusal | null {
  const data =
    err instanceof ConvexError
      ? (err.data as unknown)
      : isObj(err) && "data" in err
        ? (err as { data: unknown }).data
        : undefined;
  if (!isObj(data) || typeof data.name !== "string") return null;
  if (data.code === "PLAYER_EXISTS") {
    if (!Array.isArray(data.players) || typeof data.reason !== "string") return null;
    const players = data.players.flatMap((p: unknown): ExistingPlayer[] =>
      isObj(p) && typeof p.id === "string" && typeof p.name === "string"
        ? [{ id: p.id, name: p.name, ...(typeof p.birthYear === "number" ? { birthYear: p.birthYear } : {}) }]
        : [],
    );
    return {
      code: "PLAYER_EXISTS",
      reason: data.reason as PlayerCreateRefusalReason,
      name: data.name,
      ...(typeof data.birthYear === "number" ? { birthYear: data.birthYear } : {}),
      count: typeof data.count === "number" ? data.count : players.length,
      players,
    };
  }
  if (data.code === "TEAM_EXISTS") {
    if (!Array.isArray(data.teams)) return null;
    const teams = data.teams.flatMap((t: unknown): ExistingTeam[] =>
      isObj(t) && typeof t.id === "string" && typeof t.name === "string"
        ? [{ id: t.id, name: t.name, years: typeof t.years === "string" ? t.years : "" }]
        : [],
    );
    return { code: "TEAM_EXISTS", name: data.name, teams };
  }
  return null;
}

/** "Mike Trout (born 1991)" — how a row on file is named on its "Use" button. */
export function existingPlayerLabel(p: ExistingPlayer): string {
  return p.birthYear !== undefined ? `${p.name} (born ${p.birthYear})` : p.name;
}

/** "Kansas City Monarchs · 1920–1965" — the pickers' own era label. */
export function existingTeamLabel(t: ExistingTeam): string {
  return t.years ? `${t.name} · ${t.years}` : t.name;
}

/**
 * The sentence a player refusal shows. DRAFT copy (NB voice). Says what is
 * already on file and what to do; the "Use …" buttons beside it are the way.
 */
export function playerExistsText(r: PlayerExistsRefusal): string {
  switch (r.reason) {
    case "sameName":
      return `${r.name} is already in the binder. Use that player instead of adding a second one.`;
    case "noBirthYear":
      return `${r.count} players are already filed under ${r.name}. Pick the one on this card.`;
    case "sameBirthYear":
      return `A ${r.name} born ${r.birthYear} is already in the binder. Use that player instead.`;
    case "undatedRival":
      return `${r.name} is already on file with no birth year, so a new one can't be told apart. Pick the one on this card.`;
    case "tooMany":
      return `${r.name} matches ${r.count} or more players — too many to tell a new one apart. Pick the one on this card.`;
  }
}

/** The sentence a team refusal shows. DRAFT copy (NB voice). */
export function teamExistsText(r: TeamExistsRefusal): string {
  return r.teams.length > 1
    ? `${r.name} already names ${r.teams.length} teams in this sport. Use the one on this card.`
    : `${r.name} is already a team in this sport. Use it instead of adding a second one.`;
}

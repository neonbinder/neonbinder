/**
 * NEO-339 — answering the cards `listCardAttention` lists, through the exact
 * writes the walker's fixers make, with the same gates.
 *
 * | Answer                 | Fixer                 | Write                                                  |
 * |------------------------|-----------------------|--------------------------------------------------------|
 * | `{ players, teams? }`  | MissingPlayerFixer    | `selectorOptions.updateCard { id, playerIds, teams? }` |
 * | `{ noPlayer: true }`   | "No player on this card"| `cardChecklist.confirmCardNoPlayer { cardId }`       |
 * | `{ teams }` (missing)  | MissingTeamFixer Save | `selectorOptions.updateCard { id, teamOnCardIds }`     |
 * | `{ noTeam: true }`     | "No team on this card"| `cardChecklist.confirmCardNoTeam { cardId }`           |
 * | `{ players?, teams? }` | UnreviewedNameFixer   | `updateCard { id, playerIds, teamOnCardIds, pending… }`|
 * | `{ title, variation? }`| TitleFixer Save       | `updateCard { id, listingTitle, cardVariation? }`      |
 *
 * And per row, the checklist header's autograph prompt (NEO-345, the end of
 * this file): `autographs[i] = { row, format }` through the prompt's own
 * `autographFormat.setAutographFormat { selectorOptionId, value }`.
 *
 * The gates, each the fixer's own:
 *  - a player Save (NEO-339) needs 1–20 players (`MAX_CARD_PLAYERS`); teams
 *    ride along only on a card that is missing its team too;
 *  - `confirmCardNoPlayer` answering `confirmed: false` (the card names a
 *    player now, or is gone) is a refusal, not a fix;
 *  - a team Save needs 1–8 teams (`MAX_CARD_TEAMS`, refused past it, never
 *    trimmed);
 *  - `confirmCardNoTeam` answering `confirmed: false` (the card has teams now,
 *    or is gone) is a refusal, not a fix;
 *  - a names Save must CLEAR the card (`clearsCard`: every side with typed
 *    names gains a link) and must change something;
 *  - a title over 80 characters (after trimming, as the server measures it) is
 *    refused before the write, in the server's own sentence;
 *  - a variation over 65 is WRITTEN, with a warning, as the fixer allows (warn
 *    only; the server does not cap it), and the card stays listed.
 *
 * Two phases. Everything is resolved first, with no write: every card address
 * (exactly-one by row + card number, `cardId` breaking a tie, invariant 7),
 * every team and player an answer names (exactly-one, a `ResolveError` with
 * the candidates otherwise; ties are never given to the first). Then the
 * answers apply in order, each gated on the card as it stands at that moment:
 * an answer whose question the card no longer asks is a reported no-op
 * (`moot`), like `matchReview`'s `mootUnmatched`.
 *
 * Invariant 8: a team answer is always an explicit NB team (a name that
 * resolves to one row, an era, or a New Team create). The listing's team name
 * is never an answer and is never written.
 *
 * `create` answers mint global rows through the pickers' own "+ Create"
 * (`teams.findOrCreate`, `players.findOrCreate`), only once the card's gate
 * has passed; each one is reported in `created`. A create only ever CREATES:
 * both mutations are find-or-create, and would quietly hand back an existing
 * row (one same-name player, whatever the birthYear; a player born that year;
 * a team holding that name or alias). Every such answer is refused while
 * resolving, with the existing rows as candidates, so linking one is always
 * the operator's explicit `link` / team-name answer. Should the server still
 * return a row that was on file, the card is not written.
 */

import { ConvexError } from "convex/values";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  ATTENTION_LABELS,
  MAX_CARD_PLAYERS,
  MAX_CARD_TEAMS,
  deriveCardAttention,
  type AttentionKind,
} from "../../../components/SetSelector/card-attention";
import { ASPECT_VALUE_MAX, titleLengthState } from "../../../components/SetSelector/TitleLengthMeter";
import { teamOptionLabel } from "../../../lib/teams/team-era";
import {
  entityExistsRefusal,
  existingPlayerLabel,
  existingTeamLabel,
  playerCreateRefusal,
  playerExistsText,
  teamExistsText,
} from "../../../lib/entities/entity-exists";
import { listingTitleRefusal } from "../../../lib/cards/listing-title-gate";
import {
  NOTHING_TO_CHANGE,
  unreviewedNameGate,
  unreviewedNameSidesOpen,
  unreviewedNameWrite,
} from "../../../lib/set-build/unreviewed-name-gate";
import { teamFullName } from "../../../lib/teams/team-name";
import type { NbClient } from "../client/convex-client";
import { ResolveError, type ResolveCandidate } from "../service";
import type { ResolvedSet, RowId } from "../spec/resolve";
import {
  TITLE_KINDS,
  attentionSetOf,
  readChecklist,
  resolveAttentionRow,
  type AttentionRowNode,
  type AttentionSetTarget,
  type CardAnswer,
  type CardAnswerKind,
  type CardFixAnswer,
  type CardRowRef,
  type ChecklistCard,
  type PlayerAnswer,
  type TeamAnswer,
} from "./attention";
import { PLAYER_LINK_SCAN_LIMIT, birthYearsText, pickPlayerByBirthYear } from "./review";
import {
  AUTOGRAPH_CHOICE_LABEL,
  AUTOGRAPH_FORMATS,
  asAutographFormat,
  autographPromptCount,
  autographPromptParallels,
  autographPromptSaved,
  countUnformattedAutographs,
  type AutographFormat,
} from "../../../components/SetSelector/autograph-prompt";
import { isAutographFormat } from "../../../convex/features/deriveCardFeatures";

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** A team or player a `create` answer minted. */
export interface CreatedRow {
  kind: "team" | "player";
  name: string;
  id: string;
}

export interface CardFixResult {
  /** `cards[i]`: which answer. */
  at: string;
  card: { row: CardRowRef; rowLabel: string; cardNumber: string; cardName: string; cardId: string };
  /** The fixer the answer went through. */
  answered: CardAnswerKind;
  outcome: "applied" | "moot" | "refused";
  detail: string;
  warning?: string;
  created?: CreatedRow[];
  /** What the card still needs after this run (`ATTENTION_LABELS` text); absent when it could not be re-read. */
  stillNeeds?: string[];
}

/** An answer that is not one of the shapes `CardAnswer` allows. Thrown before any read. */
export class CardAnswerError extends Error {
  readonly at: string;
  constructor(at: string, message: string) {
    super(`${at}: ${message}`);
    this.name = "CardAnswerError";
    this.at = at;
  }
}

/**
 * A failure that is not a refusal (network, auth, a server fault) part-way
 * through the writes. Carries the results of the answers before it, so what
 * was written is never unreported.
 */
export class CardFixAborted extends Error {
  readonly results: CardFixResult[];
  readonly cause: unknown;
  constructor(results: CardFixResult[], cause: unknown, at: string) {
    super(`${at}: stopped after ${results.length} answer(s): ${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}`);
    this.name = "CardFixAborted";
    this.results = results;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Answer shapes (pure)
// ---------------------------------------------------------------------------

type AnswerShape = "noPlayer" | "noTeam" | "title" | "links";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Which fixer an answer is for, refusing a shape that is none of them. */
export function answerShape(answer: CardAnswer, at: string): AnswerShape {
  if (!isObj(answer)) throw new CardAnswerError(at, "an answer is an object.");
  const keys = Object.keys(answer).filter((k) => (answer as Record<string, unknown>)[k] !== undefined);
  if ("noPlayer" in answer && answer.noPlayer !== undefined) {
    if (answer.noPlayer !== true || keys.length !== 1) throw new CardAnswerError(at, '"noPlayer" is `true` and stands alone.');
    return "noPlayer";
  }
  if ("noTeam" in answer && answer.noTeam !== undefined) {
    if (answer.noTeam !== true || keys.length !== 1) throw new CardAnswerError(at, '"noTeam" is `true` and stands alone.');
    return "noTeam";
  }
  if ("title" in answer && answer.title !== undefined) {
    if (typeof answer.title !== "string") throw new CardAnswerError(at, '"title" is the title text.');
    if (keys.some((k) => k !== "title" && k !== "variation")) throw new CardAnswerError(at, 'a title answer takes "title" and "variation" only.');
    if ("variation" in answer && answer.variation !== undefined && typeof answer.variation !== "string") {
      throw new CardAnswerError(at, '"variation" is the variation text.');
    }
    return "title";
  }
  const links = answer as { players?: unknown; teams?: unknown };
  if (keys.some((k) => k !== "players" && k !== "teams")) {
    throw new CardAnswerError(at, 'an answer is { players }, { noPlayer: true }, { teams }, { noTeam: true }, { players, teams } or { title, variation }.');
  }
  if (links.players === undefined && links.teams === undefined) {
    throw new CardAnswerError(at, 'name "teams", "players", or both.');
  }
  if (links.players !== undefined && !Array.isArray(links.players)) throw new CardAnswerError(at, '"players" is a list.');
  if (links.teams !== undefined && !Array.isArray(links.teams)) throw new CardAnswerError(at, '"teams" is a list.');
  return "links";
}

// ---------------------------------------------------------------------------
// Resolution (reads only)
// ---------------------------------------------------------------------------

/** "#103b" and "103B" are one spelling of a card number; nothing else is folded. */
export function foldCardNumber(n: string): string {
  return n.trim().replace(/^#\s*/, "").toLowerCase();
}

function cardCandidate(c: ChecklistCard): ResolveCandidate {
  return { id: String(c._id), name: `#${c.cardNumber} ${c.cardName}` };
}

/**
 * The one card an answer addresses on its checklist. Pure. A number on two
 * cards needs the `cardId` of the one meant (invariant 7: never the first).
 */
export function pickCard(cards: readonly ChecklistCard[], cardNumber: string, cardId: string | undefined, rowLabel: string, at: string): ChecklistCard {
  const key = foldCardNumber(cardNumber);
  const byNumber = cards.filter((c) => foldCardNumber(c.cardNumber) === key);
  if (cardId !== undefined) {
    const hit = byNumber.find((c) => String(c._id) === cardId);
    if (hit) return hit;
    const elsewhere = cards.find((c) => String(c._id) === cardId);
    throw new ResolveError({
      kind: "card",
      query: `#${cardNumber}`,
      at: `${at}.cardId`,
      candidates: byNumber.map(cardCandidate),
      message: elsewhere
        ? `Card ${cardId} on ${rowLabel} is #${elsewhere.cardNumber}, not #${cardNumber}.`
        : `No card ${cardId} on ${rowLabel}.`,
    });
  }
  if (byNumber.length === 1) return byNumber[0];
  throw new ResolveError({
    kind: "card",
    query: `#${cardNumber}`,
    at: `${at}.cardNumber`,
    candidates: byNumber.map(cardCandidate),
    message:
      byNumber.length === 0
        ? `No card numbered #${cardNumber} on ${rowLabel}.`
        : `#${cardNumber} is on ${byNumber.length} cards on ${rowLabel}; add the cardId of the one you mean.`,
  });
}

type TeamPlan =
  | { kind: "link"; id: Id<"teams">; name: string }
  | { kind: "create"; name: string; location?: string; league?: string; fullName: string; onFile: string[] };

type PlayerPlan =
  | { kind: "link"; id: Id<"players">; name: string }
  | { kind: "create"; name: string; birthYear?: number; onFile: string[] };

interface TeamOption {
  id: Id<"teams">;
  fullName: string;
  yearsActive?: { from: number; to?: number };
  label: string;
}

function eraText(y: { from: number; to?: number } | undefined): string | undefined {
  return y ? `${y.from}–${y.to ?? ""}` : undefined;
}

/**
 * The NB teams a name could mean: the rows the sport holds under that full
 * name (`erasByNameAndSport`, the pickers' identity lookup), or, when none,
 * the exact hits of `nearMatches` (a name a team answers to as an alias).
 */
async function teamOptions(client: NbClient, sportId: Id<"selectorOptions">, name: string): Promise<{ options: TeamOption[]; close: ResolveCandidate[] }> {
  const eras = await client.query(api.teams.erasByNameAndSport, { name, sportId });
  if (eras.length > 0) {
    return {
      options: eras.map((e) => ({ id: e._id, fullName: teamFullName(e), yearsActive: e.yearsActive, label: e.label })),
      close: [],
    };
  }
  const hits = await client.query(api.teams.nearMatches, { name, sportId, limit: 25 });
  const exact = hits.filter((h) => h.confidence === "exact");
  return {
    options: exact.map((h) => ({ id: h._id, fullName: h.name, yearsActive: h.yearsActive, label: teamOptionLabel(h.name, h.yearsActive) })),
    close: hits.filter((h) => h.confidence === "close").map((h) => ({ id: String(h._id), name: h.name, detail: eraText(h.yearsActive) })),
  };
}

function teamCandidates(options: readonly TeamOption[]): ResolveCandidate[] {
  return options.map((o) => ({ id: String(o.id), name: o.label, detail: eraText(o.yearsActive) }));
}

/** The one NB team a team answer names, or the plan to create it. Reads only. */
export async function resolveTeamAnswer(client: NbClient, sportId: Id<"selectorOptions">, answer: TeamAnswer, at: string): Promise<TeamPlan> {
  if (isObj(answer) && "create" in answer) {
    const c = isObj(answer.create) ? answer.create : undefined;
    const name = typeof c?.name === "string" ? c.name.trim() : "";
    if (!c || name === "") throw new CardAnswerError(at, 'a team "create" names the team: { "location": "Wisconsin", "name": "Badgers" }.');
    const location = typeof c.location === "string" && c.location.trim() !== "" ? c.location.trim() : undefined;
    const league = typeof c.league === "string" && c.league.trim() !== "" ? c.league.trim() : undefined;
    const fullName = teamFullName({ name, location });
    // `teams.findOrCreate` returns the row it finds: one era under the name
    // (an undated row overlaps any), or a team that answers to it as an alias.
    // A create must never link, so any team already holding the name refuses.
    const eras = await client.query(api.teams.erasByNameAndSport, { name: fullName, sportId });
    if (eras.length > 0) {
      throw new ResolveError({
        kind: "team",
        query: fullName,
        at,
        candidates: eras.map((e) => ({ id: String(e._id), name: e.label, detail: eraText(e.yearsActive) })),
        message:
          eras.length === 1
            ? `"${fullName}" is already a team in this sport; answer with "${fullName}" to put that team on the card instead of creating one.`
            : `"${fullName}" already names ${eras.length} teams in this sport; answer with { "name", "from" } for the one on the card instead of creating one.`,
      });
    }
    const hits = await client.query(api.teams.nearMatches, { name: fullName, sportId, limit: 25 });
    const aliasOf = hits.filter((h) => h.confidence === "exact");
    if (aliasOf.length > 0) {
      throw new ResolveError({
        kind: "team",
        query: fullName,
        at,
        candidates: aliasOf.map((h) => ({ id: String(h._id), name: h.name, detail: h.matchedAlias ? `also known as "${h.matchedAlias}"` : eraText(h.yearsActive) })),
        message: `"${fullName}" is already a name of ${aliasOf.length === 1 ? "a team" : `${aliasOf.length} teams`} in this sport; answer with that team instead of creating one.`,
      });
    }
    return { kind: "create", name, fullName, onFile: [], ...(location ? { location } : {}), ...(league ? { league } : {}) };
  }
  const ref = typeof answer === "string" ? { name: answer } : isObj(answer) ? answer : undefined;
  const name = typeof ref?.name === "string" ? ref.name.trim() : "";
  if (!ref || name === "") throw new CardAnswerError(at, 'a team is a name, { "name", "from" }, or { "create": { "location", "name" } }.');
  const { options, close } = await teamOptions(client, sportId, name);
  let pool = options;
  if (ref.id !== undefined) pool = pool.filter((o) => String(o.id) === ref.id);
  if (ref.from !== undefined) pool = pool.filter((o) => o.yearsActive?.from === ref.from);
  if (pool.length === 1) return { kind: "link", id: pool[0].id, name: pool[0].label };
  if (options.length === 0) {
    throw new ResolveError({ kind: "team", query: name, at, candidates: close, message: `No team named "${name}" in this sport.` });
  }
  const asked = [ref.from !== undefined ? `from ${ref.from}` : "", ref.id !== undefined ? `id ${ref.id}` : ""].filter(Boolean).join(", ");
  throw new ResolveError({
    kind: "team",
    query: name,
    at,
    candidates: teamCandidates(options),
    message:
      pool.length === 0
        ? `No "${name}" team matches ${asked}.`
        : `"${name}" names ${pool.length} teams in this sport; answer with { "name", "from" } (or "id") for the one on the card.`,
  });
}

type PlayerHit = { _id: Id<"players">; name: string; confidence: "exact" | "close"; birthYear?: number; matchedAlias?: string };

function playerCandidate(h: PlayerHit): ResolveCandidate {
  const detail = [h.birthYear ? `born ${h.birthYear}` : "", h.matchedAlias ? `alias "${h.matchedAlias}"` : ""].filter(Boolean).join(", ");
  return { id: String(h._id), name: h.name, ...(detail ? { detail } : {}) };
}

/** The one NB player a player answer names, or the plan to create one. Reads only. */
export async function resolvePlayerAnswer(client: NbClient, sportId: Id<"selectorOptions">, answer: PlayerAnswer, at: string): Promise<PlayerPlan> {
  if (isObj(answer) && "create" in answer) {
    const name = typeof answer.create === "string" ? answer.create.trim() : "";
    if (name === "") throw new CardAnswerError(at, 'a player "create" is the name: { "create": "Wyatt Langford" }.');
    const hits = await client.query(api.players.nearMatches, { name, sportId, limit: PLAYER_LINK_SCAN_LIMIT });
    const exact = hits.filter((h) => h.confidence === "exact");
    const birthYear = answer.birthYear;
    // `players.findOrCreate` LINKS rather than creates when exactly one player
    // has the name (whatever birthYear says), or when one of several was born
    // in birthYear; it refuses when several share it and birthYear is absent
    // or an undated one could be the same man. A create must never link, so
    // every one of those is refused here, with the players on file.
    const refuse = (message: string): never => {
      throw new ResolveError({ kind: "player", query: name, at, candidates: exact.map(playerCandidate), message });
    };
    // The rule is the server's own (`playerCreateRefusal`, which
    // `players.findOrCreate` enforces under `createOnly`); this is the plan's
    // read-only look at it, so a refused create is reported before any write.
    switch (playerCreateRefusal(exact, birthYear, PLAYER_LINK_SCAN_LIMIT)) {
      case "sameName":
        refuse(`"${name}" is already a player in this sport; link that player with { "link": "${name}" } instead of creating one.`);
        break;
      case "noBirthYear":
        refuse(
          `"${name}" already names ${exact.length} players; link one with { "link", "birthYear" } (born ${birthYearsText(exact)}), or add the new player's birthYear.`,
        );
        break;
      case "tooMany":
        refuse(`"${name}" matches ${exact.length} or more players, too many to check birthYear ${birthYear} against all of them.`);
        break;
      case "sameBirthYear":
        refuse(`A player named "${name}" born ${birthYear} is already on file; link that player with { "link", "birthYear" } instead of creating one.`);
        break;
      case "undatedRival":
        refuse(
          `"${name}" already names ${exact.length} players and one has no birth year on file, so a new one cannot be told apart from it; link one with { "link", "birthYear" }.`,
        );
        break;
      case null:
        break;
    }
    return { kind: "create", name, ...(birthYear !== undefined ? { birthYear } : {}), onFile: exact.map((h) => String(h._id)) };
  }
  const link = typeof answer === "string" ? answer.trim() : isObj(answer) && typeof answer.link === "string" ? answer.link.trim() : "";
  if (link === "") throw new CardAnswerError(at, 'a player is a name, { "link", "birthYear" }, or { "create": "<name>" }.');
  const birthYear = isObj(answer) && "link" in answer ? answer.birthYear : undefined;
  if (birthYear !== undefined) {
    const hits = await client.query(api.players.nearMatches, { name: link, sportId, limit: PLAYER_LINK_SCAN_LIMIT });
    const p = pickPlayerByBirthYear(hits, link, birthYear, at);
    return { kind: "link", id: p._id, name: p.name };
  }
  const hits = await client.query(api.players.nearMatches, { name: link, sportId });
  const exact = hits.filter((h) => h.confidence === "exact");
  if (exact.length === 1) return { kind: "link", id: exact[0]._id, name: exact[0].name };
  throw new ResolveError({
    kind: "player",
    query: link,
    at,
    candidates: (exact.length > 1 ? exact : hits).map(playerCandidate),
    message:
      exact.length > 1
        ? `"${link}" matches ${exact.length} player rows; add the birthYear of the one you mean (born ${birthYearsText(exact)}).`
        : `No player named "${link}" in this sport.`,
  });
}

interface ResolvedAnswer {
  at: string;
  index: number;
  node: AttentionRowNode;
  cardId: Id<"cardChecklist">;
  card: ChecklistCard;
  shape: AnswerShape;
  answer: CardAnswer;
  players?: PlayerPlan[];
  teams?: TeamPlan[];
}

/** Per-run reads of the set's checklists, re-read after a write touches one. */
class ChecklistCache {
  private readonly rows = new Map<string, ChecklistCard[]>();
  private readonly dirty = new Set<string>();
  constructor(private readonly client: NbClient) {}
  async cards(rowId: RowId): Promise<ChecklistCard[]> {
    const key = String(rowId);
    let hit = this.rows.get(key);
    if (!hit || this.dirty.has(key)) {
      hit = await readChecklist(this.client, rowId);
      this.rows.set(key, hit);
      this.dirty.delete(key);
    }
    return hit;
  }
  touch(rowId: RowId): void {
    this.dirty.add(String(rowId));
  }
  /** Every row a card lives on that this run read: a guest card is on two. */
  rowsHolding(cardId: string): RowId[] {
    return [...this.rows.entries()].filter(([, cards]) => cards.some((c) => String(c._id) === cardId)).map(([k]) => k as RowId);
  }
}

async function resolveAll(
  client: NbClient,
  set: ResolvedSet,
  answers: readonly CardFixAnswer[],
  cache: ChecklistCache,
): Promise<ResolvedAnswer[]> {
  const shapes = answers.map((a, i) => {
    const at = `cards[${i}]`;
    if (!isObj(a) || typeof a.cardNumber !== "string" || a.cardNumber.trim() === "") throw new CardAnswerError(at, 'every answer names its "cardNumber".');
    if (a.cardId !== undefined && typeof a.cardId !== "string") throw new CardAnswerError(at, '"cardId" is the id the listing printed.');
    return answerShape(a.answer, `${at}.answer`);
  });
  const nodes = new Map<string, AttentionRowNode>();
  const out: ResolvedAnswer[] = [];
  for (const [i, a] of answers.entries()) {
    const at = `cards[${i}]`;
    const key = JSON.stringify([a.row?.type ?? null, a.row?.name ?? null, a.row?.parallel ?? null]);
    let node = nodes.get(key);
    if (!node) {
      node = await resolveAttentionRow(client, set, a.row, at);
      nodes.set(key, node);
    }
    const card = pickCard(await cache.cards(node.rowId), a.cardNumber, a.cardId, node.label, at);
    const resolved: ResolvedAnswer = { at, index: i, node, cardId: card._id, card, shape: shapes[i], answer: a.answer };
    if (resolved.shape === "links") {
      const l = a.answer as { players?: PlayerAnswer[]; teams?: TeamAnswer[] };
      if (l.players) {
        resolved.players = [];
        for (const [j, p] of l.players.entries()) resolved.players.push(await resolvePlayerAnswer(client, set.sportId, p, `${at}.answer.players[${j}]`));
      }
      if (l.teams) {
        resolved.teams = [];
        for (const [j, t] of l.teams.entries()) resolved.teams.push(await resolveTeamAnswer(client, set.sportId, t, `${at}.answer.teams[${j}]`));
      }
    }
    out.push(resolved);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/** The server refused (a ConvexError), as opposed to a network or auth failure. */
function isRefusal(err: unknown): boolean {
  return err instanceof ConvexError || (isObj(err) && "data" in err);
}

/** The sentence a refusal carries: the ConvexError's string, else its code, else the message's first line. */
export function refusalText(err: unknown, subject?: string): string {
  const data = (err as { data?: unknown } | null)?.data;
  if (typeof data === "string") return data;
  // NEO-339 — a create the server refused because the name is on file: its
  // own sentence, plus how to answer with the row instead.
  const exists = entityExistsRefusal(err);
  if (exists?.code === "PLAYER_EXISTS") {
    const rows = exists.players.map(existingPlayerLabel).join("; ");
    return `${playerExistsText(exists)} On file: ${rows}. Answer with { "link", "birthYear" } instead of creating one.`;
  }
  if (exists?.code === "TEAM_EXISTS") {
    const rows = exists.teams.map(existingTeamLabel).join("; ");
    return `${teamExistsText(exists)} On file: ${rows}. Answer with that team instead of creating one.`;
  }
  if (isObj(data) && data.code === "TEAM_ERA_EXISTS") {
    const eras = Array.isArray(data.eras) ? (data.eras as Array<{ years?: string }>).map((e) => e.years || "no years").join(", ") : "";
    return `"${subject ?? "That team"}" already names a team in this sport (${eras}); answer with that team instead of creating one.`;
  }
  if (isObj(data) && typeof data.code === "string") return `Refused (${data.code}).`;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0];
}

class Refused extends Error {}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function uniqueIds<T extends string>(ids: readonly T[]): T[] {
  return [...new Set(ids)];
}

/** "no longer flagged …" for the kind an answer addresses. */
function settled(kind: AttentionKind | "title"): string {
  if (kind === "title") return "Already settled: this card's title no longer needs attention.";
  return `Already settled: this card is no longer flagged “${ATTENTION_LABELS[kind]}”.`;
}

/**
 * Answer the cards. Resolves every answer before writing anything (a
 * `ResolveError` or `CardAnswerError` throws with nothing written), then
 * applies them in order, one fixer write each. A refusal or a moot answer is a
 * result, never a throw; a failure that is neither stops the run with
 * `CardFixAborted`, which carries every result before it.
 */
export async function applyCardAnswers(
  client: NbClient,
  target: AttentionSetTarget,
  answers: readonly CardFixAnswer[],
): Promise<CardFixResult[]> {
  const set = attentionSetOf(target);
  const cache = new ChecklistCache(client);
  const resolved = await resolveAll(client, set, answers, cache);
  const results: CardFixResult[] = [];

  for (const r of resolved) {
    const result = await applyOne(client, set, r, cache).catch((err: unknown) => {
      throw new CardFixAborted(results, err, r.at);
    });
    results.push(result);
  }

  // What each card still needs, off a fresh read of every row this run wrote.
  try {
    for (const [i, r] of resolved.entries()) {
      const fresh = (await cache.cards(r.node.rowId)).find((c) => String(c._id) === String(r.cardId));
      if (fresh) results[i].stillNeeds = deriveCardAttention(fresh).map((it) => ATTENTION_LABELS[it.kind]);
    }
  } catch {
    // The writes stand and are reported; only the follow-up read failed.
  }
  return results;
}

async function applyOne(client: NbClient, set: ResolvedSet, r: ResolvedAnswer, cache: ChecklistCache): Promise<CardFixResult> {
  const card = (await cache.cards(r.node.rowId)).find((c) => String(c._id) === String(r.cardId));
  const head = {
    at: r.at,
    card: { row: r.node.ref, rowLabel: r.node.label, cardNumber: r.card.cardNumber, cardName: r.card.cardName, cardId: String(r.cardId) },
  };
  const kinds = card ? deriveCardAttention(card).map((i) => i.kind) : [];
  const created: CreatedRow[] = [];
  const done = (answered: CardAnswerKind, outcome: CardFixResult["outcome"], detail: string, warning?: string): CardFixResult => ({
    ...head,
    answered,
    outcome,
    detail,
    ...(warning ? { warning } : {}),
    ...(created.length > 0 ? { created } : {}),
  });
  /** A write landed on this card: every row this run read it on is stale. */
  const touch = () => {
    for (const rowId of cache.rowsHolding(String(r.cardId))) cache.touch(rowId);
  };

  // ── which fixer ────────────────────────────────────────────────────────
  let answered: CardAnswerKind;
  if (r.shape === "noPlayer") answered = "noPlayer";
  else if (r.shape === "noTeam") answered = "noTeam";
  else if (r.shape === "title") answered = (r.answer as { variation?: string }).variation !== undefined ? "title+variation" : "title";
  else if (kinds.includes("unreviewedName")) answered = "players+teams";
  else if (r.players && kinds.includes("missingPlayer")) answered = "players";
  else answered = r.players ? "players+teams" : "teams";

  if (!card) return done(answered, "moot", "Already settled: this card is no longer on this checklist.");

  try {
    // ── "No player on this card" (NEO-339) ───────────────────────────────
    if (r.shape === "noPlayer") {
      if (!kinds.includes("missingPlayer")) return done(answered, "moot", settled("missingPlayer"));
      const res = await client.mutation(api.cardChecklist.confirmCardNoPlayer, { cardId: r.cardId });
      touch();
      if (!res.confirmed) {
        return done(answered, "refused", "This card has a player now, or it is no longer on this checklist — nothing to confirm.");
      }
      return done(answered, "applied", res.stamped ? "Recorded: no player on this card." : "Already recorded: no player on this card.");
    }

    // ── "No team on this card" ───────────────────────────────────────────
    if (r.shape === "noTeam") {
      if (!kinds.includes("missingTeam")) return done(answered, "moot", settled("missingTeam"));
      const res = await client.mutation(api.cardChecklist.confirmCardNoTeam, { cardId: r.cardId });
      touch();
      if (!res.confirmed) {
        return done(answered, "refused", "This card has teams now, or it is no longer on this checklist — nothing to confirm.");
      }
      return done(answered, "applied", res.stamped ? "Recorded: no team on this card." : "Already recorded: no team on this card.");
    }

    // ── TitleFixer ───────────────────────────────────────────────────────
    if (r.shape === "title") {
      const { title, variation } = r.answer as { title: string; variation?: string };
      if (!kinds.some((k) => TITLE_KINDS.has(k))) return done(answered, "moot", settled("title"));
      const fixesVariation = kinds.includes("aspectValueOverLimit");
      if (variation !== undefined && !fixesVariation) {
        return done(answered, "refused", "This card's variation is not flagged; send the title alone.");
      }
      const trimmed = title.trim();
      // The server's own rule and sentences (`updateCard`, through
      // lib/cards/listing-title-gate.ts), said before the write.
      const titleRefusal = listingTitleRefusal(trimmed);
      if (titleRefusal) return done(answered, "refused", titleRefusal);
      const v = variation?.trim();
      await client.mutation(api.selectorOptions.updateCard, {
        id: r.cardId,
        listingTitle: trimmed,
        ...(v !== undefined ? { cardVariation: v } : {}),
      });
      touch();
      const over = v !== undefined ? titleLengthState(v.length, ASPECT_VALUE_MAX) : null;
      const warning = over?.over
        ? `Variation is ${over.alert} Saved anyway; a marketplace that caps this field will reject the value.`
        : undefined;
      return done(answered, "applied", v !== undefined ? "Saved the title and variation on this card." : "Saved the title on this card.", warning);
    }

    // ── UnreviewedNameFixer ──────────────────────────────────────────────
    if (kinds.includes("unreviewedName")) {
      return await linkNames(client, set, r, card, created, done, touch);
    }

    // ── MissingPlayerFixer (NEO-339) ─────────────────────────────────────
    if (kinds.includes("missingPlayer")) {
      if (r.players) return await linkPlayers(client, set, r, kinds, created, done, touch);
      if (!kinds.includes("missingTeam")) {
        return done(answered, "refused", "This card needs a player, not a team; answer with players, or noPlayer.");
      }
    }

    // ── MissingTeamFixer ─────────────────────────────────────────────────
    if (kinds.includes("missingTeam")) {
      if (r.players) {
        return done(answered, "refused", "This card needs a team, not a player; answer with teams, or noTeam.");
      }
      const plans = r.teams ?? [];
      if (plans.length === 0) return done(answered, "refused", "Pick at least one team, or record that this card has none.");
      if (plannedCount(plans) > MAX_CARD_TEAMS) {
        return done(answered, "refused", `That is the limit of ${MAX_CARD_TEAMS} teams on one card.`);
      }
      const ids = uniqueIds(await teamIdsOf(client, set, plans, created));
      await client.mutation(api.selectorOptions.updateCard, { id: r.cardId, teamOnCardIds: ids });
      touch();
      return done(answered, "applied", `Saved ${plural(ids.length, "team", "teams")} on this card.`);
    }

    return done(answered, "moot", settled(r.players ? "unreviewedName" : "missingTeam"));
  } catch (err) {
    if (err instanceof Refused) return done(answered, "refused", err.message);
    if (isRefusal(err)) return done(answered, "refused", refusalText(err));
    throw err;
  }
}

/** How many distinct teams a plan list names (a create counts once). */
function plannedCount(plans: readonly TeamPlan[]): number {
  return new Set(plans.map((p) => (p.kind === "link" ? `id:${p.id}` : `new:${p.fullName.toLowerCase()}`))).size;
}

async function teamIdsOf(client: NbClient, set: ResolvedSet, plans: readonly TeamPlan[], created: CreatedRow[]): Promise<Array<Id<"teams">>> {
  const ids: Array<Id<"teams">> = [];
  for (const p of plans) {
    if (p.kind === "link") {
      ids.push(p.id);
      continue;
    }
    // `createOnly`: the server refuses (TEAM_EXISTS) rather than hand back a
    // team on file — including one created since the answer resolved — so a
    // create can never link (NEO-339). Atomic, unlike a re-read before it.
    let id: Id<"teams">;
    try {
      id = await client.mutation(api.teams.findOrCreate, {
        name: p.name,
        sportId: set.sportId,
        ...(p.location ? { location: p.location } : {}),
        ...(p.league ? { leagueName: p.league } : {}),
        createOnly: true,
      });
    } catch (err) {
      if (isRefusal(err)) throw new Refused(refusalText(err, p.fullName));
      throw err;
    }
    created.push({ kind: "team", name: p.fullName, id: String(id) });
    ids.push(id);
  }
  return ids;
}

async function playerIdsOf(client: NbClient, set: ResolvedSet, plans: readonly PlayerPlan[], created: CreatedRow[]): Promise<Array<Id<"players">>> {
  const ids: Array<Id<"players">> = [];
  for (const p of plans) {
    if (p.kind === "link") {
      ids.push(p.id);
      continue;
    }
    // `createOnly`: the server refuses (PLAYER_EXISTS) rather than hand back
    // a player on file, so a create can never link (NEO-339).
    let id: Id<"players">;
    try {
      id = await client.mutation(api.players.findOrCreate, {
        name: p.name,
        sportId: set.sportId,
        ...(p.birthYear !== undefined ? { birthYear: p.birthYear } : {}),
        createOnly: true,
      });
    } catch (err) {
      if (isRefusal(err)) throw new Refused(refusalText(err, p.name));
      throw err;
    }
    created.push({ kind: "player", name: p.name, id: String(id) });
    ids.push(id);
  }
  return ids;
}

/** How many distinct players a plan list names (a create counts once). */
function plannedPlayerCount(plans: readonly PlayerPlan[]): number {
  return new Set(plans.map((p) => (p.kind === "link" ? `id:${p.id}` : `new:${p.name.toLowerCase()}`))).size;
}

/**
 * NEO-339 — MissingPlayerFixer's Save: the card's players, a full list (the
 * picker starts empty, because the card has none). Gated as the fixer gates
 * its button: at least one player, at most `MAX_CARD_PLAYERS`. A card also
 * missing its team may take its teams in the same write (1–8, as
 * MissingTeamFixer's Save); a card that has its team refuses them rather than
 * replacing it. Creates only ever create (`playerIdsOf`, `teamIdsOf`).
 */
async function linkPlayers(
  client: NbClient,
  set: ResolvedSet,
  r: ResolvedAnswer,
  kinds: readonly AttentionKind[],
  created: CreatedRow[],
  done: (answered: CardAnswerKind, outcome: CardFixResult["outcome"], detail: string, warning?: string) => CardFixResult,
  touch: () => void,
): Promise<CardFixResult> {
  const answered: CardAnswerKind = "players";
  const plans = r.players ?? [];
  if (plans.length === 0) return done(answered, "refused", "Pick at least one player, or record that this card has none.");
  if (plannedPlayerCount(plans) > MAX_CARD_PLAYERS) {
    return done(answered, "refused", `That is the limit of ${MAX_CARD_PLAYERS} players on one card.`);
  }
  if (r.teams) {
    if (!kinds.includes("missingTeam")) {
      return done(answered, "refused", "This card has its team already; answer with players alone.");
    }
    if (r.teams.length === 0) return done(answered, "refused", "Pick at least one team, or leave teams out.");
    if (plannedCount(r.teams) > MAX_CARD_TEAMS) {
      return done(answered, "refused", `That is the limit of ${MAX_CARD_TEAMS} teams on one card.`);
    }
  }
  const playerIds = uniqueIds(await playerIdsOf(client, set, plans, created));
  const teamIds = r.teams ? uniqueIds(await teamIdsOf(client, set, r.teams, created)) : undefined;
  await client.mutation(api.selectorOptions.updateCard, {
    id: r.cardId,
    playerIds,
    ...(teamIds ? { teamOnCardIds: teamIds } : {}),
  });
  touch();
  const parts = [plural(playerIds.length, "player", "players"), ...(teamIds ? [plural(teamIds.length, "team", "teams")] : [])];
  return done(answered, "applied", `Saved ${parts.join(" and ")} on this card.`);
}


/**
 * UnreviewedNameFixer's Save. A side the answer gives is that side's whole
 * list (the picker's value); a side it leaves out keeps the card's links (the
 * picker seeded from the row). Gated exactly as the fixer gates its button:
 * the write must clear the card, and must change something.
 */
async function linkNames(
  client: NbClient,
  set: ResolvedSet,
  r: ResolvedAnswer,
  card: ChecklistCard,
  created: CreatedRow[],
  done: (answered: CardAnswerKind, outcome: CardFixResult["outcome"], detail: string, warning?: string) => CardFixResult,
  touch: () => void,
): Promise<CardFixResult> {
  const answered: CardAnswerKind = "players+teams";
  const rowPlayers = (card.playerIds ?? []).map(String);
  const rowTeams = (card.teamOnCardIds ?? []).map(String);
  const playerCount = r.players ? new Set(r.players.map((p) => (p.kind === "link" ? `id:${p.id}` : `new:${p.name.toLowerCase()}`))).size : rowPlayers.length;
  const teamCount = r.teams ? plannedCount(r.teams) : rowTeams.length;

  if (teamCount > MAX_CARD_TEAMS) return done(answered, "refused", `That is the limit of ${MAX_CARD_TEAMS} teams on one card.`);
  if (playerCount > MAX_CARD_PLAYERS) return done(answered, "refused", `That is the limit of ${MAX_CARD_PLAYERS} players on one card.`);

  // `clearsCard`, from the counts, before any create runs: the fixer's own
  // gate (lib/set-build/unreviewed-name-gate.ts, NEO-339).
  const sidesOpen = unreviewedNameSidesOpen(card, { players: playerCount, teams: teamCount });
  if (sidesOpen) return done(answered, "refused", sidesOpen);

  const playerIds = r.players ? uniqueIds(await playerIdsOf(client, set, r.players, created)) : (card.playerIds ?? []);
  const teamIds = r.teams ? uniqueIds(await teamIdsOf(client, set, r.teams, created)) : (card.teamOnCardIds ?? []);

  const gate = unreviewedNameGate(card, { playerIds, teamIds });
  if (!gate.canSave) return done(answered, "refused", gate.refusal ?? NOTHING_TO_CHANGE);

  await client.mutation(api.selectorOptions.updateCard, {
    id: r.cardId,
    ...unreviewedNameWrite(card, { playerIds, teamIds }),
  });
  touch();
  const parts = [
    ...(playerIds.length > 0 ? [plural(playerIds.length, "player", "players")] : []),
    ...(teamIds.length > 0 ? [plural(teamIds.length, "team", "teams")] : []),
  ];
  return done(answered, "applied", `Linked ${parts.join(" and ")} to this card.`);
}


// ---------------------------------------------------------------------------
// NEO-345 — the checklist header's autograph prompt
// ---------------------------------------------------------------------------

/**
 * One row's answer to "on card or sticker?": the stored value, as the
 * prompt's buttons write it. The operator's answer, never the tool's: no
 * marketplace says which, so nothing here proposes one.
 */
export interface AutographFixAnswer {
  /** The row; omitted = the set's Base. */
  row?: CardRowRef;
  format: AutographFormat;
}

export interface AutographFixResult {
  /** `autographs[i]`. */
  at: string;
  row: CardRowRef;
  rowLabel: string;
  rowId: string;
  format: AutographFormat;
  outcome: "applied" | "moot" | "refused";
  detail: string;
  /** Saved, but the row's cards were not all seen marked (the wait ran out, or the re-read failed). */
  warning?: string;
  /** The row's own autographed cards still marked not autographed when the wait ended. */
  stillUnformatted?: number;
  /**
   * Jason, 2026-10-18 — the parallels the answer also reached (each one whose
   * own format was unset), not counting rows this call answers itself: how
   * many, and their autographed cards still marked not autographed when the
   * wait ended (absent when none was left, or none could be read), and
   * their NB row ids (the one-shot counts them gone from the listing).
   */
  parallels?: { count: number; rowIds: string[]; stillUnformatted?: number };
}

export interface AutographFixOptions {
  /** How long, in all, to wait for the server to mark the answered rows' cards. Default `AUTOGRAPH_WAIT_MS`. */
  waitMs?: number;
  /** How often to look. Default `AUTOGRAPH_POLL_MS`. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * The carry-over to the cards is scheduled server-side (`cascadeAutographFormat`,
 * one bounded page per 500 cards, the row's first and then its parallels');
 * this is the whole call's wait for it, shared by every row the call answers
 * and every parallel those answers reach, so a batch never waits row after
 * row. The budget is checked between polling passes, so a slow pass can run a
 * little past it: about 30 s, not a hard deadline.
 */
export const AUTOGRAPH_WAIT_MS = 30_000;
export const AUTOGRAPH_POLL_MS = 1_000;

/** An autograph answer resolved to its row, before anything is written. */
export interface ResolvedAutographAnswer {
  at: string;
  node: AttentionRowNode;
  answer: AutographFixAnswer;
}

/**
 * A failure that is not a refusal (network, auth, a server fault) part-way
 * through the autograph writes. Carries every result before it, the rows
 * already saved included, so what was written is never unreported.
 */
export class AutographFixAborted extends Error {
  readonly results: AutographFixResult[];
  readonly cause: unknown;
  constructor(results: AutographFixResult[], cause: unknown, at: string) {
    super(`${at}: stopped after ${results.length} answer(s): ${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}`);
    this.name = "AutographFixAborted";
    this.results = results;
    this.cause = cause;
  }
}

/**
 * The row's OWN autographed cards still "None". A guest (a card listed here
 * from its home set) is its home row's to format: the server's walk over this
 * row never touches it, so the wait does not count it.
 */
function ownUnformatted(cards: readonly ChecklistCard[]): number {
  return countUnformattedAutographs(cards.filter((c) => !c.isCrossListed));
}

const labelOf = (f: AutographFormat) => AUTOGRAPH_CHOICE_LABEL[f].toLowerCase();

/**
 * The parallels `setAutographFormat` says its answer reached. A server from
 * before that answer was returned says nothing (null): no parallels, never a
 * failure.
 */
function parallelIdsOf(saved: unknown): string[] {
  const ids = (saved as { parallelIds?: unknown } | null | undefined)?.parallelIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

/**
 * Resolve every autograph answer to its row (exactly-one at every level; a
 * `ResolveError` with the candidates otherwise). Reads only. A row answered
 * twice in one call is refused here, before anything is written: two answers
 * are never settled by their order.
 */
export async function resolveAutographAnswers(
  client: NbClient,
  target: AttentionSetTarget,
  answers: readonly AutographFixAnswer[],
): Promise<ResolvedAutographAnswer[]> {
  const set = attentionSetOf(target);
  const out: ResolvedAutographAnswer[] = [];
  const seen = new Map<string, string>();
  for (const [i, answer] of answers.entries()) {
    const at = `autographs[${i}]`;
    if (!isAutographFormat(answer.format)) {
      throw new CardAnswerError(at, `"format" is ${AUTOGRAPH_FORMATS.map((f) => `"${f}"`).join(" or ")}.`);
    }
    const node = await resolveAttentionRow(client, set, answer.row, at);
    const first = seen.get(String(node.rowId));
    if (first !== undefined) {
      throw new CardAnswerError(at, `${node.label} is answered at ${first} too. Answer each row once.`);
    }
    seen.set(String(node.rowId), at);
    out.push({ at, node, answer });
  }
  return out;
}

/**
 * Answer the header's autograph prompt, through its own mutation
 * (`autographFormat.setAutographFormat { selectorOptionId, value }`), gated
 * as the prompt is shown: a row that already has a format, or whose
 * autographed cards are all marked, no longer asks, so its answer is moot
 * (changing a format is Set details' job, not this one). After the writes it
 * waits, once for the whole call and bounded, for the server's scheduled walk
 * to mark each row's cards, and says so for a row whose cards it did not see
 * finish.
 *
 * An answer on an insert (or the Base) also reaches its parallels whose own
 * format is unset (the server says which), and the wait covers their cards
 * too. So the writes go DEEPEST ROW FIRST, whatever order the answers came
 * in: a parallel answered in the same call holds its own answer before its
 * insert's could reach it, and two answers are never settled by their order.
 * Results stay in the answers' order.
 *
 * Takes answers (resolved here first, with no write) or answers the caller
 * has already resolved. A refusal or a moot answer is a result, never a
 * throw; a failure that is neither throws `AutographFixAborted` with every
 * result before it.
 */
export async function applyAutographAnswers(
  client: NbClient,
  target: AttentionSetTarget,
  answers: readonly AutographFixAnswer[] | readonly ResolvedAutographAnswer[],
  opts: AutographFixOptions = {},
): Promise<AutographFixResult[]> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const waitMs = opts.waitMs ?? AUTOGRAPH_WAIT_MS;
  const pollMs = opts.pollMs ?? AUTOGRAPH_POLL_MS;
  const resolved: readonly ResolvedAutographAnswer[] =
    answers.length > 0 && "node" in answers[0]
      ? (answers as readonly ResolvedAutographAnswer[])
      : await resolveAutographAnswers(client, target, answers as readonly AutographFixAnswer[]);

  /** Indexed by the answer's position, so results keep the answers' order. */
  const byIndex: Array<AutographFixResult | undefined> = [];
  const inOrder = () => byIndex.filter((r): r is AutographFixResult => r !== undefined);
  /** Rows written, waiting for the server to mark their cards: index into `byIndex`. */
  const written: Array<{ i: number; node: AttentionRowNode; marking: number }> = [];
  /** Parallels an answer reached, waiting the same way: `i` is the answer that reached them. */
  const reached: Array<{ i: number; rowId: RowId; marking: number }> = [];
  const answeredIds = new Set(resolved.map((r) => String(r.node.rowId)));
  const reachedIds = new Set<string>();
  // Deepest row first (a parallel before its insert, an insert before the
  // Base); a stable sort, so rows at one depth keep the answers' order.
  const order = resolved
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.node.drillIds.length - a.r.node.drillIds.length);

  for (const { r: { at, node, answer }, i } of order) {
    const head = { at, row: node.ref, rowLabel: node.label, rowId: String(node.rowId), format: answer.format };
    try {
      const leaf = await client.query(api.selectorOptions.getSelectorOptionById, { id: node.rowId });
      if (!leaf) {
        byIndex[i] = { ...head, outcome: "moot", detail: "Already settled: this row is no longer in the set." };
        continue;
      }
      const stored = asAutographFormat(leaf.features?.autographFormat);
      if (stored !== undefined) {
        byIndex[i] = {
          ...head,
          outcome: "moot",
          detail:
            stored === answer.format
              ? `Already settled: ${node.label}'s autographs are marked ${labelOf(stored)}.`
              : `Already settled: ${node.label}'s autographs are marked ${labelOf(stored)}. If that is wrong, change it in Set details.`,
        };
        continue;
      }
      const cards = await readChecklist(client, node.rowId);
      // The prompt's own rule (the leaf has no format, read just above).
      if (autographPromptCount(leaf.features?.autographFormat, cards) === 0) {
        byIndex[i] = { ...head, outcome: "moot", detail: `Already settled: no autographed card on ${node.label} is waiting for a format.` };
        continue;
      }
      let saved: unknown;
      try {
        saved = await client.mutation(api.autographFormat.setAutographFormat, { selectorOptionId: node.rowId, value: answer.format });
      } catch (err) {
        if (isRefusal(err)) {
          byIndex[i] = { ...head, outcome: "refused", detail: refusalText(err) };
          continue;
        }
        throw err;
      }
      byIndex[i] = { ...head, outcome: "applied", detail: autographPromptSaved(answer.format) };
      written.push({ i, node, marking: ownUnformatted(cards) });
      // The parallels it reached, less the rows this call answers itself
      // (each waited on as its own row) and any an earlier answer reached.
      const parallelIds = parallelIdsOf(saved).filter((id) => !answeredIds.has(id) && !reachedIds.has(id));
      for (const id of parallelIds) {
        reachedIds.add(id);
        let marking = -1;
        try {
          marking = ownUnformatted(await readChecklist(client, id as RowId));
        } catch {
          // Saved; only the first look failed. The wait looks again.
        }
        reached.push({ i, rowId: id as RowId, marking });
      }
      if (parallelIds.length > 0) byIndex[i]!.parallels = { count: parallelIds.length, rowIds: parallelIds };
    } catch (err) {
      for (const w of written) {
        byIndex[w.i]!.warning = "The run stopped before this row's cards were checked; list attention again.";
      }
      throw new AutographFixAborted(inOrder(), err, at);
    }
  }
  const results = byIndex as AutographFixResult[];

  // The server marks each row's cards, then its parallels', in a scheduled
  // walk: look until none of those autographed cards shows "None", within one
  // budget. A parallel whose first look failed (`marking` -1) is looked at too.
  type Watch = { key: string; rowId: RowId; left: number };
  const pending = new Map<string, Watch>();
  for (const w of written) if (w.marking > 0) pending.set(`row:${w.i}`, { key: `row:${w.i}`, rowId: w.node.rowId, left: w.marking });
  for (const p of reached) if (p.marking !== 0) pending.set(`par:${p.rowId}`, { key: `par:${p.rowId}`, rowId: p.rowId, left: Math.max(p.marking, 0) });
  const unread = new Set<string>();
  const started = now();
  while (pending.size > 0) {
    for (const [key, w] of pending) {
      try {
        w.left = ownUnformatted(await readChecklist(client, w.rowId));
        unread.delete(key);
      } catch {
        // The answer is saved; only the check failed. Try again next pass.
        unread.add(key);
      }
      if (w.left === 0 && !unread.has(key)) pending.delete(key);
    }
    if (pending.size === 0 || now() - started >= waitMs) break;
    await sleep(pollMs);
  }

  for (const w of written) {
    const r = results[w.i];
    const label = labelOf(r.format);
    const still = pending.get(`row:${w.i}`);
    if (w.marking === 0) {
      r.detail = `${r.detail} Its autographed cards here are listed from other sets, which keep their own format.`;
    } else if (!still) {
      r.detail = `${r.detail} ${plural(w.marking, "card", "cards")} on ${w.node.label} now marked ${label}.`;
    } else if (unread.has(`row:${w.i}`)) {
      r.warning = `Saved, but ${w.node.label} could not be read back to check its cards; list attention again shortly.`;
    } else {
      r.warning = `${plural(still.left, "autographed card", "autographed cards")} on ${w.node.label} still show no format after ${Math.round(waitMs / 1000)}s; the server is still marking them. List attention again shortly.`;
      r.stillUnformatted = still.left;
    }

    // The parallels this answer reached.
    const mine = reached.filter((p) => p.i === w.i);
    if (mine.length === 0) continue;
    const left = mine.reduce((n, p) => n + (pending.get(`par:${p.rowId}`)?.left ?? 0), 0);
    const notRead = mine.some((p) => unread.has(`par:${p.rowId}`));
    const one = mine.length === 1;
    r.detail = `${r.detail} ${autographPromptParallels(mine.length)}`;
    if (left > 0) {
      r.parallels = { count: mine.length, rowIds: mine.map((p) => String(p.rowId)), stillUnformatted: left };
      const more = `${plural(left, "autographed card", "autographed cards")} on ${one ? "its parallel" : "its parallels"} still show no format; the server is still marking them. List attention again shortly.`;
      r.warning = r.warning ? `${r.warning} ${more}` : more;
    } else if (notRead) {
      const more = `${one ? "Its parallel" : "Its parallels"} could not be read back to check ${one ? "its" : "their"} cards; list attention again shortly.`;
      r.warning = r.warning ? `${r.warning} ${more}` : more;
    }
  }
  return results;
}

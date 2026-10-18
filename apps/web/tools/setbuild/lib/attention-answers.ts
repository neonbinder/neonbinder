/**
 * NEO-339 — answering the cards `listCardAttention` lists, through the exact
 * writes the walker's fixers make, with the same gates.
 *
 * | Answer                 | Fixer                 | Write                                                  |
 * |------------------------|-----------------------|--------------------------------------------------------|
 * | `{ teams }` (missing)  | MissingTeamFixer Save | `selectorOptions.updateCard { id, teamOnCardIds }`     |
 * | `{ noTeam: true }`     | "No team on this card"| `cardChecklist.confirmCardNoTeam { cardId }`           |
 * | `{ players?, teams? }` | UnreviewedNameFixer   | `updateCard { id, playerIds, teamOnCardIds, pending… }`|
 * | `{ title, variation? }`| TitleFixer Save       | `updateCard { id, listingTitle, cardVariation? }`      |
 *
 * The gates, each the fixer's own:
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
import { ASPECT_VALUE_MAX, LISTING_TITLE_MAX, titleLengthState } from "../../../components/SetSelector/TitleLengthMeter";
import { teamOptionLabel } from "../../../lib/teams/team-era";
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

type AnswerShape = "noTeam" | "title" | "links";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Which fixer an answer is for, refusing a shape that is none of them. */
export function answerShape(answer: CardAnswer, at: string): AnswerShape {
  if (!isObj(answer)) throw new CardAnswerError(at, "an answer is an object.");
  const keys = Object.keys(answer).filter((k) => (answer as Record<string, unknown>)[k] !== undefined);
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
    throw new CardAnswerError(at, 'an answer is { teams }, { noTeam: true }, { players, teams } or { title, variation }.');
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
    if (exact.length === 1) {
      refuse(`"${name}" is already a player in this sport; link that player with { "link": "${name}" } instead of creating one.`);
    }
    if (exact.length > 1) {
      if (birthYear === undefined) {
        refuse(
          `"${name}" already names ${exact.length} players; link one with { "link", "birthYear" } (born ${birthYearsText(exact)}), or add the new player's birthYear.`,
        );
      }
      if (exact.length >= PLAYER_LINK_SCAN_LIMIT) {
        refuse(`"${name}" matches ${exact.length} or more players, too many to check birthYear ${birthYear} against all of them.`);
      }
      if (exact.some((h) => h.birthYear === birthYear)) {
        refuse(`A player named "${name}" born ${birthYear} is already on file; link that player with { "link", "birthYear" } instead of creating one.`);
      }
      if (exact.some((h) => h.birthYear === undefined)) {
        refuse(
          `"${name}" already names ${exact.length} players and one has no birth year on file, so a new one cannot be told apart from it; link one with { "link", "birthYear" }.`,
        );
      }
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
  if (r.shape === "noTeam") answered = "noTeam";
  else if (r.shape === "title") answered = (r.answer as { variation?: string }).variation !== undefined ? "title+variation" : "title";
  else answered = kinds.includes("unreviewedName") || r.players ? "players+teams" : "teams";

  if (!card) return done(answered, "moot", "Already settled: this card is no longer on this checklist.");

  try {
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
      if (trimmed === "") return done(answered, "refused", "A card title can't be blank.");
      if (trimmed.length > LISTING_TITLE_MAX) {
        // The server's own sentence (`updateCard`), said before the write.
        return done(answered, "refused", `Listing title is ${trimmed.length} characters; the limit is ${LISTING_TITLE_MAX}.`);
      }
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
    // Re-read at write time: a team created since the answer resolved would
    // be handed back by find-or-create instead of a new one.
    const before = (await client.query(api.teams.erasByNameAndSport, { name: p.fullName, sportId: set.sportId })).map((e) => String(e._id));
    let id: Id<"teams">;
    try {
      id = await client.mutation(api.teams.findOrCreate, {
        name: p.name,
        sportId: set.sportId,
        ...(p.location ? { location: p.location } : {}),
        ...(p.league ? { leagueName: p.league } : {}),
      });
    } catch (err) {
      if (isRefusal(err)) throw new Refused(refusalText(err, p.fullName));
      throw err;
    }
    if (before.includes(String(id)) || p.onFile.includes(String(id))) {
      throw new Refused(`"${p.fullName}" is already a team in this sport; answer with that team instead of creating one.`);
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
    let id: Id<"players">;
    try {
      id = await client.mutation(api.players.findOrCreate, {
        name: p.name,
        sportId: set.sportId,
        ...(p.birthYear !== undefined ? { birthYear: p.birthYear } : {}),
      });
    } catch (err) {
      if (isRefusal(err)) throw new Refused(refusalText(err, p.name));
      throw err;
    }
    if (p.onFile.includes(String(id))) {
      // find-or-create handed back a player that was on file: nothing was
      // created, and the card is not linked to a row nobody named.
      throw new Refused(`"${p.name}" is already a player in this sport; link that player with { "link", "birthYear" } instead of creating one.`);
    }
    created.push({ kind: "player", name: p.name, id: String(id) });
    ids.push(id);
  }
  return ids;
}

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

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

  // `clearsCard`, side by side with the rule: a side with typed names must gain a link.
  const unlinkedPlayerNames = card.pendingPlayerNames ?? [];
  const unlinkedTeamNames = rowTeams.length > 0 ? [] : (card.pendingTeamNames ?? []);
  const playerSideOpen = unlinkedPlayerNames.length > 0 && playerCount === 0;
  const teamSideOpen = unlinkedTeamNames.length > 0 && teamCount === 0;
  if (playerSideOpen || teamSideOpen) {
    const missing = [...(playerSideOpen ? ["a player"] : []), ...(teamSideOpen ? ["a team"] : [])];
    return done(answered, "refused", `Link ${missing.join(" and ")} to clear this card.`);
  }

  const playerIds = r.players ? uniqueIds(await playerIdsOf(client, set, r.players, created)) : (card.playerIds ?? []);
  const teamIds = r.teams ? uniqueIds(await teamIdsOf(client, set, r.teams, created)) : (card.teamOnCardIds ?? []);

  const idsChanged = !sameIds(playerIds.map(String), rowPlayers) || !sameIds(teamIds.map(String), rowTeams);
  const retiresNames =
    (playerIds.length > 0 && (card.pendingPlayerNames?.length ?? 0) > 0) ||
    (teamIds.length > 0 && (card.pendingTeamNames?.length ?? 0) > 0);
  if (!idsChanged && !retiresNames) return done(answered, "refused", "Nothing to change here — skip this card.");

  await client.mutation(api.selectorOptions.updateCard, {
    id: r.cardId,
    playerIds,
    teamOnCardIds: teamIds,
    pendingPlayerNames: playerIds.length > 0 ? [] : (card.pendingPlayerNames ?? []),
    pendingTeamNames: teamIds.length > 0 ? [] : (card.pendingTeamNames ?? []),
  });
  touch();
  const parts = [
    ...(playerIds.length > 0 ? [plural(playerIds.length, "player", "players")] : []),
    ...(teamIds.length > 0 ? [plural(teamIds.length, "team", "teams")] : []),
  ];
  return done(answered, "applied", `Linked ${parts.join(" and ")} to this card.`);
}

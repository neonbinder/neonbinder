"use node";

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { fetchEspnTeamInfo } from "./espn";

/**
 * Wikidata SPARQL adapter — enriches players (HoF, career teams) and
 * teams (city, league, years active) from query.wikidata.org. No API
 * key required.
 *
 * Concurrency model: enrichment runs through a chained queue
 * (`processEnrichmentQueue`) so global request rate stays one-at-a-time
 * regardless of how many entities a fetch produces. Each entity's
 * processing reschedules the next one after `INTER_ENTITY_DELAY_MS`,
 * which Wikidata's WMF service is happy with even under bursty
 * batches like 300+ players. We previously used `scheduler.runAfter(0)`
 * per entity which fired N parallel actions — each with its own
 * isolated throttle counter — and hit 429s immediately at scale.
 *
 * Why Wikidata over baseball-reference / TheSportsDB:
 * - one source covers every sport (no per-sport adapter sprawl)
 * - structured: HoF status as a P166 award triple, not a scraped string
 * - permissive: CC0 license, public SPARQL endpoint
 * - covers defunct franchises (Expos → Q1130155) which catalog vintage cards
 *
 * Failure mode: if a player has no Wikidata entry (rare for major-league
 * pros, common for minor leaguers / prospects on rookie cards), we leave
 * the row unenriched. The UI must always treat these fields as optional.
 */

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT = "NeonBinder/1.0 (https://neonbinder.io; jburich@neonbinder.io)";

/**
 * Gap between processing successive entities in the enrichment queue.
 * 3000ms is well within Wikidata's published etiquette (≤1 req/sec) and
 * leaves headroom for the two SPARQL calls each entity performs (search +
 * detail). Bumped from 1100ms after live testing showed 429s at scale.
 */
const INTER_ENTITY_DELAY_MS = 3000;

// Sport string → Wikidata sport QID. Used in the `wdt:P641` filter so
// SPARQL only returns athletes from the relevant league.
const SPORT_QIDS: Record<string, string> = {
  baseball: "Q5369",
  football: "Q41323",   // American football (our domain — no soccer cards)
  basketball: "Q5372",
  hockey: "Q41466",     // Ice hockey
};

// Sport → Hall of Fame QID. A P166 (award received) value matching this
// QID flips isHallOfFame to true. Sports without a single canonical HoF
// (e.g. soccer) are intentionally absent — those players ship with
// isHallOfFame undefined rather than misleadingly false.
const HOF_QIDS: Record<string, string> = {
  baseball: "Q1194380",   // National Baseball Hall of Fame
  football: "Q1382553",   // Pro Football Hall of Fame
  basketball: "Q635155",  // Naismith Memorial Basketball Hall of Fame
  hockey: "Q579974",      // Hockey Hall of Fame
};

interface SparqlBinding {
  type: string;
  value: string;
  "xml:lang"?: string;
}

interface SparqlResults {
  results: {
    bindings: Array<Record<string, SparqlBinding>>;
  };
}

/**
 * Escape a JS string for safe interpolation inside a SPARQL string
 * literal (per SPARQL 1.1 grammar). The previous `replace(/"/g, "")`
 * was insufficient — it left newlines, backslashes, and Unicode line
 * separators intact, any of which could break out of the literal in
 * downstream MWAPI/SPARQL parsers and run arbitrary SPARQL against
 * query.wikidata.org under our User-Agent. Names interpolated come
 * from BSC's `players[]` / `teamName` (external adapter) and from
 * user-confirmed dialog rows; both must be treated as untrusted.
 *
 * Length is capped at 200 chars so a malformed BSC payload can't blow
 * the query budget.
 */
function sparqlStringLiteral(raw: string): string {
  const truncated = raw.slice(0, 200);
  let out = "";
  for (let i = 0; i < truncated.length; i++) {
    const ch = truncated[i];
    const code = truncated.charCodeAt(i);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    // U+2028 LINE SEPARATOR + U+2029 PARAGRAPH SEPARATOR — treated as line
    // terminators by some SPARQL parsers even inside string literals.
    else if (code === 0x2028 || code === 0x2029) out += " ";
    else out += ch;
  }
  return out;
}

/**
 * Run a SPARQL query against Wikidata. Returns null on any non-OK
 * response (including 429 rate-limit and 5xx). The chained queue caller
 * handles retry sequencing — this function does not retry inline.
 *
 * Note: there is no in-process throttle here. The serial queue
 * provides the only rate limit; running this from outside the queue
 * (e.g., directly from another action) is allowed but bypasses
 * pacing — do so only for one-off lookups.
 */
async function runSparql(query: string): Promise<SparqlResults | null> {
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/sparql-results+json",
        "User-Agent": USER_AGENT,
      },
    });
    if (!response.ok) {
      console.warn(`[wikidata] SPARQL ${response.status}`);
      return null;
    }
    return (await response.json()) as SparqlResults;
  } catch (error) {
    console.warn(`[wikidata] SPARQL fetch failed:`, error);
    return null;
  }
}

/**
 * Strip the wd: prefix from a Wikidata IRI to get the bare QID, e.g.
 * "http://www.wikidata.org/entity/Q5369" → "Q5369".
 */
function qidFromIri(iri: string): string {
  const idx = iri.lastIndexOf("/");
  return idx === -1 ? iri : iri.slice(idx + 1);
}

/**
 * Parse a Wikidata date binding (xsd:dateTime, e.g. "2011-01-01T00:00:00Z")
 * to a 4-digit year. Wikidata sometimes uses "+0000-01-01" for unknown
 * precision — those return undefined.
 */
function yearFromBinding(binding?: SparqlBinding): number | undefined {
  if (!binding) return undefined;
  const m = binding.value.match(/(-?\d{1,4})-/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 1800 ? n : undefined;
}

/**
 * Find the best Wikidata QID for a player using the MediaWiki entity
 * search inlined in SPARQL — much faster than a label-FILTER scan since
 * Wikidata indexes labels and aliases for prefix lookup. The sport
 * filter (`wdt:P641`) picks off the right "John Smith" across leagues.
 */
async function findPlayerQid(name: string, sport: string): Promise<string | null> {
  // SPORT_QIDS is keyed lowercase; callers pass NeonBinder's display-cased
  // sport strings ("Baseball", not "baseball") — normalize so this
  // actually matches instead of silently no-op'ing on every real sport
  // value. (Found as a real, pre-existing bug: this meant Wikidata player
  // enrichment silently never matched anyone.)
  const sportQid = SPORT_QIDS[sport.toLowerCase()];
  if (!sportQid) return null;

  const safeName = sparqlStringLiteral(name);
  const query = `
    SELECT ?player WHERE {
      SERVICE wikibase:mwapi {
        bd:serviceParam wikibase:api "EntitySearch" .
        bd:serviceParam wikibase:endpoint "www.wikidata.org" .
        bd:serviceParam mwapi:search "${safeName}" .
        bd:serviceParam mwapi:language "en" .
        ?player wikibase:apiOutputItem mwapi:item .
      }
      ?player wdt:P31 wd:Q5 ;
              wdt:P641 wd:${sportQid} .
    }
    LIMIT 1
  `;

  const result = await runSparql(query);
  const binding = result?.results.bindings[0];
  return binding ? qidFromIri(binding.player.value) : null;
}

async function findTeamQid(name: string, sport: string): Promise<string | null> {
  // See the identical note in findPlayerQid above — same case-mismatch bug.
  const sportQid = SPORT_QIDS[sport.toLowerCase()];
  if (!sportQid) return null;

  const safeName = sparqlStringLiteral(name);
  // Sports team class is Q12973014; sports club Q847017 catches international
  // franchises. We accept any subclass relationship via wdt:P31/wdt:P279*.
  const query = `
    SELECT ?team WHERE {
      SERVICE wikibase:mwapi {
        bd:serviceParam wikibase:api "EntitySearch" .
        bd:serviceParam wikibase:endpoint "www.wikidata.org" .
        bd:serviceParam mwapi:search "${safeName}" .
        bd:serviceParam mwapi:language "en" .
        ?team wikibase:apiOutputItem mwapi:item .
      }
      { ?team wdt:P31/wdt:P279* wd:Q12973014 . }
      UNION
      { ?team wdt:P31/wdt:P279* wd:Q847017 . }
      ?team wdt:P641 wd:${sportQid} .
    }
    LIMIT 1
  `;

  const result = await runSparql(query);
  const binding = result?.results.bindings[0];
  return binding ? qidFromIri(binding.team.value) : null;
}

/**
 * Player enrichment result, shared by both consumers:
 *  - `enrichPlayer` (id-based, post-creation) resolves `careerTeams` names
 *    to real team ids via teams.findOrCreateInternal before persisting.
 *  - `processEntityReviewQueue` (NEO-92, name-based, pre-creation preview)
 *    stores `careerTeams` as bare names — resolving to real team rows is
 *    deferred to commit time (only once "create" is the confirmed decision)
 *    so a mere preview lookup can never orphan a team row for a player the
 *    user ends up linking to someone else or never creates at all.
 */
export interface PlayerLookupResult {
  wikidataId: string;
  careerTeams: Array<{ name: string; fromYear: number; toYear?: number }>;
  isHallOfFame?: boolean;
}

export interface TeamLookupResult {
  wikidataId?: string;
  league?: string;
  city?: string;
  yearsActive?: { from: number; to?: number };
  colors?: { primary?: string; secondary?: string };
  espnId?: string;
}

/**
 * Pure(-ish) lookup — no db writes. Given a player's name + sport, finds
 * its Wikidata QID and pulls career teams (as names) + HoF status. Returns
 * null if no Wikidata match is found (common for minor leaguers/prospects).
 *
 * teamYears: each P54 (member of sports team) statement may carry
 * P580 (start time) and P582 (end time) qualifiers.
 */
export async function lookupPlayerEnrichment(
  name: string,
  sport: string,
): Promise<PlayerLookupResult | null> {
  const qid = await findPlayerQid(name, sport);
  if (!qid) {
    console.log(`[wikidata.lookupPlayerEnrichment] no Wikidata match for ${name} (${sport})`);
    return null;
  }

  // HOF_QIDS is keyed lowercase, same as SPORT_QIDS above (see the identical
  // note on findPlayerQid) — callers pass display-cased sport strings
  // ("Baseball"), so this lookup must normalize too. Found as a real,
  // pre-existing bug while adding NEO-92 coverage: without `.toLowerCase()`
  // here, `isHallOfFame` silently never resolved for any real caller (every
  // production call site passes display-cased sport), even though the QID
  // lookup two lines up already got this right.
  const hofQid = HOF_QIDS[sport.toLowerCase()];

  const detailQuery = `
    SELECT ?team ?teamLabel ?start ?end ?award WHERE {
      OPTIONAL {
        wd:${qid} p:P54 ?membership .
        ?membership ps:P54 ?team .
        OPTIONAL { ?membership pq:P580 ?start . }
        OPTIONAL { ?membership pq:P582 ?end . }
      }
      OPTIONAL { wd:${qid} wdt:P166 ?award . }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
  `;
  const result = await runSparql(detailQuery);
  if (!result) return null;

  const careerTeams: Array<{ name: string; fromYear: number; toYear?: number }> = [];
  let isHallOfFame: boolean | undefined;
  const seenTeams = new Set<string>();

  for (const row of result.results.bindings) {
    if (row.team && row.teamLabel) {
      const teamWdId = qidFromIri(row.team.value);
      if (!seenTeams.has(teamWdId)) {
        seenTeams.add(teamWdId);
        const fromYear = yearFromBinding(row.start);
        if (fromYear !== undefined) {
          // Wikidata's label service returns the bare QID as the label
          // when no label exists in the requested language (en).
          // Q127635 turned up via the Yakult Swallows lineage — a real
          // NPB team that simply hasn't had its English label added on
          // Wikidata yet. Rather than create a team named "Q127635",
          // skip the membership and leave a breadcrumb so we can
          // backfill once an English label appears upstream.
          const labelLooksLikeQid = /^Q\d+$/.test(row.teamLabel.value);
          if (labelLooksLikeQid) {
            console.warn(
              `[wikidata.lookupPlayerEnrichment] skipped team membership for ${name}: ` +
              `Wikidata entity ${teamWdId} has no en label (label service returned QID).`,
            );
          } else {
            careerTeams.push({
              name: row.teamLabel.value,
              fromYear,
              toYear: yearFromBinding(row.end),
            });
          }
        }
      }
    }
    if (hofQid && row.award && qidFromIri(row.award.value) === hofQid) {
      isHallOfFame = true;
    }
  }

  // No HoF row matched, but the player IS in our HoF-aware sports — we
  // can confidently say not-HoF. Otherwise leave undefined so unsupported
  // sports don't claim a definitive answer.
  if (isHallOfFame === undefined && hofQid) {
    isHallOfFame = false;
  }

  return { wikidataId: qid, careerTeams, isHallOfFame };
}

/**
 * Internal action — given a player record, look up its Wikidata QID,
 * pull career teams + HoF status, and persist via applyEnrichmentInternal.
 *
 * Resolves each `careerTeams` name through teams.findOrCreateInternal so
 * `teamYears` points at our own teams table, not Wikidata QIDs. This is the
 * single most expensive enrichment call (one entity lookup + N team
 * resolutions per player); the calling action treats it as best-effort.
 */
export const enrichPlayer = internalAction({
  args: { playerId: v.id("players") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const player = await ctx.runQuery(internal.players.getInternal, { id: args.playerId });
    if (!player) return null;

    const result = await lookupPlayerEnrichment(player.name, player.primarySport);
    if (!result) return null;

    const teamYears: Array<{ teamId: import("../_generated/dataModel").Id<"teams">; fromYear: number; toYear?: number }> = [];
    for (const ct of result.careerTeams) {
      const teamId = await ctx.runMutation(internal.teams.findOrCreateInternal, {
        name: ct.name,
        sport: player.primarySport,
      });
      teamYears.push({ teamId, fromYear: ct.fromYear, toYear: ct.toYear });
    }

    await ctx.runMutation(internal.players.applyEnrichmentInternal, {
      id: args.playerId,
      teamYears: teamYears.length ? teamYears : undefined,
      isHallOfFame: result.isHallOfFame,
      wikidataId: result.wikidataId,
    });
    return null;
  },
});

/**
 * NEO-91: multi-source. ESPN (adapters/espn.ts) is tried first — reliable
 * hex colors and city for any CURRENT team, confirmed live against
 * NBA/NFL/MLB/NHL — but it has zero historical/defunct-franchise coverage.
 * Wikidata always runs too: it's the only source for `yearsActive`/
 * `wikidataId`, and the only source for `city`/`league` when ESPN found no
 * match (a defunct team). When both resolve a city, ESPN's wins (more
 * likely accurate for anything currently active); ESPN's league (the exact
 * name from SPORT_TO_ESPN_LEAGUE, not a guess) also wins over Wikidata's
 * label when present.
 */
/**
 * Pure(-ish) lookup — no db writes. Already side-effect-free (unlike the
 * player lookup, a team has no nested "career teams" to defer). Tries ESPN
 * first (reliable colors/city/league for CURRENT teams), then Wikidata
 * (sole source of yearsActive/wikidataId, and the only source for
 * city/league when ESPN found no match — a defunct team). Returns null
 * only when NEITHER source matches.
 */
export async function lookupTeamEnrichment(
  name: string,
  sport: string,
): Promise<TeamLookupResult | null> {
  const espnInfo = await fetchEspnTeamInfo(sport, name);

  const qid = await findTeamQid(name, sport);
  if (!qid) {
    if (!espnInfo) {
      console.log(`[wikidata.lookupTeamEnrichment] no match for ${name} (${sport}) on either source`);
      return null;
    }
    return {
      league: espnInfo.league,
      city: espnInfo.city,
      colors: { primary: espnInfo.colorPrimary, secondary: espnInfo.colorAlternate },
      espnId: espnInfo.espnId,
    };
  }

  // P159 (headquarters location) is inconsistent for sports teams —
  // confirmed empty for Washington Nationals and LA Rams (which instead
  // had it, if at all, under P276 "location"), present for the Celtics.
  // Ask for both, prefer P159.
  const detailQuery = `
    SELECT ?league ?leagueLabel ?city159 ?city159Label ?city276 ?city276Label ?inception ?dissolved WHERE {
      OPTIONAL { wd:${qid} wdt:P118 ?league . }
      OPTIONAL { wd:${qid} wdt:P159 ?city159 . }
      OPTIONAL { wd:${qid} wdt:P276 ?city276 . }
      OPTIONAL { wd:${qid} wdt:P571 ?inception . }
      OPTIONAL { wd:${qid} wdt:P576 ?dissolved . }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    LIMIT 1
  `;
  const result = await runSparql(detailQuery);
  const row = result?.results.bindings[0];

  const wikidataCity = row?.city159Label?.value ?? row?.city276Label?.value;
  const fromYear = yearFromBinding(row?.inception);
  const toYear = yearFromBinding(row?.dissolved);
  const yearsActive = fromYear !== undefined ? { from: fromYear, to: toYear } : undefined;

  return {
    wikidataId: qid,
    league: espnInfo?.league ?? row?.leagueLabel?.value,
    city: espnInfo?.city ?? wikidataCity,
    yearsActive,
    colors: espnInfo
      ? { primary: espnInfo.colorPrimary, secondary: espnInfo.colorAlternate }
      : undefined,
    espnId: espnInfo?.espnId,
  };
}

export const enrichTeam = internalAction({
  args: { teamId: v.id("teams") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const team = await ctx.runQuery(internal.teams.getInternal, { id: args.teamId });
    if (!team) return null;

    const result = await lookupTeamEnrichment(team.name, team.sport);
    if (!result) return null;

    await ctx.runMutation(internal.teams.applyEnrichmentInternal, {
      id: args.teamId,
      league: result.league,
      city: result.city,
      yearsActive: result.yearsActive,
      colors: result.colors,
      wikidataId: result.wikidataId,
      espnId: result.espnId,
    });
    return null;
  },
});

/**
 * Chained serial queue for Wikidata enrichment.
 *
 * commitCardChecklist hands the full list of newly-created player +
 * team IDs to this action via `scheduler.runAfter(0, ...)`. The action
 * pops one id off the front, enriches it, then reschedules itself with
 * the remaining tail after `INTER_ENTITY_DELAY_MS`. Result: globally
 * one Wikidata request at a time, regardless of how many entities a
 * fetch produced. Players are processed before teams so card render
 * gets HoF/career-team flags first; team metadata (city, league)
 * matters less for the immediate UI.
 *
 * Errors on a single entity are caught and logged — the queue moves
 * on. We do NOT retry on 429 here; the 3-second gap is already
 * conservative and a transient 429 just means that one entity stays
 * unenriched until a future fetch.
 */
export const processEnrichmentQueue = internalAction({
  args: {
    playerIds: v.array(v.id("players")),
    teamIds: v.array(v.id("teams")),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    let nextPlayerIds: Array<Id<"players">> = args.playerIds;
    let nextTeamIds: Array<Id<"teams">> = args.teamIds;

    if (nextPlayerIds.length > 0) {
      const [head, ...tail] = nextPlayerIds;
      try {
        await ctx.runAction(internal.adapters.wikidata.enrichPlayer, { playerId: head });
      } catch (error) {
        console.error(`[enrichment-queue] enrichPlayer ${head} failed:`, error);
      }
      nextPlayerIds = tail;
    } else if (nextTeamIds.length > 0) {
      const [head, ...tail] = nextTeamIds;
      try {
        await ctx.runAction(internal.adapters.wikidata.enrichTeam, { teamId: head });
      } catch (error) {
        console.error(`[enrichment-queue] enrichTeam ${head} failed:`, error);
      }
      nextTeamIds = tail;
    } else {
      // Both queues empty — done.
      console.log(`[enrichment-queue] queue drained.`);
      return null;
    }

    if (nextPlayerIds.length > 0 || nextTeamIds.length > 0) {
      await ctx.scheduler.runAfter(
        INTER_ENTITY_DELAY_MS,
        internal.adapters.wikidata.processEnrichmentQueue,
        { playerIds: nextPlayerIds, teamIds: nextTeamIds },
      );
    }
    return null;
  },
});

/**
 * NEO-92: chained serial queue for the pre-creation review-wizard preview
 * (see entityReviewQueue.ts). Same shape/pacing as processEnrichmentQueue
 * above (same Wikidata rate-limit constraint applies) but processes
 * `entityReviewQueue` rows by name+sport instead of already-created
 * player/team ids — nothing is written to `players`/`teams` here, only the
 * review row's own `status`/`enrichment` fields. The wizard's reactive
 * `getBatch` query is what turns each patch into a visible UI update.
 */
export const processEntityReviewQueue = internalAction({
  args: {
    ids: v.array(v.id("entityReviewQueue")),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const [head, ...tail] = args.ids;
    if (!head) return null;

    const row = await ctx.runQuery(internal.entityReviewQueue.getInternal, { id: head });
    if (row) {
      try {
        const result =
          row.kind === "player"
            ? await lookupPlayerEnrichment(row.name, row.sport)
            : await lookupTeamEnrichment(row.name, row.sport);
        await ctx.runMutation(internal.entityReviewQueue.applyLookupResult, {
          id: head,
          status: result ? "ready" : "error",
          enrichment: result ?? undefined,
        });
      } catch (error) {
        console.error(`[entity-review-queue] lookup for ${head} failed:`, error);
        await ctx.runMutation(internal.entityReviewQueue.applyLookupResult, {
          id: head,
          status: "error",
        });
      }
    }

    if (tail.length > 0) {
      await ctx.scheduler.runAfter(
        INTER_ENTITY_DELAY_MS,
        internal.adapters.wikidata.processEntityReviewQueue,
        { ids: tail },
      );
    }
    return null;
  },
});

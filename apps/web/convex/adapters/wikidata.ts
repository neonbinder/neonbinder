"use node";

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { fetchEspnTeamInfo } from "./espn";
// NEO-212: the SINGLE career-timeline ordering, shared with
// commitCardChecklistPrelude in convex/selectorOptions.ts. Both paths write
// `players.teamYears`; if they sorted differently the same player would read
// back as a different timeline depending on which one created them.
import { sortTeamYears } from "../../lib/players/team-tenure";
// NEO-212 security review: the shared `Q<digits>` chokepoint. `qidFromIri`
// below is where an EXTERNAL string first becomes something we call an id, so
// it is the right place to decide whether it is one.
import { isWikidataQid } from "../../lib/players/wikidata-id";
// NEO-236: every outward-facing lookup (ESPN's displayName, Wikidata's label)
// is keyed on the COMPOSED full name, never on the stored nickname.
import { teamFullName } from "../../lib/teams/team-name";

/**
 * Wikidata SPARQL adapter — enriches players (HoF, career teams) and
 * teams (location, league, years active) from query.wikidata.org. No API
 * key required.
 *
 * Concurrency model (NEO-99): every SPARQL caller — the review-wizard
 * drain and the id-based `enrichPlayer`/`enrichTeam` alike — is enqueued
 * onto the deployment-wide `wikidataPool` (convex/wikidataPool.ts, pinned
 * to `maxParallelism: 5`). That pool is the ONLY thing rate-limiting
 * Wikidata now, and it does so across the whole deployment: Wikidata's
 * documented ceiling is 5 parallel queries per client IP, and Convex Cloud
 * egresses one IP, so a per-batch chain was never enough — several review
 * batches (or the E2E runners) draining at once each ran their own serial
 * chain and still summed past 5 parallel, Wikidata throttled the IP, and a
 * lookup with no fetch timeout hung forever, stranding the wizard on
 * "Looking up…". The pool replaces the old per-batch `runAfter` chains
 * (`processEntityReviewQueue` / `processEnrichmentQueue`, both removed):
 * 100s of items queue and drain exactly 5-wide, so the wizard's reactive
 * `getBatch` streams rows resolving one-by-one instead of blocking.
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
 * Hard ceiling on a single SPARQL round trip (NEO-99).
 *
 * `runSparql` had no timeout at all, which is the second half of the
 * "Looking up…" hang: when Wikidata throttled our IP a request could stall
 * indefinitely, and because the `await` never returned, the row was never
 * patched out of `pending` — the pool's `onComplete` and the stale-row cron
 * are backstops, but the primary fix is to never stall in the first place.
 * `AbortSignal.timeout` makes a throttled/slow call reject fast; `runSparql`
 * already maps any rejection to `null`, so the caller resolves the row to
 * "error" (shown as "No Wikidata match found") within seconds instead of hanging.
 *
 * 10s is comfortably above a healthy query — a single direct SPARQL call
 * returns in ~0.4s — while short enough that a genuinely stuck request gives
 * up long before a user would. Each lookup makes at most two of these
 * sequentially (search + detail), so the worst case per entity is ~20s.
 */
const WIKIDATA_FETCH_TIMEOUT_MS = 10_000;

/**
 * NEO-96: everything this module needs to know about a sport, resolved by the
 * caller from the sport row's `sportConfig` and passed in.
 *
 * The `SPORT_QIDS` and `HOF_QIDS` maps that used to live here were keyed by
 * lowercase display name while every production caller passed display-cased
 * strings ("Baseball"). That silently disabled player matching AND Hall-of-Fame
 * resolution until two separate `.toLowerCase()` patches were added — two
 * outages of the same class, in one file, from keying behaviour on a display
 * string. The values now live on the sport row (see convex/sportConfig.ts) and
 * arrive here already resolved, so there is nothing left to mis-key.
 *
 * Every field is optional: an unmapped or custom sport yields no enrichment
 * rather than an error, which is the long-standing convention here (a miss is
 * "fall back", not a failure).
 */
export interface SportEnrichmentContext {
  /** Display value, for log lines only — never used for lookup. */
  label: string;
  espn?: { path: string; leagueName: string };
  wikidata?: { sportQid: string; hallOfFameQid?: string };
}

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
 * response (including 429 rate-limit and 5xx), and null on a timeout or
 * network error — a throttled or slow request aborts after
 * `WIKIDATA_FETCH_TIMEOUT_MS` and is mapped to null like any other failure,
 * so the caller resolves its row to "error" rather than awaiting forever.
 *
 * Concurrency is NOT this function's concern: the `wikidataPool` bounds how
 * many of these run at once across the whole deployment (≤5). The timeout
 * bounds how LONG any single one may run. Together they are what make the
 * "Looking up…" hang impossible — the pool keeps us under Wikidata's
 * 5-parallel-per-IP ceiling so it does not throttle us, and the timeout
 * guarantees termination even if it does. This function does not retry.
 */
async function runSparql(query: string): Promise<SparqlResults | null> {
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/sparql-results+json",
        "User-Agent": USER_AGENT,
      },
      // Aborts a throttled/stalled request instead of hanging the action (and
      // with it the review row) indefinitely — see WIKIDATA_FETCH_TIMEOUT_MS.
      // A fired timeout rejects fetch with a TimeoutError, caught below → null.
      signal: AbortSignal.timeout(WIKIDATA_FETCH_TIMEOUT_MS),
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
 *
 * NEO-212 security review — returns `undefined` unless the result actually IS
 * a `Q<digits>` id.
 *
 * It used to return the last path segment unconditionally, which meant this
 * function's return type said "a QID" while its behaviour said "whatever came
 * after the last slash of a string an external endpoint sent us". That value
 * flows into `players`/`teams` `externalIds.wikidataId`, and a stored id is
 * later interpolated into an outbound link — so this is the earliest point
 * where the claim can be made true rather than assumed.
 *
 * Callers cope by treating `undefined` as "no match", which is the answer they
 * already had a branch for: a lookup that finds nothing is the ordinary case
 * here (minor leaguers, defunct clubs), not an error path.
 */
function qidFromIri(iri: string): string | undefined {
  const idx = iri.lastIndexOf("/");
  const candidate = idx === -1 ? iri : iri.slice(idx + 1);
  return isWikidataQid(candidate) ? candidate : undefined;
}

/**
 * NEO-254 — the label service's language list, in ONE place.
 *
 * ## Why `en,mul` and not `en`
 *
 * Wikidata has been migrating names that are the same in every language into
 * the `mul` (multilingual) label since 2024, and REMOVING the per-language
 * copies as it goes. `wikibase:label` does not fall back across languages
 * unless the list says so, so a query asking only for `en` gets nothing for
 * such an entity — and the service's documented behaviour when it finds no
 * label is to hand back the bare QID as the label.
 *
 * That is not hypothetical. Q1215892 is the National Hockey League; its name
 * lives in `mul` and it has no `en` label at all, so `?leagueLabel` came back
 * as the string "Q1215892" and the review wizard offered to create a league
 * literally named that (Jason, preview test on California Golden Seals
 * Q849315). Asking for `en,mul` fixes it at the source for every entity in
 * that migration — which is a growing share of them.
 *
 * Order matters and `en` stays first: where both exist, the English label is
 * the one that has been curated for an English audience.
 *
 * A constant rather than three copies of the string, for the reason
 * `lib/players/wikidata-id.ts` gives about `Q<digits>`: three copies of a rule
 * are three chances for the next query added here to be written against the
 * old one. `wikidata.labelService.test.ts` asserts nothing in this file builds
 * a label-service block any other way.
 */
const LABEL_SERVICE_LANGUAGES = "en,mul";

/**
 * The `SERVICE wikibase:label` block every query here shares.
 */
const LABEL_SERVICE = `SERVICE wikibase:label { bd:serviceParam wikibase:language "${LABEL_SERVICE_LANGUAGES}". }`;

/**
 * NEO-254 — a label-service value, or undefined when it handed back a QID.
 *
 * The second line of defence behind `LABEL_SERVICE`. `en,mul` finds a name for
 * everything that HAS one somewhere, but an entity with no label in either
 * still yields the bare QID, and "Q127635" must never reach an operator as a
 * name — it is not a name, and offering to create a row called that is how a
 * junk row gets made with the app's own encouragement.
 *
 * Undefined rather than the QID, so every caller's existing "no value" branch
 * handles it: the wizard shows its existing-league pills and "No league"
 * instead of a `Create Q1215892` pill.
 */
function labelValue(binding?: SparqlBinding): string | undefined {
  const value = binding?.value;
  if (value === undefined) return undefined;
  return isWikidataQid(value) ? undefined : value;
}

/**
 * Parse a Wikidata date binding (xsd:dateTime, e.g. "2011-01-01T00:00:00Z")
 * to a 4-digit year. Wikidata sometimes uses "+0000-01-01" for unknown
 * precision — those return undefined.
 *
 * NEO-235: a qualifier is NOT always a bare year. Wikidata stores each date
 * with a precision, and WDQS renders whatever it has: Tony Gwynn's P580 for
 * the Padres is precision 11 (day) and arrives as "1982-07-19T00:00:00Z",
 * where a year-precision one arrives as "1982-01-01T00:00:00Z". Both must
 * yield 1982 — the regex anchors on the first `<digits>-` group, which is the
 * year in either rendering, so day precision was already handled. There is now
 * a test pinning that, because the failure mode (a full date silently becoming
 * no stint) is exactly the class of bug this ticket is about.
 */
function yearFromBinding(binding?: SparqlBinding): number | undefined {
  if (!binding) return undefined;
  const m = binding.value.match(/(-?\d{1,4})-/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 1800 ? n : undefined;
}

/**
 * ── NEO-235: how Wikidata actually records the facts we want ────────────────
 *
 * Verified live against query.wikidata.org and Special:EntityData on
 * 2026-09-04. Everything below is transcribed from that dump, not inferred.
 *
 * ## Hall of Fame is NOT one property
 *
 * We shipped a single rule — `wdt:P166` (award received) == the sport's
 * `hallOfFameQid` — and it is correct but PARTIAL. Wikidata's editors record
 * an induction under either of two properties depending on whether they model
 * the Hall as an award or as an institution you become a member of, and which
 * one they picked varies BY SPORT:
 *
 *   Tony Gwynn        Q1145222  P463 → Q809892 (P580 2007)   ← no P166 at all
 *   Babe Ruth         Q213812   P463 → Q809892 (P585 1936)   ← no P166 at all
 *   Ken Griffey Jr.   Q536900   P463 → Q809892 (P585 2016)   ← no P166 at all
 *   Jerry Rice        Q505423   P166 → Q778412 (Pro Football HoF)
 *   Wayne Gretzky     Q209518   P166 → Q1136687 (Hockey HoF)
 *
 * Endpoint-wide counts of humans linked to each Hall (SPARQL, same date):
 *
 *   National Baseball HoF Q809892   P463  66   P166  41   ← both, majority P463
 *   Pro Football HoF      Q778412   P463   0   P166 314
 *   Naismith BB HoF       Q290922   P463   0   P166  52
 *   Hockey HoF            Q1136687  P463   2   P166 402
 *
 * So P166 alone loses roughly two thirds of baseball's Hall of Famers, and
 * baseball is the sport with the most cards. Both properties are checked now.
 *
 * P1344 (participant in) and P39 (position held) were sampled too and carry
 * nothing HoF-shaped for any of the four Halls — they are not strategies.
 *
 * Known upstream GAP, not a code gap: Michael Jordan (Q41421) has no statement
 * of any property pointing at Q290922. No strategy can find what is not there;
 * he resolves to `isHallOfFame: false` until Wikidata is edited.
 *
 * ## Career teams are not always dated
 *
 * Gwynn's three `P54` (member of sports team) statements:
 *
 *   Q721134   San Diego Padres                    P580 1982-07-19  P582 2001
 *   Q7413724  San Diego State Aztecs men's bball   P580 1977        P582 1981
 *   Q16969667 San Diego State Aztecs baseball      (no qualifiers)
 *
 * The Padres' P580 is a FULL date, which is why `yearFromBinding` has to cope
 * with more than a bare year — see the test that pins 1982-07-19 → 1982.
 *
 * The third has no qualifiers at all, and `players.teamYears` requires
 * `fromYear`, so it cannot become a stint. See `CAREER_TEAM_STRATEGIES` below
 * for why we do NOT synthesize one from P2031/P2032.
 *
 * ## Career teams are not always the player's sport
 *
 * The second is a BASKETBALL team (its `P641` is Q5372). Gwynn is a baseball
 * player, and before NEO-254 every `P54` became a stint regardless, so
 * enriching him minted a Baseball-sport team "San Diego State Aztecs men's
 * basketball" and, through that team's `P118`, a Baseball-sport league "NCAA
 * Division I men's basketball" (Q94861615). The detail query now also binds
 * the team's own `P641`, and `membershipIsOutsidePlayerSport` drops a
 * membership whose team sport is known AND is not the player's. A team with
 * no `P641` at all is kept: an unknown sport is not evidence of a wrong one.
 */

/**
 * The ordered list of ways a Hall-of-Fame induction can be recorded, checked
 * in order — first match wins and the rest are skipped. Adding a newly
 * discovered shape means adding one entry here: the SPARQL fragment and the
 * row parser are both generated from this array, so the two cannot drift.
 *
 * `binding` is the SPARQL result variable the strategy's block binds. The
 * label SERVICE auto-binds any `?<var>Label` whose prefix is another variable
 * in scope, so these names must not collide with one another's prefixes.
 *
 * `award` is deliberately still called `award` — it is the pre-NEO-235
 * variable name, and keeping it means the existing fixtures keep describing
 * the same wire shape they always did.
 */
interface HallOfFameStrategy {
  /** Stable id, used in the log line that says which strategy answered. */
  id: string;
  /** The Wikidata property that carries the link. */
  property: string;
  /** The SPARQL result variable this strategy's OPTIONAL block binds. */
  binding: string;
}

const HALL_OF_FAME_STRATEGIES: ReadonlyArray<HallOfFameStrategy> = [
  // P166 "award received" — how football, basketball and hockey record it,
  // and a large minority of baseball.
  { id: "awardReceived", property: "P166", binding: "award" },
  // P463 "member of" — how the majority of baseball records it (Gwynn, Ruth,
  // Griffey). NEO-235: the shape that was invisible to us before.
  { id: "memberOf", property: "P463", binding: "memberOf" },
];

/**
 * The strategies' SPARQL fragment, or "" when the sport has no usable Hall
 * QID (an unmapped sport, or a row carrying a non-QID string).
 *
 * Each block matches a FIXED object — `wd:<hofQid>` — rather than binding
 * every award the player ever won and filtering in JS. That is both the
 * cheaper query (a single triple lookup instead of a scan) and a large
 * response saving: the old `?award` column multiplied the membership rows by
 * the player's entire award list, so Michael Jordan's detail query returned
 * ~350 rows for 7 teams. Gwynn's returns exactly 3 — one per membership.
 */
function hallOfFameSparqlBlocks(qid: string, hofQid: string | undefined): string {
  if (!hofQid) return "";
  return HALL_OF_FAME_STRATEGIES.map(
    (s) =>
      `      OPTIONAL { wd:${qid} wdt:${s.property} wd:${hofQid} . ` +
      `BIND(wd:${hofQid} AS ?${s.binding}) }`,
  ).join("\n");
}

/**
 * The id of the first strategy whose binding resolves to the sport's Hall,
 * or undefined when none does.
 *
 * The `=== hofQid` re-check is not redundant with the SPARQL fixed object: it
 * is the same defensive posture as `qidFromIri` itself — the endpoint's
 * response is external input, and this is the value that decides a stored
 * boolean.
 */
function detectHallOfFame(
  row: Record<string, SparqlBinding>,
  hofQid: string,
): string | undefined {
  for (const strategy of HALL_OF_FAME_STRATEGIES) {
    const binding = row[strategy.binding];
    if (binding && qidFromIri(binding.value) === hofQid) return strategy.id;
  }
  return undefined;
}

/** One P54 membership as it arrives from the detail query. */
interface MembershipBindings {
  start?: SparqlBinding;
  end?: SparqlBinding;
}

/**
 * What a career-team strategy decided about one membership: either a real
 * stint, or a membership we can name but not place in time.
 */
type CareerTeamMatch =
  | { kind: "stint"; fromYear: number; toYear?: number }
  | { kind: "undated" };

interface CareerTeamStrategy {
  id: string;
  match: (m: MembershipBindings) => CareerTeamMatch | undefined;
}

/**
 * The ordered list of P54 membership shapes, checked in order — first match
 * wins. Like `HALL_OF_FAME_STRATEGIES`, this is the extension point: a newly
 * discovered shape is one more entry, and both consumers of
 * `PlayerLookupResult` (the review wizard's preview and `enrichPlayer`'s
 * write) pick it up at once because both read the same parsed result.
 *
 * ## NEO-235: why an undated membership is NOT given a synthetic span
 *
 * `players.teamYears` requires `fromYear`, so a membership with no P580
 * cannot be stored as a stint. The tempting fix is to borrow the player's
 * P2031/P2032 (start/end of work period) when there is exactly one undated
 * membership. Gwynn is the counter-example that rules it out: his undated P54
 * is San Diego State Aztecs BASEBALL — a college team he played for around
 * 1977-1981 — while his P2031/P2032 are 1982 and 2001, his MLB career. That
 * inference would have written "Tony Gwynn, San Diego State Aztecs baseball,
 * 1982-2001", a stint that never happened, into a table the SKU/listing paths
 * read. Fabricating a wrong date is strictly worse than admitting we have
 * none.
 *
 * So undated memberships are excluded from `careerTeams` and surfaced by NAME
 * in `undatedCareerTeams`, where an operator can see that Wikidata knows about
 * the team and add the years by hand if they matter.
 */
const CAREER_TEAM_STRATEGIES: ReadonlyArray<CareerTeamStrategy> = [
  {
    // A closed stint: P580 and P582 both present. Also the OPEN-ENDED case
    // (P580 only, an active player) — `yearFromBinding` answers undefined for
    // a missing end, which is exactly what `toYear` optional means.
    id: "datedMembership",
    match: (m) => {
      const fromYear = yearFromBinding(m.start);
      if (fromYear === undefined) return undefined;
      return { kind: "stint", fromYear, toYear: yearFromBinding(m.end) };
    },
  },
  {
    // No usable P580. Named, but not placeable in time — see the block
    // comment above for why we do not invent one.
    id: "undatedMembership",
    match: () => ({ kind: "undated" }),
  },
];

/** First strategy to claim the membership. The list ends in a total match. */
function classifyMembership(m: MembershipBindings): CareerTeamMatch | undefined {
  for (const strategy of CAREER_TEAM_STRATEGIES) {
    const match = strategy.match(m);
    if (match) return match;
  }
  return undefined;
}

/**
 * NEO-240 security review — a sport QID that is safe to interpolate into a
 * SPARQL body, or `undefined`.
 *
 * All three `find*Qid` functions below build their query by string
 * interpolation, and `wd:${sportQid}` puts an arbitrary value directly into
 * the query TEXT: a value containing `.`, `}` or `#` closes the triple and
 * writes the rest of the pattern. The value is not attacker-supplied over the
 * wire, but it is not a constant either — it comes off a `selectorOptions`
 * sport row, which an operator can edit, which a legacy row may predate any
 * validation of, and which `storeSelectorOptions` writes from config. "The
 * schema says string" is not the same as "this is safe to inline".
 *
 * So it is validated at the point of interpolation, exactly as
 * `hallOfFameQid` already is further down this file — the one place the claim
 * can be made true rather than assumed.
 *
 * Warn-and-degrade rather than throw: a mis-typed sport QID is a
 * configuration defect, and the right outcome is the same graceful "no match"
 * an unconfigured sport already gets, with a log line naming which lookup saw
 * it so the row can be found. `where` is a literal from the call site, never
 * input.
 */
function safeSportQid(
  sportQid: string | undefined,
  where: string,
): string | undefined {
  if (sportQid === undefined) return undefined;
  if (isWikidataQid(sportQid)) return sportQid;
  console.warn(JSON.stringify({ msg: "wikidata_sport_qid_not_a_qid", where }));
  return undefined;
}

/**
 * NEO-254 — is this `P54` membership on a team of a DIFFERENT sport from the
 * player's? True only when both sides are known QIDs and they differ.
 *
 * Both absences answer false on purpose:
 *  - no `teamSportQid`: the team has no `P641`. Unknown is not evidence, and
 *    dropping every un-annotated club would lose real memberships.
 *  - no `playerSportQid` (or one that is not a QID): the sport row gives us
 *    nothing to compare against, so nothing is filtered. Today this cannot be
 *    reached from `lookupPlayerEnrichment` — `findPlayerQid` refuses to run
 *    without the same QID — but the filter must not become a silent "drop
 *    everything" if that guard is ever relaxed.
 *
 * Exported so the absent-sport case can be pinned directly.
 */
export function membershipIsOutsidePlayerSport(
  teamSportQid: string | undefined,
  playerSportQid: string | undefined,
): boolean {
  if (teamSportQid === undefined || !isWikidataQid(teamSportQid)) return false;
  if (playerSportQid === undefined || !isWikidataQid(playerSportQid)) return false;
  return teamSportQid !== playerSportQid;
}

/**
 * Find the best Wikidata QID for a player using the MediaWiki entity
 * search inlined in SPARQL — much faster than a label-FILTER scan since
 * Wikidata indexes labels and aliases for prefix lookup. The sport
 * filter (`wdt:P641`) picks off the right "John Smith" across leagues.
 */
async function findPlayerQid(
  name: string,
  sportQid: string | undefined,
): Promise<string | null> {
  // NEO-96: the QID now arrives from the sport row's `sportConfig.wikidata`
  // instead of being looked up in a display-name-keyed map here. That map's
  // casing assumption had already caused one real outage of this exact
  // function — it was keyed lowercase while callers passed "Baseball", so
  // player enrichment silently matched nobody until a `.toLowerCase()` was
  // patched in. Passing the resolved value removes the class of bug.
  //
  // NEO-240 security review: validated before it is interpolated — see
  // `safeSportQid`. A non-QID is indistinguishable from an ABSENT one for
  // this function, and both refuse: `wdt:P641` is what makes "any human"
  // matching a name tolerable, so running without it is not a degraded
  // lookup, it is a wrong one.
  const safeQid = safeSportQid(sportQid, "findPlayerQid");
  if (!safeQid) return null;

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
              wdt:P641 wd:${safeQid} .
    }
    LIMIT 1
  `;

  const result = await runSparql(query);
  const binding = result?.results.bindings[0];
  // `?? null`: an IRI whose final segment is not a QID is no match at all.
  return binding ? (qidFromIri(binding.player.value) ?? null) : null;
}

async function findTeamQid(
  /** The COMPOSED full name — Wikidata labels franchises "San Diego Padres". */
  name: string,
  sportQid: string | undefined,
): Promise<string | null> {
  // See the NEO-96 note in findPlayerQid above, and the NEO-240 one: the same
  // interpolation, the same validation, and the same refusal on a non-QID —
  // "any sports team" needs `wdt:P641` for the same reason "any human" does.
  const safeQid = safeSportQid(sportQid, "findTeamQid");
  if (!safeQid) return null;

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
      ?team wdt:P641 wd:${safeQid} .
    }
    LIMIT 1
  `;

  const result = await runSparql(query);
  const binding = result?.results.bindings[0];
  // See the note in findPlayerQid — a non-QID segment is treated as no match.
  return binding ? (qidFromIri(binding.team.value) ?? null) : null;
}

/**
 * NEO-240 — Wikidata's class for a sports league: "group of sports teams or
 * individual athletes that compete against each other".
 *
 * VERIFIED LIVE 2026-09-04 against
 * `https://www.wikidata.org/wiki/Special:EntityData/Q623109.json` (User-Agent
 * header set): `labels.en.value === "sports league"`. Recorded here rather
 * than assumed, because a wrong class QID fails silently in exactly the way
 * NEO-235's four `hallOfFameQid` constants did — the filter matches nothing,
 * every league resolves to "no match", and a unit test that supplies both
 * sides of the comparison agrees with itself while agreeing with nothing real.
 */
const SPORTS_LEAGUE_QID = "Q623109";

/**
 * Find the best Wikidata QID for a LEAGUE — the twin of `findTeamQid`, using
 * the same inlined MediaWiki EntitySearch.
 *
 * ## Two filters, and why the sport one is optional here
 *
 * `wdt:P31/wdt:P279* wd:Q623109` (instance/subclass of sports league) is the
 * load-bearing one, and it is far narrower than the team/player equivalents:
 * "any human" and "any sports team" match thousands of entities per name, so
 * those two functions REFUSE to run without `wdt:P641` to disambiguate. A
 * league name plus "is a sports league" is already a tight bound, so this one
 * degrades instead of refusing: a sport row with no `sportConfig.wikidata`
 * (any custom sport) still gets a lookup rather than a guaranteed miss.
 *
 * The residual risk of the sport-less path is a same-named league in another
 * sport, and what contains it is downstream: `applyEnrichmentInternal` gap-fills
 * only and never touches `name`, so a wrong match can add an abbreviation and a
 * span to a bare row, never rewrite an operator's answer, and the admin
 * "Discover" button is the documented remedy.
 *
 * ## VERIFIED LIVE 2026-09-04 — this exact query, one call per sport
 *
 *   "MLB" + Q5369  (baseball)         → Q1163715  Major League Baseball
 *   "NFL" + Q41323 (American football) → Q1215884  National Football League
 *   "NBA" + Q5372  (basketball)        → Q155223   National Basketball Association
 *   "NHL" + Q41466 (ice hockey)        → Q1215892  P1813 "NHL", P571 1917-11-26
 *
 * Two things that verification found, neither of which reading the code would
 * have shown:
 *
 * 1. **The NHL is Q1215892, not Q1734.** Q1734 — the value this work package
 *    was specified with — is `volleyball`, the SPORT. Same class of error as
 *    the NEO-235 hall-of-fame QIDs, caught this time before it was written
 *    down. Q1215892 has no English *label* (only a description and a P1813
 *    short name), which is why the label service renders it as its own QID;
 *    that is a Wikidata gap, not a lookup failure, and it costs us nothing
 *    because we never read a league's Wikidata label.
 *
 * 2. **Search-result order must be asked for explicitly.** Without
 *    `wikibase:apiOrdinal`, "NFL" + Q41323 returned Q6972733 FIRST — a real,
 *    correctly-classified "National Football League", but the 1902
 *    Pennsylvania one, defunct for 120 years. mwapi hands SPARQL its hits as
 *    an unordered set, so `LIMIT 1` over a bare join keeps whichever row the
 *    join emitted first, which is not the relevance order the search computed.
 *    Binding `?num wikibase:apiOrdinal true` and ordering by it restores that
 *    ranking: the real NFL is rank 0, the 1902 league rank 21.
 *
 *    `findPlayerQid` / `findTeamQid` do NOT do this, and this is not a drive-by
 *    fix for them: their `wdt:P641` filter is what makes their first row
 *    tolerable, and changing their result selection is a behaviour change to
 *    two shipped enrichment paths that belongs to its own ticket.
 *
 * ## Nothing from that table is stored anywhere
 *
 * `sportConfig` gains no league QIDs. These are the answers this function must
 * PRODUCE; pinning them as constants would recreate both halves of the NEO-235
 * failure — a hand-copied external id, and one that gets stamped onto rows
 * where correcting the constant can no longer reach it.
 */
async function findLeagueQid(
  name: string,
  sportQid: string | undefined,
): Promise<string | null> {
  const safeName = sparqlStringLiteral(name);
  // NEO-240 security review — see `safeSportQid`. This is the one of the three
  // that DEGRADES rather than refusing: the sports-league class filter is a
  // tight enough bound on its own (see above), so a non-QID lands on exactly
  // the sport-less path a custom sport already takes. What it must never do is
  // reach the query body.
  const safeQid = safeSportQid(sportQid, "findLeagueQid");
  const sportFilter = safeQid ? `?league wdt:P641 wd:${safeQid} .` : "";
  const query = `
    SELECT DISTINCT ?league ?num WHERE {
      SERVICE wikibase:mwapi {
        bd:serviceParam wikibase:api "EntitySearch" .
        bd:serviceParam wikibase:endpoint "www.wikidata.org" .
        bd:serviceParam mwapi:search "${safeName}" .
        bd:serviceParam mwapi:language "en" .
        ?league wikibase:apiOutputItem mwapi:item .
        ?num wikibase:apiOrdinal true .
      }
      ?league wdt:P31/wdt:P279* wd:${SPORTS_LEAGUE_QID} .
      ${sportFilter}
    }
    ORDER BY ?num
    LIMIT 1
  `;

  const result = await runSparql(query);
  const binding = result?.results.bindings[0];
  // See the note in findPlayerQid — a non-QID segment is treated as no match.
  return binding ? (qidFromIri(binding.league.value) ?? null) : null;
}

/**
 * Player enrichment result, shared by both consumers:
 *  - `enrichPlayer` (id-based, post-creation) resolves `careerTeams` names to
 *    real team ids via `teams.findByFullNameInternal` before persisting, and
 *    DROPS any it cannot match (NEO-236 — it never creates a team).
 *  - `runEntityReviewLookup` (NEO-92, name-based, pre-creation preview)
 *    stores `careerTeams` as bare names — resolving to real team rows is
 *    deferred to commit time (only once "create" is the confirmed decision)
 *    so a mere preview lookup can never orphan a team row for a player the
 *    user ends up linking to someone else or never creates at all.
 */
export interface PlayerLookupResult {
  wikidataId: string;
  /**
   * Sorted earliest-stint-first (see `sortTeamYears`), and one entry PER
   * STINT — a player who left a franchise and came back has two.
   */
  careerTeams: Array<{
    name: string;
    fromYear: number;
    toYear?: number;
    /**
     * NEO-236 — the team's OWN Wikidata QID, from the P54 statement's value.
     *
     * Carried through because the review wizard now stages a real team row for
     * a career team we do not hold, and that row needs its own enrichment. A
     * name search for "Sydney Blue Sox" against EntitySearch is a guess that
     * can land on the wrong entity or on nothing; the QID Wikidata just handed
     * us for this membership is the same club, by construction. Optional
     * because the value is only a QID when the IRI parses as one.
     *
     * This is a Wikidata id travelling as LINKAGE, not as truth: it selects
     * which upstream record to read, and nothing user-facing is keyed on it.
     */
    wikidataId?: string;
  }>;
  /**
   * NEO-235 — teams Wikidata links the player to with NO usable start year,
   * by name, sorted alphabetically. Absent (not `[]`) when there are none.
   *
   * These are real memberships that simply cannot be stored: `teamYears`
   * requires `fromYear`, and inventing one from the player's P2031/P2032 work
   * period fabricates a stint that never happened (see
   * `CAREER_TEAM_STRATEGIES` for the Gwynn case that proves it). Before this
   * they were dropped SILENTLY, so a Wikidata team the operator could have
   * dated by hand was invisible to them.
   *
   * Alphabetical rather than response order for the same reason `careerTeams`
   * is sorted: SPARQL binding order is not stable, and an unsorted list would
   * make the same player read back differently on two lookups.
   *
   * Preview-only — `enrichPlayer` ignores it, because `players.teamYears` has
   * nowhere to put a team with no years. The review wizard can render it as
   * "also listed, without dates: …"; no UI consumes it yet.
   */
  undatedCareerTeams?: string[];
  isHallOfFame?: boolean;
  // ── NEO-212: player disambiguation context for the review wizard ──────────
  //
  // Wikidata routinely returns several entities for one card name ("Chris
  // Johnson" is a running back, an outfielder and a British cyclist), and a
  // bare label gave the operator nothing to choose on. All three are
  // best-effort: a real but thinly-documented player has none of them, which
  // is why each is optional rather than defaulted to a placeholder string.
  //
  // These are consumed only by the review-wizard path: `runEntityReviewLookup`
  // spreads this whole result into `entityReviewQueue.enrichment` (whose
  // validator carries all three), so nothing extra is needed to route them.
  // `enrichPlayer` ignores them — `players` has no column for them, and adding
  // one would be storing a Wikidata blurb as if it were NeonBinder card data.
  /** Wikidata's English `schema:description` — "American football running back". */
  description?: string;
  birthYear?: number;
  /** English Wikipedia article title, so the wizard can link out to it. */
  enwikiTitle?: string;
}

export interface TeamLookupResult {
  wikidataId?: string;
  league?: string;
  /**
   * NEO-254 — the LEAGUE's own Wikidata QID, off the same P118 statement the
   * label came from.
   *
   * Carried for the reason `careerTeams[].wikidataId` is (NEO-236): the review
   * wizard now stages a real league row for a league we do not hold, and that
   * row needs its own lookup. Searching EntitySearch for "National Hockey
   * League" is a guess that can land on a video game or a defunct namesake;
   * the QID Wikidata just handed us for this team's league is the same
   * competition by construction.
   *
   * LINKAGE, not truth: it selects which upstream record to read, and nothing
   * user-facing is keyed on it.
   */
  leagueWikidataId?: string;
  /** NEO-236: the place part of the team name. Location, not city. */
  location?: string;
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
  sport: SportEnrichmentContext,
): Promise<PlayerLookupResult | null> {
  const qid = await findPlayerQid(name, sport.wikidata?.sportQid);
  if (!qid) {
    // NEO-208 security condition: structured, not concatenated. `name` is
    // operator-typed free text (the quick-add form, the review wizard, the
    // pickers), and a raw interpolation lets it inject newlines and
    // log-shaped text into the deployment log a human then reads.
    console.log(
      JSON.stringify({
        msg: "wikidata_player_no_match",
        name,
        sport: sport.label,
      }),
    );
    return null;
  }

  // NEO-96: from the sport row's own config. This used to be a lookup into a
  // lowercase-keyed HOF_QIDS map with display-cased callers, which silently
  // meant `isHallOfFame` never resolved for anyone until a `.toLowerCase()` was
  // patched in — the second outage of that exact class in this file.
  //
  // NEO-235 security: this value reaches SPARQL as `wd:${hofQid}` now, so it
  // has to be a QID before it is interpolated. It comes off a `selectorOptions`
  // sport row — written from `sportConfig.ts` defaults today, but the row is
  // the source of truth and nothing stops an operator edit or a legacy row from
  // holding something else. A non-QID is treated as "this sport has no Hall we
  // know of" (isHallOfFame stays undefined), which is the same graceful
  // degradation an unmapped sport already gets — never a definitive `false`
  // derived from a value we refused to use.
  const configuredHofQid = sport.wikidata?.hallOfFameQid;
  const hofQid =
    configuredHofQid && isWikidataQid(configuredHofQid) ? configuredHofQid : undefined;
  if (configuredHofQid && !hofQid) {
    console.warn(
      JSON.stringify({
        msg: "wikidata_sport_hall_of_fame_qid_not_a_qid",
        sport: sport.label,
      }),
    );
  }

  // NEO-212: the three disambiguation fields are all OPTIONAL and all
  // single-valued per entity, so they ride along on the existing membership ×
  // award cross-product rather than costing another round trip. Variable names
  // are deliberately NOT `?playerDescription`/`?playerLabel`-shaped: the label
  // SERVICE below auto-binds any `?<var>Label`/`?<var>Description` whose
  // prefix is another variable in scope, and colliding with that would make it
  // overwrite our own bindings.
  //
  // NEO-235: the Hall-of-Fame blocks are GENERATED from
  // `HALL_OF_FAME_STRATEGIES` rather than written out here, so adding a newly
  // discovered shape never means remembering to edit both the query and the
  // parser. They are omitted entirely for a sport with no usable Hall QID.
  const detailQuery = `
    SELECT ?team ?teamLabel ?teamSport ?start ?end ${HALL_OF_FAME_STRATEGIES.map((s) => `?${s.binding} `).join("")}?descr ?dob ?title WHERE {
      OPTIONAL {
        wd:${qid} p:P54 ?membership .
        ?membership ps:P54 ?team .
        OPTIONAL { ?membership pq:P580 ?start . }
        OPTIONAL { ?membership pq:P582 ?end . }
        OPTIONAL { ?team wdt:P641 ?teamSport . }
      }
${hallOfFameSparqlBlocks(qid, hofQid)}
      OPTIONAL {
        wd:${qid} schema:description ?descr .
        FILTER(LANG(?descr) = "en")
      }
      OPTIONAL { wd:${qid} wdt:P569 ?dob . }
      OPTIONAL {
        ?article schema:about wd:${qid} ;
                 schema:isPartOf <https://en.wikipedia.org/> ;
                 schema:name ?title .
      }
      ${LABEL_SERVICE}
    }
  `;
  const result = await runSparql(detailQuery);
  if (!result) return null;

  const careerTeams: Array<{
    name: string;
    fromYear: number;
    toYear?: number;
    wikidataId?: string;
  }> = [];
  // NEO-235: undated memberships, keyed by team QID so the same team repeated
  // across cross-product rows is named once. Values are the en labels.
  const undatedByTeamQid = new Map<string, string>();
  let isHallOfFame: boolean | undefined;
  // Which strategy answered, for the log line below — the whole point of
  // NEO-235 is that this is no longer always P166, and when a player comes back
  // wrong we need to know which shape we read them from.
  let hallOfFameVia: string | undefined;
  let description: string | undefined;
  let birthYear: number | undefined;
  let enwikiTitle: string | undefined;
  // NEO-212: keyed on the full STINT, not the team.
  //
  // The query returns the cross-product of memberships × whatever else binds
  // more than once, so a membership can repeat across rows. This set collapses
  // that repetition — that is the only job it ever had. Keying it on the bare
  // team QID also collapsed something real, though: a player traded away and
  // later re-signed has TWO P54 statements for one team, with different
  // P580/P582 qualifiers, and the second one was silently dropped. Including
  // the years in the key keeps the cross-product collapse (identical repeated
  // rows still collide) while letting two genuinely distinct stints both
  // through.
  //
  // NEO-235 shrank the cross-product at the source — the Hall-of-Fame blocks
  // now match a fixed object instead of binding every award — but did not
  // remove the need for this: Wikidata itself carries duplicate P54 statements
  // for one stint (Michael Jordan has North Carolina twice at 1981-1984, at
  // different date precisions), and those still arrive as two identical rows.
  const seenStints = new Set<string>();
  // NEO-254: memberships on a team of another sport, keyed by the same stint
  // key. A team can carry SEVERAL `P641` values (a multi-sport athletic
  // program), and they arrive as one row per sport, so a membership is only
  // truly outside the player's sport if NO row for it matches. A mismatching
  // row parks the stint here; a later matching (or un-annotated) row accepts
  // it through the ordinary path and removes it; whatever is still parked
  // after the loop is skipped and logged, once per stint.
  const playerSportQid = sport.wikidata?.sportQid;
  const parkedOutsideSport = new Map<
    string,
    { teamWdId: string; teamLabel: string; teamSportQid: string }
  >();

  for (const row of result.results.bindings) {
    // NEO-212 security review: `qidFromIri` now answers `undefined` for an IRI
    // whose final segment is not a `Q<digits>` id. A membership with no
    // resolvable team QID is skipped: the QID is the stint dedup key, and
    // keying on `"undefined"` would collapse two genuinely different teams'
    // stints into one. Wikidata always returns entity IRIs here, so this is a
    // guard against a malformed response, not an expected branch.
    const teamWdId = row.team ? qidFromIri(row.team.value) : undefined;
    if (row.team && row.teamLabel && teamWdId) {
      const stintKey = `${teamWdId}|${row.start?.value ?? ""}|${row.end?.value ?? ""}`;
      const teamSportQid = row.teamSport ? qidFromIri(row.teamSport.value) : undefined;
      if (
        !seenStints.has(stintKey) &&
        membershipIsOutsidePlayerSport(teamSportQid, playerSportQid)
      ) {
        // NEO-254: not accepted, not yet rejected — see `parkedOutsideSport`.
        if (!parkedOutsideSport.has(stintKey)) {
          parkedOutsideSport.set(stintKey, {
            teamWdId,
            teamLabel: row.teamLabel.value,
            // `membershipIsOutsidePlayerSport` answered true, so it is a QID.
            teamSportQid: teamSportQid as string,
          });
        }
      } else if (!seenStints.has(stintKey)) {
        seenStints.add(stintKey);
        parkedOutsideSport.delete(stintKey);
        // Wikidata's label service returns the bare QID as the label
        // when no label exists in the requested language (en).
        // Q127635 turned up via the Yakult Swallows lineage — a real
        // NPB team that simply hasn't had its English label added on
        // Wikidata yet. Rather than create a team named "Q127635",
        // skip the membership and leave a breadcrumb so we can
        // backfill once an English label appears upstream.
        //
        // NEO-235: hoisted ABOVE the dated/undated split — an unlabelled team
        // is unusable in `undatedCareerTeams` for exactly the same reason it is
        // unusable as a stint (the operator would be shown "Q127635").
        const labelLooksLikeQid = isWikidataQid(row.teamLabel.value);
        if (labelLooksLikeQid) {
          // NEO-208: structured for the same reason as the no-match log
          // above — `name` is operator input.
          console.warn(
            JSON.stringify({
              msg: "wikidata_player_team_membership_skipped_no_en_label",
              name,
              teamWdId,
            }),
          );
        } else {
          // NEO-235: which shape this membership is in is decided by the
          // ordered `CAREER_TEAM_STRATEGIES`, not by an inline `if`, so a
          // newly discovered shape is one array entry rather than a new branch
          // here.
          const match = classifyMembership({ start: row.start, end: row.end });
          if (match?.kind === "stint") {
            careerTeams.push({
              name: row.teamLabel.value,
              fromYear: match.fromYear,
              toYear: match.toYear,
              // NEO-236: `teamWdId` is already proven non-null by the guard
              // above (it is the stint dedup key), so this is never a guess.
              wikidataId: teamWdId,
            });
          } else if (match?.kind === "undated") {
            undatedByTeamQid.set(teamWdId, row.teamLabel.value);
          }
        }
      }
    }
    // NEO-235: strategy-driven. `hofQid` undefined short-circuits before the
    // loop, so a sport with no known Hall never claims an answer either way.
    if (hofQid && hallOfFameVia === undefined) {
      const via = detectHallOfFame(row, hofQid);
      if (via !== undefined) {
        hallOfFameVia = via;
        isHallOfFame = true;
      }
    }
    // NEO-212: entity-level, so identical on every row of the cross-product —
    // keep the first non-empty answer. Guarded on "still undefined" rather
    // than assigned unconditionally so a later row (where an OPTIONAL happened
    // to bind nothing) cannot blank a value an earlier row supplied.
    if (description === undefined && row.descr?.value) description = row.descr.value;
    if (birthYear === undefined) birthYear = yearFromBinding(row.dob);
    if (enwikiTitle === undefined && row.title?.value) enwikiTitle = row.title.value;
  }

  // NEO-254: one line per membership dropped for being another sport's team
  // — the Gwynn basketball case. Structured, and the label is truncated, for
  // the reasons `career_team_unmatched` gives: `name` is operator input and
  // the label is third-party text of no fixed length.
  for (const parked of parkedOutsideSport.values()) {
    console.log(
      JSON.stringify({
        msg: "wikidata_player_team_membership_skipped_other_sport",
        name,
        team: parked.teamLabel.slice(0, MAX_LOGGED_TEAM_NAME_LENGTH),
        teamWdId: parked.teamWdId,
        teamSportQid: parked.teamSportQid,
        playerSportQid,
      }),
    );
  }

  // No HoF row matched, but the player IS in our HoF-aware sports — we
  // can confidently say not-HoF. Otherwise leave undefined so unsupported
  // sports don't claim a definitive answer.
  if (isHallOfFame === undefined && hofQid) {
    isHallOfFame = false;
  }

  // NEO-235: WHICH strategy answered, not just that one did. The bug this
  // ticket fixes was invisible precisely because a false negative and a
  // genuine non-inductee looked identical in the logs; naming the shape means
  // the next player who comes back wrong tells us whether we read a shape we
  // do not handle yet or Wikidata simply has nothing. Structured for the same
  // reason as the no-match log above — `name` is operator input.
  if (isHallOfFame) {
    console.log(
      JSON.stringify({
        msg: "wikidata_player_hall_of_fame_detected",
        name,
        qid,
        via: hallOfFameVia,
      }),
    );
  }

  return {
    wikidataId: qid,
    // NEO-212: SPARQL binding order is not a career timeline — it is whatever
    // order the endpoint happened to return the statements in. Sorted here so
    // the wizard's preview, the committed `players.teamYears`, and
    // `enrichPlayer`'s own write all present the same sequence.
    careerTeams: sortTeamYears(careerTeams),
    // NEO-235: alphabetical, and omitted entirely when empty so a player with
    // nothing undated does not carry an empty array through the review row.
    //
    // NEO-254: deduped by LABEL on the way out, having been collected by QID.
    // The QID key is what collapses one membership repeated across the
    // cross-product rows, and it has to stay that key — two genuinely
    // different clubs can share a label. But the consumers downstream are all
    // name-shaped: `players.undatedCareerTeams` stores names, the wizard keys
    // its list items by name, and two identical strings there mean duplicate
    // React keys and two forms opening on one click. A label collision is
    // rare, and when it happens one entry the operator can date is a better
    // outcome than two they cannot tell apart.
    ...(undatedByTeamQid.size > 0
      ? {
          undatedCareerTeams: Array.from(
            new Set(undatedByTeamQid.values()),
          ).sort(),
        }
      : {}),
    isHallOfFame,
    ...(description !== undefined ? { description } : {}),
    ...(birthYear !== undefined ? { birthYear } : {}),
    ...(enwikiTitle !== undefined ? { enwikiTitle } : {}),
  };
}

/**
 * NEO-203 — "has this row already been enriched?", for the already-enriched
 * guard on `enrichPlayer` / `enrichTeam` below.
 *
 * ## Choosing markers that cannot mis-fire on a legitimately bare new row
 *
 * The guard must never suppress enrichment for a team or player that has
 * nothing yet. So the marker set is exactly the fields that NO creation path
 * writes, checked against every path that can insert a row:
 *
 *   teams — `selectorOptions` prelude `createTeamFromOperatorInput`, and
 *           `teams.findOrCreate` (the operator surfaces: TeamPicker's
 *           "+ Create", MissingTeamFixer, Team Management). Both insert
 *           exactly `{name, location?, nameNormalized, sportId, leagueId,
 *           lastUpdated}`. Since NEO-254 neither enqueues `enrichTeam` at all,
 *           so for teams this guard is now read by the operator's Discover
 *           button rather than by a creation path — a bare team reaching it is
 *           one a human is asking about.
 *   players — the `selectorOptions` prelude create path, which is the only one
 *           that inserts a player row outside Team/Player Management, and
 *           which does still enqueue at creation.
 *
 * `leagueId`, `lastUpdated` and — since NEO-236 — `location` are therefore NOT
 * markers, and must never become ones: every creation path can set all three,
 * so any of them would make the guard skip a brand-new row and silently
 * disable enrichment for it. That is the one failure mode this design has, and
 * it is why the markers are listed explicitly here rather than derived from
 * "any enrichment field".
 *
 * ## Why `location` had to be dropped (NEO-236)
 *
 * It was a valid marker for exactly as long as `teams.location` was something
 * only enrichment could produce. NEO-236 made Location the FIRST HALF OF THE
 * CREATION FORM — Jason: "Location & Team Name should be the input" — so every
 * team an operator creates for a real franchise arrives carrying one. Leaving
 * it in the marker set meant those teams were skipped here before any lookup
 * ran: no colours, no years, no `wikidataId`, no `espnId`, and no error
 * anywhere. Precisely the "silently disable enrichment" failure this docblock
 * warns about, reached through the front door.
 *
 * Nothing is lost by dropping it. An operator's location is still protected —
 * `teams.applyEnrichmentInternal` gap-fills `location` only when the row has
 * none, so enrichment cannot overwrite what they typed. The marker was
 * guarding the LOOKUP; the gap-fill guards the VALUE, and only the second one
 * was ever load-bearing for "never overwrite a human".
 *
 * Everything below IS a marker: no insert path writes any of them, and each is
 * something enrichment (or an operator, through Team Management's editor) put
 * there. A row carrying even one has already been answered.
 */
function teamEnrichmentMarkers(team: {
  yearsActive?: unknown;
  colors?: { primary?: string; secondary?: string };
  colorSource?: unknown;
  colorCandidates?: unknown[];
  externalIds?: { wikidataId?: string; espnId?: string };
}): string[] {
  const markers: string[] = [];
  // NOT `location` — it is a creation input since NEO-236. See the docblock.
  if (team.yearsActive) markers.push("yearsActive");
  if (team.colors?.primary || team.colors?.secondary) markers.push("colors");
  if (team.colorSource) markers.push("colorSource");
  if ((team.colorCandidates?.length ?? 0) > 0) markers.push("colorCandidates");
  if (team.externalIds?.wikidataId) markers.push("wikidataId");
  if (team.externalIds?.espnId) markers.push("espnId");
  return markers;
}

/** The player twin of `teamEnrichmentMarkers` — same contract, same reasoning. */
function playerEnrichmentMarkers(player: {
  teamYears?: unknown[];
  isHallOfFame?: boolean;
  externalIds?: { wikidataId?: string };
}): string[] {
  const markers: string[] = [];
  if ((player.teamYears?.length ?? 0) > 0) markers.push("teamYears");
  // `false` is a real answer — "we looked, and they are not in the Hall" — and
  // must count as enriched, or every non-HoF player stays permanently eligible
  // for another lookup.
  if (player.isHallOfFame !== undefined) markers.push("isHallOfFame");
  if (player.externalIds?.wikidataId) markers.push("wikidataId");
  return markers;
}

/**
 * Internal action — given a player record, look up its Wikidata QID,
 * pull career teams + HoF status, and persist via applyEnrichmentInternal.
 *
 * Resolves each `careerTeams` name through `teams.findByFullNameInternal` so
 * `teamYears` points at our own teams table, not Wikidata QIDs — and skips any
 * stint whose team we do not already hold (NEO-236; see the loop). This is the
 * single most expensive enrichment call (one entity lookup + N team
 * resolutions per player); the calling action treats it as best-effort.
 */
/**
 * NEO-236 — bound on a Wikidata team label copied into a log line.
 *
 * The same 120 a stored team name is capped at (`teams.MAX_TEAM_NAME_LENGTH`),
 * so a real franchise is never cut. See `career_team_unmatched` below.
 */
const MAX_LOGGED_TEAM_NAME_LENGTH = 120;

export const enrichPlayer = internalAction({
  args: { playerId: v.id("players"), force: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const player = await ctx.runQuery(internal.players.getInternal, { id: args.playerId });
    if (!player) return null;

    // ── NEO-203: automatic enrichment is CREATION-ONLY ──────────────────────
    //
    // Jason, 2026-09-02: "if the player is already known we should not try to
    // look up the data again." Same rule and same structural belt as
    // `enrichTeam` below — see `playerEnrichmentMarkers` for why these
    // particular fields cannot mis-fire on a bare newly-created player.
    //
    // Above the network call deliberately: the point is that no LOOKUP happens
    // for a known player, not merely that no write does. This one is the most
    // expensive enrichment we run (one entity lookup plus N team resolutions).
    const alreadyEnriched = playerEnrichmentMarkers(player);
    if (alreadyEnriched.length > 0 && !args.force) {
      console.log(
        JSON.stringify({
          msg: "enrich_player_skipped_existing",
          playerId: args.playerId,
          markers: alreadyEnriched,
        }),
      );
      return null;
    }

    // NEO-96: resolve the sport row's config once, then reuse it for both the
    // lookup and the career-team creations below.
    const sportCtx = await ctx.runQuery(
      internal.selectorOptions.getSportEnrichmentContext,
      { sportId: player.sportId },
    );
    if (!sportCtx) return null;

    const result = await lookupPlayerEnrichment(player.name, sportCtx);
    if (!result) return null;

    // NEO-212: the SAME `(teamId, fromYear)` key and the same ordering the
    // review-wizard commit path uses (commitCardChecklistPrelude in
    // convex/selectorOptions.ts). These two are the only writers of
    // `players.teamYears`, and a player can be created by either one, so they
    // have to agree on what counts as a duplicate stint and on the order the
    // survivors are stored in — otherwise the same career reads back
    // differently depending on which path happened to build it.
    //
    // Two different `name` strings CAN resolve to one teamId (Wikidata
    // spellings differ across statements, and the lookup folds on a normalized
    // name), which is why the key is the resolved id and not the
    // name. A repeat of the same `(teamId, fromYear)` is a genuine duplicate;
    // a second stint at that team starting a different year is not.
    //
    // ── NEO-236: a career team is LINKED, never created ─────────────────────
    //
    // Until now this called `teams.findOrCreateInternal`, so enriching one
    // player minted a globally-shared `teams` row per Wikidata P54 label it
    // had never seen — a row nobody chose, with a name nobody reviewed, that
    // every picker and spine label then offered. Jason, 2026-09-05: creation
    // takes Location + Name as its input, and this path has neither; it is
    // "still looking up the team … and if there is a match we are linking to
    // the team still", and on a miss the stint is left for operator review.
    //
    // So an unmatched stint is DROPPED from `teamYears` rather than
    // materialised. That is a real loss of a fact Wikidata had, and it is the
    // intended trade: `players.teamYears` requires a `teamId`, there is
    // nowhere on the row to park a bare name (the same constraint that
    // produced `undatedCareerTeams` in NEO-235), and inventing the team to
    // have somewhere to point is precisely what NEO-236 removes. The miss is
    // logged per stint so the aggregate is visible; the review wizard (WP5) is
    // where an operator turns one of these into a real team.
    const teamYearByKey = new Map<
      string,
      { teamId: Id<"teams">; fromYear: number; toYear?: number }
    >();
    for (const ct of result.careerTeams) {
      const teamId: Id<"teams"> | null = await ctx.runQuery(
        internal.teams.findByFullNameInternal,
        {
          // Wikidata gives a FULL name; the lookup composes ours from
          // `location` + `name`, so a split row still matches.
          name: ct.name,
          // Career teams inherit the player's sport by REFERENCE, so they
          // can no longer land under a differently-cased duplicate.
          sportId: player.sportId,
          /*
           * NEO-254 — the STINT's year, not the set's.
           *
           * This lookup is not about a card; it is about a season the player
           * actually played. A 1979 stint at a two-era club belongs to the
           * 1972-1996 row, and the 2011- row did not exist yet — so the year
           * that resolves it is the year the stint started. Without this the
           * name matched several rows, the lookup answered null, and the stint
           * was dropped from `teamYears` with a `career_team_unmatched` log.
           */
          setYear: ct.fromYear,
        },
      );
      if (!teamId) {
        // Structured, and the name is a VALUE rather than concatenated into
        // the message — it comes from query.wikidata.org with no operator in
        // the path and must not be able to shape a log line.
        //
        // NEO-236 security review: TRUNCATED as well. A Wikidata label is
        // third-party text of no fixed length, and this line fires once per
        // unmatched stint on a path that walks a whole career — an
        // adversarially long label would otherwise be copied verbatim into the
        // deployment log on every pass. 120 is the length a team name is
        // allowed to be anywhere else in the product, so nothing legitimate is
        // cut, and the value here is a diagnostic rather than data.
        console.log(
          JSON.stringify({
            msg: "career_team_unmatched",
            player: player.name,
            team: ct.name.slice(0, MAX_LOGGED_TEAM_NAME_LENGTH),
          }),
        );
        continue;
      }
      teamYearByKey.set(`${teamId}|${ct.fromYear}`, {
        teamId,
        fromYear: ct.fromYear,
        toYear: ct.toYear,
      });
    }
    const teamYears = sortTeamYears(Array.from(teamYearByKey.values()));

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
 * hex colors and location for any CURRENT team, confirmed live against
 * NBA/NFL/MLB/NHL — but it has zero historical/defunct-franchise coverage.
 * Wikidata always runs too: it's the only source for `yearsActive`/
 * `wikidataId`, and the `league` fallback when ESPN found no match (a defunct
 * team). ESPN's league (the exact name from the sport row's `sportConfig.espn`,
 * not a guess) wins over Wikidata's label when present.
 *
 * NEO-236: `location` comes from ESPN or from nowhere. Wikidata's P159/P276 is
 * a headquarters, not the place part of a team name, and it was routinely
 * neither — see the note on the SPARQL below.
 */
/**
 * Pure(-ish) lookup — no db writes. Already side-effect-free (unlike the
 * player lookup, a team has no nested "career teams" to defer). Tries ESPN
 * first (reliable colors/location/league for CURRENT teams), then Wikidata
 * (sole source of yearsActive/wikidataId, and the `league` fallback when ESPN
 * found no match — a defunct team). Returns null only when NEITHER source
 * matches.
 */
export async function lookupTeamEnrichment(
  /** The COMPOSED full name — "San Diego Padres", not "Padres" (NEO-236). */
  name: string,
  sport: SportEnrichmentContext,
  /**
   * NEO-236 — a team QID the CALLER already holds, which skips the name search.
   *
   * Set only where the id is a fact rather than a guess: a career team staged
   * off a player's P54 statements arrives with the QID Wikidata itself
   * attached to that membership, so searching EntitySearch for its English
   * label would be strictly worse — it can miss (the sport filter `wdt:P641`
   * is absent on plenty of club and college sides), and it can land on a
   * different entity that happens to share a name.
   *
   * ESPN is still consulted by NAME, because ESPN has no notion of a QID and
   * its list is keyed on `displayName`. A club side ESPN has never heard of
   * simply gets no location, which is the correct answer rather than a guess.
   *
   * Ignored unless it is a real `Q<digits>` id — the value crosses a
   * marketplace-shaped trust boundary (it was read out of a SPARQL response
   * and stored on a throwaway review row), and it is interpolated into a
   * query below.
   */
  knownQid?: string,
): Promise<TeamLookupResult | null> {
  const espnInfo = await fetchEspnTeamInfo(sport.espn, name);

  const qid =
    knownQid && isWikidataQid(knownQid)
      ? knownQid
      : await findTeamQid(name, sport.wikidata?.sportQid);
  if (!qid) {
    if (!espnInfo) {
      // NEO-208: structured for the same reason as the player no-match log
      // above. This one also fixes a latent defect the concatenation hid —
      // it interpolated the whole `sport` CONTEXT OBJECT, so every one of
      // these lines has read "(...[object Object])" rather than naming a
      // sport.
      console.log(
        JSON.stringify({
          msg: "wikidata_team_no_match",
          name,
          sport: sport.label,
        }),
      );
      return null;
    }
    return {
      league: espnInfo.league,
      location: espnInfo.location,
      colors: { primary: espnInfo.colorPrimary, secondary: espnInfo.colorAlternate },
      espnId: espnInfo.espnId,
    };
  }

  // NEO-236 — Wikidata is NOT a location source, and P159/P276 are gone from
  // this query rather than merely unread.
  //
  // They were asked for as "headquarters location" and treated as the place
  // part of the team name. They are not the same thing, and the dev data
  // proved it: "Nishi-Shinjuku" for the Chiba Lotte Marines, "Aichi
  // Prefecture" for the Chunichi Dragons, "Tokorozawa" for the Saitama Seibu
  // Lions — twelve rows, none of which is the prefix of the team's name and
  // several of which are not even a city. `teams.location` is the word at the
  // front of "San Diego Padres"; ESPN's `location` answers exactly that
  // question and is the only automatic source for it.
  //
  // Wikidata stays for the two things it is good for here: `yearsActive` (its
  // only source anywhere) and the `league` fallback for a defunct team ESPN
  // has never heard of.
  const detailQuery = `
    SELECT ?league ?leagueLabel ?inception ?dissolved WHERE {
      OPTIONAL { wd:${qid} wdt:P118 ?league . }
      OPTIONAL { wd:${qid} wdt:P571 ?inception . }
      OPTIONAL { wd:${qid} wdt:P576 ?dissolved . }
      ${LABEL_SERVICE}
    }
    LIMIT 1
  `;
  const result = await runSparql(detailQuery);
  const row = result?.results.bindings[0];

  const fromYear = yearFromBinding(row?.inception);
  const toYear = yearFromBinding(row?.dissolved);
  const yearsActive = fromYear !== undefined ? { from: fromYear, to: toYear } : undefined;

  return {
    wikidataId: qid,
    league: espnInfo?.league ?? labelValue(row?.leagueLabel),
    // NEO-254 — the P118 value's own id, when the binding parses as one. Taken
    // from Wikidata even when ESPN supplied the league NAME: the two agree
    // about which competition this is, and only Wikidata can say which record
    // it is.
    ...(row?.league ? { leagueWikidataId: qidFromIri(row.league.value) } : {}),
    // ESPN or nothing — see the note on the SPARQL above.
    location: espnInfo?.location,
    yearsActive,
    colors: espnInfo
      ? { primary: espnInfo.colorPrimary, secondary: espnInfo.colorAlternate }
      : undefined,
    espnId: espnInfo?.espnId,
  };
}

/**
 * Resolve one team's league, location, years and colours from ESPN, Wikidata
 * and teamcolorcodes.com, and write what is found.
 *
 * ## NEO-254 — OPERATOR-INITIATED ONLY. There is no automatic caller.
 *
 * Team creation used to enqueue this: `teams.findOrCreate` for a team born in
 * a picker, and `commitCardChecklistFinalize` for the career teams a checklist
 * commit invented. Both enqueues are gone. Jason, 2026-09-10: "we do not need
 * to enrich anymore on team creation because all major teams are created
 * already; if at some point there is a rare case of needing to create a team
 * it will need to be manual."
 *
 * The remaining caller is `teams.enrichFromWikidata` — Team Management's
 * "Discover" button, admin-gated, one team per click. That is what makes the
 * colour leg at the bottom of this handler affordable: it reads
 * teamcolorcodes.com's sitemap live (~1.5MB), which that module's header
 * permits for a manual one-team action and forbids "from a loop, a background
 * queue, or a render path". Enqueued per created team it WAS such a loop, and
 * because it shares one 5-wide lane with the review wizard's own lookups
 * (`convex/wikidataPool.ts`) it starved them: the wizard sat on "N still
 * looking up" while the lane worked through colour searches nobody asked for.
 */
export const enrichTeam = internalAction({
  args: { teamId: v.id("teams"), force: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const team = await ctx.runQuery(internal.teams.getInternal, { id: args.teamId });
    if (!team) return null;

    // ── NEO-203: enrichment never overwrites an answer already on the row ───
    //
    // Jason, 2026-09-02: "the enrichment writes should only fire if the team is
    // new. We should never be firing that on an update. Team data generally
    // doesn't change."
    //
    // This began as the structural belt behind a convention four automatic
    // callers held. They are gone (see the docblock above), so today it guards
    // the operator path: pressing Discover on a team that already has an
    // answer does nothing unless `force` says the answer is wrong. If the row
    // already carries an enrichment marker, the lookup does not run at all —
    // no SPARQL round-trip, no ESPN fetch, no colour sitemap read, no write.
    //
    // Cheap by design: it is a field check on a row this handler already read,
    // and it sits ABOVE the network calls, so a skipped team costs nothing
    // rather than three outbound requests.
    const alreadyEnriched = teamEnrichmentMarkers(team);
    if (alreadyEnriched.length > 0 && !args.force) {
      console.log(
        JSON.stringify({
          msg: "enrich_team_skipped_existing",
          teamId: args.teamId,
          markers: alreadyEnriched,
        }),
      );
      return null;
    }

    const sportCtx = await ctx.runQuery(
      internal.selectorOptions.getSportEnrichmentContext,
      { sportId: team.sportId },
    );

    // NEO-147: this block used to `return null` when the sport had no
    // enrichment context, or when neither ESPN nor Wikidata matched. Colors
    // now run regardless, because those early returns excluded exactly the
    // population that needs colors most: every NPB, MiLB and Dominican winter
    // league row misses on both sources, and a survey of all 58 prod teams
    // found espnId on 0 of them.
    if (sportCtx) {
      // NEO-236: the FULL name. ESPN matches on `displayName` and Wikidata on
      // the entity label, both of which are "San Diego Padres" — a split row's
      // `name` alone ("Padres") matches neither.
      const result = await lookupTeamEnrichment(teamFullName(team), sportCtx);
      if (result) {
        await ctx.runMutation(internal.teams.applyEnrichmentInternal, {
          id: args.teamId,
          league: result.league,
          location: result.location,
          yearsActive: result.yearsActive,
          colors: result.colors,
          wikidataId: result.wikidataId,
          espnId: result.espnId,
        });
      }
    }

    // NEO-147: teamcolorcodes.com, deliberately LAST so it wins over ESPN's
    // colors when it resolves — it is the better-covered source, and where both
    // answer they agree. A no-op for a team already carrying `colorSource`, and
    // it writes nothing at all when the name is ambiguous (that parks in
    // `colorCandidates` for a human instead).
    //
    // NEO-156/254 note on cost: this reads the sitemap live (~1.5MB per team)
    // rather than consulting a cached index. That is affordable because the
    // only way to get here is an operator pressing Discover on one team — see
    // the docblock on this action. Nothing may call this in a loop or from a
    // creation path.
    await ctx.runAction(internal.teamColorSources.resolveTeamColors, {
      teamId: args.teamId,
      // Not `args.force`: the operator's force path calls `resolveTeamColors`
      // itself, with force, from `teams.enrichFromWikidata` — which is what
      // lets it return an outcome to the UI. Forcing here too would re-run the
      // whole colour search twice for one operator click.
    });
    return null;
  },
});

/**
 * NEO-254 — the subset of a lookup result an `entityReviewQueue` row can hold.
 *
 * `enrichmentValidator` is a closed object, so a field the lookup returns and
 * the row has no column for is not ignored — it is a runtime refusal on every
 * function that returns the row, which reads to an operator as the wizard
 * failing to open. (That exact failure shipped once already this ticket, when
 * `activeInSetYear` was added to the schema and not to the validator.)
 *
 * Only the LEAGUE shape needs narrowing today: `lookupLeagueEnrichment`
 * returns `country` for context, and `leagues` has no column for it. The other
 * two kinds pass through whole, as they always have.
 */
function reviewEnrichmentFor(
  kind: "player" | "team" | "league",
  result: PlayerLookupResult | TeamLookupResult | LeagueLookupResult,
): Record<string, unknown> {
  if (kind !== "league") return result as unknown as Record<string, unknown>;
  const league = result as LeagueLookupResult;
  return {
    wikidataId: league.wikidataId,
    ...(league.abbreviation ? { abbreviation: league.abbreviation } : {}),
    ...(league.yearsActive ? { yearsActive: league.yearsActive } : {}),
  };
}

/**
 * NEO-99: one review row's Wikidata preview lookup — the `wikidataPool` work
 * item that replaced the old chained `processEntityReviewQueue`.
 *
 * The pool (convex/wikidataPool.ts) enqueues exactly one of these per pending
 * `entityReviewQueue` row and drains 5 at a time across the whole deployment.
 * Each item is fully self-contained: it resolves the row's sport config, runs
 * the name+sport lookup (nothing is written to `players`/`teams` — only the
 * review row's own `status`/`enrichment`), and patches the row. The wizard's
 * reactive `getBatch` turns each patch into a visible "one more reviewed" step,
 * so rows stream in as the pool works through them.
 *
 * Self-contained on purpose: the pool coordinates concurrency and the fetch
 * timeout bounds duration, so a single item completes fast (success, a
 * no-match "error", or a timed-out "error") and never blocks the lane. The row
 * is patched in BOTH the success and the caught-error branches here — the
 * pool's `onEntityReviewLookupComplete` is a further backstop for the residue
 * this cannot reach on its own (an UNCAUGHT throw, an action-level timeout, or
 * a pool cancellation), so a row can never be stranded on `pending`.
 *
 * Deliberately does its own try/catch rather than letting the error propagate
 * to the pool: resolving the row here keeps every lookup outcome in one place
 * and lets the streaming counter advance immediately, instead of waiting for
 * the completion callback to fire.
 */
export const runEntityReviewLookup = internalAction({
  args: {
    rowId: v.id("entityReviewQueue"),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.runQuery(internal.entityReviewQueue.getInternal, {
      id: args.rowId,
    });
    // The row can legitimately be gone: a Cancel deletes the batch's rows while
    // this item may still be draining. Nothing to resolve.
    if (!row) return null;

    try {
      const sportCtx = await ctx.runQuery(
        internal.selectorOptions.getSportEnrichmentContext,
        { sportId: row.sportId },
      );
      const result = !sportCtx
        ? null
        : row.kind === "player"
          ? await lookupPlayerEnrichment(row.name, sportCtx)
          : row.kind === "league"
            ? /*
               * NEO-254 — a staged New League step, pre-filled.
               *
               * Without this the step arrived carrying a name and nothing
               * else, which is the very shape the feature exists to stop an
               * operator having to produce by hand. `source.wikidataId` is the
               * league QID off the team's own P118 statement, so this reads
               * the right record rather than searching for a label.
               *
               * `country` is DROPPED on the way out: `lookupLeagueEnrichment`
               * returns it for context, `leagues` has no column for it, and
               * the New League step does not render it. Spreading the whole
               * result would put a field on the row that nothing can store —
               * and `enrichmentValidator` would refuse it at runtime, which is
               * the wizard failing to open.
               */
              await lookupLeagueEnrichment(
                row.name,
                sportCtx.wikidata?.sportQid,
                row.source?.wikidataId,
              )
            : // NEO-236: a row staged off a player's career list carries the QID
              // Wikidata attached to that P54 membership. Reading THAT record is
              // not a search — it is the same club by construction, which is what
              // gets "Sydney Blue Sox" its league instead of a null match from an
              // EntitySearch that has no `wdt:P641` to filter on.
              await lookupTeamEnrichment(row.name, sportCtx, row.source?.wikidataId);
      await ctx.runMutation(internal.entityReviewQueue.applyLookupResult, {
        id: args.rowId,
        status: result ? "ready" : "error",
        enrichment: result ? reviewEnrichmentFor(row.kind, result) : undefined,
      });
    } catch (error) {
      console.error(`[entity-review-lookup] lookup for ${args.rowId} failed:`, error);
      await ctx.runMutation(internal.entityReviewQueue.applyLookupResult, {
        id: args.rowId,
        status: "error",
      });
    }
    return null;
  },
});

/**
 * NEO-240 — what a league lookup can answer.
 *
 * `wikidataId` is non-optional: this whole object only exists once a QID
 * resolved, so a result with no id is a state the caller never has to consider
 * (contrast `TeamLookupResult`, where ESPN can answer without Wikidata).
 */
export interface LeagueLookupResult {
  wikidataId: string;
  /** P1813 short name, English only — "MLB", "NFL". */
  abbreviation?: string;
  /** P571 inception → `from`, P576 dissolved → `to`. `to` absent = still active. */
  yearsActive?: { from: number; to?: number };
  /**
   * P17 country label. Returned for CONTEXT and deliberately NOT PERSISTED:
   * `leagues` has no country field, and adding one as a side effect of writing
   * an adapter is how a schema stops meaning anything. Whoever wants it on the
   * row adds the column and the operator UI in a ticket that says so.
   *
   * A cross-border league has several — MLB, the NBA and the NHL each carry
   * both Q30 (United States) and Q16 (Canada) — and this is exactly ONE of
   * them, chosen by the query's ordering. Stable across lookups, but not "the"
   * country, which is a second reason it must not be stored as if it were.
   */
  country?: string;
}

/**
 * NEO-240 — pure lookup, no db writes: name (+ the sport's Wikidata QID when
 * the sport row has one) → the league's QID, short name and lifespan.
 *
 * Wikidata only, unlike `lookupTeamEnrichment`: ESPN's site API exposes teams
 * within a league, never a league entity of its own, so there is no second
 * source to merge and no defunct-league coverage to fall back to.
 *
 * A miss returns null and is FALL-BACK, NOT FAILURE — the long-standing
 * convention in this file. Vintage and independent leagues routinely have no
 * Wikidata entity, and an un-enriched league is a perfectly good end state.
 */
export async function lookupLeagueEnrichment(
  name: string,
  sportQid?: string,
  /**
   * NEO-254 — the league's QID when the caller already holds it.
   *
   * A staged New League step is raised off a team's P118 statement, so the
   * league's own id is already in hand. Reading THAT record is not a search:
   * it is the same competition by construction, where an EntitySearch for
   * "National Hockey League" can land on a video game or a defunct namesake.
   * Same argument, and the same shape, as `lookupTeamEnrichment`'s knownQid.
   *
   * Validated rather than trusted: the value crossed a trust boundary (it was
   * read out of a SPARQL response and stored on a throwaway review row) and it
   * is interpolated into a query. Anything that is not `Q<digits>` is not an
   * id, and the name search runs instead.
   */
  knownQid?: string,
): Promise<LeagueLookupResult | null> {
  const qid =
    knownQid && isWikidataQid(knownQid)
      ? knownQid
      : await findLeagueQid(name, sportQid);
  if (!qid) {
    // Structured for the same reason as the player/team no-match lines
    // (NEO-208): a league name is operator input and must not be able to shape
    // a log line by being concatenated into one.
    console.log(
      JSON.stringify({
        msg: "wikidata_league_no_match",
        name,
        sportQid: sportQid ?? null,
      }),
    );
    return null;
  }

  // ORDER BY ?inception is not decoration. Each OPTIONAL is independently
  // multi-valued, so this is a cross product, and `LIMIT 1` over it would
  // otherwise pick an arbitrary row: the NBA has TWO P571 values (1946-06-06,
  // the BAA's founding, and 1949-08-03, the merger that named it), and the
  // earlier one is the answer "when did this league begin" wants. The
  // `?countryLabel` tiebreak only makes the remaining arbitrary pick STABLE
  // across lookups — see the note on `country` above for why that value is
  // context and never data.
  //
  // P1813 is monolingual text, so the language filter is required; without it
  // a league with a French and an English short name would resolve to whichever
  // row the cross product emitted first.
  const detailQuery = `
    SELECT ?shortName ?inception ?dissolved ?countryLabel WHERE {
      OPTIONAL { wd:${qid} wdt:P1813 ?shortName . FILTER(LANG(?shortName) = "en") }
      OPTIONAL { wd:${qid} wdt:P571 ?inception . }
      OPTIONAL { wd:${qid} wdt:P576 ?dissolved . }
      OPTIONAL { wd:${qid} wdt:P17 ?country . }
      ${LABEL_SERVICE}
    }
    ORDER BY ?inception ?countryLabel
    LIMIT 1
  `;
  const result = await runSparql(detailQuery);
  const row = result?.results.bindings[0];

  // Same year parser as the team lookup, and for the same reason: Wikidata
  // renders a date at whatever precision it holds, so the NHL's 1917-11-26 and
  // MLB's year-precision 1903 both have to yield a bare year.
  const fromYear = yearFromBinding(row?.inception);
  const toYear = yearFromBinding(row?.dissolved);

  return {
    wikidataId: qid,
    abbreviation: row?.shortName?.value,
    yearsActive: fromYear !== undefined ? { from: fromYear, to: toYear } : undefined,
    country: labelValue(row?.countryLabel),
  };
}

/**
 * NEO-240 — the league twin of `teamEnrichmentMarkers`: "has this row already
 * been enriched?", for the creation-only guard on `enrichLeague`.
 *
 * ## `abbreviation` and `level` are NOT markers, and must never become ones
 *
 * This is the trap `teamEnrichmentMarkers` documents (`leagueId` and
 * `lastUpdated` there), and for leagues it is sharper, because the fields that
 * LOOK like enrichment output are the ones creation already writes:
 *
 *   `resolveDefaultLeagueId` builds the sport's default row from the sport's
 *   own `sportConfig` — `league` is the abbreviation ("MLB") and
 *   `espn.leagueName` the full name — and `findOrCreateLeague` stamps
 *   `level: "major"` on it in the same insert.
 *
 * So every default league row is born carrying an abbreviation AND a level. If
 * either were a marker, the guard would skip the row on the very hop that just
 * created it, and league enrichment would be dead on arrival for exactly the
 * leagues that matter most — with no error anywhere, which is what makes this
 * worth spelling out rather than deriving from "any enrichment field".
 *
 * What is left is the pair no creation path writes: `externalIds.wikidataId`
 * and `yearsActive`. Both come only from a lookup or an operator, and a row
 * carrying either has already been answered.
 */
function leagueEnrichmentMarkers(league: {
  yearsActive?: unknown;
  externalIds?: { wikidataId?: string };
}): string[] {
  const markers: string[] = [];
  if (league.yearsActive) markers.push("yearsActive");
  if (league.externalIds?.wikidataId) markers.push("wikidataId");
  return markers;
}

/**
 * NEO-240 — enrich ONE league row. The third sibling of `enrichPlayer` /
 * `enrichTeam`, with the same three-part shape: read the row, refuse to look
 * anything up for a row that already has an answer, then write back through a
 * gap-fill-only mutation.
 *
 * CREATION-ONLY (NEO-203). Jason, 2026-09-02, on the twins: "the enrichment
 * writes should only fire if the team is new. We should never be firing that
 * on an update." `leagues.findOrCreateLeague` calls
 * `scheduleLeagueEnrichment` on its insert branch and nowhere else, so the
 * automatic path already honours that; the guard below is the structural belt
 * behind the convention, and it sits ABOVE the network calls so a mis-enqueued
 * existing league costs a single field check rather than two SPARQL round
 * trips. `force` is the operator exception, reachable only through the
 * admin-gated `leagues.enrichFromWikidata`.
 *
 * Never throws. An enrichment failure has no user waiting on it and nothing to
 * age (the pool takes no `onComplete` for this lane, deliberately — see
 * `wikidataPool.enqueueEnrichment`), so an escaping error would buy a red pool
 * item and change nothing about the row. A miss and a thrown error are the same
 * outcome here: the league keeps the fields the operator can already see.
 */
export const enrichLeague = internalAction({
  args: { leagueId: v.id("leagues"), force: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const league = await ctx.runQuery(internal.leagues.getInternal, {
      id: args.leagueId,
    });
    if (!league) return null;

    const alreadyEnriched = leagueEnrichmentMarkers(league);
    if (alreadyEnriched.length > 0 && !args.force) {
      console.log(
        JSON.stringify({
          msg: "enrich_league_skipped_existing",
          leagueId: args.leagueId,
          markers: alreadyEnriched,
        }),
      );
      return null;
    }

    try {
      // The sport's Wikidata context, resolved the same way `enrichTeam` does
      // it — from the sport ROW's `sportConfig`, never from a name-keyed map
      // (NEO-96). Absent for a custom sport, and `lookupLeagueEnrichment`
      // degrades to a class-only search rather than refusing; see the note on
      // `findLeagueQid`.
      const sportCtx = await ctx.runQuery(
        internal.selectorOptions.getSportEnrichmentContext,
        { sportId: league.sportId },
      );

      const result = await lookupLeagueEnrichment(
        league.name,
        sportCtx?.wikidata?.sportQid,
      );
      if (!result) return null;

      // `country` is deliberately not passed: the mutation has no such arg and
      // the table has no such column. See `LeagueLookupResult.country`.
      await ctx.runMutation(internal.leagues.applyEnrichmentInternal, {
        id: args.leagueId,
        abbreviation: result.abbreviation,
        yearsActive: result.yearsActive,
        wikidataId: result.wikidataId,
      });
    } catch (error) {
      console.error(`[wikidata] enrichLeague for ${args.leagueId} failed:`, error);
    }
    return null;
  },
});

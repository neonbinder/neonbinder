/**
 * NEO-289 — recorded enrichment lookups for dev and PR previews.
 *
 * ## What this is
 *
 * The entity-review wizard enriches every player, team and league it stages
 * with a live Wikidata (and, for teams, ESPN) lookup. The E2E seed confirms
 * ~336 names through that wizard, and when query.wikidata.org is degraded
 * (30 s answers, timeouts, 429s) the seed cannot drain. This module answers
 * those lookups from a COMMITTED RECORDING instead — on dev and previews only.
 *
 * - `enrichment-lookups.json` (next door, under `__fixtures__/`) holds one
 *   entry per `${kind}|${sportQid}|${normalised name}`: the narrowed lookup
 *   result the live path returned when it was captured, or `null` for a
 *   genuine no-match. A recorded `null` is a HIT that returns null — the
 *   whole point is that a name Wikidata has nothing for costs zero round
 *   trips too, because those are the rows that used to burn two 10 s
 *   timeouts each.
 * - `readFixture` is the only reader. The three lookup wrappers in
 *   `wikidata.ts` consult it first and fall through to the live body on a
 *   miss. A name outside the recording still goes live, so the fixture is
 *   never a ceiling on what the wizard can do.
 * - `captureFromCli` / `coverageReportFromCli` (`convex/enrichmentFixtures.ts`)
 *   produce and audit the file. They share `fixtureKey` with the reader:
 *   there is ONE normaliser, and it lives here.
 *
 * ## Why production cannot read it
 *
 * `enrichmentFixturesEnabled()` requires BOTH `NEONBINDER_ENRICHMENT_FIXTURES=1`
 * and `TESTING_RESET_SECRET` — the same "this deployment is a test target"
 * signal `convex/testing.ts` keys its reset on. Production has neither. A
 * stray flag on a deployment without the secret logs one warning per process
 * and stays inert, so the worst a misconfiguration can do is a log line.
 *
 * ## What it is not
 *
 * Not a source of truth (the product invariant in CLAUDE.md): a hit is the
 * SAME answer the live lookup gave on the capture date, stored so a test
 * deployment does not have to ask again. It never overwrites an NB row —
 * nothing here writes at all — and `wikidataId` values it hands back are
 * linkage, read from the same place the live path reads them.
 *
 * No `"use node"`: this is a pure module imported by `wikidata.ts` (node) and
 * by the capture/coverage actions (V8), and it must load in both.
 */

import { v, type Infer } from "convex/values";
import { isWikidataQid } from "../../lib/players/wikidata-id";
import type {
  LeagueLookupResult,
  PlayerLookupResult,
  TeamLookupResult,
} from "./wikidata";
import committedFixtureRaw from "./__fixtures__/enrichment-lookups.json";

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export type FixtureKind = "player" | "team" | "league";

/**
 * The ONE normaliser for fixture keys — lookup, capture and coverage all go
 * through this. NFKC folds compatibility forms (a full-width space, a
 * ligature) so the same name typed two ways lands on one key; trim, lowercase
 * and whitespace-collapse do the rest. Diacritics are deliberately KEPT:
 * "José" and "Jose" are different search strings to Wikidata, so they are
 * different recordings.
 *
 * Not `normalizePlayerName` / `normalizeTeamName` from the entity modules:
 * those token-sort and strip punctuation to dedupe NB rows, which would fold
 * two genuinely different Wikidata searches onto one recorded answer.
 */
export function normaliseLookupName(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

export function fixtureKey(kind: FixtureKind, sportQid: string, name: string): string {
  return `${kind}|${sportQid}|${normaliseLookupName(name)}`;
}

// ---------------------------------------------------------------------------
// Entry shapes and their Convex validators
// ---------------------------------------------------------------------------

/**
 * `country` is dropped from a recorded league: `lookupLeagueEnrichment`
 * returns it for context only, `reviewEnrichmentFor` strips it before it
 * reaches a review row, and `enrichLeague` never passes it on. Recording it
 * would put a value in the repo that nothing reads.
 */
export type LeagueFixtureResult = Omit<LeagueLookupResult, "country">;

export type FixtureResultFor<K extends FixtureKind> = K extends "player"
  ? PlayerLookupResult
  : K extends "team"
    ? TeamLookupResult
    : LeagueFixtureResult;

const yearsActiveValidator = v.object({ from: v.number(), to: v.optional(v.number()) });

export const playerFixtureResultValidator = v.object({
  wikidataId: v.string(),
  careerTeams: v.array(
    v.object({
      name: v.string(),
      fromYear: v.number(),
      toYear: v.optional(v.number()),
      wikidataId: v.optional(v.string()),
    }),
  ),
  undatedCareerTeams: v.optional(v.array(v.string())),
  isHallOfFame: v.optional(v.boolean()),
  description: v.optional(v.string()),
  birthYear: v.optional(v.number()),
  enwikiTitle: v.optional(v.string()),
});

export const teamFixtureResultValidator = v.object({
  wikidataId: v.optional(v.string()),
  league: v.optional(v.string()),
  leagueWikidataId: v.optional(v.string()),
  location: v.optional(v.string()),
  yearsActive: v.optional(yearsActiveValidator),
  colors: v.optional(
    v.object({ primary: v.optional(v.string()), secondary: v.optional(v.string()) }),
  ),
  espnId: v.optional(v.string()),
});

export const leagueFixtureResultValidator = v.object({
  wikidataId: v.string(),
  abbreviation: v.optional(v.string()),
  yearsActive: v.optional(yearsActiveValidator),
});

/**
 * One recorded lookup. A discriminated union so a `player` entry can only
 * carry a player-shaped result; `result: null` is a recorded no-match.
 */
export const fixtureEntryValidator = v.union(
  v.object({
    kind: v.literal("player"),
    name: v.string(),
    result: v.union(playerFixtureResultValidator, v.null()),
  }),
  v.object({
    kind: v.literal("team"),
    name: v.string(),
    result: v.union(teamFixtureResultValidator, v.null()),
  }),
  v.object({
    kind: v.literal("league"),
    name: v.string(),
    result: v.union(leagueFixtureResultValidator, v.null()),
  }),
);

export type EnrichmentFixtureEntry = Infer<typeof fixtureEntryValidator>;

// Static proof that the validators above describe the SAME shapes the live
// lookups return. If `PlayerLookupResult` grows a field these fail to compile,
// which is the moment to add it to the validator too — otherwise a capture
// would silently drop it and a hit would silently come back without it.
type AssertAssignable<_A extends B, B> = true;
type _PlayerShape = AssertAssignable<PlayerLookupResult, Infer<typeof playerFixtureResultValidator>>;
type _PlayerShapeBack = AssertAssignable<Infer<typeof playerFixtureResultValidator>, PlayerLookupResult>;
type _TeamShape = AssertAssignable<TeamLookupResult, Infer<typeof teamFixtureResultValidator>>;
type _TeamShapeBack = AssertAssignable<Infer<typeof teamFixtureResultValidator>, TeamLookupResult>;
type _LeagueShape = AssertAssignable<LeagueFixtureResult, Infer<typeof leagueFixtureResultValidator>>;
type _LeagueShapeBack = AssertAssignable<Infer<typeof leagueFixtureResultValidator>, LeagueFixtureResult>;

// Shared by `runCaptureLookups` (adapters/wikidata.ts, node) and the CLI
// actions (convex/enrichmentFixtures.ts, V8). Defined here because a V8
// module cannot import a `"use node"` one.
export const captureSportValidator = v.object({
  label: v.string(),
  espn: v.optional(v.object({ path: v.string(), leagueName: v.string() })),
  wikidata: v.optional(
    v.object({ sportQid: v.string(), hallOfFameQid: v.optional(v.string()) }),
  ),
});

export const captureItemValidator = v.object({
  kind: v.union(v.literal("player"), v.literal("team"), v.literal("league")),
  name: v.string(),
  knownQid: v.optional(v.string()),
});

export const captureSkipValidator = v.object({
  kind: v.union(v.literal("player"), v.literal("team"), v.literal("league")),
  name: v.string(),
  reason: v.string(),
});

export const fixtureFileValidator = v.object({
  version: v.literal(1),
  capturedAt: v.string(),
  sportQid: v.string(),
  entries: v.record(v.string(), fixtureEntryValidator),
});

export type EnrichmentFixtureFile = Infer<typeof fixtureFileValidator>;

export const FIXTURE_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Loading the committed file
// ---------------------------------------------------------------------------

/**
 * Validate the committed JSON before anything reads it.
 *
 * The file is repo data written by `captureFromCli`, so it is as trusted as
 * any other source file — but a `wikidataId` from it is stored on NB rows and
 * interpolated into outbound links, exactly as a live one is, so it goes
 * through the same `Q<digits>` chokepoint (`isWikidataQid`) a live id does.
 * Returns the problem rather than throwing: this module is imported by
 * `wikidata.ts`, and a throw at load would take every live enrichment down
 * with the fixture. A bad file is reported once and treated as empty.
 */
export function parseFixtureFile(
  raw: unknown,
): { ok: true; fixture: EnrichmentFixtureFile } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "fixture is not an object" };
  }
  const file = raw as Record<string, unknown>;
  if (file.version !== FIXTURE_VERSION) {
    return { ok: false, reason: `fixture version ${String(file.version)} is not ${FIXTURE_VERSION}` };
  }
  if (typeof file.capturedAt !== "string" || typeof file.sportQid !== "string") {
    return { ok: false, reason: "fixture capturedAt/sportQid must be strings" };
  }
  if (typeof file.entries !== "object" || file.entries === null || Array.isArray(file.entries)) {
    return { ok: false, reason: "fixture entries must be an object" };
  }
  const entries: Record<string, EnrichmentFixtureEntry> = {};
  for (const [key, value] of Object.entries(file.entries as Record<string, unknown>)) {
    const entry = parseEntry(value);
    if (!entry) return { ok: false, reason: `fixture entry ${key} is malformed` };
    if (key !== fixtureKey(entry.kind, file.sportQid, entry.name)) {
      return { ok: false, reason: `fixture entry ${key} does not match its own kind/name` };
    }
    const id = entry.result?.wikidataId;
    if (id !== undefined && !isWikidataQid(id)) {
      return { ok: false, reason: `fixture entry ${key} carries a non-QID wikidataId` };
    }
    entries[key] = entry;
  }
  return {
    ok: true,
    fixture: {
      version: FIXTURE_VERSION,
      capturedAt: file.capturedAt,
      sportQid: file.sportQid,
      entries,
    },
  };
}

function parseEntry(value: unknown): EnrichmentFixtureEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  if (entry.kind !== "player" && entry.kind !== "team" && entry.kind !== "league") return undefined;
  if (typeof entry.name !== "string") return undefined;
  if (!("result" in entry)) return undefined;
  if (entry.result !== null && (typeof entry.result !== "object" || Array.isArray(entry.result))) {
    return undefined;
  }
  // The per-kind result shape is structural (the file test pins it against
  // the validators); here we only need to know it is an object or null.
  return entry as unknown as EnrichmentFixtureEntry;
}

let committedFixture: EnrichmentFixtureFile | null | undefined;
let committedFixtureWarned = false;

function loadCommittedFixture(): EnrichmentFixtureFile | null {
  if (committedFixture !== undefined) return committedFixture;
  const parsed = parseFixtureFile(committedFixtureRaw);
  if (parsed.ok) {
    committedFixture = parsed.fixture;
  } else {
    committedFixture = null;
    if (!committedFixtureWarned) {
      committedFixtureWarned = true;
      console.warn(JSON.stringify({ msg: "enrichment_fixture_file_invalid", reason: parsed.reason }));
    }
  }
  return committedFixture;
}

/** Test seam: the fixture `readFixture` and the coverage report consult. */
let fixtureOverride: EnrichmentFixtureFile | undefined;

/**
 * Test-only. Replaces the committed fixture for the life of the override and
 * resets the once-per-process warnings so each test observes its own.
 */
export function __setEnrichmentFixtureForTests(fixture: EnrichmentFixtureFile | undefined): void {
  fixtureOverride = fixture;
  flagWithoutSecretWarned = false;
  offLogged = false;
}

/** The fixture in force: the test override when set, else the committed file. */
export function getEnrichmentFixture(): EnrichmentFixtureFile | null {
  return fixtureOverride ?? loadCommittedFixture();
}

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

let flagWithoutSecretWarned = false;
/** `readFixture` logs `outcome: "off"` once per process, not per lookup. */
let offLogged = false;

/**
 * True only on a deployment that is BOTH opted in and a test target.
 *
 * `TESTING_RESET_SECRET` is the precedent `convex/testing.ts` sets: it is
 * present on dev and on every PR preview and absent on production, and the
 * reset endpoint fails closed on it. Reusing it means "can read fixtures" can
 * never be true on a deployment where "can be reset" is false — there is no
 * second flag to set wrong. The flag alone, without the secret, is logged
 * once and ignored.
 */
export function enrichmentFixturesEnabled(): boolean {
  if (process.env.NEONBINDER_ENRICHMENT_FIXTURES !== "1") return false;
  if (!process.env.TESTING_RESET_SECRET) {
    if (!flagWithoutSecretWarned) {
      flagWithoutSecretWarned = true;
      console.warn(
        JSON.stringify({
          msg: "enrichment_fixture_flag_without_secret",
          detail:
            "NEONBINDER_ENRICHMENT_FIXTURES=1 is set but TESTING_RESET_SECRET is not; fixtures stay off",
        }),
      );
    }
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type FixtureRead<K extends FixtureKind> =
  | { hit: true; result: FixtureResultFor<K> | null }
  | { hit: false };

/**
 * The lookup wrappers' one question: "is this answered already?"
 *
 * - Off (flag unset, or set without the secret) → miss, logged as `off`.
 * - No entry for the key → miss.
 * - No `knownQid` → whatever is recorded is honoured, including a recorded
 *   `null`: "Wikidata had nothing for this name" costs no round trip either.
 * - `knownQid` supplied → the caller's id is a fact (it came off the same
 *   Wikidata statement that staged the row) and the live path would READ that
 *   record rather than search by name, so the recording is honoured only when
 *   it agrees: recorded `wikidataId` equal → hit; different → miss (live);
 *   recorded `null` → miss (live) — a name search that found nothing says
 *   nothing about an id-path lookup, and a staged career team must never be
 *   handed a no-match its id would have answered. (Coordinator decision,
 *   2026-09-20.) An entry with a result but no `wikidataId` (an ESPN-only
 *   team) is honoured: there is no id to disagree with.
 *
 * Logs one structured `hit`/`miss` line per call when the switch is on;
 * `off` is logged ONCE per process, because with the switch off this runs on
 * every production lookup and a line per call would be noise (security
 * audit, 2026-09-20). `name` is card data (a player, team or league name),
 * which is fine to log; nothing else is.
 */
export function readFixture<K extends FixtureKind>(
  kind: K,
  sportQid: string,
  name: string,
  knownQid?: string,
): FixtureRead<K> {
  const log = (outcome: "hit" | "miss" | "off") =>
    console.log(JSON.stringify({ msg: "enrichment_fixture", outcome, kind, name }));

  if (!enrichmentFixturesEnabled()) {
    if (!offLogged) {
      offLogged = true;
      log("off");
    }
    return { hit: false };
  }
  const fixture = getEnrichmentFixture();
  const entry = fixture?.entries[fixtureKey(kind, sportQid, name)];
  if (!entry || entry.kind !== kind) {
    log("miss");
    return { hit: false };
  }
  if (knownQid !== undefined) {
    if (entry.result === null) {
      log("miss");
      return { hit: false };
    }
    const recordedQid = entry.result.wikidataId;
    if (recordedQid !== undefined && recordedQid !== knownQid) {
      log("miss");
      return { hit: false };
    }
  }
  log("hit");
  return { hit: true, result: entry.result as FixtureResultFor<K> | null };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Deep-copy a lookup result with every `undefined` field removed. The live
 * bodies build results with explicit `field: undefined` slots (a team with no
 * ESPN match has `location: undefined`); JSON has no such value and a Convex
 * return validator wants the field absent, so a recording strips them.
 */
function dropUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => dropUndefined(item)) as unknown as T;
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
      if (field !== undefined) out[key] = dropUndefined(field);
    }
    return out as T;
  }
  return value;
}

/**
 * Narrow a live lookup result to what the recording keeps. Players and teams
 * are kept whole; a league loses `country` (see `LeagueFixtureResult`).
 */
export function toFixtureEntry<K extends FixtureKind>(
  kind: K,
  name: string,
  result: (K extends "league" ? LeagueLookupResult : FixtureResultFor<K>) | null,
): EnrichmentFixtureEntry {
  if (result === null) return { kind, name, result: null } as EnrichmentFixtureEntry;
  if (kind === "league") {
    const { country: _country, ...rest } = result as LeagueLookupResult;
    return { kind: "league", name, result: dropUndefined(rest) };
  }
  return { kind, name, result: dropUndefined(result) } as EnrichmentFixtureEntry;
}

/** Coverage: does the fixture in force hold an entry for this name? */
export function hasFixtureEntry(kind: FixtureKind, sportQid: string, name: string): boolean {
  const fixture = getEnrichmentFixture();
  return fixture?.entries[fixtureKey(kind, sportQid, name)] !== undefined;
}

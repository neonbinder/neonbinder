/**
 * Real people for the specs that ADD a Baseball player only as scaffolding
 * (a career editor to make teams in, a card to put a player on), chosen so the
 * add costs no live Wikidata call (Jason, 2026-10-30: "Use real names in
 * tests. Keep a single test that does a real Wikidata lookup").
 *
 * Every player the product creates is enriched once, through the
 * deployment-wide 5-wide `wikidataPool` that the review wizard's lookups wait
 * in. A minted name (`PM<token>`) always missed the NEO-289 recording and went
 * to Wikidata live, so every such spec held a pool slot behind the wizard specs
 * on its shard.
 *
 * Each name here is a 1996 Line Up Venezuelan Winter League player whose
 * Baseball lookup the recording holds as a genuine no-match (`result: null`,
 * captured live in NEO-330, when that set was the alias spec's fixture; NEO-475
 * retired it as a fixture, and the recorded names stay). So on a preview with
 * the recording on:
 *   - the enrichment is a fixture HIT that makes no request, and
 *   - it returns null, so the new row stays exactly as bare as a minted name's
 *     did (no Wikidata id, no stints): the specs' "No stints recorded yet."
 *     still holds.
 * `convex/enrichmentFixtureFile.test.ts` fails if any name here stops being a
 * recorded Baseball no-match. Measured absent from the reference catalogue:
 * each one was looked up by the Venezuelan set's review in both passes of a CI
 * run (2026-10-30), so no catalogue row resolved it, and no player row of the
 * name exists on dev.
 *
 * ONE pool per spec, ONE name per worker (accounts 0-11), so no two specs and
 * no two shards ever add the same person. The trade against a minted name:
 *   - these specs are FRESH-ONLY (GUIDE "Fresh-only specs"). A second run
 *     against the same seed finds the row, the add form demotes
 *     `Create player <name>` to `... anyway`, the server adopts the row, and
 *     the spec fails on `Added <name>` by name. Re-seed before re-running.
 *     CI runs each spec once per seed (desktop and mobile each get a reset),
 *     which is why the pool is keyed on WORKER_INDEX, not WORKER_KEY.
 *   - no spec fetches a checklist that carries these names any more. Until
 *     NEO-475 the alias spec (`checklist-wizard-link-team-saves-alias`)
 *     committed the Venezuelan set itself, so its fetch could resolve a card to
 *     a pool row and link it. It now commits 1996 New Haven Ravens Rally
 *     Raffle, which carries none of them. A checklist that does carry one
 *     can link its card to the row when it commits, so
 *     `player-sports-multi-sport-membership` still asserts the refusal ("N
 *     cards in Baseball sets still link to ..."), not N: the count belongs to
 *     the server and the unit tests.
 */
import type { FlowEnv } from "./env";

export const RECORDED_NO_MATCH_PLAYERS = {
  "player-management-add-and-career-history": [
    "Alejandro Prieto", "Alex Oviedo", "Alexander Portillo", "Alexis Santaella",
    "Amador Arias", "Andres Espinoza", "Andy Vicentino", "Arquimedes Rojas",
    "Asdrubal Estrada", "Boanerge Corzo", "Carlos Burguillos", "Damaso Betancourt",
  ],
  "admin-teams-two-eras": [
    "Dan Urbina", "Darwin Bracho", "David Jauss", "David Montiel",
    "Didimo Bracho", "Douglas Aguillar", "Edgar Naveda", "Edgar Tovar",
    "Elias Lugo", "Eminson Soto", "Ender Perozo", "Erick Ojeda",
  ],
  "admin-franchises-link-teams": [
    "Esmili Guerra", "Fernando Mejias", "Guillermo Larreal", "Heberto Andrade",
    "Hector Rincones", "Hector Ugueto", "Henry Centeno", "Homer Baez",
    "Hugo Pinero", "Ifrain Linares", "Igor Oropeza", "Isbel Cardona",
  ],
  "team-management-edit-a-team": [
    "Ismel Zabala", "Ivan Arteaga", "Jesus Azuaje", "Jesus Garces",
    "Jesus Laya", "Jesus Lugo", "Jesus Ugueto", "Johnny Carvajal",
    "Jorge Uribe", "Jose Amado", "Juan Querecuto", "Justo Massaro",
  ],
  "player-team-colors-default-to-longest-tenure": [
    "Lino Connell", "Luis Burelli", "Luis Lunar", "Malvin Matos",
    "Marcos Manrique", "Marlon Nava", "Mauro Zerpa", "Melchor Pacheco",
    "Miguel Castellanos", "Miguel Nieves", "Miguel Rendon", "Nelson Canas",
  ],
  "checklist-wizard-link-team-saves-alias": [
    "Nelson Porte", "Nestor Serrano", "Nigel Alejo", "Noe Maduro",
    "Oswaldo Villalobos", "Pedro Belmonte", "Rafael DeLima", "Raul Marcano",
    "Raul Marval", "Richard Negrette", "Roberto Zambrano", "Robinson Garces",
  ],
  "checklist-attention-badge-and-filter": [
    "Ronnie Sorzano", "Silverio Navas", "Simon Pinango", "Temis Liendo",
    "Victor Oramas", "Wilfredo Polidor", "William Magallanes", "William Oropeza",
    "Wilmer Montoya", "Wuarnner Rincones", "Kevin Noriega", "Jose Villa",
  ],
} as const satisfies Record<string, readonly string[]>;

export type RecordedNamePool = keyof typeof RECORDED_NO_MATCH_PLAYERS;

/** This worker's person from `pool` (one pool per spec; see the file header). */
export function recordedNoMatchPlayer(env: FlowEnv, pool: RecordedNamePool): string {
  const names = RECORDED_NO_MATCH_PLAYERS[pool];
  const name = names[Number(env.WORKER_INDEX)];
  if (!name) {
    throw new Error(`recorded-names: pool ${pool} has no name for worker ${env.WORKER_INDEX}`);
  }
  return name;
}

/** Wikidata sport QIDs the pools below are recorded under. */
const BASEBALL = "Q5369";
const FOOTBALL = "Q41323";
const HOCKEY = "Q41466";

/**
 * NEO-413 (Jason, 2026-11-01: "We should only be sending one made up name to
 * ensure that functionality works"): real names for every OTHER spec whose
 * player, league or team reaches the enrichment lookup. Before this, eleven
 * specs minted a token (`Gm<token>`, `Lg<token>`, `ProbeTeam<token>`, ...) for
 * a row the product looks up, and every run sent those to Wikidata live.
 *
 * Each name is a real person, league or club, chosen so that:
 *   - the recording holds its lookup, in the pool's sport, as a genuine
 *     no-match (`result: null`, captured live on 2026-11-01), so the row
 *     stays as bare as the minted name's did and no request is made;
 *   - it is absent from the reference catalogue: every player was checked
 *     in Baseball, Football and Hockey, and every club in those and Soccer,
 *     against the catalogue on dev the same day (leagues have no by-name
 *     lookup to check with; the specs' exact-count filters would show a
 *     clash). So a create is a create, and a filter finds this row only.
 * The players are 1996 Line Up Venezuelan Winter League (a retired fixture,
 * NEO-475) and 1990s minor-league hockey names (real people Wikidata does not know); the leagues are cricket,
 * hurling, netball, handball, volleyball, floorball and bandy competitions;
 * the clubs are hurling and Gaelic football clubs, each ONE word: a team
 * name is typed into a team picker, and `teams.search` matches any shared
 * word (SET-REGISTRY.md, "A name typed into a team picker must be a SINGLE
 * search token"), so each club was also checked to find no team at all on
 * dev's catalogue. A league or club from another sport is a no-match by
 * construction: the lookup filters on the pool's sport.
 *
 * Same contract as `RECORDED_NO_MATCH_PLAYERS` above: one pool per spec (a
 * spec with two lookups has a pool per role), one name per worker, never
 * shared, and the specs are FRESH-ONLY. `convex/enrichmentFixtureFile.test.ts`
 * fails if any name stops being a recorded no-match of its kind and sport, or
 * appears in two pools.
 */
export const RECORDED_NO_MATCH_NAMES = {
  "player-sports-multi-sport-membership": {
    kind: "player",
    sportQid: FOOTBALL,
    names: [
      "Alejandro Alvarez", "Angel Pocho Gomez", "Carlos Tovar Trillo",
      "Gustavo Jose Gil", "Ivan Paz Montiel", "Jesus Avila", "Jesus Chalao Mendez",
      "Jesus Marquez", "Jesus Mendoza", "Johnny Gonzalez", "Jose Cheo Garcia",
      "Jose Luis Ramos",
    ],
  },
  "card-player-picker-cross-sport": {
    kind: "player",
    sportQid: FOOTBALL,
    names: [
      "Jose Luis Zambrano", "Juan Munoz", "Julio Cesar Strauss",
      "Luis Rafael Salazar", "Luis Tinoco", "Manuel Gonzalez", "Mario Gonzalez",
      "Mauricio Ruiz", "Miguel Campos", "Omar Sanchez", "Richard Fernandez",
      "Richard Romero",
    ],
  },
  "checklist-wizard-link-commits": {
    kind: "player",
    sportQid: FOOTBALL,
    names: [
      "Rigoberto Mendoza", "Tomas Salazar", "Vicente Garcia", "Vitico Davalillo",
      "Wilfredo Romero", "William Martinez", "Brian Gallentine", "Bryan Forslund",
      "Dean Zayonce", "Doug Stromback", "Mark Yannetti", "Craig Hamelin",
    ],
  },
  "admin-players-same-name-birth-year": {
    kind: "player",
    sportQid: BASEBALL,
    names: [
      "Adrian Jordan", "Agustin Gomez", "Alfredo Ortiz", "Antonio Castillo",
      "Carlos Aguilar", "Cesar Diaz", "Edwin Marquez", "Erick Perez",
      "Francisco Munoz", "Freddy Gonzalez", "Hector Ortega", "Jaime Torres",
    ],
  },
  "league-management-add-and-edit": {
    kind: "league",
    sportQid: BASEBALL,
    names: [
      "Ranji Trophy", "Plunket Shield", "Sheffield Shield", "Vitality Blast",
      "Duleep Trophy", "Irani Cup", "Vijay Hazare Trophy", "Syed Mushtaq Ali Trophy",
      "Logan Cup", "Ford Trophy", "Marsh Cup", "Super Smash",
    ],
  },
  "team-picker-ranks-by-set-context": {
    kind: "league",
    sportQid: BASEBALL,
    names: [
      "Bob Willis Trophy", "County Championship", "Handbollsligan", "PlusLiga",
      "SuperLega", "Salibandyliiga", "Svenska Superligan", "Efeler Ligi",
      "Sultanlar Ligi", "Christy Ring Cup", "Joe McDonagh Cup",
      "Suncorp Super Netball",
    ],
  },
  "checklist-wizard-career-team-entry:league": {
    kind: "league",
    sportQid: BASEBALL,
    names: [
      "Netball Superleague", "ANZ Premiership", "Bandyallsvenskan", "Currie Cup",
      "Nicky Rackard Cup", "Lory Meagher Cup", "Tailteann Cup", "Hogan Cup",
      "Deodhar Trophy", "Rachael Heyhoe Flint Trophy", "Charlotte Edwards Cup",
      "Sigerson Cup",
    ],
  },
  "checklist-wizard-career-team-entry:first-team": {
    kind: "team",
    sportQid: BASEBALL,
    names: [
      "Ballygunner", "Kilmallock", "Cuala", "Sixmilebridge", "Clarinbridge",
      "Portumna", "Slaughtneil", "Toomevara", "Patrickswell", "Kiltormer", "Athenry",
      "Birr",
    ],
  },
  "checklist-wizard-career-team-entry:second-team": {
    kind: "team",
    sportQid: BASEBALL,
    names: [
      "Ballyea", "Newtownshandrum", "Cushendall", "Loughgiel", "Ballycran",
      "Portaferry", "Crossmaglen", "Kilcoo", "Corofin", "Mullinalaghta", "Kilmacud",
      "Ballyboden",
    ],
  },
  "checklist-one-marketplace-skips-match-dialog": {
    kind: "team",
    sportQid: HOCKEY,
    names: [
      "Castlehaven", "Craughwell", "Loughrea", "Mullinavat", "Dicksboro",
      "Tullaroan", "Thomastown", "Mooncoin", "Templetuohy", "Borrisoleigh",
      "Kiladangan", "Roscrea",
    ],
  },
  "checklist-wizard-career-team-commits": {
    kind: "team",
    sportQid: HOCKEY,
    names: [
      "Cappawhite", "Moycarkey", "Nenagh", "Lismore", "Dungarvan", "Fourmilewater",
      "Kilruane", "Clonoulty", "Ballinderreen", "Dunloy", "Ballyhale",
      "Carrickshock",
    ],
  },
} as const satisfies Record<
  string,
  { kind: "player" | "league" | "team"; sportQid: string; names: readonly string[] }
>;

export type RecordedNoMatchPool = keyof typeof RECORDED_NO_MATCH_NAMES;

/** This worker's name from `pool` (one pool per spec role; see above). */
export function recordedNoMatchName(env: FlowEnv, pool: RecordedNoMatchPool): string {
  const name = RECORDED_NO_MATCH_NAMES[pool].names[Number(env.WORKER_INDEX)];
  if (!name) {
    throw new Error(`recorded-names: pool ${pool} has no name for worker ${env.WORKER_INDEX}`);
  }
  return name;
}

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
 * Each name here is a 1996 Venezuelan Winter League player whose Baseball
 * lookup the recording holds as a genuine no-match (`result: null`, captured
 * live in NEO-330). So on a preview with the recording on:
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
 *   - the Venezuelan set's own spec (`checklist-wizard-link-team-saves-alias`)
 *     may meet one of these rows: a fetch after the add resolves that card's
 *     name to it instead of staging it. That spec skips every player row and
 *     asserts no player count, and a commit never writes to an existing
 *     player's stints, so neither side observes the other.
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

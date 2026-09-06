/**
 * NEO-254 — the shape of `data/preload/mlb.json` and `data/preload/nfl.json`.
 *
 * Three readers share it and must not drift: the generator
 * (`scripts/build-preload-data.mjs`, which writes the files), the loader
 * (`convex/preloadPlayers.ts`, which reads them into `teams`/`players`), and
 * the integrity test that asserts the committed files still match. The
 * generator is plain `.mjs` and imports these types only through JSDoc, so a
 * change here is caught by `tsc` on the two TypeScript sides and by the
 * integrity test on the generator's side.
 *
 * ## These files are INITIAL INPUT, not truth
 *
 * Product invariant: NeonBinder owns its rows. Lahman and nflverse seed a team
 * or a player at creation and their source id is kept on the row so a re-run
 * finds what it made last time. After that they are never authoritative — the
 * loader gap-fills and never overwrites, and nothing user-facing keys on a
 * dataset value. Dropping either dataset tomorrow leaves every NB row intact.
 */

/**
 * A league the dataset's teams played in.
 *
 * `code` is the generator's own key (the `league` field on a team points at
 * it); it is NOT a marketplace or dataset identifier that anything downstream
 * keys behaviour on.
 */
export interface PreloadLeague {
  /** Generator-local key, referenced by `PreloadTeam.league`. */
  code: string;
  /** The name the NB `leagues` row is created under. */
  name: string;
  abbreviation?: string;
  /** First season the league operated. */
  from: number;
  /** Last season, absent while it is still operating. */
  to?: number;
  /**
   * True for the sport's OWN default league — the one `leagues.resolveDefault‑
   * LeagueId` already derives from `sportConfig`. The loader routes these
   * through that helper rather than creating a second row by name, so the
   * preload can never mint a rival "Major League Baseball".
   *
   * Explicit in the data rather than a constant in the loader: the loader would
   * otherwise have to recognise a league by its literal name, which is exactly
   * the "behaviour keyed on a name" shape the product invariant rules out.
   */
  default?: true;
}

/**
 * One NB team row's worth of dataset facts.
 *
 * ONE ROW PER DISTINCT HISTORICAL NAME (NEO-254 decision 2). "Montreal Expos"
 * and "Washington Nationals" are two rows, as are "Cleveland Indians" and
 * "Cleveland Guardians" — that is what a card says, and what a stint should
 * read as. `franchise` is what links them without merging them.
 */
export interface PreloadTeam {
  /** Slug of `name`. Generator-local; the loader dedupes on `normalizeTeamName(name)`. */
  key: string;
  /** Full display name, e.g. "Montreal Expos". What the loader writes to `teams.name`. */
  name: string;
  /**
   * The name split for NEO-236, carried now so the switch to a
   * location/nickname `teams` schema is a one-line change in the loader.
   * `location` is empty for a name with no place in it ("Card-Pitt",
   * "Oorang Indians", the 2025 "Athletics").
   */
  location: string;
  nickname: string;
  /** `PreloadLeague.code` of the league this team is created under. */
  league: string;
  /** First season under this name. */
  from: number;
  /** Last season under this name; absent while the team is still active. */
  to?: number;
  /**
   * Slug linking relocations and renames of one franchise ("raiders" covers
   * Oakland, Los Angeles and Las Vegas). Informational — nothing merges rows
   * on it. Where two unrelated franchises shared a name (the 1947-50 AAFC
   * Baltimore Colts and the 1953-83 NFL ones), NB has one row and this carries
   * the franchise of whichever era ran longest; the generator reports the
   * disagreement on stderr.
   */
  franchise: string;
}

/**
 * One career stint: `[teamIndex, fromSeason, toSeason]`.
 *
 * A tuple rather than an object because there are ~110k of them across the two
 * files and the key names would be a third of the committed bytes.
 * `teamIndex` indexes `PreloadFile.teams`.
 */
export type PreloadStint = [teamIndex: number, from: number, to: number];

export interface PreloadPlayer {
  /**
   * The source's own id — a Lahman `playerID` ("gwynnto01") or an nflverse
   * `gsis_id` ("00-0014313"). Where the source has none (every pre-1990 NFL
   * roster row), a synthetic `name:<slug>|<birthdate>` key derived from the
   * fields that do identify a person. Stored on `players.externalIds` so a
   * re-run finds its own rows instead of minting duplicates.
   */
  id: string;
  /** Source spelling, accents and all. `normalizePlayerName` handles identity. */
  name: string;
  birthYear?: number;
  /** Present only when true — a Hall of Fame inductee in the PLAYER category. */
  hof?: true;
  /**
   * Present only when true: this player was keyed by name alone because the
   * source had neither an id nor a birth date for them, so two same-named
   * people may have been folded into one row. The loader reports the count.
   */
  lowConfidence?: true;
  /** Career stints, earliest first. Never empty — a player with none is dropped. */
  stints: PreloadStint[];
}

export interface PreloadSource {
  /** Human name of the dataset, e.g. "Lahman Baseball Database". */
  name: string;
  /** Whatever version the source states, else the date it was downloaded. */
  version: string;
  /** SPDX-ish licence id, e.g. "CC-BY-SA-3.0". */
  licence: string;
  /** Where to get it again. */
  url: string;
  /** ISO date (no time) the file was generated — a time would churn the diff. */
  generatedAt: string;
  /** Free-text notes: exclusions applied, attribution wording. */
  notes?: string[];
}

export interface PreloadFile {
  source: PreloadSource;
  leagues: PreloadLeague[];
  teams: PreloadTeam[];
  players: PreloadPlayer[];
}

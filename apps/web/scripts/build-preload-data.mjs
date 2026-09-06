#!/usr/bin/env node
/**
 * NEO-254 — build the committed player/team preload files.
 *
 * Reads the gitignored raw datasets under `data/preload/raw/` and writes
 * `data/preload/mlb.json` and `data/preload/nfl.json`, which ARE committed and
 * are the only thing `convex/preloadPlayers.ts` reads. See
 * `data/preload/README.md` for provenance, licences, and how to fetch the raw
 * inputs again.
 *
 *   node scripts/build-preload-data.mjs                 # both sports
 *   node scripts/build-preload-data.mjs --sport mlb     # one
 *   node scripts/build-preload-data.mjs --raw <dir> --out <dir>
 *
 * ## Why derived JSON is committed rather than fetched at runtime
 *
 * Lahman has no scriptable official download (the SABR page is a hand click),
 * a Convex function has no filesystem, and a release step that reaches the
 * public internet is a release step that can fail on somebody else's outage.
 * ~5 MB of committed JSON against a 32 MiB Convex bundle cap is the cheap
 * side of that trade, and the licence attribution then ships beside the data.
 *
 * ## It fails loudly rather than guessing
 *
 * Two places where a silent wrong answer is worse than a red build:
 *
 *  - An nflverse (team code, season) the era table does not resolve. A code
 *    alone means nothing (BOS was four different franchises), so an
 *    unresolved pair would put real players on a made-up team.
 *  - A Lahman team name whose nickname looks like it runs to two words but is
 *    not in the split table ("Chicago Green Sox").
 *
 * Both throw. Adding the row to `lib/players/preload/` is the fix.
 *
 * ## Product invariant
 *
 * These datasets are INITIAL INPUT. Nothing here decides NB behaviour, and the
 * loader gap-fills rather than overwrites. Both files could be deleted and
 * every NB row would stand.
 *
 * No dependencies: the CSV parser below is ~40 lines and the alternative was a
 * package in `apps/web` that only a build script would ever import.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { splitMlbTeamName } from "../lib/players/preload/mlb-team-names.ts";
import {
  NFL_TEAM_ERAS,
  nflEraTeamName,
  resolveNflTeamEra,
} from "../lib/players/preload/nfl-team-eras.ts";

const WEB_ROOT = path.resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC 4180 CSV → array of rows of strings.
 *
 * Handles the three things a `split(",")` gets wrong and that these files
 * actually contain: quoted fields with embedded commas (nflverse headshot
 * URLs are `"https://…f_auto,q_auto/…"`), doubled quotes inside a quoted
 * field, and CRLF line endings. A UTF-8 BOM is stripped — three of the Lahman
 * files carry one, and without this the first header would be `﻿yearID`.
 *
 * Returns rows exactly as they appear; a trailing newline does not produce an
 * empty final row.
 */
export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let sawAnyChar = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      sawAnyChar = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      sawAnyChar = true;
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAnyChar = false;
      continue;
    }
    field += ch;
    sawAnyChar = true;
  }
  if (sawAnyChar || field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** `parseCsv` plus the header row applied, so callers read `r.playerID`. */
export function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const obj = {};
    for (let i = 0; i < header.length; i += 1) obj[header[i]] = cells[i] ?? "";
    return obj;
  });
}

function readCsv(file) {
  return parseCsvObjects(readFileSync(file, "utf8"));
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Team/player key slug. Lowercase, alphanumerics and single dashes. */
function slug(raw) {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function intOrNull(raw) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Season rows → career stints, run-length encoded on the TEAM, not the source
 * team code.
 *
 * Keyed on the resolved team so a franchise whose code changed under it — the
 * Cardinals are ARI, then ARZ, then ARI again — stays one stint rather than
 * three. Two seasons continue a stint when they are consecutive; a gap of a
 * season or more starts a new one, because leaving and coming back is real
 * history that `players.teamYears` exists to record (NEO-212).
 *
 * `rows` is `[{ season, teamIndex }]` in any order.
 */
function buildStints(rows) {
  // Group by season so the within-season ordering below has something to work
  // with. A player traded mid-season has two rows for one year, and the source
  // does not say which came first.
  const bySeason = new Map();
  for (const r of rows) {
    if (!bySeason.has(r.season)) bySeason.set(r.season, new Set());
    bySeason.get(r.season).add(r.teamIndex);
  }
  const seasons = [...bySeason.keys()].sort((a, b) => a - b);

  /**
   * Within one season, put the team they were also on LAST season first and
   * the team they are on NEXT season last. That turns BOS+NYY in 1990 followed
   * by NYY in 1991 into "BOS 1990, NYY 1990-1991" instead of an interleaved
   * three stints. Everything else is sorted by index, so the output is
   * deterministic rather than dependent on file order.
   */
  const ordered = [];
  for (let s = 0; s < seasons.length; s += 1) {
    const season = seasons[s];
    const prev = s > 0 ? bySeason.get(seasons[s - 1]) : new Set();
    const next = s + 1 < seasons.length ? bySeason.get(seasons[s + 1]) : new Set();
    const teams = [...bySeason.get(season)].sort((a, b) => {
      const rank = (t) => (prev.has(t) ? 0 : next.has(t) ? 2 : 1);
      return rank(a) - rank(b) || a - b;
    });
    for (const teamIndex of teams) ordered.push({ season, teamIndex });
  }

  const stints = [];
  for (const { season, teamIndex } of ordered) {
    const last = stints[stints.length - 1];
    if (last && last[0] === teamIndex && season <= last[2] + 1) {
      last[2] = Math.max(last[2], season);
      continue;
    }
    stints.push([teamIndex, season, season]);
  }
  return stints;
}

/**
 * Fold eras that produce the SAME team name into one row.
 *
 * NB dedupes teams by `(nameNormalized, sportId)`, so two rows spelled
 * "Buffalo Bills" cannot both exist; emitting both would just make the loader
 * adopt the first and drop the second's years. Folding here keeps the JSON
 * honest about what the loader will do with it.
 *
 * League and franchise come from whichever FRANCHISE played the most seasons
 * under the name, ties going to the earliest. The row's years then span only
 * that franchise's eras — so "Washington Nationals" reads 2005-present rather
 * than 1872-present, and "Baltimore Colts" is the 1953-83 club rather than a
 * 1947-1983 chimera with the unrelated AAFC one. Where the folded eras
 * disagree on the franchise the caller is told, so the fold is visible rather
 * than silent.
 */
function foldTeamEras(entries, currentSeason) {
  const byName = new Map();
  for (const e of entries) {
    const existing = byName.get(e.name);
    if (!existing) {
      byName.set(e.name, {
        name: e.name,
        location: e.location,
        nickname: e.nickname,
        spans: [{ ...e }],
      });
      continue;
    }
    existing.spans.push({ ...e });
  }

  const franchiseDisagreements = [];
  const teams = [];
  for (const group of byName.values()) {
    // Seasons per franchise; a span may state its own count (Lahman's seasons
    // under one name are not always contiguous), else the span's length.
    const seasonsOf = (s) => s.seasons ?? (s.to ?? currentSeason) - s.from + 1;
    const byFranchise = new Map();
    for (const s of group.spans) {
      byFranchise.set(s.franchise, (byFranchise.get(s.franchise) ?? 0) + seasonsOf(s));
    }
    let franchise = null;
    let bestSeasons = -1;
    for (const [key, seasons] of byFranchise) {
      if (seasons > bestSeasons) {
        bestSeasons = seasons;
        franchise = key;
      }
    }

    // The winning franchise's own eras are what the row's years and league
    // describe; the other franchises' eras only contributed the name.
    const won = group.spans.filter((s) => s.franchise === franchise);
    const from = Math.min(...won.map((s) => s.from));
    const open = won.some((s) => s.to === null || s.to >= currentSeason);
    const to = open ? undefined : Math.max(...won.map((s) => s.to));

    const leagueWeight = new Map();
    for (const s of won) {
      leagueWeight.set(s.league, (leagueWeight.get(s.league) ?? 0) + seasonsOf(s));
    }
    let league = null;
    let bestLeagueSeasons = -1;
    for (const [key, seasons] of leagueWeight) {
      if (seasons > bestLeagueSeasons) {
        bestLeagueSeasons = seasons;
        league = key;
      }
    }

    const franchises = new Set(group.spans.map((s) => s.franchise));
    if (franchises.size > 1) {
      franchiseDisagreements.push({
        name: group.name,
        franchises: [...franchises].sort(),
        kept: franchise,
      });
    }

    teams.push({
      key: slug(group.name),
      name: group.name,
      location: group.location,
      nickname: group.nickname,
      league,
      from,
      ...(to === undefined ? {} : { to }),
      franchise,
    });
  }

  teams.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { teams, franchiseDisagreements };
}

// ---------------------------------------------------------------------------
// Lahman → mlb.json
// ---------------------------------------------------------------------------

/**
 * League ids excluded from the build.
 *
 * The seven Negro Leagues SABR recognises as major (NNL, ECL, ANL, EWL, NSL,
 * NN2, NAL) plus the five pseudo-league ids Lahman uses for independent and
 * all-star play (EAS, IND, WES, NAC, INT).
 *
 * WHY: that portion of the database is Seamheads' compilation, and the Lahman
 * readme's CC BY-SA 3.0 grant covers the database as a whole without saying
 * anything about redistributing the Seamheads-sourced rows in a derived work.
 * Excluding them costs 2,784 players and is reversible in one edit once the
 * question is answered; shipping them and being wrong is not. Players who ALSO
 * played in AL/NL keep their AL/NL stints and are not dropped.
 */
export const EXCLUDED_LAHMAN_LEAGUE_IDS = new Set([
  "NNL",
  "ECL",
  "ANL",
  "EWL",
  "NSL",
  "NN2",
  "NAL",
  "EAS",
  "IND",
  "WES",
  "NAC",
  "INT",
]);

/**
 * Lahman `lgID` → the NB league row the team is created under.
 *
 * `default: true` means "the sport's own league" — the loader routes those
 * through `leagues.resolveDefaultLeagueId`, which derives Major League
 * Baseball from `sportConfig`, so the preload can never mint a rival row.
 * The pre-modern leagues are real historical major leagues and get real rows.
 */
export const LAHMAN_LEAGUES = {
  AL: { code: "MLB", name: "Major League Baseball", abbreviation: "MLB", from: 1876, to: null, default: true },
  NL: { code: "MLB", name: "Major League Baseball", abbreviation: "MLB", from: 1876, to: null, default: true },
  NA: { code: "NA", name: "National Association", abbreviation: "NA", from: 1871, to: 1875 },
  AA: { code: "AA", name: "American Association", abbreviation: "AA", from: 1882, to: 1891 },
  UA: { code: "UA", name: "Union Association", abbreviation: "UA", from: 1884, to: 1884 },
  PL: { code: "PL", name: "Players League", abbreviation: "PL", from: 1890, to: 1890 },
  FL: { code: "FL", name: "Federal League", abbreviation: "FL", from: 1914, to: 1915 },
};

export function buildMlb({ rawDir, generatedAt }) {
  const dir = path.join(rawDir, "lahman");
  const teamRows = readCsv(path.join(dir, "Teams.csv"));
  const franchiseRows = readCsv(path.join(dir, "TeamsFranchises.csv"));
  const peopleRows = readCsv(path.join(dir, "People.csv"));
  const appearanceRows = readCsv(path.join(dir, "Appearances.csv"));
  const hofRows = readCsv(path.join(dir, "HallOfFame.csv"));

  const warnings = [];

  // Lahman's `franchID` IS the franchise key, so it is what `franchise` carries
  // — slugged with the franchise name for readability, but keyed on the id,
  // because 19 franchise NAMES are shared by two or more ids ("Washington
  // Nationals" is four of them) and slugging the name alone merges them.
  const franchiseSlug = new Map();
  for (const r of franchiseRows) {
    const named = slug(r.franchName || r.franchID);
    franchiseSlug.set(r.franchID, named + "-" + r.franchID.toLowerCase());
  }

  // (season, teamID) → the team as it was called THAT year. Lahman's own
  // `name` column is the source of the historical name; `franchID` is what
  // links "Montreal Expos" to "Washington Nationals" without merging them.
  const seasonTeams = new Map();
  const eraEntries = [];
  // Keyed (name, franchise, league) rather than by name alone: "Washington
  // Nationals" is four unrelated franchises across three leagues, and folding
  // them by name first labelled the modern club a National Association team
  // playing since 1872.
  const spanByKey = new Map();
  let maxSeason = 0;
  let excludedTeamSeasons = 0;
  for (const r of teamRows) {
    const season = intOrNull(r.yearID);
    if (season === null) continue;
    if (EXCLUDED_LAHMAN_LEAGUE_IDS.has(r.lgID)) {
      excludedTeamSeasons += 1;
      continue;
    }
    maxSeason = Math.max(maxSeason, season);
    const name = r.name.trim();
    seasonTeams.set(`${season}:${r.teamID}`, {
      name,
      franchise: r.franchID,
      lgID: r.lgID,
    });
    const leagueMeta = LAHMAN_LEAGUES[r.lgID];
    if (!leagueMeta) {
      warnings.push(`unknown Lahman lgID "${r.lgID}" on "${name}" in season ${season}; used MLB`);
    }
    const key = [name, r.franchID, r.lgID].join("|");
    const prior = spanByKey.get(key);
    if (prior) {
      prior.from = Math.min(prior.from, season);
      prior.to = Math.max(prior.to, season);
      prior.seasons += 1;
      continue;
    }
    const split = splitMlbTeamName(name);
    const entry = {
      name,
      location: split.location,
      nickname: split.nickname,
      league: (leagueMeta ?? LAHMAN_LEAGUES.NL).code,
      from: season,
      to: season,
      seasons: 1,
      franchise: franchiseSlug.get(r.franchID) ?? slug(r.franchID),
    };
    spanByKey.set(key, entry);
    eraEntries.push(entry);
  }

  // A team still playing in the dataset's final season is still active, so its
  // `to` is dropped rather than frozen at the last year we happen to have.
  for (const e of eraEntries) if (e.to >= maxSeason) e.to = null;

  const { teams, franchiseDisagreements } = foldTeamEras(eraEntries, maxSeason);
  const teamIndexByName = new Map(teams.map((t, i) => [t.name, i]));

  const people = new Map();
  for (const r of peopleRows) {
    people.set(r.playerID, {
      first: r.nameFirst.trim(),
      last: r.nameLast.trim(),
      birthYear: intOrNull(r.birthYear),
    });
  }

  // Inducted PLAYERS only. The same table carries managers, umpires and
  // executives, and `players.isHallOfFame` is about the player.
  const hof = new Set();
  for (const r of hofRows) {
    if (r.inducted === "Y" && r.category === "Player") hof.add(r.playerID);
  }

  const seasonsByPlayer = new Map();
  let excludedAppearances = 0;
  let unknownTeamAppearances = 0;
  for (const r of appearanceRows) {
    const season = intOrNull(r.yearID);
    if (season === null) continue;
    if (EXCLUDED_LAHMAN_LEAGUE_IDS.has(r.lgID)) {
      excludedAppearances += 1;
      continue;
    }
    const team = seasonTeams.get(`${season}:${r.teamID}`);
    if (!team) {
      // The team row was excluded (its lgID is a Negro League one) or the
      // season/team pair simply is not in Teams.csv. Either way there is no
      // team to attach the stint to.
      excludedAppearances += 1;
      unknownTeamAppearances += 1;
      continue;
    }
    const teamIndex = teamIndexByName.get(team.name);
    if (teamIndex === undefined) {
      throw new Error(`Lahman: no team row built for "${team.name}"`);
    }
    if (!seasonsByPlayer.has(r.playerID)) seasonsByPlayer.set(r.playerID, []);
    seasonsByPlayer.get(r.playerID).push({ season, teamIndex });
  }

  const players = [];
  let skippedNoName = 0;
  for (const [playerID, rows] of seasonsByPlayer) {
    const person = people.get(playerID);
    const name = `${person?.first ?? ""} ${person?.last ?? ""}`.trim();
    if (!name) {
      skippedNoName += 1;
      continue;
    }
    players.push({
      id: playerID,
      name,
      ...(person?.birthYear ? { birthYear: person.birthYear } : {}),
      ...(hof.has(playerID) ? { hof: true } : {}),
      stints: buildStints(rows),
    });
  }
  players.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const leagues = [];
  const seenLeague = new Set();
  for (const meta of Object.values(LAHMAN_LEAGUES)) {
    if (seenLeague.has(meta.code)) continue;
    if (!teams.some((t) => t.league === meta.code)) continue;
    seenLeague.add(meta.code);
    leagues.push({
      code: meta.code,
      name: meta.name,
      abbreviation: meta.abbreviation,
      from: meta.from,
      ...(meta.to === null ? {} : { to: meta.to }),
      ...(meta.default ? { default: true } : {}),
    });
  }
  leagues.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  const file = {
    source: {
      name: "The SABR Lahman Baseball Database",
      version: lahmanVersion(dir),
      licence: "CC-BY-SA-3.0",
      url: "https://sabr.org/lahman-database/",
      generatedAt,
      notes: [
        "Copyright 1996-2025 by SABR, via generous donation from Sean Lahman. " +
          "Licensed under a Creative Commons Attribution-ShareAlike 3.0 Unported License.",
        "Negro League and independent-team rows (lgID " +
          [...EXCLUDED_LAHMAN_LEAGUE_IDS].join(", ") +
          ") are EXCLUDED — see data/preload/README.md.",
      ],
    },
    leagues,
    teams,
    players,
  };

  return {
    file,
    stats: {
      players: players.length,
      teams: teams.length,
      leagues: leagues.length,
      stints: players.reduce((n, p) => n + p.stints.length, 0),
      excludedAppearances,
      unknownTeamAppearances,
      excludedTeamSeasons,
      droppedPlayers: new Set(appearanceRows.map((r) => r.playerID)).size - players.length,
      skippedNoName,
      hallOfFamers: players.filter((p) => p.hof).length,
      franchiseDisagreements,
      warnings,
    },
  };
}

/** "1871-2025 (released Dec 10, 2025)" from the readme, else the file's date. */
function lahmanVersion(dir) {
  const readme = path.join(dir, "lahman-readme.txt");
  if (!existsSync(readme)) return "unknown";
  const text = readFileSync(readme, "utf8").slice(0, 400);
  const title = /^(.*Database.*)$/m.exec(text)?.[1]?.trim();
  const release = /Release Date:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (title && release) return `${title} (released ${release})`;
  return title ?? release ?? "unknown";
}

// ---------------------------------------------------------------------------
// nflverse → nfl.json
// ---------------------------------------------------------------------------

export const NFL_LEAGUES = {
  NFL: { code: "NFL", name: "National Football League", abbreviation: "NFL", from: 1920, to: null, default: true },
  APFA: { code: "APFA", name: "American Professional Football Association", abbreviation: "APFA", from: 1920, to: 1921 },
  AAFC: { code: "AAFC", name: "All-America Football Conference", abbreviation: "AAFC", from: 1946, to: 1949 },
  AFL: { code: "AFL", name: "American Football League", abbreviation: "AFL", from: 1960, to: 1969 },
};

/** Key a source-id-less roster row by the fields that do identify a person. */
function nflNameKey(name) {
  return slug(name);
}

export function buildNfl({ rawDir, generatedAt }) {
  const dir = path.join(rawDir, "nflverse");
  const rosterFiles = readdirSync(dir)
    .filter((f) => /^roster_\d{4}\.csv$/.test(f))
    .sort();
  if (rosterFiles.length === 0) {
    throw new Error(`nflverse: no roster_*.csv under ${dir}`);
  }

  const warnings = [];
  const rows = [];
  let maxSeason = 0;
  for (const f of rosterFiles) {
    for (const r of readCsv(path.join(dir, f))) {
      const season = intOrNull(r.season);
      const name = (r.full_name ?? "").trim();
      const team = (r.team ?? "").trim();
      if (season === null || !team) continue;
      if (!name) {
        warnings.push(`roster row with no full_name: ${f} ${team} ${season}`);
        continue;
      }
      maxSeason = Math.max(maxSeason, season);
      // Every status is membership. A player cut in camp or on injured
      // reserve was on that team that year, which is what a card says and what
      // a stint means here; filtering to ACT would erase real roster rows.
      rows.push({
        season,
        team,
        name,
        birthDate: (r.birth_date ?? "").trim(),
        gsisId: (r.gsis_id ?? "").trim(),
      });
    }
  }

  // Resolve every (code, season) BEFORE anything else, so an unknown pair is a
  // failed build rather than a mislabelled player.
  const eraEntries = [];
  const seenEra = new Set();
  const unresolved = new Set();
  const rowTeamName = new Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    const { team, season } = rows[i];
    const era = resolveNflTeamEra(team, season);
    if (!era) {
      unresolved.add(`${team} ${season}`);
      continue;
    }
    rowTeamName[i] = nflEraTeamName(era);
    const eraKey = `${era.code}:${era.from}`;
    if (!seenEra.has(eraKey)) {
      seenEra.add(eraKey);
      eraEntries.push({
        name: nflEraTeamName(era),
        location: era.location,
        nickname: era.nickname,
        league: era.league,
        from: era.from,
        to: era.to,
        franchise: era.franchise,
      });
    }
  }
  if (unresolved.size > 0) {
    throw new Error(
      `nflverse: ${unresolved.size} (team code, season) pair(s) are not in ` +
        `NFL_TEAM_ERAS and cannot be resolved to a team:\n  ` +
        [...unresolved].sort().join("\n  ") +
        `\nAdd them to lib/players/preload/nfl-team-eras.ts.`,
    );
  }

  const { teams, franchiseDisagreements } = foldTeamEras(eraEntries, maxSeason);
  const teamIndexByName = new Map(teams.map((t, i) => [t.name, i]));

  // Identity, in the order the source supports it:
  //  1. gsis_id — 19k players, every one from the late 1990s on.
  //  2. name + birth date — the pre-id rows. Two people share a name often;
  //     almost nobody shares a name AND a birth date.
  //  3. name alone — 117 rows where the source has neither. Flagged
  //     `lowConfidence` so the loader can report them rather than pretending.
  const byPlayer = new Map();
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const key = r.gsisId
      ? `gsis:${r.gsisId}`
      : r.birthDate
        ? `name:${nflNameKey(r.name)}|${r.birthDate}`
        : `noid:${nflNameKey(r.name)}`;
    let p = byPlayer.get(key);
    if (!p) {
      p = {
        key,
        gsisId: r.gsisId,
        birthDate: r.birthDate,
        names: new Map(),
        seasons: [],
        lowConfidence: !r.gsisId && !r.birthDate,
      };
      byPlayer.set(key, p);
    }
    // A gsis id can carry several spellings across seasons (300 of them do).
    // Take the most recent, so the row reads as the name the player is known
    // by now rather than a rookie-year typo.
    const prevSeason = p.names.get(r.name);
    if (prevSeason === undefined || r.season > prevSeason) p.names.set(r.name, r.season);
    if (!p.birthDate && r.birthDate) p.birthDate = r.birthDate;
    p.seasons.push({ season: r.season, teamIndex: teamIndexByName.get(rowTeamName[i]) });
  }

  const players = [];
  let lowConfidence = 0;
  for (const p of byPlayer.values()) {
    let name = "";
    let bestSeason = -1;
    for (const [candidate, season] of p.names) {
      if (season > bestSeason || (season === bestSeason && candidate < name)) {
        bestSeason = season;
        name = candidate;
      }
    }
    const firstSeason = Math.min(...p.seasons.map((s) => s.season));
    const id = p.gsisId
      ? p.gsisId
      : p.birthDate
        ? `name:${nflNameKey(name)}|${p.birthDate}`
        : `name:${nflNameKey(name)}|s${firstSeason}`;
    const birthYear = p.birthDate ? intOrNull(p.birthDate.slice(0, 4)) : null;
    if (p.lowConfidence) lowConfidence += 1;
    players.push({
      id,
      name,
      ...(birthYear ? { birthYear } : {}),
      ...(p.lowConfidence ? { lowConfidence: true } : {}),
      stints: buildStints(p.seasons),
    });
  }
  players.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const duplicateIds = players.length - new Set(players.map((p) => p.id)).size;
  if (duplicateIds > 0) {
    throw new Error(`nflverse: ${duplicateIds} duplicate player ids`);
  }

  const leagues = [];
  for (const meta of Object.values(NFL_LEAGUES)) {
    if (!teams.some((t) => t.league === meta.code)) continue;
    leagues.push({
      code: meta.code,
      name: meta.name,
      abbreviation: meta.abbreviation,
      from: meta.from,
      ...(meta.to === null ? {} : { to: meta.to }),
      ...(meta.default ? { default: true } : {}),
    });
  }
  leagues.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  const file = {
    source: {
      name: "nflverse rosters",
      version: `roster_${rosterFiles[0].slice(7, 11)}…${rosterFiles[rosterFiles.length - 1].slice(7, 11)}`,
      licence: "CC-BY-4.0",
      url: "https://github.com/nflverse/nflverse-data",
      generatedAt,
      notes: [
        "nflverse-data, licensed CC BY 4.0. https://github.com/nflverse/nflverse-data",
        "Team identity per season comes from NB's own curated era table " +
          "(lib/players/preload/nfl-team-eras.ts), not from the source's team code.",
      ],
    },
    leagues,
    teams,
    players,
  };

  return {
    file,
    stats: {
      players: players.length,
      teams: teams.length,
      leagues: leagues.length,
      stints: players.reduce((n, p) => n + p.stints.length, 0),
      rosterRows: rows.length,
      eraRows: NFL_TEAM_ERAS.length,
      lowConfidence,
      withGsisId: players.filter((p) => !p.id.startsWith("name:")).length,
      franchiseDisagreements,
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { raw: path.join(WEB_ROOT, "data/preload/raw"), out: path.join(WEB_ROOT, "data/preload"), sport: "both" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--raw") args.raw = path.resolve(argv[++i]);
    else if (a === "--out") args.out = path.resolve(argv[++i]);
    else if (a === "--sport") args.sport = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function report(label, stats) {
  const lines = [
    `${label}: ${stats.players} players, ${stats.teams} teams, ${stats.leagues} leagues, ${stats.stints} stints`,
  ];
  if (stats.excludedAppearances !== undefined) {
    lines.push(
      `  excluded (Negro League + independent): ${stats.excludedAppearances} appearance rows, ` +
        `${stats.excludedTeamSeasons} team-seasons, ${stats.droppedPlayers} players dropped entirely`,
    );
    lines.push(`  hall of famers: ${stats.hallOfFamers}; skipped for a missing name: ${stats.skippedNoName}`);
  }
  if (stats.lowConfidence !== undefined) {
    lines.push(
      `  identity: ${stats.withGsisId} by source id, ${stats.players - stats.withGsisId} by name key, ` +
        `${stats.lowConfidence} low confidence (no id, no birth date)`,
    );
    lines.push(`  ${stats.rosterRows} roster rows resolved through ${stats.eraRows} era rows`);
  }
  for (const d of stats.franchiseDisagreements) {
    lines.push(
      `  note: "${d.name}" folds eras from ${d.franchises.length} franchises ` +
        `(${d.franchises.join(", ")}) into one NB row; kept "${d.kept}"`,
    );
  }
  for (const w of stats.warnings) lines.push(`  warning: ${w}`);
  console.error(lines.join("\n"));
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const generatedAt = new Date().toISOString().slice(0, 10);

  if (args.sport === "mlb" || args.sport === "both") {
    const { file, stats } = buildMlb({ rawDir: args.raw, generatedAt });
    const out = path.join(args.out, "mlb.json");
    writeFileSync(out, JSON.stringify(file));
    report(`mlb.json (${path.relative(WEB_ROOT, out)})`, stats);
  }
  if (args.sport === "nfl" || args.sport === "both") {
    const { file, stats } = buildNfl({ rawDir: args.raw, generatedAt });
    const out = path.join(args.out, "nfl.json");
    writeFileSync(out, JSON.stringify(file));
    report(`nfl.json (${path.relative(WEB_ROOT, out)})`, stats);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main();
}

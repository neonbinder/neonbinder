/**
 * NEO-156 — bundled team colour reference data.
 *
 * 165 teams across six leagues, sourced from a public team-colours dataset and
 * normalised here (hex values lowercased and `#`-prefixed, entries sorted).
 * Checked in rather than fetched so the common case needs no network at all:
 * `convex/teamColorSources.ts` consults this BEFORE reaching for
 * teamcolorcodes.com, and `convex/seedTeamColors.ts` seeds leagues and teams
 * from it at release.
 *
 * ## What this does NOT cover — read before trusting it
 *
 * The six leagues are NFL, NHL, MLB, NBA, MLS and EPL. There is **no NCAA, no
 * NPB, no MiLB and no Dominican winter league** here, and those are most of
 * what our `teams` table actually holds: a survey of all 58 prod rows found
 * Saitama Seibu Lions, Chiba Lotte Marines, Estrellas Orientales, Fort Wayne
 * TinCaps and "UConn Huskies baseball". This is a fast path for the big
 * leagues, NOT a replacement for the live lookup — a miss here is normal and
 * falls through to the scraper.
 *
 * **All 165 rows carry colours.** The NBA's 30 arrived empty in the original
 * dataset and were filled from a second source, taking each team's CURRENT
 * `colors` and deliberately ignoring its `retrocolors` — labelling a binder in
 * a retired palette is precisely the failure the scraper's era-parsing exists
 * to avoid.
 *
 * Two of those NBA values were corrected against the RGB in their own record,
 * which contradicted the hex beside it:
 *
 *  - **Lakers gold** was `#F9A01B`, the Miami Heat's yellow, while its RGB
 *    `(253,185,39)` says `#FDB927` — the real Lakers gold, and the one that
 *    matters here because gold is their SECONDARY colour and therefore the
 *    lettering on a Lakers spine.
 *  - **Suns yellow** was `#000000` against an RGB of `(249,160,27)`.
 *
 * A "Black" entry whose RGB reads `(6,25,34)` is left as `#000000`: that
 * near-black RGB repeats across many teams and is the artifact, not the hex.
 *
 * **The names are inconsistently dated.** It carries "Cleveland Indians"
 * (renamed Guardians in 2022) and "Los Angeles Angels of Anaheim" (renamed in
 * 2016), yet also "Washington Commanders" (2022). `RENAMED_FRANCHISES` below
 * maps the stale ones forward so seeding cannot mint a duplicate row for a
 * franchise we already hold under its current name.
 */

import type { TeamNameParts } from "./team-name";

export interface SeedTeam {
  /**
   * NEO-236 — the NICKNAME. "Padres", not "San Diego Padres".
   *
   * Split by hand, row by row, rather than derived: this is NeonBinder's own
   * reference data and a heuristic would get it wrong in both directions.
   * "Real Salt Lake" has no location part ("Real" is the club's name), while
   * "New England Patriots" and "Golden State Warriors" have two-word ones that
   * no first-token rule finds. The English clubs carry none at all — Liverpool
   * FC is not "the Liverpool FC of Liverpool" — which is the same shape a
   * college side or a Japanese corporate club has.
   *
   * Compose the display name with `teamFullName` (lib/teams/team-name.ts);
   * nothing here should concatenate the two by hand.
   */
  name: string;
  /** The place part, absent when the club's name carries none. */
  location?: string;
  league: SeedLeagueCode;
  /** `#rrggbb`, most prominent first. Empty for every NBA row. */
  hex: string[];
}

export type SeedLeagueCode = "epl" | "mlb" | "mls" | "nba" | "nfl" | "nhl";

/**
 * League metadata, and the SPORT each maps to.
 *
 * `sportValue` is matched against a `level: "sport"` selectorOptions row by
 * display value — the same rows the sync creates. A sport we have never synced
 * simply yields no teams for its leagues rather than inventing a sport row,
 * because sports are created by the marketplace sync and guessing one here
 * would produce a row nothing else recognises.
 */
export const SEED_LEAGUES: Record<
  SeedLeagueCode,
  { name: string; abbreviation: string; sportValue: string }
> = {
  epl: {
    name: "Premier League",
    abbreviation: "EPL",
    sportValue: "Soccer",
  },
  mlb: {
    name: "Major League Baseball",
    abbreviation: "MLB",
    sportValue: "Baseball",
  },
  mls: { name: "Major League Soccer", abbreviation: "MLS", sportValue: "Soccer" },
  nba: {
    name: "National Basketball Association",
    abbreviation: "NBA",
    sportValue: "Basketball",
  },
  nfl: {
    name: "National Football League",
    abbreviation: "NFL",
    sportValue: "Football",
  },
  nhl: {
    name: "National Hockey League",
    abbreviation: "NHL",
    sportValue: "Hockey",
  },
};

/**
 * Stale names in the dataset, mapped to the franchise's current name.
 *
 * Without this, seeding "Cleveland Indians" alongside our existing "Cleveland
 * Guardians" row would leave two rows for one franchise, each with half the
 * data — and a collector's binder labelled with a name retired in 2022.
 *
 * These are renames of the SAME franchise, not relocations to a different one.
 * A relocation that we track as two distinct historical teams (Montreal Expos
 * → Washington Nationals) is deliberately absent: both are real, separate rows
 * for us, and collapsing them would lose the Expos.
 *
 * NEO-236: keyed by the dataset's FULL name (that is what a caller has when
 * it is holding a scraped or marketplace string), and valued as the split the
 * seeder inserts — so the rename lands as Location + Name like every other
 * creation, rather than as a string somebody has to re-split.
 */
export const RENAMED_FRANCHISES: Record<string, TeamNameParts> = {
  "Cleveland Indians": { location: "Cleveland", name: "Guardians" },
  "Los Angeles Angels of Anaheim": { location: "Los Angeles", name: "Angels" },
};

export const SEED_TEAMS: SeedTeam[] = [
  { name: "AFC Bournemouth", league: "epl", hex: ["#e62333", "#000000"] },
  { name: "Arsenal", league: "epl", hex: ["#ef0107", "#023474", "#9c824a"] },
  { name: "Brighton & Hove Albion", league: "epl", hex: ["#0055a9", "#f8bc1b"] },
  { name: "Burnley", league: "epl", hex: ["#8ccce5", "#53162f", "#f9ec34"] },
  { name: "Chelsea", league: "epl", hex: ["#034694", "#dba111", "#ed1c24"] },
  { name: "Crystal Palace", league: "epl", hex: ["#1b458f", "#c4122e", "#a7a5a6"] },
  { name: "Everton", league: "epl", hex: ["#274488"] },
  { name: "Huddersfield Town", league: "epl", hex: ["#0073d2"] },
  { name: "Leicester City", league: "epl", hex: ["#fdbe11", "#0053a0"] },
  { name: "Liverpool", league: "epl", hex: ["#00a398", "#d00027", "#fef667"] },
  { name: "Manchester City", league: "epl", hex: ["#98c5e9", "#00285e", "#f4bc46"] },
  { name: "Manchester United", league: "epl", hex: ["#da020e", "#ffe500", "#000000"] },
  { name: "Newcastle United", league: "epl", hex: ["#241f20", "#00b8f4", "#c3a572"] },
  { name: "Southampton", league: "epl", hex: ["#ed1a3b", "#211e1f", "#ffc20e"] },
  { name: "Stoke City", league: "epl", hex: ["#e03a3e", "#1b449c"] },
  { name: "Swansea City", league: "epl", hex: ["#000000"] },
  { name: "Tottenham Hotspur", league: "epl", hex: ["#001c58"] },
  { name: "Watford", league: "epl", hex: ["#fbee23", "#ed2127", "#000000"] },
  { name: "West Bromwich Albion", league: "epl", hex: ["#091453"] },
  { name: "West Ham United", league: "epl", hex: ["#60223b", "#f7c240", "#5299c6"] },
  { location: "Arizona", name: "Diamondbacks", league: "mlb", hex: ["#a71930", "#000000", "#e3d4ad"] },
  { location: "Atlanta", name: "Braves", league: "mlb", hex: ["#ce1141", "#13274f"] },
  { location: "Baltimore", name: "Orioles", league: "mlb", hex: ["#df4601", "#000000"] },
  { location: "Boston", name: "Red Sox", league: "mlb", hex: ["#bd3039", "#0d2b56"] },
  { location: "Chicago", name: "Cubs", league: "mlb", hex: ["#cc3433", "#0e3386"] },
  { location: "Chicago", name: "White Sox", league: "mlb", hex: ["#000000", "#c4ced4"] },
  { location: "Cincinnati", name: "Reds", league: "mlb", hex: ["#c6011f", "#000000"] },
  { location: "Cleveland", name: "Indians", league: "mlb", hex: ["#e31937", "#002b5c"] },
  { location: "Colorado", name: "Rockies", league: "mlb", hex: ["#333366", "#231f20", "#c4ced4"] },
  { location: "Detroit", name: "Tigers", league: "mlb", hex: ["#0c2c56"] },
  { location: "Houston", name: "Astros", league: "mlb", hex: ["#002d62", "#eb6e1f"] },
  { location: "Kansas City", name: "Royals", league: "mlb", hex: ["#004687", "#c09a5b"] },
  { location: "Los Angeles", name: "Angels of Anaheim", league: "mlb", hex: ["#ba0021", "#003263"] },
  { location: "Los Angeles", name: "Dodgers", league: "mlb", hex: ["#ef3e42", "#005a9c"] },
  { location: "Miami", name: "Marlins", league: "mlb", hex: ["#ff6600", "#0077c8", "#ffd100", "#000000"] },
  { location: "Milwaukee", name: "Brewers", league: "mlb", hex: ["#0a2351", "#b6922e"] },
  { location: "Minnesota", name: "Twins", league: "mlb", hex: ["#002b5c", "#d31145"] },
  { location: "New York", name: "Mets", league: "mlb", hex: ["#ff5910", "#002d72"] },
  { location: "New York", name: "Yankees", league: "mlb", hex: ["#e4002b", "#003087"] },
  { location: "Oakland", name: "Athletics", league: "mlb", hex: ["#003831", "#efb21e"] },
  { location: "Philadelphia", name: "Phillies", league: "mlb", hex: ["#284898", "#e81828"] },
  { location: "Pittsburgh", name: "Pirates", league: "mlb", hex: ["#fdb827", "#000000"] },
  { location: "San Diego", name: "Padres", league: "mlb", hex: ["#002d62", "#fec325", "#7f411c", "#a0aab2"] },
  { location: "San Francisco", name: "Giants", league: "mlb", hex: ["#fd5a1e", "#000000", "#8b6f4e"] },
  { location: "Seattle", name: "Mariners", league: "mlb", hex: ["#0c2c56", "#005c5c", "#c4ced4"] },
  { location: "St Louis", name: "Cardinals", league: "mlb", hex: ["#c41e3a", "#000066", "#fedb00"] },
  { location: "Tampa Bay", name: "Rays", league: "mlb", hex: ["#092c5c", "#8fbce6", "#f5d130"] },
  { location: "Texas", name: "Rangers", league: "mlb", hex: ["#c0111f", "#003278"] },
  { location: "Toronto", name: "Blue Jays", league: "mlb", hex: ["#134a8e", "#1d2d5c", "#e8291c"] },
  { location: "Washington", name: "Nationals", league: "mlb", hex: ["#ab0003", "#11225b"] },
  { location: "Atlanta", name: "United FC", league: "mls", hex: ["#a29061", "#80000b", "#000000"] },
  { location: "Chicago", name: "Fire", league: "mls", hex: ["#af2626", "#0a174a", "#8a8d8f"] },
  { location: "Colorado", name: "Rapids", league: "mls", hex: ["#91022d", "#85b7ea", "#8a8d8f", "#313f49"] },
  { location: "Columbus", name: "Crew", league: "mls", hex: ["#000000", "#ffdb00", "#8a8d8f"] },
  { name: "DC United", league: "mls", hex: ["#000000", "#dd0000"] },
  { name: "FC Dallas", league: "mls", hex: ["#cf0032", "#07175c", "#8a8d8f"] },
  { location: "Houston", name: "Dynamo", league: "mls", hex: ["#f36600", "#2e2926", "#85b7ea"] },
  { location: "LA", name: "Galaxy", league: "mls", hex: ["#00245d", "#004689", "#f1aa00", "#ffd200"] },
  { location: "Minnesota", name: "United FC", league: "mls", hex: ["#cfd4d8", "#6caddf", "#000000"] },
  { location: "Montreal", name: "Impact", league: "mls", hex: ["#122089", "#000000", "#7a878f"] },
  { location: "New England", name: "Revolution", league: "mls", hex: ["#0a2141", "#d80016", "#8a8d8f"] },
  { name: "New York City FC", league: "mls", hex: ["#6caddf", "#00285e", "#fd4f00"] },
  { location: "New York", name: "Red Bulls", league: "mls", hex: ["#d50031", "#012055", "#ffc800", "#8a8d8f"] },
  { name: "Orlando City SC", league: "mls", hex: ["#633492", "#fde192"] },
  { location: "Philadelphia", name: "Union", league: "mls", hex: ["#002d55", "#5090cd", "#b38707", "#b49759", "#f4f4f4"] },
  { location: "Portland", name: "Timbers", league: "mls", hex: ["#004812", "#ebe72b"] },
  { name: "Real Salt Lake", league: "mls", hex: ["#a50531", "#013474", "#f2d11a"] },
  { location: "San Jose", name: "Earthquakes", league: "mls", hex: ["#0051ba", "#000000", "#b1b4b2"] },
  { location: "Seattle", name: "Sounders FC", league: "mls", hex: ["#4f8a10", "#11568c", "#212930"] },
  { name: "Sporting Kansas City", league: "mls", hex: ["#91b0d5", "#002b5c", "#9fa1a4"] },
  { name: "Toronto FC", league: "mls", hex: ["#d80016", "#313f49", "#a1aaad"] },
  { location: "Vancouver", name: "Whitecaps FC", league: "mls", hex: ["#12264c", "#85b7ea", "#838383"] },
  { location: "Atlanta", name: "Hawks", league: "nba", hex: ["#e03a3e", "#c1d32f", "#26282a"] },
  { location: "Boston", name: "Celtics", league: "nba", hex: ["#007a33", "#ba9653", "#963821"] },
  { location: "Brooklyn", name: "Nets", league: "nba", hex: ["#000000", "#ffffff"] },
  { location: "Charlotte", name: "Hornets", league: "nba", hex: ["#1d1160", "#00788c", "#a1a1a4"] },
  { location: "Chicago", name: "Bulls", league: "nba", hex: ["#ce1141", "#000000"] },
  { location: "Cleveland", name: "Cavaliers", league: "nba", hex: ["#860038", "#041e42", "#fdbb30", "#000000"] },
  { location: "Dallas", name: "Mavericks", league: "nba", hex: ["#00538c", "#002b5e", "#b8c4ca", "#000000"] },
  { location: "Denver", name: "Nuggets", league: "nba", hex: ["#0e2240", "#fec524", "#8b2131", "#1d428a"] },
  { location: "Detroit", name: "Pistons", league: "nba", hex: ["#c8102e", "#1d42ba", "#bec0c2", "#002d62"] },
  { location: "Golden State", name: "Warriors", league: "nba", hex: ["#1d428a", "#ffc72c"] },
  { location: "Houston", name: "Rockets", league: "nba", hex: ["#ce1141", "#000000", "#c4ced4"] },
  { location: "Indiana", name: "Pacers", league: "nba", hex: ["#002d62", "#fdbb30", "#bec0c2"] },
  { location: "Los Angeles", name: "Clippers", league: "nba", hex: ["#c8102e", "#1d428a", "#bec0c2", "#000000"] },
  { location: "Los Angeles", name: "Lakers", league: "nba", hex: ["#552583", "#fdb927", "#000000"] },
  { location: "Memphis", name: "Grizzlies", league: "nba", hex: ["#5d76a9", "#12173f", "#f5b112", "#707271"] },
  { location: "Miami", name: "Heat", league: "nba", hex: ["#98002e", "#f9a01b", "#000000"] },
  { location: "Milwaukee", name: "Bucks", league: "nba", hex: ["#00471b", "#eee1c6", "#0077c0", "#000000"] },
  { location: "Minnesota", name: "Timberwolves", league: "nba", hex: ["#0c2340", "#236192", "#9ea2a2", "#78be20"] },
  { location: "New Orleans", name: "Pelicans", league: "nba", hex: ["#0c2340", "#c8102e", "#85714d"] },
  { location: "New York", name: "Knicks", league: "nba", hex: ["#006bb6", "#f58426", "#bec0c2", "#000000"] },
  { location: "Oklahoma City", name: "Thunder", league: "nba", hex: ["#007ac1", "#ef3b24", "#002d62", "#fdbb30"] },
  { location: "Orlando", name: "Magic", league: "nba", hex: ["#0077c0", "#c4ced4", "#000000"] },
  { location: "Philadelphia", name: "76ers", league: "nba", hex: ["#006bb6", "#ed174c", "#002b5c", "#c4ced4"] },
  { location: "Phoenix", name: "Suns", league: "nba", hex: ["#1d1160", "#e56020", "#000000", "#63727a", "#f9a01b", "#b95915", "#bec0c2"] },
  { location: "Portland", name: "Trail Blazers", league: "nba", hex: ["#e03a3e", "#000000"] },
  { location: "Sacramento", name: "Kings", league: "nba", hex: ["#5a2d81", "#63727a", "#000000"] },
  { location: "San Antonio", name: "Spurs", league: "nba", hex: ["#c4ced4", "#000000"] },
  { location: "Toronto", name: "Raptors", league: "nba", hex: ["#ce1141", "#000000", "#a1a1a4", "#b4975a"] },
  { location: "Utah", name: "Jazz", league: "nba", hex: ["#002b5c", "#00471b", "#f9a01b"] },
  { location: "Washington", name: "Wizards", league: "nba", hex: ["#002b5c", "#e31837", "#c4ced4"] },
  { location: "Arizona", name: "Cardinals", league: "nfl", hex: ["#97233f", "#000000", "#ffb612", "#a5acaf"] },
  { location: "Atlanta", name: "Falcons", league: "nfl", hex: ["#a71930", "#000000", "#a5acaf"] },
  { location: "Baltimore", name: "Ravens", league: "nfl", hex: ["#241773", "#000000", "#9e7c0c", "#c60c30"] },
  { location: "Buffalo", name: "Bills", league: "nfl", hex: ["#00338d", "#c60c30"] },
  { location: "Carolina", name: "Panthers", league: "nfl", hex: ["#0085ca", "#000000", "#bfc0bf"] },
  { location: "Chicago", name: "Bears", league: "nfl", hex: ["#0b162a", "#c83803"] },
  { location: "Cincinnati", name: "Bengals", league: "nfl", hex: ["#000000", "#fb4f14"] },
  { location: "Cleveland", name: "Browns", league: "nfl", hex: ["#fb4f14", "#22150c", "#a5acaf"] },
  { location: "Dallas", name: "Cowboys", league: "nfl", hex: ["#002244", "#b0b7bc", "#acc0c6", "#a5acaf", "#00338d", "#000000"] },
  { location: "Denver", name: "Broncos", league: "nfl", hex: ["#002244", "#fb4f14"] },
  { location: "Detroit", name: "Lions", league: "nfl", hex: ["#005a8b", "#b0b7bc", "#000000"] },
  { location: "Green Bay", name: "Packers", league: "nfl", hex: ["#203731", "#ffb612"] },
  { location: "Houston", name: "Texans", league: "nfl", hex: ["#03202f", "#a71930"] },
  { location: "Indianapolis", name: "Colts", league: "nfl", hex: ["#002c5f", "#a5acaf"] },
  { location: "Jacksonville", name: "Jaguars", league: "nfl", hex: ["#000000", "#006778", "#9f792c", "#d7a22a"] },
  { location: "Kansas City", name: "Chiefs", league: "nfl", hex: ["#e31837", "#ffb612", "#000000"] },
  { location: "Los Angeles", name: "Chargers", league: "nfl", hex: ["#002244", "#0073cf", "#ffb612"] },
  { location: "Los Angeles", name: "Rams", league: "nfl", hex: ["#002244", "#b3995d"] },
  { location: "Miami", name: "Dolphins", league: "nfl", hex: ["#008e97", "#f58220", "#005778"] },
  { location: "Minnesota", name: "Vikings", league: "nfl", hex: ["#4f2683", "#ffc62f", "#e9bf9b", "#000000"] },
  { location: "New England", name: "Patriots", league: "nfl", hex: ["#002244", "#c60c30", "#b0b7bc"] },
  { location: "New Orleans", name: "Saints", league: "nfl", hex: ["#9f8958", "#000000"] },
  { location: "New York", name: "Giants", league: "nfl", hex: ["#0b2265", "#a71930", "#a5acaf"] },
  { location: "New York", name: "Jets", league: "nfl", hex: ["#203731"] },
  { location: "Oakland", name: "Raiders", league: "nfl", hex: ["#a5acaf", "#000000"] },
  { location: "Philadelphia", name: "Eagles", league: "nfl", hex: ["#004953", "#a5acaf", "#acc0c6", "#000000", "#565a5c"] },
  { location: "Pittsburgh", name: "Steelers", league: "nfl", hex: ["#000000", "#ffb612", "#c60c30", "#00539b", "#a5acaf"] },
  { location: "San Francisco", name: "49ers", league: "nfl", hex: ["#aa0000", "#b3995d", "#000000", "#a5acaf"] },
  { location: "Seattle", name: "Seahawks", league: "nfl", hex: ["#002244", "#69be28", "#a5acaf"] },
  { location: "Tampa Bay", name: "Buccaneers", league: "nfl", hex: ["#d50a0a", "#34302b", "#000000", "#ff7900", "#b1babf"] },
  { location: "Tennessee", name: "Titans", league: "nfl", hex: ["#002244", "#4b92db", "#c60c30", "#a5acaf"] },
  { location: "Washington", name: "Commanders", league: "nfl", hex: ["#773141", "#ffb612", "#000000", "#5a1414"] },
  { location: "Anaheim", name: "Ducks", league: "nhl", hex: ["#010101", "#a2aaad", "#fc4c02", "#85714d"] },
  { location: "Arizona", name: "Coyotes", league: "nhl", hex: ["#010101", "#862633", "#ddcba4"] },
  { location: "Boston", name: "Bruins", league: "nhl", hex: ["#010101", "#ffb81c"] },
  { location: "Buffalo", name: "Sabres", league: "nhl", hex: ["#041e42", "#a2aaad", "#ffb81c", "#c8102e"] },
  { location: "Calgary", name: "Flames", league: "nhl", hex: ["#010101", "#f1be48", "#c8102e"] },
  { location: "Carolina", name: "Hurricanes", league: "nhl", hex: ["#010101", "#a2aaad", "#c8102e"] },
  { location: "Chicago", name: "Blackhawks", league: "nhl", hex: ["#010101", "#ff671f", "#ffd100", "#001871", "#c8102e", "#00843d", "#cc8a00"] },
  { location: "Colorado", name: "Avalanche", league: "nhl", hex: ["#010101", "#236192", "#a4a9ad", "#6f263d"] },
  { location: "Columbus", name: "Blue Jackets", league: "nhl", hex: ["#041e42", "#a4a9ad", "#c8102e"] },
  { location: "Dallas", name: "Stars", league: "nhl", hex: ["#010101", "#006341", "#8a8d8f"] },
  { location: "Detroit", name: "Red Wings", league: "nhl", hex: ["#c8102e"] },
  { location: "Edmonton", name: "Oilers", league: "nhl", hex: ["#00205b", "#cf4520"] },
  { location: "Florida", name: "Panthers", league: "nhl", hex: ["#041e42", "#b9975b", "#c8102e"] },
  { location: "Los Angeles", name: "Kings", league: "nhl", hex: ["#010101", "#a2aaad"] },
  { location: "Minnesota", name: "Wild", league: "nhl", hex: ["#154734", "#ddcba4", "#eaaa00", "#a6192e"] },
  { location: "Montreal", name: "Canadiens", league: "nhl", hex: ["#001e62", "#a6192e"] },
  { location: "Nashville", name: "Predators", league: "nhl", hex: ["#041e42", "#ffb81c"] },
  { location: "New Jersey", name: "Devils", league: "nhl", hex: ["#010101", "#c8102e"] },
  { location: "New York", name: "Islanders", league: "nhl", hex: ["#003087", "#fc4c02"] },
  { location: "New York", name: "Rangers", league: "nhl", hex: ["#0033a0", "#c8102e"] },
  { location: "Ottawa", name: "Senators", league: "nhl", hex: ["#010101", "#c8102e", "#c69214"] },
  { location: "Philadelphia", name: "Flyers", league: "nhl", hex: ["#010101", "#fa4616"] },
  { location: "Pittsburgh", name: "Penguins", league: "nhl", hex: ["#010101", "#ffb81c"] },
  { location: "San Jose", name: "Sharks", league: "nhl", hex: ["#010101", "#e57200", "#006272"] },
  { location: "St Louis", name: "Blues", league: "nhl", hex: ["#041e42", "#ffb81c", "#003087"] },
  { location: "Tampa Bay", name: "Lightning", league: "nhl", hex: ["#00205b"] },
  { location: "Toronto", name: "Maple Leafs", league: "nhl", hex: ["#00205b"] },
  { location: "Vancouver", name: "Canucks", league: "nhl", hex: ["#00205b", "#97999b", "#041c2c"] },
  { location: "Vegas", name: "Golden Knights", league: "nhl", hex: ["#010101", "#b4975a", "#333f42"] },
  { location: "Washington", name: "Capitals", league: "nhl", hex: ["#041e42", "#a2aaad", "#782f40", "#a6192e", "#53565a"] },
  { location: "Winnipeg", name: "Jets", league: "nhl", hex: ["#041e42", "#c8102e"] },
];


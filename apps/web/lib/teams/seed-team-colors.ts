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

export interface SeedTeam {
  name: string;
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
 */
export const RENAMED_FRANCHISES: Record<string, string> = {
  "Cleveland Indians": "Cleveland Guardians",
  "Los Angeles Angels of Anaheim": "Los Angeles Angels",
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
  { name: "Arizona Diamondbacks", league: "mlb", hex: ["#a71930", "#000000", "#e3d4ad"] },
  { name: "Atlanta Braves", league: "mlb", hex: ["#ce1141", "#13274f"] },
  { name: "Baltimore Orioles", league: "mlb", hex: ["#df4601", "#000000"] },
  { name: "Boston Red Sox", league: "mlb", hex: ["#bd3039", "#0d2b56"] },
  { name: "Chicago Cubs", league: "mlb", hex: ["#cc3433", "#0e3386"] },
  { name: "Chicago White Sox", league: "mlb", hex: ["#000000", "#c4ced4"] },
  { name: "Cincinnati Reds", league: "mlb", hex: ["#c6011f", "#000000"] },
  { name: "Cleveland Indians", league: "mlb", hex: ["#e31937", "#002b5c"] },
  { name: "Colorado Rockies", league: "mlb", hex: ["#333366", "#231f20", "#c4ced4"] },
  { name: "Detroit Tigers", league: "mlb", hex: ["#0c2c56"] },
  { name: "Houston Astros", league: "mlb", hex: ["#002d62", "#eb6e1f"] },
  { name: "Kansas City Royals", league: "mlb", hex: ["#004687", "#c09a5b"] },
  { name: "Los Angeles Angels of Anaheim", league: "mlb", hex: ["#ba0021", "#003263"] },
  { name: "Los Angeles Dodgers", league: "mlb", hex: ["#ef3e42", "#005a9c"] },
  { name: "Miami Marlins", league: "mlb", hex: ["#ff6600", "#0077c8", "#ffd100", "#000000"] },
  { name: "Milwaukee Brewers", league: "mlb", hex: ["#0a2351", "#b6922e"] },
  { name: "Minnesota Twins", league: "mlb", hex: ["#002b5c", "#d31145"] },
  { name: "New York Mets", league: "mlb", hex: ["#ff5910", "#002d72"] },
  { name: "New York Yankees", league: "mlb", hex: ["#e4002b", "#003087"] },
  { name: "Oakland Athletics", league: "mlb", hex: ["#003831", "#efb21e"] },
  { name: "Philadelphia Phillies", league: "mlb", hex: ["#284898", "#e81828"] },
  { name: "Pittsburgh Pirates", league: "mlb", hex: ["#fdb827", "#000000"] },
  { name: "San Diego Padres", league: "mlb", hex: ["#002d62", "#fec325", "#7f411c", "#a0aab2"] },
  { name: "San Francisco Giants", league: "mlb", hex: ["#fd5a1e", "#000000", "#8b6f4e"] },
  { name: "Seattle Mariners", league: "mlb", hex: ["#0c2c56", "#005c5c", "#c4ced4"] },
  { name: "St Louis Cardinals", league: "mlb", hex: ["#c41e3a", "#000066", "#fedb00"] },
  { name: "Tampa Bay Rays", league: "mlb", hex: ["#092c5c", "#8fbce6", "#f5d130"] },
  { name: "Texas Rangers", league: "mlb", hex: ["#c0111f", "#003278"] },
  { name: "Toronto Blue Jays", league: "mlb", hex: ["#134a8e", "#1d2d5c", "#e8291c"] },
  { name: "Washington Nationals", league: "mlb", hex: ["#ab0003", "#11225b"] },
  { name: "Atlanta United FC", league: "mls", hex: ["#a29061", "#80000b", "#000000"] },
  { name: "Chicago Fire", league: "mls", hex: ["#af2626", "#0a174a", "#8a8d8f"] },
  { name: "Colorado Rapids", league: "mls", hex: ["#91022d", "#85b7ea", "#8a8d8f", "#313f49"] },
  { name: "Columbus Crew", league: "mls", hex: ["#000000", "#ffdb00", "#8a8d8f"] },
  { name: "DC United", league: "mls", hex: ["#000000", "#dd0000"] },
  { name: "FC Dallas", league: "mls", hex: ["#cf0032", "#07175c", "#8a8d8f"] },
  { name: "Houston Dynamo", league: "mls", hex: ["#f36600", "#2e2926", "#85b7ea"] },
  { name: "LA Galaxy", league: "mls", hex: ["#00245d", "#004689", "#f1aa00", "#ffd200"] },
  { name: "Minnesota United FC", league: "mls", hex: ["#cfd4d8", "#6caddf", "#000000"] },
  { name: "Montreal Impact", league: "mls", hex: ["#122089", "#000000", "#7a878f"] },
  { name: "New England Revolution", league: "mls", hex: ["#0a2141", "#d80016", "#8a8d8f"] },
  { name: "New York City FC", league: "mls", hex: ["#6caddf", "#00285e", "#fd4f00"] },
  { name: "New York Red Bulls", league: "mls", hex: ["#d50031", "#012055", "#ffc800", "#8a8d8f"] },
  { name: "Orlando City SC", league: "mls", hex: ["#633492", "#fde192"] },
  { name: "Philadelphia Union", league: "mls", hex: ["#002d55", "#5090cd", "#b38707", "#b49759", "#f4f4f4"] },
  { name: "Portland Timbers", league: "mls", hex: ["#004812", "#ebe72b"] },
  { name: "Real Salt Lake", league: "mls", hex: ["#a50531", "#013474", "#f2d11a"] },
  { name: "San Jose Earthquakes", league: "mls", hex: ["#0051ba", "#000000", "#b1b4b2"] },
  { name: "Seattle Sounders FC", league: "mls", hex: ["#4f8a10", "#11568c", "#212930"] },
  { name: "Sporting Kansas City", league: "mls", hex: ["#91b0d5", "#002b5c", "#9fa1a4"] },
  { name: "Toronto FC", league: "mls", hex: ["#d80016", "#313f49", "#a1aaad"] },
  { name: "Vancouver Whitecaps FC", league: "mls", hex: ["#12264c", "#85b7ea", "#838383"] },
  { name: "Atlanta Hawks", league: "nba", hex: ["#e03a3e", "#c1d32f", "#26282a"] },
  { name: "Boston Celtics", league: "nba", hex: ["#007a33", "#ba9653", "#963821"] },
  { name: "Brooklyn Nets", league: "nba", hex: ["#000000", "#ffffff"] },
  { name: "Charlotte Hornets", league: "nba", hex: ["#1d1160", "#00788c", "#a1a1a4"] },
  { name: "Chicago Bulls", league: "nba", hex: ["#ce1141", "#000000"] },
  { name: "Cleveland Cavaliers", league: "nba", hex: ["#860038", "#041e42", "#fdbb30", "#000000"] },
  { name: "Dallas Mavericks", league: "nba", hex: ["#00538c", "#002b5e", "#b8c4ca", "#000000"] },
  { name: "Denver Nuggets", league: "nba", hex: ["#0e2240", "#fec524", "#8b2131", "#1d428a"] },
  { name: "Detroit Pistons", league: "nba", hex: ["#c8102e", "#1d42ba", "#bec0c2", "#002d62"] },
  { name: "Golden State Warriors", league: "nba", hex: ["#1d428a", "#ffc72c"] },
  { name: "Houston Rockets", league: "nba", hex: ["#ce1141", "#000000", "#c4ced4"] },
  { name: "Indiana Pacers", league: "nba", hex: ["#002d62", "#fdbb30", "#bec0c2"] },
  { name: "Los Angeles Clippers", league: "nba", hex: ["#c8102e", "#1d428a", "#bec0c2", "#000000"] },
  { name: "Los Angeles Lakers", league: "nba", hex: ["#552583", "#fdb927", "#000000"] },
  { name: "Memphis Grizzlies", league: "nba", hex: ["#5d76a9", "#12173f", "#f5b112", "#707271"] },
  { name: "Miami Heat", league: "nba", hex: ["#98002e", "#f9a01b", "#000000"] },
  { name: "Milwaukee Bucks", league: "nba", hex: ["#00471b", "#eee1c6", "#0077c0", "#000000"] },
  { name: "Minnesota Timberwolves", league: "nba", hex: ["#0c2340", "#236192", "#9ea2a2", "#78be20"] },
  { name: "New Orleans Pelicans", league: "nba", hex: ["#0c2340", "#c8102e", "#85714d"] },
  { name: "New York Knicks", league: "nba", hex: ["#006bb6", "#f58426", "#bec0c2", "#000000"] },
  { name: "Oklahoma City Thunder", league: "nba", hex: ["#007ac1", "#ef3b24", "#002d62", "#fdbb30"] },
  { name: "Orlando Magic", league: "nba", hex: ["#0077c0", "#c4ced4", "#000000"] },
  { name: "Philadelphia 76ers", league: "nba", hex: ["#006bb6", "#ed174c", "#002b5c", "#c4ced4"] },
  { name: "Phoenix Suns", league: "nba", hex: ["#1d1160", "#e56020", "#000000", "#63727a", "#f9a01b", "#b95915", "#bec0c2"] },
  { name: "Portland Trail Blazers", league: "nba", hex: ["#e03a3e", "#000000"] },
  { name: "Sacramento Kings", league: "nba", hex: ["#5a2d81", "#63727a", "#000000"] },
  { name: "San Antonio Spurs", league: "nba", hex: ["#c4ced4", "#000000"] },
  { name: "Toronto Raptors", league: "nba", hex: ["#ce1141", "#000000", "#a1a1a4", "#b4975a"] },
  { name: "Utah Jazz", league: "nba", hex: ["#002b5c", "#00471b", "#f9a01b"] },
  { name: "Washington Wizards", league: "nba", hex: ["#002b5c", "#e31837", "#c4ced4"] },
  { name: "Arizona Cardinals", league: "nfl", hex: ["#97233f", "#000000", "#ffb612", "#a5acaf"] },
  { name: "Atlanta Falcons", league: "nfl", hex: ["#a71930", "#000000", "#a5acaf"] },
  { name: "Baltimore Ravens", league: "nfl", hex: ["#241773", "#000000", "#9e7c0c", "#c60c30"] },
  { name: "Buffalo Bills", league: "nfl", hex: ["#00338d", "#c60c30"] },
  { name: "Carolina Panthers", league: "nfl", hex: ["#0085ca", "#000000", "#bfc0bf"] },
  { name: "Chicago Bears", league: "nfl", hex: ["#0b162a", "#c83803"] },
  { name: "Cincinnati Bengals", league: "nfl", hex: ["#000000", "#fb4f14"] },
  { name: "Cleveland Browns", league: "nfl", hex: ["#fb4f14", "#22150c", "#a5acaf"] },
  { name: "Dallas Cowboys", league: "nfl", hex: ["#002244", "#b0b7bc", "#acc0c6", "#a5acaf", "#00338d", "#000000"] },
  { name: "Denver Broncos", league: "nfl", hex: ["#002244", "#fb4f14"] },
  { name: "Detroit Lions", league: "nfl", hex: ["#005a8b", "#b0b7bc", "#000000"] },
  { name: "Green Bay Packers", league: "nfl", hex: ["#203731", "#ffb612"] },
  { name: "Houston Texans", league: "nfl", hex: ["#03202f", "#a71930"] },
  { name: "Indianapolis Colts", league: "nfl", hex: ["#002c5f", "#a5acaf"] },
  { name: "Jacksonville Jaguars", league: "nfl", hex: ["#000000", "#006778", "#9f792c", "#d7a22a"] },
  { name: "Kansas City Chiefs", league: "nfl", hex: ["#e31837", "#ffb612", "#000000"] },
  { name: "Los Angeles Chargers", league: "nfl", hex: ["#002244", "#0073cf", "#ffb612"] },
  { name: "Los Angeles Rams", league: "nfl", hex: ["#002244", "#b3995d"] },
  { name: "Miami Dolphins", league: "nfl", hex: ["#008e97", "#f58220", "#005778"] },
  { name: "Minnesota Vikings", league: "nfl", hex: ["#4f2683", "#ffc62f", "#e9bf9b", "#000000"] },
  { name: "New England Patriots", league: "nfl", hex: ["#002244", "#c60c30", "#b0b7bc"] },
  { name: "New Orleans Saints", league: "nfl", hex: ["#9f8958", "#000000"] },
  { name: "New York Giants", league: "nfl", hex: ["#0b2265", "#a71930", "#a5acaf"] },
  { name: "New York Jets", league: "nfl", hex: ["#203731"] },
  { name: "Oakland Raiders", league: "nfl", hex: ["#a5acaf", "#000000"] },
  { name: "Philadelphia Eagles", league: "nfl", hex: ["#004953", "#a5acaf", "#acc0c6", "#000000", "#565a5c"] },
  { name: "Pittsburgh Steelers", league: "nfl", hex: ["#000000", "#ffb612", "#c60c30", "#00539b", "#a5acaf"] },
  { name: "San Francisco 49ers", league: "nfl", hex: ["#aa0000", "#b3995d", "#000000", "#a5acaf"] },
  { name: "Seattle Seahawks", league: "nfl", hex: ["#002244", "#69be28", "#a5acaf"] },
  { name: "Tampa Bay Buccaneers", league: "nfl", hex: ["#d50a0a", "#34302b", "#000000", "#ff7900", "#b1babf"] },
  { name: "Tennessee Titans", league: "nfl", hex: ["#002244", "#4b92db", "#c60c30", "#a5acaf"] },
  { name: "Washington Commanders", league: "nfl", hex: ["#773141", "#ffb612", "#000000", "#5a1414"] },
  { name: "Anaheim Ducks", league: "nhl", hex: ["#010101", "#a2aaad", "#fc4c02", "#85714d"] },
  { name: "Arizona Coyotes", league: "nhl", hex: ["#010101", "#862633", "#ddcba4"] },
  { name: "Boston Bruins", league: "nhl", hex: ["#010101", "#ffb81c"] },
  { name: "Buffalo Sabres", league: "nhl", hex: ["#041e42", "#a2aaad", "#ffb81c", "#c8102e"] },
  { name: "Calgary Flames", league: "nhl", hex: ["#010101", "#f1be48", "#c8102e"] },
  { name: "Carolina Hurricanes", league: "nhl", hex: ["#010101", "#a2aaad", "#c8102e"] },
  { name: "Chicago Blackhawks", league: "nhl", hex: ["#010101", "#ff671f", "#ffd100", "#001871", "#c8102e", "#00843d", "#cc8a00"] },
  { name: "Colorado Avalanche", league: "nhl", hex: ["#010101", "#236192", "#a4a9ad", "#6f263d"] },
  { name: "Columbus Blue Jackets", league: "nhl", hex: ["#041e42", "#a4a9ad", "#c8102e"] },
  { name: "Dallas Stars", league: "nhl", hex: ["#010101", "#006341", "#8a8d8f"] },
  { name: "Detroit Red Wings", league: "nhl", hex: ["#c8102e"] },
  { name: "Edmonton Oilers", league: "nhl", hex: ["#00205b", "#cf4520"] },
  { name: "Florida Panthers", league: "nhl", hex: ["#041e42", "#b9975b", "#c8102e"] },
  { name: "Los Angeles Kings", league: "nhl", hex: ["#010101", "#a2aaad"] },
  { name: "Minnesota Wild", league: "nhl", hex: ["#154734", "#ddcba4", "#eaaa00", "#a6192e"] },
  { name: "Montreal Canadiens", league: "nhl", hex: ["#001e62", "#a6192e"] },
  { name: "Nashville Predators", league: "nhl", hex: ["#041e42", "#ffb81c"] },
  { name: "New Jersey Devils", league: "nhl", hex: ["#010101", "#c8102e"] },
  { name: "New York Islanders", league: "nhl", hex: ["#003087", "#fc4c02"] },
  { name: "New York Rangers", league: "nhl", hex: ["#0033a0", "#c8102e"] },
  { name: "Ottawa Senators", league: "nhl", hex: ["#010101", "#c8102e", "#c69214"] },
  { name: "Philadelphia Flyers", league: "nhl", hex: ["#010101", "#fa4616"] },
  { name: "Pittsburgh Penguins", league: "nhl", hex: ["#010101", "#ffb81c"] },
  { name: "San Jose Sharks", league: "nhl", hex: ["#010101", "#e57200", "#006272"] },
  { name: "St Louis Blues", league: "nhl", hex: ["#041e42", "#ffb81c", "#003087"] },
  { name: "Tampa Bay Lightning", league: "nhl", hex: ["#00205b"] },
  { name: "Toronto Maple Leafs", league: "nhl", hex: ["#00205b"] },
  { name: "Vancouver Canucks", league: "nhl", hex: ["#00205b", "#97999b", "#041c2c"] },
  { name: "Vegas Golden Knights", league: "nhl", hex: ["#010101", "#b4975a", "#333f42"] },
  { name: "Washington Capitals", league: "nhl", hex: ["#041e42", "#a2aaad", "#782f40", "#a6192e", "#53565a"] },
  { name: "Winnipeg Jets", league: "nhl", hex: ["#041e42", "#c8102e"] },
];


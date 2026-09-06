/**
 * NEO-254 — what an nflverse team code MEANT in a given season.
 *
 * ## Why a hand-curated table and not a lookup
 *
 * nflverse's rosters cover 1920-2026 and carry a bare team code per row. Only
 * 36 of the 86 codes appear in `teams_colors_logos.csv`; the other 50 are
 * historical, and several codes were REUSED by unrelated franchises:
 *
 *   BOS   Bulldogs 1929 · Braves 1932 · Redskins 1933-36 · Yanks 1944-48 · Patriots 1960-70
 *   CHR   Chicago Rockets (AAFC) 1946-48 · Los Angeles Chargers (AFL) 1960
 *   DAL   Dallas Texans (NFL) 1952 · Dallas Cowboys 1963-
 *   NY    New York Brickley Giants 1921 · New York Giants 1925-59
 *   STL   All-Stars 1923 · Gunners 1934 · Cardinals 1960-87 · Rams 1995-2001
 *   HOU   Oilers 1960-96 · Texans 2016-
 *   CLE   Tigers · Indians · Bulldogs · Rams · Browns
 *
 * A code alone therefore identifies nothing. The pair (code, season) does, and
 * that is what this table maps — curated against Pro Football Reference's
 * franchise histories and spot-checked against the roster rows themselves
 * (the 1960 CHR roster is Dick Harris and Charlie McNeil, LA Chargers DBs;
 * the 1921 NY roster is Harrie Dadmun of the Brickley Giants; DAL 1952 is Dick
 * McKissack of the Texans).
 *
 * ## Coverage is ENFORCED, not trusted
 *
 * `resolveNflTeamEra` returns null for an unresolved pair, and both the
 * generator and a unit test walk every (code, season) in the rosters and fail
 * on any null or any pair matching more than one era. A missing 2027 season or
 * a newly-added historical club is a failed build, not a mislabelled player.
 *
 * ## League boundaries split an era
 *
 * A team that carried one name across the APFA→NFL rename (1922) or the
 * AFL/AAFC merger gets one era per league, so a 1965 Bills stint records the
 * AFL and a 1975 one the NFL. The generator then merges eras that share a NAME
 * into a single NB team row — NB dedupes teams by name, so "Buffalo Bills" is
 * one row — taking the league of whichever era ran longest.
 *
 * ## The names are historical fact, including the uncomfortable ones
 *
 * "Boston Redskins" (1933-36) and "Washington Redskins" (1937-2019) are what
 * the cards of those years say, and a collector searching for one needs the
 * row to exist. They are recorded as history alongside "Washington Football
 * Team" and "Washington Commanders", not used as anything's current name.
 *
 * Product invariant: this is initial input at creation. Nothing downstream
 * keys behaviour on an era, a code, or a league string.
 */

/** The leagues nflverse's rosters span. */
export type NflLeagueCode = "APFA" | "NFL" | "AAFC" | "AFL";

export interface NflTeamEra {
  /** nflverse `team` code as it appears in the roster rows. */
  code: string;
  /** First season this code meant this team in this league. */
  from: number;
  /**
   * Last season, or `null` while the era is still current. `null` is what
   * makes the table survive next season's roster file without an edit, and it
   * is what the generator turns into an absent `to` on the team row.
   */
  to: number | null;
  /** Empty for a name with no place in it ("Card-Pitt", "Oorang Indians"). */
  location: string;
  nickname: string;
  league: NflLeagueCode;
  /** Slug linking relocations/renames of one franchise. Informational. */
  franchise: string;
}

/** `location` and `nickname` joined the way the team row spells it. */
export function nflEraTeamName(era: NflTeamEra): string {
  return era.location ? `${era.location} ${era.nickname}` : era.nickname;
}

/**
 * Every (code, season) span in the nflverse rosters, 1920-2026.
 *
 * Ordered by code then season so a human can audit it against PFR a code at a
 * time. Spans may leave gaps (Canton sat out 1924); a gap is fine as long as
 * no roster row falls in it, which is what the coverage check proves.
 */
export const NFL_TEAM_ERAS: readonly NflTeamEra[] = [
  // Akron — Pros through 1925, Indians for their last season.
  { code: "AKR", from: 1920, to: 1921, location: "Akron", nickname: "Pros", league: "APFA", franchise: "akron-pros" },
  { code: "AKR", from: 1922, to: 1925, location: "Akron", nickname: "Pros", league: "NFL", franchise: "akron-pros" },
  { code: "AKR", from: 1926, to: 1926, location: "Akron", nickname: "Indians", league: "NFL", franchise: "akron-pros" },

  // Cardinals: Chicago 1920-59 → St. Louis 1960-87 → Phoenix → Arizona.
  // ARZ is the 2002-2015 alternate code for the same rows.
  { code: "ARI", from: 1994, to: 2001, location: "Arizona", nickname: "Cardinals", league: "NFL", franchise: "cardinals" },
  { code: "ARI", from: 2016, to: null, location: "Arizona", nickname: "Cardinals", league: "NFL", franchise: "cardinals" },
  { code: "ARZ", from: 2002, to: 2015, location: "Arizona", nickname: "Cardinals", league: "NFL", franchise: "cardinals" },

  { code: "ATL", from: 1966, to: null, location: "Atlanta", nickname: "Falcons", league: "NFL", franchise: "falcons" },

  // BAL is two unrelated franchises plus the Ravens.
  // 1947-50: the AAFC Baltimore Colts, who joined the NFL for 1950 and folded.
  // 1953-83: the Colts NB knows, from the Dallas Texans (see DAL 1952).
  // They share a NAME, so NB has one "Baltimore Colts" row; `franchise` below
  // records the longer-lived line and the generator reports the disagreement.
  { code: "BAL", from: 1947, to: 1949, location: "Baltimore", nickname: "Colts", league: "AAFC", franchise: "baltimore-colts-aafc" },
  { code: "BAL", from: 1950, to: 1950, location: "Baltimore", nickname: "Colts", league: "NFL", franchise: "baltimore-colts-aafc" },
  { code: "BAL", from: 1953, to: 1983, location: "Baltimore", nickname: "Colts", league: "NFL", franchise: "colts" },
  { code: "BAL", from: 1996, to: 2001, location: "Baltimore", nickname: "Ravens", league: "NFL", franchise: "ravens" },
  { code: "BAL", from: 2016, to: null, location: "Baltimore", nickname: "Ravens", league: "NFL", franchise: "ravens" },
  { code: "BLT", from: 2002, to: 2015, location: "Baltimore", nickname: "Ravens", league: "NFL", franchise: "ravens" },

  // Boston, four different franchises across four decades.
  { code: "BOS", from: 1929, to: 1929, location: "Boston", nickname: "Bulldogs", league: "NFL", franchise: "boston-bulldogs" },
  { code: "BOS", from: 1932, to: 1932, location: "Boston", nickname: "Braves", league: "NFL", franchise: "commanders" },
  { code: "BOS", from: 1933, to: 1936, location: "Boston", nickname: "Redskins", league: "NFL", franchise: "commanders" },
  { code: "BOS", from: 1944, to: 1948, location: "Boston", nickname: "Yanks", league: "NFL", franchise: "colts" },
  { code: "BOS", from: 1960, to: 1969, location: "Boston", nickname: "Patriots", league: "AFL", franchise: "patriots" },
  { code: "BOS", from: 1970, to: 1970, location: "Boston", nickname: "Patriots", league: "NFL", franchise: "patriots" },

  // Brooklyn: the 1926 Lions, the NFL Dodgers (ex-Dayton Triangles) who became
  // the Tigers for their last year, and the unrelated AAFC Dodgers.
  { code: "BRK", from: 1926, to: 1926, location: "Brooklyn", nickname: "Lions", league: "NFL", franchise: "brooklyn-lions" },
  { code: "BRK", from: 1930, to: 1943, location: "Brooklyn", nickname: "Dodgers", league: "NFL", franchise: "brooklyn-dodgers" },
  { code: "BRK", from: 1944, to: 1944, location: "Brooklyn", nickname: "Tigers", league: "NFL", franchise: "brooklyn-dodgers" },
  { code: "BRK", from: 1946, to: 1948, location: "Brooklyn", nickname: "Dodgers", league: "AAFC", franchise: "brooklyn-dodgers-aafc" },

  // Buffalo: All-Americans → Bisons → Rangers → Bisons (one franchise), then
  // the AAFC club that renamed itself the Bills in 1947, then the AFL Bills.
  { code: "BUF", from: 1920, to: 1921, location: "Buffalo", nickname: "All-Americans", league: "APFA", franchise: "buffalo-bisons" },
  { code: "BUF", from: 1922, to: 1923, location: "Buffalo", nickname: "All-Americans", league: "NFL", franchise: "buffalo-bisons" },
  { code: "BUF", from: 1924, to: 1925, location: "Buffalo", nickname: "Bisons", league: "NFL", franchise: "buffalo-bisons" },
  { code: "BUF", from: 1926, to: 1926, location: "Buffalo", nickname: "Rangers", league: "NFL", franchise: "buffalo-bisons" },
  { code: "BUF", from: 1927, to: 1927, location: "Buffalo", nickname: "Bisons", league: "NFL", franchise: "buffalo-bisons" },
  { code: "BUF", from: 1929, to: 1929, location: "Buffalo", nickname: "Bisons", league: "NFL", franchise: "buffalo-bisons" },
  { code: "BUF", from: 1946, to: 1946, location: "Buffalo", nickname: "Bisons", league: "AAFC", franchise: "buffalo-bills-aafc" },
  { code: "BUF", from: 1947, to: 1949, location: "Buffalo", nickname: "Bills", league: "AAFC", franchise: "buffalo-bills-aafc" },
  { code: "BUF", from: 1960, to: 1969, location: "Buffalo", nickname: "Bills", league: "AFL", franchise: "bills" },
  { code: "BUF", from: 1970, to: null, location: "Buffalo", nickname: "Bills", league: "NFL", franchise: "bills" },

  // The two wartime mergers. Both carry no city of their own.
  { code: "C-P", from: 1944, to: 1944, location: "", nickname: "Card-Pitt", league: "NFL", franchise: "card-pitt" },
  { code: "P-P", from: 1943, to: 1943, location: "", nickname: "Phil-Pitt", league: "NFL", franchise: "phil-pitt" },

  { code: "CAN", from: 1920, to: 1921, location: "Canton", nickname: "Bulldogs", league: "APFA", franchise: "canton-bulldogs" },
  { code: "CAN", from: 1922, to: 1923, location: "Canton", nickname: "Bulldogs", league: "NFL", franchise: "canton-bulldogs" },
  { code: "CAN", from: 1925, to: 1926, location: "Canton", nickname: "Bulldogs", league: "NFL", franchise: "canton-bulldogs" },

  { code: "CAR", from: 1995, to: null, location: "Carolina", nickname: "Panthers", league: "NFL", franchise: "panthers" },

  // Bears: Decatur Staleys 1920 → Chicago Staleys 1921 → Bears 1922-.
  { code: "DEC", from: 1920, to: 1920, location: "Decatur", nickname: "Staleys", league: "APFA", franchise: "bears" },
  { code: "CHS", from: 1921, to: 1921, location: "Chicago", nickname: "Staleys", league: "APFA", franchise: "bears" },
  { code: "CHB", from: 1922, to: 1959, location: "Chicago", nickname: "Bears", league: "NFL", franchise: "bears" },
  { code: "CHI", from: 1960, to: null, location: "Chicago", nickname: "Bears", league: "NFL", franchise: "bears" },

  { code: "CHC", from: 1920, to: 1921, location: "Chicago", nickname: "Cardinals", league: "APFA", franchise: "cardinals" },
  { code: "CHC", from: 1922, to: 1943, location: "Chicago", nickname: "Cardinals", league: "NFL", franchise: "cardinals" },
  { code: "CHC", from: 1945, to: 1959, location: "Chicago", nickname: "Cardinals", league: "NFL", franchise: "cardinals" },

  // CHR is the collision: the AAFC Rockets, then the 1960 AFL Chargers.
  { code: "CHR", from: 1946, to: 1948, location: "Chicago", nickname: "Rockets", league: "AAFC", franchise: "chicago-rockets" },
  { code: "CHH", from: 1949, to: 1949, location: "Chicago", nickname: "Hornets", league: "AAFC", franchise: "chicago-rockets" },
  { code: "CHR", from: 1960, to: 1960, location: "Los Angeles", nickname: "Chargers", league: "AFL", franchise: "chargers" },
  { code: "SD", from: 1961, to: 1969, location: "San Diego", nickname: "Chargers", league: "AFL", franchise: "chargers" },
  { code: "SD", from: 1970, to: 2016, location: "San Diego", nickname: "Chargers", league: "NFL", franchise: "chargers" },
  { code: "LAC", from: 2017, to: null, location: "Los Angeles", nickname: "Chargers", league: "NFL", franchise: "chargers" },

  { code: "CHT", from: 1920, to: 1920, location: "Chicago", nickname: "Tigers", league: "APFA", franchise: "chicago-tigers" },

  { code: "CIN", from: 1921, to: 1921, location: "Cincinnati", nickname: "Celts", league: "APFA", franchise: "cincinnati-celts" },
  { code: "CIN", from: 1933, to: 1934, location: "Cincinnati", nickname: "Reds", league: "NFL", franchise: "cincinnati-reds-nfl" },
  { code: "CIN", from: 1968, to: 1969, location: "Cincinnati", nickname: "Bengals", league: "AFL", franchise: "bengals" },
  { code: "CIN", from: 1970, to: null, location: "Cincinnati", nickname: "Bengals", league: "NFL", franchise: "bengals" },

  // Cleveland, five franchises. The 1923 Indians renamed to Bulldogs in 1924
  // after buying the Canton roster; the 1931 Indians are a different club.
  { code: "CLE", from: 1920, to: 1921, location: "Cleveland", nickname: "Tigers", league: "APFA", franchise: "cleveland-tigers" },
  { code: "CLE", from: 1923, to: 1923, location: "Cleveland", nickname: "Indians", league: "NFL", franchise: "cleveland-bulldogs" },
  { code: "CLE", from: 1924, to: 1925, location: "Cleveland", nickname: "Bulldogs", league: "NFL", franchise: "cleveland-bulldogs" },
  { code: "CLE", from: 1927, to: 1927, location: "Cleveland", nickname: "Bulldogs", league: "NFL", franchise: "cleveland-bulldogs" },
  { code: "CLE", from: 1931, to: 1931, location: "Cleveland", nickname: "Indians", league: "NFL", franchise: "cleveland-indians-1931" },
  { code: "CLE", from: 1937, to: 1942, location: "Cleveland", nickname: "Rams", league: "NFL", franchise: "rams" },
  { code: "CLE", from: 1944, to: 1945, location: "Cleveland", nickname: "Rams", league: "NFL", franchise: "rams" },
  { code: "CLE", from: 1946, to: 1949, location: "Cleveland", nickname: "Browns", league: "AAFC", franchise: "browns" },
  { code: "CLE", from: 1950, to: 1995, location: "Cleveland", nickname: "Browns", league: "NFL", franchise: "browns" },
  { code: "CLE", from: 1999, to: 2001, location: "Cleveland", nickname: "Browns", league: "NFL", franchise: "browns" },
  { code: "CLE", from: 2016, to: null, location: "Cleveland", nickname: "Browns", league: "NFL", franchise: "browns" },
  { code: "CLV", from: 2002, to: 2015, location: "Cleveland", nickname: "Browns", league: "NFL", franchise: "browns" },

  { code: "COL", from: 1920, to: 1921, location: "Columbus", nickname: "Panhandles", league: "APFA", franchise: "columbus-tigers" },
  { code: "COL", from: 1922, to: 1922, location: "Columbus", nickname: "Panhandles", league: "NFL", franchise: "columbus-tigers" },
  { code: "COL", from: 1923, to: 1926, location: "Columbus", nickname: "Tigers", league: "NFL", franchise: "columbus-tigers" },

  // Cowboys 1960-62 under COW, then DAL. DAL 1952 is the unrelated NFL Texans.
  { code: "COW", from: 1960, to: 1962, location: "Dallas", nickname: "Cowboys", league: "NFL", franchise: "cowboys" },
  { code: "DAL", from: 1952, to: 1952, location: "Dallas", nickname: "Texans", league: "NFL", franchise: "colts" },
  { code: "DAL", from: 1963, to: null, location: "Dallas", nickname: "Cowboys", league: "NFL", franchise: "cowboys" },

  // Dayton Triangles moved to Brooklyn for 1930 — same franchise as BRK above.
  { code: "DAY", from: 1920, to: 1921, location: "Dayton", nickname: "Triangles", league: "APFA", franchise: "brooklyn-dodgers" },
  { code: "DAY", from: 1922, to: 1929, location: "Dayton", nickname: "Triangles", league: "NFL", franchise: "brooklyn-dodgers" },

  { code: "DEN", from: 1960, to: 1969, location: "Denver", nickname: "Broncos", league: "AFL", franchise: "broncos" },
  { code: "DEN", from: 1970, to: null, location: "Denver", nickname: "Broncos", league: "NFL", franchise: "broncos" },

  // Four unrelated Detroit clubs before the Lions arrived from Portsmouth.
  { code: "DET", from: 1920, to: 1920, location: "Detroit", nickname: "Heralds", league: "APFA", franchise: "detroit-heralds" },
  { code: "DET", from: 1921, to: 1921, location: "Detroit", nickname: "Tigers", league: "APFA", franchise: "detroit-tigers-nfl" },
  { code: "DET", from: 1925, to: 1926, location: "Detroit", nickname: "Panthers", league: "NFL", franchise: "detroit-panthers" },
  { code: "DET", from: 1928, to: 1928, location: "Detroit", nickname: "Wolverines", league: "NFL", franchise: "detroit-wolverines" },
  { code: "POR", from: 1930, to: 1933, location: "Portsmouth", nickname: "Spartans", league: "NFL", franchise: "lions" },
  { code: "DET", from: 1934, to: null, location: "Detroit", nickname: "Lions", league: "NFL", franchise: "lions" },

  { code: "DON", from: 1946, to: 1949, location: "Los Angeles", nickname: "Dons", league: "AAFC", franchise: "la-dons" },

  { code: "DUL", from: 1923, to: 1925, location: "Duluth", nickname: "Kelleys", league: "NFL", franchise: "duluth-eskimos" },
  { code: "DUL", from: 1926, to: 1927, location: "Duluth", nickname: "Eskimos", league: "NFL", franchise: "duluth-eskimos" },

  { code: "ECG", from: 1921, to: 1921, location: "Evansville", nickname: "Crimson Giants", league: "APFA", franchise: "evansville-crimson-giants" },
  { code: "ECG", from: 1922, to: 1922, location: "Evansville", nickname: "Crimson Giants", league: "NFL", franchise: "evansville-crimson-giants" },

  { code: "FYJ", from: 1924, to: 1931, location: "Frankford", nickname: "Yellow Jackets", league: "NFL", franchise: "frankford-yellow-jackets" },

  { code: "GB", from: 1921, to: 1921, location: "Green Bay", nickname: "Packers", league: "APFA", franchise: "packers" },
  { code: "GB", from: 1922, to: null, location: "Green Bay", nickname: "Packers", league: "NFL", franchise: "packers" },

  { code: "HAM", from: 1920, to: 1921, location: "Hammond", nickname: "Pros", league: "APFA", franchise: "hammond-pros" },
  { code: "HAM", from: 1922, to: 1926, location: "Hammond", nickname: "Pros", league: "NFL", franchise: "hammond-pros" },

  { code: "HAR", from: 1926, to: 1926, location: "Hartford", nickname: "Blues", league: "NFL", franchise: "hartford-blues" },

  // HOU is the Oilers until they leave for Tennessee, then the expansion Texans.
  { code: "HOU", from: 1960, to: 1969, location: "Houston", nickname: "Oilers", league: "AFL", franchise: "oilers" },
  { code: "HOU", from: 1970, to: 1996, location: "Houston", nickname: "Oilers", league: "NFL", franchise: "oilers" },
  { code: "TEN", from: 1997, to: 1998, location: "Tennessee", nickname: "Oilers", league: "NFL", franchise: "oilers" },
  { code: "TEN", from: 1999, to: null, location: "Tennessee", nickname: "Titans", league: "NFL", franchise: "oilers" },
  { code: "HOU", from: 2016, to: null, location: "Houston", nickname: "Texans", league: "NFL", franchise: "texans" },
  { code: "HST", from: 2002, to: 2015, location: "Houston", nickname: "Texans", league: "NFL", franchise: "texans" },

  { code: "IND", from: 1984, to: null, location: "Indianapolis", nickname: "Colts", league: "NFL", franchise: "colts" },

  { code: "JAX", from: 1995, to: null, location: "Jacksonville", nickname: "Jaguars", league: "NFL", franchise: "jaguars" },

  // KC 1924-26 is the Blues/Cowboys, nothing to do with the Chiefs.
  { code: "KC", from: 1924, to: 1924, location: "Kansas City", nickname: "Blues", league: "NFL", franchise: "kansas-city-cowboys" },
  { code: "KC", from: 1925, to: 1926, location: "Kansas City", nickname: "Cowboys", league: "NFL", franchise: "kansas-city-cowboys" },
  { code: "TEX", from: 1960, to: 1962, location: "Dallas", nickname: "Texans", league: "AFL", franchise: "chiefs" },
  { code: "KC", from: 1963, to: 1969, location: "Kansas City", nickname: "Chiefs", league: "AFL", franchise: "chiefs" },
  { code: "KC", from: 1970, to: null, location: "Kansas City", nickname: "Chiefs", league: "NFL", franchise: "chiefs" },

  { code: "KEN", from: 1924, to: 1924, location: "Kenosha", nickname: "Maroons", league: "NFL", franchise: "kenosha-maroons" },

  // Rams: Cleveland 1937-45 (see CLE) → LA → St. Louis → LA. RAM and LA are
  // both used for Los Angeles depending on the season file; SL/STL for
  // St. Louis.
  { code: "LA", from: 1926, to: 1926, location: "Los Angeles", nickname: "Buccaneers", league: "NFL", franchise: "la-buccaneers" },
  { code: "RAM", from: 1946, to: 1949, location: "Los Angeles", nickname: "Rams", league: "NFL", franchise: "rams" },
  { code: "LA", from: 1950, to: 1959, location: "Los Angeles", nickname: "Rams", league: "NFL", franchise: "rams" },
  { code: "RAM", from: 1960, to: 1960, location: "Los Angeles", nickname: "Rams", league: "NFL", franchise: "rams" },
  { code: "LA", from: 1961, to: 1981, location: "Los Angeles", nickname: "Rams", league: "NFL", franchise: "rams" },
  { code: "RAM", from: 1982, to: 1994, location: "Los Angeles", nickname: "Rams", league: "NFL", franchise: "rams" },
  { code: "STL", from: 1995, to: 2001, location: "St. Louis", nickname: "Rams", league: "NFL", franchise: "rams" },
  { code: "SL", from: 2002, to: 2015, location: "St. Louis", nickname: "Rams", league: "NFL", franchise: "rams" },
  { code: "LA", from: 2016, to: null, location: "Los Angeles", nickname: "Rams", league: "NFL", franchise: "rams" },

  { code: "LOU", from: 1921, to: 1921, location: "Louisville", nickname: "Brecks", league: "APFA", franchise: "louisville-brecks" },
  { code: "LOU", from: 1922, to: 1923, location: "Louisville", nickname: "Brecks", league: "NFL", franchise: "louisville-brecks" },
  { code: "LOU", from: 1926, to: 1926, location: "Louisville", nickname: "Colonels", league: "NFL", franchise: "louisville-colonels" },

  { code: "MIA", from: 1946, to: 1946, location: "Miami", nickname: "Seahawks", league: "AAFC", franchise: "miami-seahawks" },
  { code: "MIA", from: 1966, to: 1969, location: "Miami", nickname: "Dolphins", league: "AFL", franchise: "dolphins" },
  { code: "MIA", from: 1970, to: null, location: "Miami", nickname: "Dolphins", league: "NFL", franchise: "dolphins" },

  { code: "MIL", from: 1922, to: 1926, location: "Milwaukee", nickname: "Badgers", league: "NFL", franchise: "milwaukee-badgers" },

  { code: "MIN", from: 1921, to: 1921, location: "Minneapolis", nickname: "Marines", league: "APFA", franchise: "minneapolis-marines" },
  { code: "MIN", from: 1922, to: 1924, location: "Minneapolis", nickname: "Marines", league: "NFL", franchise: "minneapolis-marines" },
  { code: "MIN", from: 1929, to: 1930, location: "Minneapolis", nickname: "Red Jackets", league: "NFL", franchise: "minneapolis-marines" },
  { code: "MIN", from: 1961, to: null, location: "Minnesota", nickname: "Vikings", league: "NFL", franchise: "vikings" },

  { code: "MUN", from: 1920, to: 1921, location: "Muncie", nickname: "Flyers", league: "APFA", franchise: "muncie-flyers" },

  { code: "NE", from: 1971, to: null, location: "New England", nickname: "Patriots", league: "NFL", franchise: "patriots" },

  { code: "NO", from: 1967, to: null, location: "New Orleans", nickname: "Saints", league: "NFL", franchise: "saints" },

  // NY 1921 is the one-season Brickley Giants, not the Giants.
  { code: "NY", from: 1921, to: 1921, location: "New York", nickname: "Brickley Giants", league: "APFA", franchise: "brickley-giants" },
  { code: "NY", from: 1925, to: 1926, location: "New York", nickname: "Giants", league: "NFL", franchise: "giants" },
  { code: "NYG", from: 1927, to: 1928, location: "New York", nickname: "Giants", league: "NFL", franchise: "giants" },
  { code: "NY", from: 1929, to: 1945, location: "New York", nickname: "Giants", league: "NFL", franchise: "giants" },
  { code: "NYG", from: 1946, to: 1951, location: "New York", nickname: "Giants", league: "NFL", franchise: "giants" },
  { code: "NY", from: 1952, to: 1959, location: "New York", nickname: "Giants", league: "NFL", franchise: "giants" },
  { code: "NYG", from: 1960, to: null, location: "New York", nickname: "Giants", league: "NFL", franchise: "giants" },

  // The Boston Yanks line: Yanks → Bulldogs → Yanks → Dallas Texans → Colts.
  { code: "NYB", from: 1949, to: 1949, location: "New York", nickname: "Bulldogs", league: "NFL", franchise: "colts" },
  { code: "NYY", from: 1950, to: 1951, location: "New York", nickname: "Yanks", league: "NFL", franchise: "colts" },
  // …and the two unrelated clubs called the Yankees.
  { code: "NYY", from: 1927, to: 1928, location: "New York", nickname: "Yankees", league: "NFL", franchise: "ny-yankees-nfl" },
  { code: "NYY", from: 1946, to: 1949, location: "New York", nickname: "Yankees", league: "AAFC", franchise: "ny-yankees-aafc" },

  { code: "NYT", from: 1960, to: 1962, location: "New York", nickname: "Titans", league: "AFL", franchise: "jets" },
  { code: "NYJ", from: 1963, to: 1969, location: "New York", nickname: "Jets", league: "AFL", franchise: "jets" },
  { code: "NYJ", from: 1970, to: null, location: "New York", nickname: "Jets", league: "NFL", franchise: "jets" },

  // Based in LaRue, Ohio, but never called anything but the Oorang Indians.
  { code: "OOR", from: 1922, to: 1923, location: "", nickname: "Oorang Indians", league: "NFL", franchise: "oorang-indians" },

  { code: "ORG", from: 1929, to: 1929, location: "Orange", nickname: "Tornadoes", league: "NFL", franchise: "orange-tornadoes" },
  { code: "NEW", from: 1930, to: 1930, location: "Newark", nickname: "Tornadoes", league: "NFL", franchise: "orange-tornadoes" },

  { code: "PHI", from: 1933, to: 1942, location: "Philadelphia", nickname: "Eagles", league: "NFL", franchise: "eagles" },
  { code: "PHI", from: 1944, to: null, location: "Philadelphia", nickname: "Eagles", league: "NFL", franchise: "eagles" },

  { code: "PHO", from: 1988, to: 1993, location: "Phoenix", nickname: "Cardinals", league: "NFL", franchise: "cardinals" },

  // The Pittsburgh franchise was the Pirates until the 1940 rename.
  { code: "PIT", from: 1933, to: 1939, location: "Pittsburgh", nickname: "Pirates", league: "NFL", franchise: "steelers" },
  { code: "PIT", from: 1940, to: 1942, location: "Pittsburgh", nickname: "Steelers", league: "NFL", franchise: "steelers" },
  { code: "PIT", from: 1945, to: null, location: "Pittsburgh", nickname: "Steelers", league: "NFL", franchise: "steelers" },

  { code: "POT", from: 1925, to: 1928, location: "Pottsville", nickname: "Maroons", league: "NFL", franchise: "pottsville-maroons" },

  { code: "PRO", from: 1925, to: 1931, location: "Providence", nickname: "Steam Roller", league: "NFL", franchise: "providence-steam-roller" },

  { code: "RAC", from: 1922, to: 1924, location: "Racine", nickname: "Legion", league: "NFL", franchise: "racine-legion" },
  { code: "RAC", from: 1926, to: 1926, location: "Racine", nickname: "Tornadoes", league: "NFL", franchise: "racine-legion" },

  // Raiders: Oakland → Los Angeles (RAI) → Oakland → Las Vegas.
  { code: "OAK", from: 1960, to: 1969, location: "Oakland", nickname: "Raiders", league: "AFL", franchise: "raiders" },
  { code: "OAK", from: 1970, to: 1981, location: "Oakland", nickname: "Raiders", league: "NFL", franchise: "raiders" },
  { code: "RAI", from: 1982, to: 1994, location: "Los Angeles", nickname: "Raiders", league: "NFL", franchise: "raiders" },
  { code: "OAK", from: 1995, to: 2019, location: "Oakland", nickname: "Raiders", league: "NFL", franchise: "raiders" },
  { code: "LV", from: 2020, to: null, location: "Las Vegas", nickname: "Raiders", league: "NFL", franchise: "raiders" },

  { code: "RI", from: 1920, to: 1921, location: "Rock Island", nickname: "Independents", league: "APFA", franchise: "rock-island-independents" },
  { code: "RI", from: 1922, to: 1925, location: "Rock Island", nickname: "Independents", league: "NFL", franchise: "rock-island-independents" },

  { code: "ROC", from: 1920, to: 1921, location: "Rochester", nickname: "Jeffersons", league: "APFA", franchise: "rochester-jeffersons" },
  { code: "ROC", from: 1922, to: 1925, location: "Rochester", nickname: "Jeffersons", league: "NFL", franchise: "rochester-jeffersons" },

  { code: "SEA", from: 1976, to: null, location: "Seattle", nickname: "Seahawks", league: "NFL", franchise: "seahawks" },

  { code: "SF", from: 1946, to: 1949, location: "San Francisco", nickname: "49ers", league: "AAFC", franchise: "49ers" },
  { code: "SF", from: 1950, to: null, location: "San Francisco", nickname: "49ers", league: "NFL", franchise: "49ers" },

  { code: "SI", from: 1929, to: 1932, location: "Staten Island", nickname: "Stapletons", league: "NFL", franchise: "staten-island-stapletons" },

  { code: "STL", from: 1923, to: 1923, location: "St. Louis", nickname: "All-Stars", league: "NFL", franchise: "st-louis-all-stars" },
  { code: "STL", from: 1934, to: 1934, location: "St. Louis", nickname: "Gunners", league: "NFL", franchise: "st-louis-gunners" },
  { code: "STL", from: 1960, to: 1987, location: "St. Louis", nickname: "Cardinals", league: "NFL", franchise: "cardinals" },

  { code: "TB", from: 1976, to: null, location: "Tampa Bay", nickname: "Buccaneers", league: "NFL", franchise: "buccaneers" },

  { code: "TOL", from: 1922, to: 1923, location: "Toledo", nickname: "Maroons", league: "NFL", franchise: "toledo-maroons" },

  { code: "TON", from: 1921, to: 1921, location: "Tonawanda", nickname: "Kardex", league: "APFA", franchise: "tonawanda-kardex" },

  // WAS 1921 is the one-season Washington Senators, unrelated to what follows.
  { code: "WAS", from: 1921, to: 1921, location: "Washington", nickname: "Senators", league: "APFA", franchise: "washington-senators-nfl" },
  { code: "WAS", from: 1937, to: 2019, location: "Washington", nickname: "Redskins", league: "NFL", franchise: "commanders" },
  { code: "WAS", from: 2020, to: 2021, location: "Washington", nickname: "Football Team", league: "NFL", franchise: "commanders" },
  { code: "WAS", from: 2022, to: null, location: "Washington", nickname: "Commanders", league: "NFL", franchise: "commanders" },
];

/**
 * The era a (code, season) pair falls in, or `null` when the table does not
 * cover it.
 *
 * Returns null rather than guessing, and the caller is expected to fail: an
 * unresolved pair means a roster row whose team we do not know, and inventing
 * one would put real players on a made-up team.
 *
 * @throws when the pair matches MORE than one era — an overlap in the table
 * itself, which is a bug here rather than in the data.
 */
export function resolveNflTeamEra(
  code: string,
  season: number,
): NflTeamEra | null {
  const matches = NFL_TEAM_ERAS.filter(
    (era) =>
      era.code === code && season >= era.from && (era.to === null || season <= era.to),
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `NFL_TEAM_ERAS: ${code} ${season} matches ${matches.length} eras ` +
        `(${matches.map((m) => `${m.from}-${m.to ?? "…"} ${nflEraTeamName(m)}`).join("; ")}). ` +
        `The spans must not overlap.`,
    );
  }
  return matches[0];
}

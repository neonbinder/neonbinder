/**
 * NEO-350 — the fake catalog every collection prototype shares, and the
 * permanent collection demo (`../../final`) with them. It ships publicly on
 * `/binder-tracking`: keep it free of marketplace names and internal words.
 *
 * Six sets, about 300 cards. Long base checklists are generated from compact
 * `[number, player, team, flags]` lines; the cards a prototype is likely to
 * show off (Reggie White's run, Gordie Howe as a Whaler, the Ohtani rainbow,
 * the duplicate #13s) are written out deliberately below.
 *
 * Not NB's real data, and not limited to what NB holds today. Liveries are
 * the teams' real colours.
 */

import type {
  Brand,
  Card,
  CardFeature,
  CardSet,
  Finish,
  Player,
  SetVariant,
  Sport,
  SportId,
  Stint,
  Team,
  TeamId,
  VariantPath,
} from "./types";

export const sports: Sport[] = [
  { id: "baseball", name: "Baseball" },
  { id: "football", name: "Football" },
  { id: "hockey", name: "Hockey" },
];

export const brands: Brand[] = [
  { id: "brand-playoff", name: "Playoff" },
  { id: "brand-upper-deck", name: "Upper Deck" },
  { id: "brand-score", name: "Score" },
  { id: "brand-topps", name: "Topps" },
];

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

function team(
  id: TeamId,
  location: string,
  name: string,
  league: Team["league"],
  primary: string,
  secondary: string,
): Team {
  return { id, location, name, league, primary, secondary };
}

export const teams: Team[] = [
  // NFL
  team("packers", "Green Bay", "Packers", "NFL", "#203731", "#FFB612"),
  team("eagles", "Philadelphia", "Eagles", "NFL", "#004C54", "#A5ACAF"),
  team("panthers", "Carolina", "Panthers", "NFL", "#0085CA", "#101820"),
  team("cowboys", "Dallas", "Cowboys", "NFL", "#003594", "#869397"),
  team("49ers", "San Francisco", "49ers", "NFL", "#AA0000", "#B3995D"),
  team("steelers", "Pittsburgh", "Steelers", "NFL", "#FFB612", "#101820"),
  team("colts", "Indianapolis", "Colts", "NFL", "#002C5F", "#A2AAAD"),
  team("chiefs", "Kansas City", "Chiefs", "NFL", "#E31837", "#FFB81C"),
  team("bills", "Buffalo", "Bills", "NFL", "#00338D", "#C60C30"),
  team("texans", "Houston", "Texans", "NFL", "#03202F", "#A71930"),
  team("ravens", "Baltimore", "Ravens", "NFL", "#241773", "#9E7C0C"),
  team("bears", "Chicago", "Bears", "NFL", "#0B162A", "#C83803"),
  team("rams", "St. Louis", "Rams", "NFL", "#002244", "#B3995D"),
  team("vikings", "Minnesota", "Vikings", "NFL", "#4F2683", "#FFC62F"),
  team("lions", "Detroit", "Lions", "NFL", "#0076B6", "#B0B7BC"),
  team("bengals", "Cincinnati", "Bengals", "NFL", "#FB4F14", "#000000"),
  team("dolphins", "Miami", "Dolphins", "NFL", "#008E97", "#FC4C02"),
  team("broncos", "Denver", "Broncos", "NFL", "#FB4F14", "#002244"),
  team("seahawks", "Seattle", "Seahawks", "NFL", "#002244", "#69BE28"),
  team("titans", "Tennessee", "Titans", "NFL", "#0C2340", "#4B92DB"),
  team("patriots", "New England", "Patriots", "NFL", "#002244", "#C60C30"),
  team("jets", "New York", "Jets", "NFL", "#125740", "#FFFFFF"),
  team("browns", "Cleveland", "Browns", "NFL", "#311D00", "#FF3C00"),
  team("falcons", "Atlanta", "Falcons", "NFL", "#A71930", "#000000"),
  team("giants-nfl", "New York", "Giants", "NFL", "#0B2265", "#A71930"),
  team("cardinals-nfl", "Arizona", "Cardinals", "NFL", "#97233F", "#000000"),
  team("jaguars", "Jacksonville", "Jaguars", "NFL", "#006778", "#D7A22A"),
  team("commanders", "Washington", "Commanders", "NFL", "#5A1414", "#FFB612"),
  team("buccaneers", "Tampa Bay", "Buccaneers", "NFL", "#D50A0A", "#34302B"),
  // NCAA
  team("tennessee", "Tennessee", "Volunteers", "NCAA", "#FF8200", "#FFFFFF"),
  team("wisconsin", "Wisconsin", "Badgers", "NCAA", "#C5050C", "#FFFFFF"),
  team("nc-state", "NC State", "Wolfpack", "NCAA", "#CC0000", "#000000"),
  team("central-michigan", "Central Michigan", "Chippewas", "NCAA", "#6A0032", "#FFC82E"),
  team("michigan", "Michigan", "Wolverines", "NCAA", "#00274C", "#FFCB05"),
  team("lsu", "LSU", "Tigers", "NCAA", "#461D7C", "#FDD023"),
  team("southern-miss", "Southern Miss", "Golden Eagles", "NCAA", "#000000", "#FFAB00"),
  // NHL
  team("red-wings", "Detroit", "Red Wings", "NHL", "#CE1126", "#FFFFFF"),
  team("whalers", "Hartford", "Whalers", "NHL", "#00843D", "#00205B"),
  team("rangers-nhl", "New York", "Rangers", "NHL", "#0038A8", "#CE1126"),
  team("penguins", "Pittsburgh", "Penguins", "NHL", "#000000", "#FCB514"),
  team("avalanche", "Colorado", "Avalanche", "NHL", "#6F263D", "#236192"),
  team("flyers", "Philadelphia", "Flyers", "NHL", "#F74902", "#000000"),
  team("mighty-ducks", "Anaheim", "Mighty Ducks", "NHL", "#2E1A47", "#00857D"),
  team("devils", "New Jersey", "Devils", "NHL", "#CE1126", "#000000"),
  team("sabres", "Buffalo", "Sabres", "NHL", "#002654", "#FCB514"),
  team("blackhawks", "Chicago", "Blackhawks", "NHL", "#CF0A2C", "#000000"),
  team("bruins", "Boston", "Bruins", "NHL", "#FFB81C", "#000000"),
  team("canadiens", "Montreal", "Canadiens", "NHL", "#AF1E2D", "#192168"),
  team("maple-leafs", "Toronto", "Maple Leafs", "NHL", "#00205B", "#FFFFFF"),
  team("blues", "St. Louis", "Blues", "NHL", "#002F87", "#FCB514"),
  team("stars", "Dallas", "Stars", "NHL", "#006847", "#8F8F8C"),
  team("oilers", "Edmonton", "Oilers", "NHL", "#041E42", "#FF4C00"),
  team("kings", "Los Angeles", "Kings", "NHL", "#111111", "#A2AAAD"),
  team("capitals", "Washington", "Capitals", "NHL", "#041E42", "#C8102E"),
  team("canucks", "Vancouver", "Canucks", "NHL", "#00205B", "#00843D"),
  team("flames", "Calgary", "Flames", "NHL", "#C8102E", "#F1BE48"),
  // MLB
  team("giants-mlb", "San Francisco", "Giants", "MLB", "#FD5A1E", "#27251F"),
  team("mariners", "Seattle", "Mariners", "MLB", "#0C2C56", "#005C5C"),
  team("white-sox", "Chicago", "White Sox", "MLB", "#27251F", "#C4CED4"),
  team("rangers-mlb", "Texas", "Rangers", "MLB", "#003278", "#C0111F"),
  team("orioles", "Baltimore", "Orioles", "MLB", "#DF4601", "#000000"),
  team("twins", "Minnesota", "Twins", "MLB", "#002B5C", "#D31145"),
  team("padres", "San Diego", "Padres", "MLB", "#2F241D", "#FFC425"),
  team("dodgers", "Los Angeles", "Dodgers", "MLB", "#005A9C", "#EF3E42"),
  team("braves", "Atlanta", "Braves", "MLB", "#CE1141", "#13274F"),
  team("reds", "Cincinnati", "Reds", "MLB", "#C6011F", "#000000"),
  team("blue-jays", "Toronto", "Blue Jays", "MLB", "#134A8E", "#E8291C"),
  team("cubs", "Chicago", "Cubs", "MLB", "#0E3386", "#CC3433"),
  team("yankees", "New York", "Yankees", "MLB", "#0C2340", "#C4CED3"),
  team("royals", "Kansas City", "Royals", "MLB", "#004687", "#BD9B60"),
  team("brewers", "Milwaukee", "Brewers", "MLB", "#12284B", "#FFC52F"),
  team("cardinals-mlb", "St. Louis", "Cardinals", "MLB", "#C41E3A", "#0C2340"),
  team("astros", "Houston", "Astros", "MLB", "#002D62", "#EB6E1F"),
  team("athletics", "Oakland", "Athletics", "MLB", "#003831", "#EFB21E"),
  team("red-sox", "Boston", "Red Sox", "MLB", "#BD3039", "#0C2340"),
  team("indians", "Cleveland", "Indians", "MLB", "#0C2340", "#E31937"),
  team("guardians", "Cleveland", "Guardians", "MLB", "#00385D", "#E50022"),
  team("rockies", "Colorado", "Rockies", "MLB", "#33006F", "#C4CED4"),
  team("marlins", "Florida", "Marlins", "MLB", "#00A3E0", "#EF3340"),
  team("expos", "Montreal", "Expos", "MLB", "#003087", "#E4002B"),
  team("phillies", "Philadelphia", "Phillies", "MLB", "#E81828", "#002D72"),
  team("pirates", "Pittsburgh", "Pirates", "MLB", "#27251F", "#FDB827"),
  team("tigers-mlb", "Detroit", "Tigers", "MLB", "#0C2340", "#FA4616"),
  team("angels", "Los Angeles", "Angels", "MLB", "#BA0021", "#003263"),
  team("rays", "Tampa Bay", "Rays", "MLB", "#092C5C", "#8FBCE6"),
  team("diamondbacks", "Arizona", "Diamondbacks", "MLB", "#A71930", "#E3D4AD"),
  team("mets", "New York", "Mets", "MLB", "#002D72", "#FF5910"),
  // NPB: the sponsor leads the name (Team Location rule)
  team("fighters", "Hokkaido Nippon-Ham", "Fighters", "NPB", "#004B97", "#B19B51"),
];

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function s(teamId: TeamId, from: number, to: number | null): Stint {
  return { teamId, from, to };
}

/** Hand-written careers: the players a prototype is likely to drill into. */
const notablePlayers: Player[] = [
  {
    id: "reggie-white",
    name: "Reggie White",
    sport: "football",
    hallOfFame: true,
    stints: [
      s("tennessee", 1980, 1983),
      s("eagles", 1985, 1992),
      s("packers", 1993, 1998),
      s("panthers", 2000, 2000),
    ],
  },
  {
    id: "jj-watt",
    name: "J.J. Watt",
    sport: "football",
    hallOfFame: false,
    stints: [
      s("central-michigan", 2007, 2007),
      s("wisconsin", 2008, 2010),
      s("texans", 2011, 2020),
      s("cardinals-nfl", 2021, 2022),
    ],
  },
  {
    id: "tj-watt",
    name: "T.J. Watt",
    sport: "football",
    hallOfFame: false,
    stints: [s("wisconsin", 2013, 2016), s("steelers", 2017, null)],
  },
  {
    id: "jonathan-taylor",
    name: "Jonathan Taylor",
    sport: "football",
    hallOfFame: false,
    stints: [s("wisconsin", 2017, 2019), s("colts", 2020, null)],
  },
  {
    id: "russell-wilson",
    name: "Russell Wilson",
    sport: "football",
    hallOfFame: false,
    stints: [
      s("nc-state", 2008, 2010),
      s("wisconsin", 2011, 2011),
      s("seahawks", 2012, 2021),
      s("broncos", 2022, 2023),
      s("steelers", 2024, 2024),
      s("giants-nfl", 2025, null),
    ],
  },
  {
    id: "brett-favre",
    name: "Brett Favre",
    sport: "football",
    hallOfFame: true,
    stints: [
      s("southern-miss", 1987, 1990),
      s("falcons", 1991, 1991),
      s("packers", 1992, 2007),
      s("jets", 2008, 2008),
      s("vikings", 2009, 2010),
    ],
  },
  {
    id: "peyton-manning",
    name: "Peyton Manning",
    sport: "football",
    hallOfFame: true,
    stints: [
      s("tennessee", 1994, 1997),
      s("colts", 1998, 2011),
      s("broncos", 2012, 2015),
    ],
  },
  {
    id: "tom-brady",
    name: "Tom Brady",
    sport: "football",
    hallOfFame: false,
    stints: [
      s("michigan", 1996, 1999),
      s("patriots", 2000, 2019),
      s("buccaneers", 2020, 2022),
    ],
  },
  {
    id: "gordie-howe",
    name: "Gordie Howe",
    sport: "hockey",
    hallOfFame: true,
    stints: [s("red-wings", 1946, 1971), s("whalers", 1977, 1980)],
  },
  {
    id: "steve-yzerman",
    name: "Steve Yzerman",
    sport: "hockey",
    hallOfFame: true,
    stints: [s("red-wings", 1983, 2006)],
  },
  {
    id: "wayne-gretzky",
    name: "Wayne Gretzky",
    sport: "hockey",
    hallOfFame: true,
    stints: [
      s("oilers", 1979, 1988),
      s("kings", 1988, 1996),
      s("blues", 1996, 1996),
      s("rangers-nhl", 1996, 1999),
    ],
  },
  {
    id: "shohei-ohtani",
    name: "Shohei Ohtani",
    sport: "baseball",
    hallOfFame: false,
    stints: [
      s("fighters", 2013, 2017),
      s("angels", 2018, 2023),
      s("dodgers", 2024, null),
    ],
  },
  {
    id: "paul-skenes",
    name: "Paul Skenes",
    sport: "baseball",
    hallOfFame: false,
    stints: [s("lsu", 2023, 2023), s("pirates", 2024, null)],
  },
  {
    id: "ken-griffey-jr",
    name: "Ken Griffey Jr.",
    sport: "baseball",
    hallOfFame: true,
    stints: [
      s("mariners", 1989, 1999),
      s("reds", 2000, 2008),
      s("white-sox", 2008, 2008),
      s("mariners", 2009, 2010),
    ],
  },
  {
    id: "nolan-ryan",
    name: "Nolan Ryan",
    sport: "baseball",
    hallOfFame: true,
    stints: [
      s("mets", 1966, 1971),
      s("angels", 1972, 1979),
      s("astros", 1980, 1988),
      s("rangers-mlb", 1989, 1993),
    ],
  },
];

const playerIndex = new Map<string, Player>(
  notablePlayers.map((p) => [p.id, p]),
);

/**
 * Find or create the player a checklist line names. A filler player's career
 * is just the teams their cards show, widened as more cards reference them.
 */
function ensurePlayer(
  name: string,
  sport: SportId,
  teamId: TeamId,
  year: number,
  hallOfFame: boolean,
): Player {
  const id = slugify(name);
  const known = playerIndex.get(id);
  if (known) {
    if (notablePlayers.includes(known)) return known;
    const stint = known.stints.find((st) => st.teamId === teamId);
    if (stint) {
      stint.from = Math.min(stint.from, year);
      stint.to = Math.max(stint.to ?? year, year);
    } else {
      known.stints.push(s(teamId, year, year));
    }
    known.hallOfFame ||= hallOfFame;
    return known;
  }
  const created: Player = {
    id,
    name,
    sport,
    hallOfFame,
    stints: [s(teamId, year, year)],
  };
  playerIndex.set(id, created);
  return created;
}

// ---------------------------------------------------------------------------
// Sets and cards
// ---------------------------------------------------------------------------

/**
 * One checklist line: `[number, player name, team id, flags]`.
 * Flags is a comma list: rc, hof, au, relic, sp, `var=Sliding`.
 */
type Line = [string | number, string, TeamId, string?];

interface ParsedFlags {
  features: CardFeature[];
  hallOfFame: boolean;
  variation: string | null;
}

function parseFlags(flags: string | undefined): ParsedFlags {
  const out: ParsedFlags = { features: [], hallOfFame: false, variation: null };
  for (const raw of (flags ?? "").split(",")) {
    const flag = raw.trim();
    if (!flag) continue;
    if (flag === "rc") out.features.push("RC");
    else if (flag === "au") out.features.push("AU");
    else if (flag === "relic") out.features.push("Relic");
    else if (flag === "sp") out.features.push("SP");
    else if (flag === "hof") out.hallOfFame = true;
    else if (flag.startsWith("var=")) out.variation = flag.slice(4);
  }
  return out;
}

const STANDARD: Finish = { kind: "standard" };
const BASE: VariantPath = { type: "Base", name: null };

interface InsertDef {
  name: string;
  finish?: Finish;
  printRun?: number | null;
  lines: Line[];
}

interface ParallelDef {
  name: string;
  finish: Finish;
  printRun: number | null;
  /** Base card numbers this parallel exists for. */
  of: (string | number)[];
}

interface SetDef {
  set: Omit<CardSet, "variants">;
  base: Line[];
  inserts?: InsertDef[];
  parallels?: ParallelDef[];
}

export const sets: CardSet[] = [];
export const cards: Card[] = [];

function cardId(
  setId: string,
  path: VariantPath,
  cardNumber: string,
  variation: string | null,
): string {
  const variant = path.name ? slugify(path.name) : "base";
  const tail = variation ? `-${slugify(variation)}` : "";
  return `${setId}:${variant}:${slugify(cardNumber)}${tail}`;
}

function lineToCard(
  set: Omit<CardSet, "variants">,
  path: VariantPath,
  line: Line,
  finish: Finish,
  printRun: number | null,
): Card {
  const [num, name, teamId, flags] = line;
  const parsed = parseFlags(flags);
  const player = ensurePlayer(name, set.sportId, teamId, set.year, parsed.hallOfFame);
  const cardNumber = String(num);
  return {
    id: cardId(set.id, path, cardNumber, parsed.variation),
    setId: set.id,
    variantPath: path,
    cardNumber,
    playerIds: [player.id],
    teamIds: [teamId],
    printRun,
    features: parsed.features,
    variation: parsed.variation,
    finish,
  };
}

function defineSet(def: SetDef): void {
  const variants: SetVariant[] = [{ path: BASE, printRun: null, finish: STANDARD }];
  const built: Card[] = def.base.map((line) =>
    lineToCard(def.set, BASE, line, STANDARD, null),
  );
  const baseCards = [...built];

  for (const insert of def.inserts ?? []) {
    const path: VariantPath = { type: "Inserts", name: insert.name };
    const finish = insert.finish ?? STANDARD;
    const printRun = insert.printRun ?? null;
    variants.push({ path, printRun, finish });
    for (const line of insert.lines) {
      built.push(lineToCard(def.set, path, line, finish, printRun));
    }
  }

  for (const parallel of def.parallels ?? []) {
    const path: VariantPath = { type: "Parallels", name: parallel.name };
    variants.push({ path, printRun: parallel.printRun, finish: parallel.finish });
    for (const num of parallel.of) {
      // The regular card, never its image variation: #13 and #13 "Sliding"
      // share a number, so the lookup must not stop at the first #13.
      const matches = baseCards.filter(
        (c) => c.cardNumber === String(num) && c.variation === null,
      );
      if (matches.length !== 1) {
        throw new Error(
          `catalog: parallel ${parallel.name} of #${num} in ${def.set.id} matched ${matches.length} base cards`,
        );
      }
      const source = matches[0];
      built.push({
        ...source,
        id: cardId(def.set.id, path, source.cardNumber, null),
        variantPath: path,
        printRun: parallel.printRun,
        finish: parallel.finish,
        features: [...source.features],
      });
    }
  }

  sets.push({ ...def.set, variants });
  cards.push(...built);
}

// --- 1996 Playoff Contenders Football ---------------------------------------
defineSet({
  set: {
    id: "1996-playoff-contenders",
    sportId: "football",
    year: 1996,
    season: "1996",
    brandId: "brand-playoff",
    name: "Playoff Contenders",
  },
  base: [
    [1, "Brett Favre", "packers"],
    [2, "Emmitt Smith", "cowboys", "hof"],
    [3, "Dan Marino", "dolphins", "hof"],
    [4, "Reggie White", "packers"],
    [5, "Troy Aikman", "cowboys", "hof"],
    [6, "Steve Young", "49ers", "hof"],
    [7, "Jerry Rice", "49ers", "hof"],
    [8, "Barry Sanders", "lions", "hof"],
    [9, "John Elway", "broncos", "hof"],
    [10, "Drew Bledsoe", "patriots"],
    [11, "Kerry Collins", "panthers"],
    [12, "Jim Kelly", "bills", "hof"],
    [13, "Deion Sanders", "cowboys", "hof"],
    [14, "Curtis Martin", "patriots", "hof"],
    [15, "Marshall Faulk", "colts", "hof"],
    [16, "Terrell Davis", "broncos", "hof"],
    [17, "Herman Moore", "lions"],
    [18, "Isaac Bruce", "rams", "hof"],
    [19, "Michael Irvin", "cowboys", "hof"],
    [20, "Bruce Smith", "bills", "hof"],
    [21, "Kordell Stewart", "steelers"],
    [22, "Jerome Bettis", "steelers", "hof"],
    [23, "Rod Woodson", "steelers", "hof"],
    [24, "Cris Carter", "vikings", "hof"],
    [25, "Warren Moon", "vikings", "hof"],
    [26, "Jeff George", "falcons"],
    [27, "Mark Brunell", "jaguars"],
    [28, "Natrone Means", "jaguars"],
    [29, "Keyshawn Johnson", "jets", "rc"],
    [30, "Lawrence Phillips", "rams", "rc"],
    [31, "Terry Glenn", "patriots", "rc"],
    [32, "Marvin Harrison", "colts", "rc,hof"],
    [33, "Ray Lewis", "ravens", "rc,hof"],
    [34, "Eddie Kennison", "rams", "rc"],
    [35, "Tim Biakabutuka", "panthers", "rc"],
    [36, "Karim Abdul-Jabbar", "dolphins", "rc"],
    [37, "Simeon Rice", "cardinals-nfl", "rc"],
    [38, "Kevin Hardy", "jaguars", "rc"],
    [39, "Antonio Freeman", "packers"],
    [40, "Dorsey Levens", "packers"],
  ],
  inserts: [
    {
      name: "Pennant Flyers",
      finish: { kind: "foil", tint: "#FFB612" },
      lines: [
        [1, "Brett Favre", "packers"],
        [2, "Reggie White", "packers"],
        [3, "Emmitt Smith", "cowboys"],
        [4, "Jerry Rice", "49ers"],
        [5, "Barry Sanders", "lions"],
        [6, "Dan Marino", "dolphins"],
      ],
    },
  ],
  parallels: [
    {
      name: "Blue Foil",
      finish: { kind: "foil", tint: "#2F6BFF" },
      printRun: null,
      of: [1, 2, 4, 7, 8],
    },
  ],
});

// --- 1996-97 Upper Deck Hockey (Red Wings heavy) ----------------------------
defineSet({
  set: {
    id: "1996-97-upper-deck-hockey",
    sportId: "hockey",
    year: 1996,
    season: "1996-97",
    brandId: "brand-upper-deck",
    name: "Upper Deck",
  },
  base: [
    [1, "Steve Yzerman", "red-wings"],
    [2, "Sergei Fedorov", "red-wings", "hof"],
    [3, "Brendan Shanahan", "red-wings", "hof"],
    [4, "Nicklas Lidstrom", "red-wings", "hof"],
    [5, "Igor Larionov", "red-wings", "hof"],
    [6, "Vyacheslav Kozlov", "red-wings"],
    [7, "Chris Osgood", "red-wings"],
    [8, "Mike Vernon", "red-wings"],
    [9, "Darren McCarty", "red-wings"],
    [10, "Kris Draper", "red-wings"],
    [11, "Viacheslav Fetisov", "red-wings", "hof"],
    [12, "Vladimir Konstantinov", "red-wings"],
    [13, "Larry Murphy", "red-wings", "hof"],
    [14, "Martin Lapointe", "red-wings"],
    [15, "Kirk Maltby", "red-wings"],
    [16, "Tomas Holmstrom", "red-wings", "rc"],
    [17, "Doug Brown", "red-wings"],
    [18, "Wayne Gretzky", "rangers-nhl"],
    [19, "Mark Messier", "rangers-nhl", "hof"],
    [20, "Brian Leetch", "rangers-nhl", "hof"],
    [21, "Mario Lemieux", "penguins", "hof"],
    [22, "Jaromir Jagr", "penguins"],
    [23, "Ron Francis", "penguins", "hof"],
    [24, "Patrick Roy", "avalanche", "hof"],
    [25, "Joe Sakic", "avalanche", "hof"],
    [26, "Peter Forsberg", "avalanche", "hof"],
    [27, "Eric Lindros", "flyers", "hof"],
    [28, "John LeClair", "flyers"],
    [29, "Paul Kariya", "mighty-ducks", "hof"],
    [30, "Teemu Selanne", "mighty-ducks", "hof"],
    [31, "Martin Brodeur", "devils", "hof"],
    [32, "Dominik Hasek", "sabres", "hof"],
    [33, "Chris Chelios", "blackhawks", "hof"],
    [34, "Ray Bourque", "bruins", "hof"],
    [35, "Saku Koivu", "canadiens"],
    [36, "Mats Sundin", "maple-leafs", "hof"],
    [37, "Brett Hull", "blues", "hof"],
    [38, "Mike Modano", "stars", "hof"],
    [39, "Pavel Bure", "canucks", "hof"],
    [40, "Jarome Iginla", "flames", "rc,hof"],
    [41, "Sergei Berezin", "maple-leafs", "rc"],
    [42, "Ethan Moreau", "blackhawks", "rc"],
    [43, "Peter Bondra", "capitals"],
    [44, "Doug Weight", "oilers"],
    [45, "Theoren Fleury", "flames"],
  ],
  inserts: [
    {
      name: "Legends",
      finish: { kind: "foil", tint: "#C9A227" },
      lines: [
        // The same legend twice: once as a Red Wing, once as a Whaler.
        [1, "Gordie Howe", "red-wings"],
        [2, "Gordie Howe", "whalers"],
        [3, "Wayne Gretzky", "oilers"],
        [4, "Mario Lemieux", "penguins"],
      ],
    },
    {
      name: "Game Jerseys",
      lines: [
        ["GJ1", "Steve Yzerman", "red-wings", "relic,sp"],
        ["GJ2", "Sergei Fedorov", "red-wings", "relic,sp"],
        ["GJ3", "Patrick Roy", "avalanche", "relic,sp"],
      ],
    },
  ],
});

// --- 2024 Score Football (numbered parallels) -------------------------------
defineSet({
  set: {
    id: "2024-score-football",
    sportId: "football",
    year: 2024,
    season: "2024",
    brandId: "brand-score",
    name: "Score",
  },
  base: [
    [1, "Patrick Mahomes", "chiefs"],
    [2, "Josh Allen", "bills"],
    [3, "Lamar Jackson", "ravens"],
    [4, "Joe Burrow", "bengals"],
    [5, "Travis Kelce", "chiefs"],
    [6, "Justin Jefferson", "vikings"],
    [7, "Ja'Marr Chase", "bengals"],
    [8, "Tyreek Hill", "dolphins"],
    [9, "Christian McCaffrey", "49ers"],
    [10, "T.J. Watt", "steelers"],
    [11, "Jonathan Taylor", "colts"],
    [12, "Russell Wilson", "steelers"],
    [13, "Jalen Hurts", "eagles"],
    // "13b": a number that is a string, and a near-duplicate of "13".
    ["13b", "Jalen Hurts", "eagles", "sp,var=Kelly Green"],
    [14, "Saquon Barkley", "eagles"],
    [15, "A.J. Brown", "eagles"],
    [16, "C.J. Stroud", "texans"],
    [17, "Nico Collins", "texans"],
    [18, "Aidan Hutchinson", "lions"],
    [19, "Amon-Ra St. Brown", "lions"],
    [20, "Jared Goff", "lions"],
    [21, "Brock Purdy", "49ers"],
    [22, "Micah Parsons", "cowboys"],
    [23, "CeeDee Lamb", "cowboys"],
    [24, "Sauce Gardner", "jets"],
    [25, "Jordan Love", "packers"],
    [26, "Garrett Wilson", "jets"],
    [27, "Myles Garrett", "browns"],
    [28, "Derrick Henry", "ravens"],
    [29, "Bijan Robinson", "falcons"],
    [30, "Trevor Lawrence", "jaguars"],
    [301, "Caleb Williams", "bears", "rc"],
    [302, "Jayden Daniels", "commanders", "rc"],
    [303, "Drake Maye", "patriots", "rc"],
    [304, "Marvin Harrison Jr.", "cardinals-nfl", "rc"],
    [305, "Malik Nabers", "giants-nfl", "rc"],
    [306, "Bo Nix", "broncos", "rc"],
    [307, "J.J. McCarthy", "vikings", "rc"],
    [308, "Rome Odunze", "bears", "rc"],
  ],
  inserts: [
    {
      name: "Gridiron Heritage",
      finish: { kind: "foil", tint: "#A5ACAF" },
      lines: [
        [1, "Reggie White", "eagles"],
        [2, "J.J. Watt", "texans"],
        [3, "Peyton Manning", "colts"],
        [4, "Brett Favre", "packers"],
      ],
    },
  ],
  parallels: [
    { name: "Red", finish: { kind: "foil", tint: "#E0242B" }, printRun: null, of: [1, 10, 301, 302] },
    { name: "Lava", finish: { kind: "foil", tint: "#FF6A13" }, printRun: null, of: [1, 10, 301, 302] },
    { name: "Gold Zone", finish: { kind: "gold" }, printRun: 50, of: [1, 10, 301, 302] },
    { name: "Artist's Proof", finish: { kind: "foil", tint: "#C0C7D0" }, printRun: 25, of: [1, 10, 301, 302] },
    { name: "Showcase", finish: { kind: "foil", tint: "#00C2FF" }, printRun: 10, of: [1, 10, 301, 302] },
    { name: "Black", finish: { kind: "foil", tint: "#1A1A1A" }, printRun: 1, of: [1, 10, 301, 302] },
  ],
});

// --- 1993 Finest Baseball ---------------------------------------------------
defineSet({
  set: {
    id: "1993-finest-baseball",
    sportId: "baseball",
    year: 1993,
    season: "1993",
    brandId: "brand-topps",
    name: "Finest",
  },
  base: [
    [1, "Nolan Ryan", "rangers-mlb"],
    [2, "Ken Griffey Jr.", "mariners"],
    [3, "Barry Bonds", "giants-mlb"],
    [4, "Frank Thomas", "white-sox", "hof"],
    [5, "Cal Ripken Jr.", "orioles", "hof"],
    [6, "Kirby Puckett", "twins", "hof"],
    [7, "Tony Gwynn", "padres", "hof"],
    [8, "Greg Maddux", "braves", "hof"],
    [9, "Barry Larkin", "reds", "hof"],
    [10, "Roberto Alomar", "blue-jays", "hof"],
    [11, "Juan Gonzalez", "rangers-mlb"],
    [12, "Ryne Sandberg", "cubs", "hof"],
    [13, "Don Mattingly", "yankees"],
    [14, "George Brett", "royals", "hof"],
    [15, "Robin Yount", "brewers", "hof"],
    [16, "Ozzie Smith", "cardinals-mlb", "hof"],
    [17, "Jeff Bagwell", "astros", "hof"],
    [18, "Mark McGwire", "athletics"],
    [19, "Randy Johnson", "mariners", "hof"],
    [20, "Roger Clemens", "red-sox"],
    [21, "Dennis Eckersley", "athletics", "hof"],
    [22, "Paul Molitor", "blue-jays", "hof"],
    [23, "Carlos Baerga", "indians"],
    [24, "Tom Glavine", "braves", "hof"],
    [25, "Ivan Rodriguez", "rangers-mlb", "hof"],
    [26, "Andres Galarraga", "rockies"],
    [27, "Gary Sheffield", "marlins"],
    [28, "Larry Walker", "expos", "hof"],
    [29, "Darren Daulton", "phillies"],
    [30, "Andy Van Slyke", "pirates"],
    [31, "Mike Piazza", "dodgers", "hof"],
    [32, "Cecil Fielder", "tigers-mlb"],
    [33, "Dave Winfield", "twins", "hof"],
  ],
  parallels: [
    {
      name: "Refractor",
      finish: { kind: "refractor" },
      printRun: null,
      of: [1, 2, 3, 4, 5, 7, 8, 13, 19, 31],
    },
  ],
});

// --- 2024 Topps Chrome Baseball (rainbow) -----------------------------------
const RAINBOW_OF = [1, 13, 25];
defineSet({
  set: {
    id: "2024-topps-chrome-baseball",
    sportId: "baseball",
    year: 2024,
    season: "2024",
    brandId: "brand-topps",
    name: "Topps Chrome",
  },
  base: [
    [1, "Shohei Ohtani", "dodgers"],
    [2, "Aaron Judge", "yankees"],
    [3, "Bobby Witt Jr.", "royals"],
    [4, "Gunnar Henderson", "orioles"],
    [5, "Julio Rodríguez", "mariners"],
    [6, "Ronald Acuña Jr.", "braves"],
    [7, "Mookie Betts", "dodgers"],
    [8, "Juan Soto", "yankees"],
    [9, "Corbin Carroll", "diamondbacks"],
    [10, "Fernando Tatis Jr.", "padres"],
    [11, "Freddie Freeman", "dodgers"],
    [12, "Mike Trout", "angels"],
    // Two different cards, one number: the regular #13 and its SP image
    // variation. Anything keyed on "#13" alone must ask which.
    [13, "Elly De La Cruz", "reds"],
    [13, "Elly De La Cruz", "reds", "sp,var=Sliding"],
    [14, "José Ramírez", "guardians"],
    [15, "Kyle Tucker", "astros"],
    [16, "Adley Rutschman", "orioles"],
    [17, "Spencer Strider", "braves"],
    [18, "Corey Seager", "rangers-mlb"],
    [19, "Yordan Alvarez", "astros"],
    [20, "Bryce Harper", "phillies"],
    [21, "Pete Alonso", "mets"],
    [22, "Rafael Devers", "red-sox"],
    [23, "Vladimir Guerrero Jr.", "blue-jays"],
    [24, "Francisco Lindor", "mets"],
    [25, "Paul Skenes", "pirates", "rc"],
    [26, "Jackson Holliday", "orioles", "rc"],
    [27, "Wyatt Langford", "rangers-mlb", "rc"],
    [28, "Jackson Chourio", "brewers", "rc"],
    [29, "Yoshinobu Yamamoto", "dodgers", "rc"],
    [30, "Junior Caminero", "rays", "rc"],
    [31, "Jackson Merrill", "padres", "rc"],
    [32, "Evan Carter", "rangers-mlb", "rc"],
  ],
  inserts: [
    {
      name: "Chrome Rookie Autographs",
      finish: { kind: "refractor" },
      lines: [
        ["RA-PS", "Paul Skenes", "pirates", "rc,au"],
        ["RA-JH", "Jackson Holliday", "orioles", "rc,au"],
        ["RA-WL", "Wyatt Langford", "rangers-mlb", "rc,au"],
      ],
    },
  ],
  parallels: [
    { name: "Refractor", finish: { kind: "refractor" }, printRun: null, of: RAINBOW_OF },
    { name: "Prism Refractor", finish: { kind: "refractor", tint: "#E8E8F0" }, printRun: null, of: RAINBOW_OF },
    { name: "Negative Refractor", finish: { kind: "refractor", tint: "#3A3A44" }, printRun: null, of: RAINBOW_OF },
    { name: "Aqua Refractor", finish: { kind: "refractor", tint: "#00E5C0" }, printRun: 199, of: RAINBOW_OF },
    { name: "Blue Refractor", finish: { kind: "refractor", tint: "#1E6BFF" }, printRun: 150, of: RAINBOW_OF },
    { name: "Green Refractor", finish: { kind: "refractor", tint: "#00D558" }, printRun: 99, of: RAINBOW_OF },
    { name: "Gold Refractor", finish: { kind: "gold" }, printRun: 50, of: RAINBOW_OF },
    { name: "Orange Refractor", finish: { kind: "refractor", tint: "#FF9E00" }, printRun: 25, of: RAINBOW_OF },
    { name: "Red Refractor", finish: { kind: "refractor", tint: "#E0242B" }, printRun: 5, of: RAINBOW_OF },
    { name: "SuperFractor", finish: { kind: "superfractor" }, printRun: 1, of: RAINBOW_OF },
  ],
});

// --- 2000 Topps Football ----------------------------------------------------
defineSet({
  set: {
    id: "2000-topps-football",
    sportId: "football",
    year: 2000,
    season: "2000",
    brandId: "brand-topps",
    name: "Topps",
  },
  base: [
    [1, "Peyton Manning", "colts"],
    [2, "Brett Favre", "packers"],
    [3, "Kurt Warner", "rams"],
    [4, "Marshall Faulk", "rams"],
    [5, "Randy Moss", "vikings", "hof"],
    [6, "Cris Carter", "vikings"],
    [7, "Eddie George", "titans"],
    [8, "Edgerrin James", "colts", "hof"],
    [9, "Emmitt Smith", "cowboys"],
    [10, "Jerry Rice", "49ers"],
    [11, "Marvin Harrison", "colts"],
    [12, "Reggie White", "panthers"],
    [13, "Donovan McNabb", "eagles"],
    [14, "Ray Lewis", "ravens"],
    [15, "Tim Couch", "browns"],
    [16, "Isaac Bruce", "rams"],
    [17, "Curtis Martin", "jets"],
    [18, "Fred Taylor", "jaguars"],
    [19, "Steve McNair", "titans"],
    [20, "Drew Bledsoe", "patriots"],
    [340, "Tom Brady", "patriots", "rc"],
    [341, "Brian Urlacher", "bears", "rc,hof"],
    [342, "Jamal Lewis", "ravens", "rc"],
    [343, "Peter Warrick", "bengals", "rc"],
    [344, "Shaun Alexander", "seahawks", "rc"],
    [345, "Chad Pennington", "jets", "rc"],
    [346, "Thomas Jones", "cardinals-nfl", "rc"],
  ],
});

/** Every player, notable and filler, built once the checklists above ran. */
export const players: Player[] = [...playerIndex.values()];

// Guard the invariants the helpers rely on. Deterministic data, so a throw
// here fires on the first page load of any prototype, never later.
{
  const ids = new Set<string>();
  for (const card of cards) {
    if (ids.has(card.id)) throw new Error(`catalog: duplicate card id ${card.id}`);
    ids.add(card.id);
  }
  const teamIds = new Set(teams.map((t) => t.id));
  for (const p of players) {
    for (const st of p.stints) {
      if (!teamIds.has(st.teamId)) {
        throw new Error(`catalog: ${p.name} has a stint with unknown team ${st.teamId}`);
      }
    }
  }
}

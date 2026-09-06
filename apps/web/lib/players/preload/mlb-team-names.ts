/**
 * NEO-254 — splitting a Lahman team name into location + nickname.
 *
 * NEO-236 is moving `teams` to a Location/Name pair ("Wisconsin" / "Badgers"),
 * and the preload has to carry both halves so that switch is a one-line change
 * in the loader rather than a re-derivation over 141 historical names. The
 * split is also the only part of the MLB team data a machine cannot get right
 * on its own, so it lives here, next to a test, rather than inline in the
 * generator.
 *
 * ## The rule, and why there is an exception table at all
 *
 * The default is "everything but the last word is the location": Milwaukee /
 * Brewers, New York / Yankees, Tampa Bay / Rays. That is right for 114 of the
 * 141 names Lahman carries once the Negro Leagues are excluded.
 *
 * It is wrong whenever the nickname itself is more than one word — Red Sox,
 * White Stockings, Dark Blues, Forest Citys — and there is nothing in the
 * string that says which. So those 27 are listed by hand below.
 *
 * ## The guard is what keeps this honest over time
 *
 * A curated list silently rots: a Lahman refresh that adds a name the list
 * does not know would fall through to the default rule and split
 * "Chicago Green Sox" into "Chicago Green" / "Sox" with nobody noticing.
 * `splitMlbTeamName` therefore refuses any name whose second-to-last word is a
 * known nickname modifier (a colour, "Forest", "Devil"…) and is not in the
 * table, and the generator turns that refusal into a failed build. Adding the
 * name here is then the fix, which is the point.
 *
 * Product invariant note: this is derivation at CREATION only. Nothing reads
 * these names back to drive behaviour, and NB's rows keep whatever an operator
 * later edits them to.
 */

export interface MlbTeamNameSplit {
  /** Where the team is from. Empty when the name carries no place at all. */
  location: string;
  /** What they are called. Never empty. */
  nickname: string;
}

/**
 * Names the "last word is the nickname" default gets wrong.
 *
 * Two kinds of entry:
 *
 *  - **Multi-word nicknames** (the bulk). "Red Sox", "White Stockings",
 *    "Dark Blues", "Colt .45's" — the nickname runs to two or three words and
 *    the location is whatever precedes it.
 *  - **Names with no location** — the 2025 "Athletics", who dropped their city
 *    outright. NB's rule is that Location is blank only when the name has no
 *    place in it, and this is that case.
 *
 * "Los Angeles Angels of Anaheim" is its own oddity: the franchise's official
 * name from 2005-2015 carried both cities. The location is the one they played
 * under, and "Angels of Anaheim" stays whole as the nickname so the row still
 * reads back as the name printed on the cards.
 *
 * "Chicago/Pittsburgh (Union League)" is Lahman's own placeholder for the 1884
 * Union Association club that played half a season in each city. Kept verbatim
 * as the name; the split is the least-wrong reading of it rather than an
 * invented nickname.
 */
export const MLB_TEAM_NAME_SPLITS: Readonly<Record<string, MlbTeamNameSplit>> = {
  "Altoona Mountain City": { location: "Altoona", nickname: "Mountain City" },
  Athletics: { location: "", nickname: "Athletics" },
  "Boston Red Caps": { location: "Boston", nickname: "Red Caps" },
  "Boston Red Sox": { location: "Boston", nickname: "Red Sox" },
  "Boston Red Stockings": { location: "Boston", nickname: "Red Stockings" },
  "Brooklyn Ward's Wonders": { location: "Brooklyn", nickname: "Ward's Wonders" },
  "Chicago White Sox": { location: "Chicago", nickname: "White Sox" },
  "Chicago White Stockings": { location: "Chicago", nickname: "White Stockings" },
  "Chicago/Pittsburgh (Union League)": {
    location: "Chicago/Pittsburgh",
    nickname: "(Union League)",
  },
  "Cincinnati Kelly's Killers": { location: "Cincinnati", nickname: "Kelly's Killers" },
  "Cincinnati Outlaw Reds": { location: "Cincinnati", nickname: "Outlaw Reds" },
  "Cincinnati Red Stockings": { location: "Cincinnati", nickname: "Red Stockings" },
  "Cleveland Forest Citys": { location: "Cleveland", nickname: "Forest Citys" },
  "Hartford Dark Blues": { location: "Hartford", nickname: "Dark Blues" },
  "Houston Colt .45's": { location: "Houston", nickname: "Colt .45's" },
  "Los Angeles Angels of Anaheim": {
    location: "Los Angeles",
    nickname: "Angels of Anaheim",
  },
  "New Haven Elm Citys": { location: "New Haven", nickname: "Elm Citys" },
  "Philadelphia Blue Jays": { location: "Philadelphia", nickname: "Blue Jays" },
  "Rockford Forest Citys": { location: "Rockford", nickname: "Forest Citys" },
  "St. Louis Brown Stockings": { location: "St. Louis", nickname: "Brown Stockings" },
  "St. Louis Red Stockings": { location: "St. Louis", nickname: "Red Stockings" },
  "St. Paul White Caps": { location: "St. Paul", nickname: "White Caps" },
  "Tampa Bay Devil Rays": { location: "Tampa Bay", nickname: "Devil Rays" },
  "Toledo Blue Stockings": { location: "Toledo", nickname: "Blue Stockings" },
  "Toronto Blue Jays": { location: "Toronto", nickname: "Blue Jays" },
  "Washington Blue Legs": { location: "Washington", nickname: "Blue Legs" },
  "Worcester Ruby Legs": { location: "Worcester", nickname: "Ruby Legs" },
};

/**
 * Words that, immediately before the last word, mean the nickname is longer
 * than one word — so a name containing one had better be in the table above.
 *
 * Derived from the 27 entries themselves plus the obvious neighbours a future
 * refresh could add (Green, Black, Golden). Deliberately over-broad: a false
 * alarm costs one line in the table, a miss costs a wrong split nobody sees.
 */
const NICKNAME_MODIFIERS: ReadonlySet<string> = new Set([
  "red",
  "white",
  "blue",
  "brown",
  "black",
  "green",
  "golden",
  "grey",
  "gray",
  "dark",
  "forest",
  "elm",
  "mountain",
  "ruby",
  "devil",
  "outlaw",
  "steam",
  "yellow",
  "crimson",
]);

/**
 * Split a Lahman team name.
 *
 * @throws when the name looks like it has a multi-word nickname but is not in
 * `MLB_TEAM_NAME_SPLITS`. The generator lets that throw fail the build — see
 * the header for why silence is the worse outcome.
 */
export function splitMlbTeamName(name: string): MlbTeamNameSplit {
  const trimmed = name.trim();
  const known = MLB_TEAM_NAME_SPLITS[trimmed];
  if (known) return known;

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    throw new Error("splitMlbTeamName: empty team name");
  }
  if (words.length === 1) {
    // A bare nickname with no city — the same case as the 2025 "Athletics",
    // which is in the table. Anything else reaching here is new, so say so
    // rather than guessing a location out of thin air.
    throw new Error(
      `splitMlbTeamName: "${trimmed}" is a single word and is not in ` +
        `MLB_TEAM_NAME_SPLITS. Add it with the location you want (blank if the ` +
        `name genuinely carries no place).`,
    );
  }

  const penultimate = words[words.length - 2].toLowerCase();
  if (NICKNAME_MODIFIERS.has(penultimate)) {
    throw new Error(
      `splitMlbTeamName: "${trimmed}" looks like a multi-word nickname ` +
        `("${words.slice(-2).join(" ")}") but is not in MLB_TEAM_NAME_SPLITS. ` +
        `Add it rather than letting the last-word rule split it wrongly.`,
    );
  }

  return {
    location: words.slice(0, -1).join(" "),
    nickname: words[words.length - 1],
  };
}

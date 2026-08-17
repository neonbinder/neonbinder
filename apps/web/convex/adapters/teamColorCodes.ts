/**
 * NEO-147: teamcolorcodes.com as the team-color source.
 *
 * `adapters/espn.ts` was the original color source (NEO-91) and is not
 * sufficient. A survey of all 58 prod `teams` rows found `colors` on 0 and
 * `externalIds.espnId` on 0 — the table spans MLB, NCAA, NPB (Japan), MiLB and
 * the Dominican winter league, and ESPN carries only current MLB/NCAA. Every
 * NPB/MiLB/DR row was structurally unreachable, not merely unmatched.
 *
 * This site covers exactly that tail (spot-confirmed: Saitama Seibu Lions,
 * Chiba Lotte Marines). It is a WordPress site, so the contract here is HTML,
 * not an API — everything below is defensive and no-throw, matching the
 * adapter conventions in espn.ts: a miss returns null and the caller falls
 * back, it is never an error.
 *
 * Three things about this source are counter-intuitive and each one has bitten
 * a naive implementation:
 *
 *  1. SLUGS CANNOT BE CONSTRUCTED. Two suffixes are in live use —
 *     `-color-codes` (1893 pages) and `-colors` (297) — with no rule
 *     predicting which. "UConn Huskies" is served from
 *     `/connecticut-huskies-colors/`; both `/uconn-huskies-color-codes/` and
 *     `/connecticut-huskies-color-codes/` are 404s. The sitemap must be
 *     read and matched against. See `findTeamColorPages`.
 *
 *  2. PAGES CARRY HISTORICAL COLORS. The Milwaukee Brewers page lists 11
 *     colorblocks across 5 eras (current, 2018-2019, alternate, 2000-2017,
 *     retro). Taking "the colorblocks on the page" labels a binder in 1990s
 *     colors. See `parseCurrentTeamColors` for the boundary rule.
 *
 *  3. `/search/` IS DISALLOWED by robots.txt (confirmed 2026-08-13, alongside
 *     `/wp-admin/` and `/page/`). The `/?s=` query form evades that rule but
 *     not its intent. Nothing here fetches it — the sitemap makes search
 *     unnecessary.
 *
 * Politeness: every function here is reached only from an explicit,
 * one-team-at-a-time operator action ("Discover" in Team Management). Nothing
 * in this module may be put behind a bulk loop, a background queue, or a render
 * path — one search reads the sitemap index plus up to four children (~1.5MB),
 * which is affordable once on a click and abusive in a loop.
 */

const BASE_URL = "https://teamcolorcodes.com";
const SITEMAP_INDEX_URL = `${BASE_URL}/wp-sitemap.xml`;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * The ONLY hosts this adapter may fetch. Every URL it handles arrives from
 * somewhere it does not control — the sitemap's own `<loc>` elements, a row in
 * the cached index, or an admin's click in the team editor — and a Convex
 * action's `fetch` runs inside our backend's network, not the user's. Without
 * this check a URL that reached `fetchText` would be a server-side request
 * forgery primitive: cloud metadata endpoints, private ranges, anything else
 * reachable from Convex egress.
 *
 * `www.` is included because the site serves both and either could appear in a
 * canonical URL; nothing else is.
 */
const ALLOWED_HOSTS = new Set(["teamcolorcodes.com", "www.teamcolorcodes.com"]);

/**
 * Hard ceiling on a single response.
 *
 * The whole sitemap set is ~1.5MB and a team page is ~100KB, so 4MB is far
 * above anything legitimate. It bounds two things: the memory an action holds
 * for one body, and the input the regex parsers below scan.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Ceiling on child sitemaps followed from the index (4 as of 2026-08-13). The
 * list comes from the remote site, so it is bounded rather than trusted.
 */
const MAX_CHILD_SITEMAPS = 25;

/**
 * True only for an `https://` URL on {@link ALLOWED_HOSTS}. Exported so the
 * callers that hand user-supplied URLs to this adapter can reject early with a
 * useful message rather than getting a silent null.
 */
export function isAllowedSourceUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
}

/**
 * Identifies us and gives the site owner a way to make contact. Same shape as
 * the ESPN adapter's UA — this is a courtesy source with no contract, so being
 * anonymous would be the wrong posture.
 */
const USER_AGENT =
  "NeonBinder/1.0 (https://neonbinder.io; jburich@neonbinder.io)";

/** The two live page-slug suffixes. Anything else in the sitemap is not a team page. */
const TEAM_SLUG_SUFFIXES = ["-color-codes", "-colors"] as const;

export interface TeamColorSourceEntry {
  /** Display name derived from the slug, e.g. "connecticut huskies". */
  name: string;
  url: string;
}

export interface TeamColorParseResult {
  primary?: string;
  secondary?: string;
  /** All current-era colors in source order, primary/secondary included. */
  all: string[];
  /** The heading the colors were read from — useful when a human audits a match. */
  heading: string;
}

/**
 * Sport words that our `teams.name` values carry but the source's never do.
 *
 * College rows arrive as "UConn Huskies baseball" — a Set Builder artifact.
 * The suffix breaks matching against "UConn Huskies" AND would look wrong
 * printed down the spine of a binder, so it is stripped for matching here and
 * left alone on the row itself (renaming teams is the editor's job, not a
 * backfill's).
 */
const SPORT_SUFFIXES = [
  "baseball",
  "basketball",
  "football",
  "hockey",
  "soccer",
  "softball",
  "volleyball",
];

/**
 * Match key for a team name. Deliberately NOT `teams.normalizeTeamName` —
 * that one token-sorts for dedup, and while sorting is harmless for equality
 * it would silently make "Chiba Lotte Marines" and "Marines Lotte Chiba"
 * identical. Here both sides of the comparison are real team names, so
 * order-preserving normalization keeps the match honest and the failure mode
 * (no match → human review) safe.
 */
export function colorSourceMatchKey(raw: string): string {
  let s = raw
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  for (const suffix of SPORT_SUFFIXES) {
    s = s.replace(new RegExp(`\\s+${suffix}$`), "");
  }
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Slug → display name. `/connecticut-huskies-colors/` → "connecticut huskies".
 * Returns null for any URL that is not a team page (the sitemap also carries
 * the homepage, league index pages and WP template pages).
 */
export function teamNameFromSourceUrl(url: string): string | null {
  const match = url.match(/^https?:\/\/teamcolorcodes\.com\/([^/?#]+)\/?$/i);
  if (!match) return null;
  const slug = match[1].toLowerCase();

  const suffix = TEAM_SLUG_SUFFIXES.find((s) => slug.endsWith(s));
  if (!suffix) return null;

  const stem = slug.slice(0, -suffix.length);
  if (!stem) return null;
  return stem.replace(/-/g, " ").trim();
}

async function fetchText(url: string): Promise<string | null> {
  if (!isAllowedSourceUrl(url)) {
    console.warn(`[teamColorCodes] refused off-host url=${url}`);
    return null;
  }
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(
        `[teamColorCodes] fetch failed status=${response.status} url=${url}`,
      );
      return null;
    }
    // Redirects are FOLLOWED deliberately — `/wp-sitemap.xml` 301s to
    // `/sitemap_index.xml`, so refusing them would break the index refresh.
    // That means the check above only covers the first hop, and where we
    // actually landed has to be checked too, or a redirect from the source
    // site would carry us (and the parsed result) off-host.
    const finalUrl = typeof response.url === "string" ? response.url : "";
    if (finalUrl && !isAllowedSourceUrl(finalUrl)) {
      console.warn(
        `[teamColorCodes] refused off-host redirect url=${url} landed=${finalUrl}`,
      );
      return null;
    }
    const declaredLength = Number(
      response.headers?.get?.("content-length") ?? "",
    );
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      console.warn(
        `[teamColorCodes] response too large declared=${declaredLength} url=${url}`,
      );
      return null;
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      console.warn(
        `[teamColorCodes] response too large bytes=${text.length} url=${url}`,
      );
      return null;
    }
    return text;
  } catch (error) {
    console.warn(`[teamColorCodes] fetch threw url=${url}`, error);
    return null;
  }
}

/** Pull every <loc> out of a sitemap or sitemap index. */
export function parseSitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
}

/**
 * Find the source pages whose name matches this team, reading the sitemap
 * LIVE.
 *
 * NEO-156 removed the cached index this used to build. The site's ~2190 pages
 * were mirrored into a Convex table that an operator had to remember to
 * refresh, which is a second copy of someone else's data that goes stale
 * silently — a team added upstream simply stopped being findable until someone
 * pressed a button. Reading the sitemap at the moment of the search has no such
 * failure mode.
 *
 * The cost is honest: the sitemap index plus up to four children, roughly
 * 1.5MB, per search. That is affordable precisely because this is a manual,
 * one-team-at-a-time action — it must never be put behind a bulk loop or a
 * render path.
 *
 * Children are fetched one at a time and searched as they arrive, returning as
 * soon as a child yields a hit, so the common case costs fewer than the full
 * four. The whole child list is only read when the team is not on the site at
 * all.
 *
 * Returns every match, because "several pages match this name" is a real and
 * common answer — the site carries 10+ distinct "Huskies" — and the caller
 * must put that to a human rather than guess.
 */
export async function findTeamColorPages(
  teamName: string,
): Promise<TeamColorSourceEntry[]> {
  const key = colorSourceMatchKey(teamName);
  if (!key) return [];

  const indexXml = await fetchText(SITEMAP_INDEX_URL);
  if (!indexXml) return [];

  // The index is remote content: filter to on-host `.xml` and cap how many we
  // will follow, so a changed (or tampered) index cannot turn one search into
  // an unbounded fan-out of outbound requests.
  const childSitemaps = parseSitemapLocs(indexXml)
    .filter((u) => u.toLowerCase().endsWith(".xml") && isAllowedSourceUrl(u))
    .slice(0, MAX_CHILD_SITEMAPS);
  if (childSitemaps.length === 0) {
    console.warn("[teamColorCodes] sitemap index listed no child sitemaps");
    return [];
  }

  for (const sitemapUrl of childSitemaps) {
    const xml = await fetchText(sitemapUrl);
    if (!xml) continue;

    const matches: TeamColorSourceEntry[] = [];
    const seen = new Set<string>();
    for (const loc of parseSitemapLocs(xml)) {
      const name = teamNameFromSourceUrl(loc);
      if (!name) continue;
      if (colorSourceMatchKey(name) !== key) continue;
      if (seen.has(loc)) continue;
      seen.add(loc);
      matches.push({ name, url: loc });
    }
    if (matches.length > 0) return matches;
  }

  return [];
}

function normalizeHex(raw: string): string | null {
  const hex = raw.trim().toLowerCase();
  const short = hex.match(/^#([0-9a-f]{3})$/);
  if (short) {
    const [r, g, b] = short[1].split("");
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : null;
}

/**
 * Relative luminance, used only to keep near-white out of the `primary` slot.
 * Not the WCAG contrast calculation — the UI does that (and shows it to the
 * user); this is just "is this swatch effectively blank paper".
 */
function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const NEAR_WHITE_LUMINANCE = 0.92;

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&#8217;|&#39;|&rsquo;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the CURRENT colors from a team page.
 *
 * The boundary rule: take the `div.colorblock`s that appear between the FIRST
 * heading and the SECOND. Every page opens with its current-colors section and
 * then moves on — to historical eras (Brewers: "Primary Logo Colors
 * (2018-2019)", "(2000-2017)", "Retro"), or straight to the Pantone/HEX/RGB
 * reference tables. Both are headings, so "before the second heading" cuts in
 * the right place for both shapes without having to enumerate era-heading
 * spellings.
 *
 * Matching the heading TEXT instead would be brittle: across four sampled
 * pages the first heading was "Milwaukee Brewers Primary Colors", "Saitama
 * Seibu Lions&#8217; Primary Colors" (entity apostrophe), "Chiba Lotte
 * Marines’ Primary Color" (raw curly apostrophe, singular "Color") and "UConn
 * Huskies Primary Logo Colors". Position is stable where wording is not; the
 * text is only used as a sanity guard below.
 *
 * Returns null when the page does not look like a color page at all, which the
 * caller escalates to human review rather than guessing.
 */
export function parseCurrentTeamColors(html: string): TeamColorParseResult | null {
  const contentMatch = html.match(
    /<div class="entry-content"[^>]*>([\s\S]*?)<\/article>/i,
  );
  const body = contentMatch ? contentMatch[1] : html;

  const tokens = [
    ...body.matchAll(
      /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>|<div[^>]*class="[^"]*\bcolorblock\b[^"]*"[^>]*style="[^"]*background-color:\s*(#[0-9a-fA-F]{3,6})/gi,
    ),
  ];

  let heading: string | null = null;
  let headingsSeen = 0;
  const all: string[] = [];

  for (const token of tokens) {
    const isHeading = token[2] !== undefined;
    if (isHeading) {
      headingsSeen += 1;
      if (headingsSeen === 1) heading = stripTags(token[2]);
      // Second heading closes the current-colors section.
      if (headingsSeen >= 2) break;
      continue;
    }
    // A colorblock before any heading is not part of a titled section; ignore
    // it rather than attribute it to a section that has not started.
    if (headingsSeen === 0) continue;
    const hex = normalizeHex(token[3]);
    if (hex && !all.includes(hex)) all.push(hex);
  }

  if (heading === null || all.length === 0) return null;

  // Sanity guard: the first heading on a team page always names colors. If it
  // does not, the page shape has changed and a silent wrong answer is worse
  // than no answer.
  if (!/colou?rs?\b/i.test(heading)) {
    console.warn(
      `[teamColorCodes] first heading did not look like a colors heading: "${heading}"`,
    );
    return null;
  }

  // Near-white is real team livery but useless as a label background, and
  // several pages lead with it (Chiba Lotte Marines opens #E5E1E6, #FFFFFF).
  // Prefer ink for the two stored slots; fall back to the raw order if
  // filtering leaves nothing, so an all-white team still yields something the
  // user can see and override.
  const inked = all.filter((hex) => luminance(hex) < NEAR_WHITE_LUMINANCE);
  const ordered = inked.length > 0 ? inked : all;

  return {
    primary: ordered[0],
    secondary: ordered[1],
    all,
    heading,
  };
}

/** Fetch and parse one team page. No-throw; null means "no usable answer". */
export async function fetchTeamColors(
  url: string,
): Promise<TeamColorParseResult | null> {
  const html = await fetchText(url);
  if (!html) return null;
  return parseCurrentTeamColors(html);
}

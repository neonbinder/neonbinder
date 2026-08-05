import type { PostalAddress } from "./address";

/**
 * NEO-118 — turn a pasted blob of address text into structured fields.
 *
 * The workflow this serves: a sale comes in on SportLots/eBay/BSC, the seller
 * has the buyer's address on a packing slip in another tab, and retyping six
 * fields per package is both slow and the easiest place to introduce a typo
 * that costs a real package. Paste once instead.
 *
 * Design stance: **never guess destructively**. Anything this cannot confidently
 * classify is left for the human — an unparsed field the seller fills in is a
 * minor annoyance, a *wrongly* parsed one gets a card mailed to the wrong
 * street. So the parser anchors on the one line it can identify with certainty
 * (city/state/ZIP) and assigns the rest by position relative to it, rather than
 * trying to be clever about ambiguous lines.
 */

/** Lines that are never part of a postal address. */
const NOISE_PATTERNS: RegExp[] = [
  /^ship\s*to:?$/i,
  /^sold\s*to:?$/i,
  /^bill\s*to:?$/i,
  /^deliver\s*to:?$/i,
  /^address:?$/i,
  /^(united states|usa|u\.s\.a\.|us)$/i,
  // Contact details often sit in the same block on a packing slip.
  /^(tel|phone|ph|mobile|cell)[:.]?\s*[-+()\d\s.]{7,}$/i,
  /^[-+()\d\s.]{10,}$/, // a bare phone number
  /^\S+@\S+\.\S+$/, // a bare email
  /^order\s*(#|number|date|id)/i,
  /^(qty|quantity|item|total|subtotal)\b/i,
];

/**
 * A trailing "City ST 12345" / "City, ST 12345-6789". The state is captured as
 * two letters and the ZIP as 5 or 9 digits, which is what makes this line
 * identifiable without a dictionary of place names.
 */
const CITY_STATE_ZIP =
  /^(.*?)[,\s]+([A-Za-z]{2})[,\s]+(\d{5}(?:-\d{4})?)$/;

/** A ZIP on its own, for slips that break the last line in two. */
const STATE_ZIP_ONLY = /^([A-Za-z]{2})[,\s]+(\d{5}(?:-\d{4})?)$/;

/**
 * A country marker at the END of a line, e.g. the real SportLots packing-slip
 * shape "West Suffield, CT 06093 USA". Both anchors below require the ZIP to be
 * last, so the country has to come off first — otherwise the anchor is missed
 * and every line gets assigned one slot too high.
 */
const TRAILING_COUNTRY =
  /[,\s]+(?:usa|u\.?s\.?a\.?|u\.?s\.?|united states(?: of america)?)\.?$/i;

function stripTrailingCountry(line: string): string {
  return line.replace(TRAILING_COUNTRY, "").trim();
}

/** Secondary unit designators — these belong on line2, not line1. */
const SECONDARY_UNIT =
  /^(apt|apartment|unit|ste|suite|fl|floor|rm|room|bldg|building|lot|trlr|space|spc|#)\b/i;

export interface ParsedAddress {
  fields: Partial<PostalAddress>;
  /** Field keys this actually populated — drives the "what got filled" UI. */
  filled: (keyof PostalAddress)[];
  /** Lines it could not place. Surfaced so nothing is silently dropped. */
  unparsed: string[];
}

function cleanLine(line: string): string {
  return line
    .replace(/ /g, " ") // packing slips love non-breaking spaces
    .replace(/\s+/g, " ")
    .trim();
}

function isNoise(line: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(line));
}

/**
 * Split pasted text into candidate address lines.
 *
 * Newlines win when present. A single-line paste ("Jane, 1 Main St, Austin TX
 * 78701") is split on commas instead — but only then, because a comma inside a
 * multi-line paste is usually the "City, ST" separator and splitting on it
 * would destroy the line we most rely on.
 */
function toLines(raw: string): string[] {
  const byNewline = raw
    .split(/\r?\n/)
    .map(cleanLine)
    .filter((l) => l !== "");

  if (byNewline.length > 1) return byNewline;

  return (byNewline[0] ?? "")
    .split(",")
    .map(cleanLine)
    .filter((l) => l !== "");
}

/**
 * Parse pasted text into address fields.
 *
 * Returns only what it is confident about; callers should merge into existing
 * state rather than replacing it wholesale, so a partial parse never blanks a
 * field the user already typed.
 */
export function parseAddressText(raw: string): ParsedAddress {
  const fields: Partial<PostalAddress> = {};
  const filled: (keyof PostalAddress)[] = [];
  const empty: ParsedAddress = { fields, filled, unparsed: [] };

  if (!raw || raw.trim() === "") return empty;

  const all = toLines(raw);
  const lines = all.filter((l) => !isNoise(l));
  if (lines.length === 0) return empty;

  const set = <K extends keyof PostalAddress>(key: K, value: string) => {
    if (value === "") return;
    fields[key] = value as PostalAddress[K];
    filled.push(key);
  };

  // 1. Anchor on the city/state/ZIP line. Search from the END: a street like
  //    "12 CA 90210 Blvd" is pathological, but a trailing match is not.
  let anchorIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = stripTrailingCountry(lines[i]);
    const m = candidate.match(CITY_STATE_ZIP);
    if (m && m[1].trim() !== "") {
      set("city", m[1].trim());
      set("state", m[2].toUpperCase());
      set("postalCode", m[3]);
      anchorIndex = i;
      break;
    }
    // "Austin" / "TX 78701" split across two lines.
    const only = candidate.match(STATE_ZIP_ONLY);
    if (only && i > 0) {
      set("city", lines[i - 1]);
      set("state", only[1].toUpperCase());
      set("postalCode", only[2]);
      anchorIndex = i - 1;
      break;
    }
  }

  // WITHOUT an anchor, position means nothing and assigning by it is guessing.
  // This is not hypothetical: before the country-stripping above, the real
  // SportLots shape ("… CT 06093 USA") missed the anchor and every line landed
  // one slot too high — the street became the COMPANY and the city line became
  // the street. Silently wrong beats loudly wrong only if nobody is shipping a
  // package. So with no anchor we interpret at most an unambiguous two lines
  // (recipient, then street) and hand everything else back untouched.
  if (anchorIndex === -1) {
    if (lines.length === 1) {
      set("line1", lines[0]);
      return { fields, filled, unparsed: [] };
    }
    if (lines.length === 2) {
      set("name", lines[0]);
      set("line1", lines[1]);
      return { fields, filled, unparsed: [] };
    }
    return { fields, filled, unparsed: lines };
  }

  // Everything above the anchor is name / company / street. Anything BELOW it
  // is trailing noise we could not classify (a country line already filtered,
  // a phone number in an odd format) — reported, never guessed at.
  const head = lines.slice(0, anchorIndex);
  const tail = lines.slice(anchorIndex + 1);

  // 2. Street lines, taken from the bottom of the head upward.
  const streetLines: string[] = [];
  if (head.length > 0) {
    const last = head[head.length - 1];
    if (SECONDARY_UNIT.test(last) && head.length > 1) {
      // "…/ 742 Evergreen Ter / Apt 4B" — the unit is line2.
      streetLines.push(head[head.length - 2], last);
      head.splice(head.length - 2, 2);
    } else {
      streetLines.push(last);
      head.splice(head.length - 1, 1);
    }
  }
  if (streetLines[0]) set("line1", streetLines[0]);
  if (streetLines[1]) set("line2", streetLines[1]);

  // 3. What remains above the street is the recipient, then optionally a
  //    company. Two lines is the most we will interpret; more than that and we
  //    hand the extras back rather than inventing a mapping.
  if (head.length > 0) set("name", head[0]);
  if (head.length > 1) set("company", head[1]);

  const unparsed = [...head.slice(2), ...tail];

  if (filled.length > 0) fields.country = "US";

  return { fields, filled, unparsed };
}

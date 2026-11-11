#!/usr/bin/env node
// Capture a BuySportsCards set's own per-card answers as a checklist CSV
// (number, player, team) for the E2E upload fixtures (NEO-478, D4).
//
// WHAT IT WRITES. One row per BSC card of the set, in the shape the "Add the
// publisher's checklist" dialog reads: a header row `number,player,team`, a
// cell holding several names joined with "; ". The player cell is the names
// BSC's own row carries (a Team Checklist "<Team> TC" / Team Leaders
// "<Team> TL" card names the team, as the adapter's `parsePlayersField` does);
// the team cell is what BSC's per-card `card-listing` answer says, read the
// way the adapter reads it (zero-width stripped, an attribute label such as
// "AU  SN1" is no team, split on commas). A card BSC gives no team is written
// with an empty team cell. So the file reproduces today's BSC answers, and the
// spec that uploads it asserts what it always asserted.
//
// WHERE THE ROWS COME FROM. BSC's storefront search (`search/shop/results`)
// answers without a login and lists a set's cards with their ids; the per-card
// answer is `marketplace/card/<id>/card-listing` (also public). The seller-only
// bulk-upload catalogue needs a token and is not used. The card count is
// checked against `totalResults`, and the run refuses a set whose pages gave
// fewer distinct ids than that.
//
// RUN IT FROM A LAPTOP. Never from a Convex deployment (Convex's shared egress
// is what BSC pushes back on), and never while a CI seller job runs:
//   gh run list --status in_progress
// It paces itself at no more than 2 calls a second (--rate; 0.5 is one call
// every 2 s), honours Retry-After on a 429 and backs off (15 s, doubling), writes
// EVERY 429 to stderr with its UTC time and counts them, and when a 429 is still
// there after --max-429 retries it STOPS, writing nothing, and says how long
// the block lasted. The answers it did get are kept in --cache so a re-run
// resumes without asking BSC again.
//
// USAGE
//   node capture-bsc-checklist-teams.mjs --out <file.csv> --sport baseball \
//     --year 2024 --set-name topps-stars-of-mlb-network --variant base \
//     [--variant-name <slug> ...] [--cache <file.json>] [--rate 2] [--max-429 4] \
//     [--omit-number <card number> ...]
//   --omit-number leaves that card's row OUT of the file (a card left to a live
//   lookup on purpose); the card is still read, so the count check holds.
//   (slugs are the storefront facet slugs: lower-case, hyphenated)
//
// Prints a one-line summary on stdout; progress and 429 reports go to stderr.
// No token, header or cookie value is ever read or printed: both endpoints are
// public.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API = "https://api-prod.buysportscards.com";
const SHOP_BODY = {
  listingSearch: {},
  size: 100,
  sort: "best-sellers",
  inStock: false,
  productCriteria: { condition: null, priceRangeStart: null, priceRangeEnd: null },
};
const HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  origin: "https://www.buysportscards.com",
  referer: "https://www.buysportscards.com/",
};

function parseArgs(argv) {
  const args = { variantName: [], omitNumber: [], rate: 2, max429: 4 };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    switch (key) {
      case "--out": args.out = value; i++; break;
      case "--cache": args.cache = value; i++; break;
      case "--sport": args.sport = value; i++; break;
      case "--year": args.year = value; i++; break;
      case "--set-name": args.setName = value; i++; break;
      case "--variant": args.variant = value; i++; break;
      case "--variant-name": args.variantName.push(value); i++; break;
      case "--omit-number": args.omitNumber.push(String(value)); i++; break;
      case "--rate": args.rate = Number(value); i++; break;
      case "--max-429": args.max429 = Number(value); i++; break;
      default:
        throw new Error(`unknown argument ${key}`);
    }
  }
  for (const need of ["out", "sport", "year", "setName"]) {
    if (!args[need]) throw new Error(`--${need.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  if (!(args.rate > 0 && args.rate <= 2)) throw new Error("--rate must be above 0 and at most 2 calls a second");
  args.cache ??= `${args.out}.cache.json`;
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One 429 episode, kept so the run can say how long BSC pushed back. */
const blocks = [];
/** Every single 429 answer, with the UTC time it came back and the call it answered. */
const all429 = [];

function makeClient(rate, max429) {
  const gap = 1000 / rate;
  let lastCall = 0;
  const pace = async () => {
    const wait = lastCall + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
  };
  /** `fn` returns a fetch Response; 429 and 5xx are retried, everything else is returned. */
  return async function call(label, makeRequest) {
    let blockedSince;
    let backoff = 15_000;
    for (let attempt = 0; attempt <= max429; attempt++) {
      await pace();
      let response;
      try {
        response = await makeRequest();
      } catch (error) {
        if (attempt < 3) { await sleep(2_000); continue; }
        throw new Error(`${label}: network error (${error?.name ?? "unknown"})`);
      }
      if (response.status === 429) {
        blockedSince ??= Date.now();
        all429.push({ at: new Date().toISOString(), label });
        const retryAfter = Number(response.headers.get("retry-after"));
        const pause = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff;
        backoff = Math.min(backoff * 2, 240_000);
        process.stderr.write(`${all429[all429.length - 1].at} 429 #${all429.length} on ${label}; pausing ${Math.round(pause / 1000)} s\n`);
        if (attempt === max429) {
          blocks.push({ label, startedAt: blockedSince, lastsMs: Date.now() - blockedSince, ended: false });
          throw new Error("rate-limited");
        }
        await sleep(pause);
        continue;
      }
      if (response.status >= 500 && attempt < 3) { await sleep(2_000); continue; }
      if (blockedSince) blocks.push({ label, startedAt: blockedSince, lastsMs: Date.now() - blockedSince, ended: true });
      return response;
    }
    throw new Error(`${label}: gave up`);
  };
}

// --- reading BSC's strings the way the adapter does (convex/adapters/marketplaceNames.ts) ---
const ZERO_WIDTH = /[​-‍﻿]/g;
const SUFFIX_ONLY = /^(?:jr|sr|ii|iii|iv)\.?$/i;
// Mirrors KNOWN_BSC_ATTRIBUTE_TOKENS in convex/lib/bscAttributeTokens.ts.
const KNOWN_ATTRIBUTE = new Set([
  "AU", "RC", "SP", "SSP", "RELIC", "MEM", "JSY", "JERSEY", "PATCH", "VAR", "UER", "IA", "BP", "ASR", "FBC", "MGR", "HC", "PC", "FY", "EXCH", "NUM",
]);

function splitNames(raw, separator) {
  const parts = raw.replace(ZERO_WIDTH, "").split(separator).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const joined = [];
  for (const part of parts) {
    if (SUFFIX_ONLY.test(part)) {
      if (joined.length === 0) continue;
      const previous = joined[joined.length - 1];
      const lastToken = previous.slice(previous.lastIndexOf(" ") + 1);
      if (previous.includes(" ") && SUFFIX_ONLY.test(lastToken)) continue;
      joined[joined.length - 1] = `${previous} ${part}`;
      continue;
    }
    joined.push(part);
  }
  const seen = new Set();
  return joined.filter((n) => (seen.has(n.toLowerCase()) ? false : (seen.add(n.toLowerCase()), true)));
}

const isAttributeToken = (p) => KNOWN_ATTRIBUTE.has(p.toUpperCase()) || /^SN\s*\d{1,7}$/i.test(p) || /^1\s*\/\s*1$/.test(p);

/** A team value is really an attribute label ("AU  SN1"): no team. */
function isAttributeLabel(teamName, payloadTokens) {
  const parts = teamName.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return false;
  const upper = [...new Set(parts.map((p) => p.toUpperCase()))].sort();
  const payload = [...new Set(payloadTokens.map((t) => t.trim().toUpperCase()).filter(Boolean))].sort();
  if (payload.length > 0 && payload.length === upper.length && payload.every((t, i) => t === upper[i])) return true;
  return parts.every(isAttributeToken);
}

/** The card's player names: a shop row's `players` (an array, or one string). */
function playersOf(row) {
  const items = Array.isArray(row.players) ? row.players : typeof row.players === "string" ? [row.players] : [];
  const names = [];
  for (const item of items) {
    const text = String(item).replace(ZERO_WIDTH, "").trim();
    if (!text) continue;
    // "<Team> TC" / "<Team> TL": the whole string is a team (the adapter's TEAM_CARD_SUFFIXES).
    const team = /^(.*\S)\s+(?:TC|TL)$/.exec(text);
    if (team) { names.push(team[1]); continue; }
    // "<description> (<names>) <tag>": the names inside the parentheses.
    const paren = /^(.*)\(([^)]*)\)(.*)$/.exec(text);
    names.push(...splitNames(paren ? paren[2] : text, /[,/|]/));
  }
  const seen = new Set();
  return names.filter((n) => (seen.has(n.toLowerCase()) ? false : (seen.add(n.toLowerCase()), true)));
}

function teamsOf(listing) {
  const raw = typeof listing.teamName === "string" ? listing.teamName.replace(ZERO_WIDTH, "").trim() : "";
  const attribute = listing.playerAttribute;
  const tokens = (Array.isArray(attribute) ? attribute.join(",") : typeof attribute === "string" ? attribute : "")
    .split(/[\s,]+/).filter(Boolean);
  if (!raw || isAttributeLabel(raw, tokens)) return [];
  return splitNames(raw, /,/);
}

const csvCell = (value) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

async function main() {
  const args = parseArgs(process.argv);
  const call = makeClient(args.rate, args.max429);
  const cache = existsSync(args.cache) ? JSON.parse(readFileSync(args.cache, "utf8")) : { cards: [], listings: {} };

  // 1. The set's cards from the storefront search, page by page.
  if (!cache.complete) {
    const filters = { sport: [args.sport], year: [args.year], setName: [args.setName] };
    if (args.variant) filters.variant = [args.variant];
    if (args.variantName.length > 0) filters.variantName = args.variantName;
    const byId = new Map();
    let total = Infinity;
    for (let page = 0; byId.size < total; page++) {
      const response = await call(`shop page ${page}`, () =>
        fetch(`${API}/search/shop/results?q=`, {
          method: "POST",
          headers: HEADERS,
          body: JSON.stringify({ ...SHOP_BODY, filters, page }),
          signal: AbortSignal.timeout(20_000),
        }),
      );
      if (!response.ok) throw new Error(`shop search answered ${response.status}`);
      const body = await response.json();
      total = Number(body.totalResults);
      const results = Array.isArray(body.results) ? body.results : [];
      for (const row of results) byId.set(String(row.id), row);
      process.stderr.write(`shop page ${page}: ${results.length} rows, ${byId.size} of ${total}\n`);
      if (results.length === 0) break;
    }
    if (byId.size !== total) throw new Error(`the search listed ${byId.size} distinct cards but says ${total}: refusing a partial set`);
    cache.cards = [...byId.values()].map((row) => ({
      id: String(row.id),
      number: String(row.cardNo ?? "").trim(),
      order: Number(row.cardNoOrder ?? 0),
      players: playersOf(row),
      setName: String(row.setName ?? ""),
      variantName: String(row.variantName ?? ""),
    }));
    // The storefront's own card-number order (a duplicated number stays visible).
    cache.cards.sort((a, b) => a.order - b.order || a.number.localeCompare(b.number, "en", { numeric: true }));
    cache.complete = true;
    writeFileSync(args.cache, JSON.stringify(cache));
  }

  // 2. Each card's own answer.
  let done = 0;
  for (const card of cache.cards) {
    if (cache.listings[card.id] === undefined) {
      const response = await call(`card-listing ${card.id}`, () =>
        fetch(`${API}/marketplace/card/${card.id}/card-listing`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(20_000),
        }),
      );
      cache.listings[card.id] = response.ok ? teamsOf(await response.json()) : { status: response.status };
      if (++done % 25 === 0) {
        writeFileSync(args.cache, JSON.stringify(cache));
        process.stderr.write(`card-listing ${Object.keys(cache.listings).length} of ${cache.cards.length}\n`);
      }
    }
  }
  writeFileSync(args.cache, JSON.stringify(cache));

  const failed = cache.cards.filter((c) => !Array.isArray(cache.listings[c.id]));
  if (failed.length > 0) throw new Error(`${failed.length} cards got no card-listing answer (status ${cache.listings[failed[0].id].status}): refusing a partial capture`);

  // 3. The CSV, in the storefront's card-number order.
  const lines = ["number,player,team"];
  let withTeam = 0;
  let omitted = 0;
  for (const card of cache.cards) {
    const teams = cache.listings[card.id];
    if (args.omitNumber.includes(card.number)) { omitted++; continue; }
    if (teams.length > 0) withTeam++;
    lines.push([card.number, card.players.join("; "), teams.join("; ")].map(csvCell).join(","));
  }
  writeFileSync(args.out, `${lines.join("\n")}\n`);
  for (const b of blocks) {
    process.stderr.write(`429 report: on ${b.label}, first seen ${new Date(b.startedAt).toISOString()}, lasted ${Math.round(b.lastsMs / 1000)} s (until the next answer)\n`);
  }
  const numbers = new Set(cache.cards.map((c) => c.number));
  process.stderr.write(`429 total this run: ${all429.length}\n`);
  process.stdout.write(
    `${args.out}: ${cache.cards.length} cards read, ${omitted} left out, ${numbers.size} distinct numbers, ${withTeam} rows with a team` +
      `, ${all429.length} 429 answers in ${blocks.length} episode(s)\n`,
  );
}

main().catch((error) => {
  if (blocks.length > 0) {
    for (const b of blocks) {
      process.stderr.write(`429 report: on ${b.label}, first seen ${new Date(b.startedAt).toISOString()}, ${b.ended ? "lasted" : "still there after"} ${Math.round(b.lastsMs / 1000)} s\n`);
    }
  }
  process.stderr.write(`429 total this run: ${all429.length}\n`);
  process.stderr.write(`capture stopped: ${error.message}\n`);
  process.exit(error.message === "rate-limited" ? 3 : 1);
});

// @ts-check
/**
 * NEO-422 — where eBay's OAuth hop lands, and where it goes next.
 *
 * eBay allows exactly one HTTPS "accept" URL per RuName, but every Vercel
 * preview has its own origin. So eBay always sends the browser to one fixed
 * static page, and this module forwards it to `/profile/ebay` on the origin
 * that started the connect. The starting origin rides along inside the OAuth
 * `state` parameter, which eBay echoes back untouched:
 *
 *   state = <nonce>                       same origin as the return page
 *   state = <nonce>.<base64url(origin)>   a named origin, allowlisted below
 *
 * The nonce never contains a dot, so the split is on the LAST dot. The nonce is
 * not checked here: `/profile/ebay` verifies it against what it stored before
 * the hop. This module only decides whether the origin is one of ours, so the
 * return page can never bounce an eBay `code` to someone else's site.
 *
 * Two RuNames, two pages, two allowlists:
 *
 * - `/oauth/ebay/return` (production RuName, `data-ebay-return-mode="production"`):
 *   the page's own origin and the two production origins. A production code
 *   never leaves production.
 * - `/oauth/ebay/sandbox-return` (sandbox RuName, `"sandbox"`): the above plus
 *   local dev (`http://localhost`, `http://127.0.0.1`) and Vercel hash previews.
 *
 * WHY A PLAIN JS FILE: the pages that load this (public/oauth/ebay/*.html)
 * are standalone HTML served outside the app shell, so eBay's `code` and
 * `state` never reach PostHog, Sentry, Clerk or any other third party before
 * the forward. Keep this file free of imports and of any network call, and
 * plain enough to run unbundled. It is the ONE copy of the parser: the pages
 * load it as an external same-origin script (no inline script, so a future CSP
 * needs no hash) at `/oauth/ebay/ebay-return.js`, which vite.config.ts serves
 * from here in dev and emits into dist at build; the app (NEO-415's
 * `encodeEbayReturnState`) and the unit tests import it as
 * `@/lib/marketplace/ebay-oauth-return`, typed from the JSDoc below (allowJs).
 *
 * It runs itself only when a page loads it with a `data-ebay-return-mode`
 * attribute on its script tag; imported anywhere else it does nothing.
 */

/** The path on the target origin that finishes the connect. */
export const EBAY_RETURN_DESTINATION = "/profile/ebay";

/** @typedef {"production" | "sandbox"} EbayReturnMode */
/** @typedef {{ ok: true, url: string } | { ok: false }} EbayReturnTarget */

const PRODUCTION_ORIGINS = ["https://www.neonbinder.io", "https://neonbinder.io"];

/** `http://localhost[:port]` and `http://127.0.0.1[:port]`; the port is range-checked below. */
const LOCAL_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::(\d{1,5}))?$/;

/**
 * Vercel's per-deployment hash previews only. Branch aliases
 * (`neonbinder-git-<branch>-…`) are refused: whoever can push a branch name
 * controls that hostname's shape.
 */
const VERCEL_PREVIEW_ORIGIN = /^https:\/\/neonbinder-[a-z0-9]{9}-neon-binder\.vercel\.app$/;

/** Strict base64url alphabet, with optional `=` padding tolerated. */
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * True when `origin` is a bare origin (scheme, host, optional port: no path,
 * query, fragment or userinfo) written exactly as the URL parser writes it.
 * The exact match is what refuses backslashes, tabs and newlines (the parser
 * rewrites or strips them), default ports, uppercase and unicode hosts.
 *
 * @param {string} origin
 * @returns {boolean}
 */
function isBareOrigin(origin) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return parsed.origin === origin;
}

/**
 * Whether the return page in `mode`, served from `currentOrigin`, may forward
 * to `origin`. `origin` must already be a bare origin.
 *
 * @param {string} origin
 * @param {string} currentOrigin
 * @param {EbayReturnMode} mode
 * @returns {boolean}
 */
export function isAllowedEbayReturnOrigin(origin, currentOrigin, mode) {
  if (origin === currentOrigin) return true;
  if (PRODUCTION_ORIGINS.includes(origin)) return true;
  if (mode !== "sandbox") return false;
  if (VERCEL_PREVIEW_ORIGIN.test(origin)) return true;
  const local = LOCAL_ORIGIN.exec(origin);
  if (!local) return false;
  if (local[1] === undefined) return true;
  const port = Number(local[1]);
  return port >= 1 && port <= 65535;
}

/**
 * @param {string} text
 * @returns {string}
 */
function base64UrlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * `null` for anything that is not well-formed base64url carrying UTF-8.
 *
 * @param {string} encoded
 * @returns {string | null}
 */
function base64UrlDecode(encoded) {
  if (!BASE64URL.test(encoded)) return null;
  const unpadded = encoded.replace(/=+$/, "");
  // A single leftover character can never be a whole byte.
  if (unpadded.length % 4 === 1) return null;
  const base64 = unpadded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Where the return page should send the browser, or `{ ok: false }` when it
 * must not send it anywhere.
 *
 * `search` is the page's raw query string (`location.search`, with or without
 * its leading `?`). It is appended to the destination exactly as given, never
 * re-encoded, so eBay's `code`, `state`, `expires_in` (or its decline params,
 * `error` and `error_description`) reach `/profile/ebay` byte for byte.
 *
 * @param {string} search
 * @param {string} currentOrigin
 * @param {EbayReturnMode} mode
 * @returns {EbayReturnTarget}
 */
export function ebayReturnTarget(search, currentOrigin, mode) {
  if (mode !== "production" && mode !== "sandbox") return { ok: false };
  const query = search.startsWith("?") ? search.slice(1) : search;
  const state = new URLSearchParams(query).get("state");
  if (!state) return { ok: false };

  const dot = state.lastIndexOf(".");
  let origin;
  if (dot === -1) {
    origin = currentOrigin;
  } else {
    if (dot === 0) return { ok: false };
    const decoded = base64UrlDecode(state.slice(dot + 1));
    if (decoded === null) return { ok: false };
    origin = decoded;
  }

  if (!isBareOrigin(origin)) return { ok: false };
  if (!isAllowedEbayReturnOrigin(origin, currentOrigin, mode)) return { ok: false };

  const passThrough = query ? `?${query}` : "";
  return { ok: true, url: `${origin}${EBAY_RETURN_DESTINATION}${passThrough}` };
}

/**
 * The `state` value to hand eBay when starting a connect from `origin`
 * (normally `window.location.origin`). Throws on a nonce that is empty or
 * contains a dot, or on an origin that is not a bare origin: both are caller
 * bugs, and a malformed state would only strand the user on the return page.
 *
 * @param {string} nonce
 * @param {string} origin
 * @returns {string}
 */
export function encodeEbayReturnState(nonce, origin) {
  if (!nonce || nonce.includes(".")) {
    throw new Error("encodeEbayReturnState: the nonce must be non-empty and contain no dot");
  }
  if (!isBareOrigin(origin)) {
    throw new Error("encodeEbayReturnState: origin must be a bare origin like https://example.com");
  }
  return `${nonce}.${base64UrlEncode(origin)}`;
}

/** The script tag the return pages load this module with. */
const SCRIPT_SELECTOR = "script[data-ebay-return-mode]";

/**
 * Drives a return page: forwards with `location.replace` (so Back from
 * `/profile/ebay` skips the hop), or swaps the "taking you back" status for
 * the lost-trip message. The mode comes from the page's own script tag; a page
 * without a valid one never forwards.
 *
 * @param {{
 *   document: Document,
 *   location: { search: string, origin: string, replace(url: string): void },
 * }} env
 * @returns {EbayReturnTarget}
 */
export function runEbayReturnPage({ document, location }) {
  const mode = document.querySelector(SCRIPT_SELECTOR)?.getAttribute("data-ebay-return-mode");
  const target =
    mode === "production" || mode === "sandbox"
      ? ebayReturnTarget(location.search, location.origin, mode)
      : /** @type {EbayReturnTarget} */ ({ ok: false });
  if (target.ok) {
    location.replace(target.url);
    return target;
  }
  document.querySelector('[data-ebay-return="status"]')?.setAttribute("hidden", "");
  document.querySelector('[data-ebay-return="lost"]')?.removeAttribute("hidden");
  document.title = "eBay trip got lost · NeonBinder";
  return target;
}

if (typeof window !== "undefined" && typeof document !== "undefined" && document.querySelector(SCRIPT_SELECTOR)) {
  runEbayReturnPage({ document, location: window.location });
}

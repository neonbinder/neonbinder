/**
 * NEO-360 — the rules of a public share link, shared by Convex
 * (`convex/collectionContainers.ts`, `convex/publicCollection.ts`) and the
 * client (the Share panel, the public pages), so the two can never disagree
 * about what a link looks like.
 *
 * A binder's link is `/u/<username>/binders/<slug>-<slugKey>`:
 *   - `slug` is the readable part the collector controls ("ohtani-rainbow").
 *   - `slugKey` is 6 random characters, minted once, so a visitor who knows
 *     the username and the binder's name still cannot find it. "Reset link"
 *     mints a new one.
 * The shelves have fixed paths: `want-list`, `up-for-trade`, `for-sale`.
 * Main, a single box and a set have no link at all.
 */

export const SLUG_MIN_CHARS = 3;
export const SLUG_MAX_CHARS = 50;
export const SLUG_KEY_CHARS = 6;

/** Lowercase letters and digits in runs joined by single hyphens. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_KEY_RE = /^[a-z0-9]{6}$/;
const KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Usernames as `publicProfile.upsertPublicProfile` stores them, bounded for a URL. */
export const USERNAME_RE = /^[a-z0-9-]{1,64}$/;

/** The longest binder path segment: slug, hyphen, key. */
export const MAX_BINDER_PATH_CHARS = SLUG_MAX_CHARS + 1 + SLUG_KEY_CHARS;

export type ShelfPath = "want-list" | "up-for-trade" | "for-sale";

/** "'96 Contenders" -> "96-contenders"; folds accents, drops what a URL can't say. */
function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Cut to `SLUG_MAX_CHARS`, at a hyphen when one is close, never ending on one. */
function cut(slug: string): string {
  if (slug.length <= SLUG_MAX_CHARS) return slug;
  const head = slug.slice(0, SLUG_MAX_CHARS);
  const lastHyphen = head.lastIndexOf("-");
  const trimmed = lastHyphen >= SLUG_MIN_CHARS ? head.slice(0, lastHyphen) : head;
  return trimmed.replace(/-+$/g, "");
}

/** The readable part suggested for a binder's name. Always valid. */
export function suggestSlug(name: string): string {
  const slug = cut(fold(name));
  if (slug.length >= SLUG_MIN_CHARS) return slug;
  return slug ? `${slug}-binder` : "binder";
}

/**
 * What the collector typed, as a stored slug: trimmed, lower-cased, spaces
 * and underscores as hyphens. Null when it still isn't one (wrong characters,
 * doubled or edge hyphens, too short or too long). Never rewrites beyond that:
 * the collector sees exactly what they will get.
 */
export function cleanSlug(raw: string): string | null {
  const slug = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (slug.length < SLUG_MIN_CHARS || slug.length > SLUG_MAX_CHARS) return null;
  return SLUG_RE.test(slug) ? slug : null;
}

/** Why `cleanSlug` said no, in words for the Share panel and the refusal. */
export const SLUG_RULE =
  `Use ${SLUG_MIN_CHARS} to ${SLUG_MAX_CHARS} lowercase letters, numbers and single hyphens, like ohtani-rainbow.`;

export function isSlugKey(raw: string): boolean {
  return SLUG_KEY_RE.test(raw);
}

/**
 * Six characters from `[a-z0-9]` (about 2.2 billion values), drawn without
 * bias from `crypto.getRandomValues`, which every Convex runtime and browser
 * has.
 */
export function mintSlugKey(): string {
  let out = "";
  const bytes = new Uint8Array(16);
  while (out.length < SLUG_KEY_CHARS) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      // 252 = 7 * 36: drop the tail so every character is equally likely.
      if (byte >= 252) continue;
      out += KEY_ALPHABET[byte % KEY_ALPHABET.length];
      if (out.length === SLUG_KEY_CHARS) break;
    }
  }
  return out;
}

/** `ohtani-rainbow` + `k7f3q2` -> `ohtani-rainbow-k7f3q2`. */
export function binderPath(slug: string, slugKey: string): string {
  return `${slug}-${slugKey}`;
}

/** The other way. Null for anything that is not a well-formed binder path. */
export function splitBinderPath(path: string): { slug: string; slugKey: string } | null {
  if (path.length > MAX_BINDER_PATH_CHARS) return null;
  const at = path.lastIndexOf("-");
  if (at < 0) return null;
  const slug = path.slice(0, at);
  const slugKey = path.slice(at + 1);
  if (!isSlugKey(slugKey)) return null;
  if (slug.length < SLUG_MIN_CHARS || slug.length > SLUG_MAX_CHARS || !SLUG_RE.test(slug)) return null;
  return { slug, slugKey };
}

/** A binder's public path under the site root. */
export function binderHref(username: string, slug: string, slugKey: string): string {
  return `/u/${username}/binders/${binderPath(slug, slugKey)}`;
}

/** A shelf's public path under the site root. */
export function shelfHref(username: string, shelf: ShelfPath): string {
  return `/u/${username}/${shelf}`;
}

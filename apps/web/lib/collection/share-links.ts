/**
 * NEO-360 — the rules of a public share link, shared by Convex
 * (`convex/collectionContainers.ts`, `convex/publicCollection.ts`) and the
 * client (the Share panel, the public pages), so the two can never disagree
 * about what a link looks like.
 *
 * A binder's link is `/u/<username>/binders/<slug>`, plain and readable
 * ("ohtani-rainbow"). The collector controls `slug`; it is unique among their
 * binders and a rename never moves it. A private binder's link reads as not
 * found, so the switch, not the link, is what keeps a binder private.
 * The shelves have fixed paths: `want-list`, `up-for-trade`, `for-sale`.
 * Main, a single box and a set have no link at all.
 */

export const SLUG_MIN_CHARS = 3;
export const SLUG_MAX_CHARS = 50;

/** Lowercase letters and digits in runs joined by single hyphens. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Usernames as `publicProfile.upsertPublicProfile` stores them, bounded for a URL. */
export const USERNAME_RE = /^[a-z0-9-]{1,64}$/;

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

/** Is `path` a well-formed binder link name? */
export function isSlug(path: string): boolean {
  return path.length >= SLUG_MIN_CHARS && path.length <= SLUG_MAX_CHARS && SLUG_RE.test(path);
}

/**
 * `base`, or `base-2`, `base-3`, ... : the first one `taken` says is free,
 * cut so the suffix still fits. Callers pass a bounded set (one collector's
 * binders), so this always ends.
 */
export function freeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const head = base.slice(0, SLUG_MAX_CHARS - suffix.length).replace(/-+$/g, "");
    const slug = `${head}${suffix}`;
    if (!taken.has(slug)) return slug;
  }
}

/** A binder's public path under the site root. */
export function binderHref(username: string, slug: string): string {
  return `/u/${username}/binders/${slug}`;
}

/** A shelf's public path under the site root. */
export function shelfHref(username: string, shelf: ShelfPath): string {
  return `/u/${username}/${shelf}`;
}

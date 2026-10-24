/**
 * NEO-358 — what a collector's typed card search MEANS, as a pure function.
 *
 * Jason's rule for the free-text card search:
 *
 *   - Unquoted words are separate TERMS. Every one must appear somewhere in the
 *     card's listing title, in any order.
 *   - Quoted text is a PHRASE. That exact string (case-insensitive) must appear
 *     in the title.
 *
 * Convex full-text search is OR over the query's words with relevance ranking,
 * so it cannot express either rule by itself. The reader
 * (`collectionCatalog.search`) searches on the words (`searchText`), then keeps
 * only the hits `titleMatches` accepts.
 *
 * An unbalanced quote reads as a phrase running to the end of the text, so a
 * collector halfway through typing `"Chrome Refr` already gets the phrase they
 * are typing rather than a different search.
 *
 * Pure on purpose: no ctx, no env, no FE import.
 */

export type TitleQuery = {
  /** Unquoted words, lower-cased. Each must appear in the title. */
  terms: string[];
  /** Quoted strings, lower-cased, inner whitespace collapsed. Each must appear verbatim. */
  phrases: string[];
};

/** Lower-case, collapse whitespace, trim. The form both sides are compared in. */
export function foldTitleText(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Split typed text into terms and phrases. */
export function parseTitleQuery(raw: string): TitleQuery {
  const terms: string[] = [];
  const phrases: string[] = [];
  // Straight and curly double quotes both open and close a phrase: a phone
  // keyboard types curly ones.
  const parts = raw.replace(/[“”]/g, '"').split('"');
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const phrase = foldTitleText(part);
      if (phrase) phrases.push(phrase);
      return;
    }
    for (const word of foldTitleText(part).split(" ")) {
      if (word) terms.push(word);
    }
  });
  return { terms, phrases };
}

/** True when the query has nothing to look for. */
export function isEmptyTitleQuery(query: TitleQuery): boolean {
  return query.terms.length === 0 && query.phrases.length === 0;
}

/**
 * The text handed to the search index: every term and every phrase's words.
 * Order does not matter to the index; the filter enforces the rule.
 */
export function searchTextFor(query: TitleQuery): string {
  return [...query.terms, ...query.phrases].join(" ");
}

/** Does `title` satisfy every term and every phrase? */
export function titleMatches(title: string, query: TitleQuery): boolean {
  const folded = foldTitleText(title);
  return (
    query.terms.every((t) => folded.includes(t)) &&
    query.phrases.every((p) => folded.includes(p))
  );
}

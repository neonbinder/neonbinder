/**
 * NEO-496 — a set's publisher checklist: the limits, the section key, the
 * chunking rule and the ONE writer of `publishedChecklistLinks`.
 *
 * ## Why bytes, not just rows
 *
 * A row's caps are counted in characters (UTF-16 units). The worst legal row
 * (20 players and 8 teams of 120 characters) is ~3.5 KB in ASCII and ~10 KB
 * in three-byte characters, so 2,000 worst rows are ~20 MB: over Convex's
 * 16 MiB limit on a function's arguments, return value and reads. Every cap
 * below that bounds a read or a write is therefore ALSO a byte cap, measured
 * with `getConvexSize` (the size Convex itself counts; it runs in the browser
 * too, so the client's batcher can use `storedRowBytes`).
 *
 * ## Client-safe
 *
 * Imports only `convex/values` at runtime (the server helpers take their
 * context as a type), so the client parser can import `sectionKeyOf` and the
 * limits from here without pulling the server graph into the bundle.
 */
import { ConvexError, getConvexSize } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { PublishedChecklistStoredRow } from "./publishedChecklistCheck";

// ───────────────────────────────────────────────────────────────────────────
// Limits
// ───────────────────────────────────────────────────────────────────────────

/** A section's name, in characters (no control characters). */
export const MAX_SECTION_NAME = 120;
/** A folded section key; longer is refused (case folding can grow a name). */
export const MAX_SECTION_KEY = 240;
/** Rows in one section (the per-leaf paste cap, `MAX_PUBLISHED_CHECKLIST_ROWS`). */
export const MAX_SECTION_ROWS = 2_000;
/** Sections in one checklist. */
export const MAX_SECTIONS = 1_000;
/** Rows in one checklist. */
export const MAX_CHECKLIST_ROWS = 50_000;
/** One section's stored rows, summed with `getConvexSize`. Always fits one batch. */
export const MAX_SECTION_BYTES = 2 * 1024 * 1024;
/** One checklist's stored rows. */
export const MAX_CHECKLIST_BYTES = 16 * 1024 * 1024;
/** A chunk document's rows; a new chunk starts past this. */
export const CHUNK_ROW_BYTES = 256 * 1024;
/** One `addSections` call: whole sections only. */
export const BATCH_MAX_SECTIONS = 100;
export const BATCH_MAX_ROWS = 2_000;
export const BATCH_MAX_BYTES = 4 * 1024 * 1024;
/** What one leaf's fetch may read; over it, the fetch runs without the checklist. */
export const LEAF_READ_MAX_ROWS = 2_000;
export const LEAF_READ_MAX_BYTES = 4 * 1024 * 1024;
/** Sections one row may link to. */
export const MAX_LINKS_PER_ROW = 50;
/** Links across every row of one set. */
export const MAX_LINKS_PER_SET = 4_000;
/** An upload idle this long (since its last batch) is abandoned. */
export const ABANDON_MS = 60 * 60 * 1000;
/** One purge run: at most this many chunk deletes (~6 MiB read) … */
export const PURGE_CHUNKS_PER_RUN = 24;
/** … and this many sections. */
export const PURGE_SECTIONS_PER_RUN = 200;
/** The uploaded file's name, in characters. */
export const MAX_FILE_NAME = 200;
/**
 * What `createdByUserId` reads once its account is deleted
 * (`publishedChecklists.forgetUploader`). Never a Clerk subject (those start
 * `user_`), so no signed-in caller ever matches it.
 */
export const DELETED_UPLOADER = "deleted-user";
/** One `forgetUploader` run: at most this many headers and this many links. */
export const FORGET_UPLOADER_PER_RUN = 200;

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * A section's key: NFC, trimmed, inner whitespace collapsed, lower-cased.
 *
 * A STORED FORMAT: links name sections by it, across replaces, so changing
 * it needs a re-key migration of `publishedChecklistSections` and
 * `publishedChecklistLinks`. Rule 4: the key is always the publisher's own
 * section name (input data), never an NB title or a marketplace value.
 */
export function sectionKeyOf(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Characters that print nothing yet change what a name shows or how it
 * compares: zero-width space, non-joiner and joiner, the left-to-right and
 * right-to-left marks (U+200B–U+200F), and the bidi embeddings, overrides
 * and isolates (U+202A–U+202E, U+2066–U+2069) that can make a name read
 * differently from what it holds ("Trojan Source"). A section, group or file
 * name carrying one is refused here and skipped by the client's grouping
 * (`hasHiddenNameChars`), so the two always agree.
 */
const HIDDEN_FORMAT_CHARS = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

/** True when `name` holds a character `HIDDEN_FORMAT_CHARS` refuses. Client-safe. */
export function hasHiddenNameChars(name: string): boolean {
  return HIDDEN_FORMAT_CHARS.test(name);
}

/**
 * A section (or group) name as stored: trimmed, 1–`MAX_SECTION_NAME`
 * characters, no control characters, no hidden direction or zero-width
 * characters, and a key within `MAX_SECTION_KEY`. `what` names it in the
 * refusal ("Section 3's name").
 */
export function checkSectionName(name: string, what: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new ConvexError(`${what} is blank.`);
  if (trimmed.length > MAX_SECTION_NAME) {
    throw new ConvexError(`${what} is over ${MAX_SECTION_NAME} characters.`);
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw new ConvexError(`${what} has a control character in it.`);
  }
  if (hasHiddenNameChars(trimmed)) {
    throw new ConvexError(`${what} has a hidden direction or zero-width character in it.`);
  }
  if (sectionKeyOf(trimmed).length > MAX_SECTION_KEY) {
    throw new ConvexError(`${what} is too long once folded.`);
  }
  return trimmed;
}

/** The uploaded file's name as stored, or a refusal. */
export function checkFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (trimmed.length === 0) throw new ConvexError("The file name is blank.");
  if (trimmed.length > MAX_FILE_NAME) {
    throw new ConvexError(`The file name is over ${MAX_FILE_NAME} characters.`);
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw new ConvexError("The file name has a control character in it.");
  }
  if (hasHiddenNameChars(trimmed)) {
    throw new ConvexError("The file name has a hidden direction or zero-width character in it.");
  }
  return trimmed;
}

/** One stored row's size as Convex counts it. */
export function storedRowBytes(row: PublishedChecklistStoredRow): number {
  return getConvexSize(row);
}

/**
 * Splits a section's rows into chunks: rows are added in order, and a new
 * chunk starts when the next row would take the current one past
 * `CHUNK_ROW_BYTES`. Never empty for a non-empty input; a single row larger
 * than the cap (impossible within a row's own caps) still gets a chunk.
 */
export function chunkRowsByBytes<T extends PublishedChecklistStoredRow>(
  rows: T[],
  sizeOf: (row: T) => number = storedRowBytes,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = sizeOf(row);
    if (current.length > 0 && bytes + size > CHUNK_ROW_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ───────────────────────────────────────────────────────────────────────────
// Reads
// ───────────────────────────────────────────────────────────────────────────

type ReadCtx = Pick<QueryCtx, "db">;
type WriteCtx = Pick<MutationCtx, "db">;

/** The set's ready checklist header, or null. Newest wins if two ever exist. */
export async function readyChecklistForSet(
  db: ReadCtx["db"],
  setId: Id<"selectorOptions">,
): Promise<Doc<"publishedChecklists"> | null> {
  return await db
    .query("publishedChecklists")
    .withIndex("by_set_and_status", (q) =>
      q.eq("setId", setId).eq("status", "ready"),
    )
    .order("desc")
    .first();
}

/** One section of a checklist by its key, or null. */
export async function sectionByKey(
  db: ReadCtx["db"],
  checklistId: Id<"publishedChecklists">,
  sectionKey: string,
): Promise<Doc<"publishedChecklistSections"> | null> {
  return await db
    .query("publishedChecklistSections")
    .withIndex("by_checklist_and_key", (q) =>
      q.eq("checklistId", checklistId).eq("sectionKey", sectionKey),
    )
    .unique();
}

/** The keys (folded here) the checklist does NOT hold. */
export async function missingChecklistSectionKeys(
  db: ReadCtx["db"],
  checklistId: Id<"publishedChecklists">,
  keys: string[],
): Promise<string[]> {
  const missing: string[] = [];
  for (const key of new Set(keys.map(sectionKeyOf))) {
    if ((await sectionByKey(db, checklistId, key)) === null) missing.push(key);
  }
  return missing;
}

/** The row's links, bounded (the writer keeps at most `MAX_LINKS_PER_ROW`). */
export async function linksForRow(
  db: ReadCtx["db"],
  rowId: Id<"selectorOptions">,
): Promise<Doc<"publishedChecklistLinks">[]> {
  return await db
    .query("publishedChecklistLinks")
    .withIndex("by_selector_option_and_key", (q) => q.eq("selectorOptionId", rowId))
    .take(MAX_LINKS_PER_ROW + 1);
}

/**
 * Every link written under the set (≤ `MAX_LINKS_PER_SET`), key order. The
 * read for any module outside the sanctioned ones
 * (`publishedChecklistLinks.pin.test.ts` flags a direct query elsewhere).
 */
export async function linksUnderSet(
  db: ReadCtx["db"],
  setId: Id<"selectorOptions">,
): Promise<Doc<"publishedChecklistLinks">[]> {
  return await db
    .query("publishedChecklistLinks")
    .withIndex("by_set_and_key", (q) => q.eq("setId", setId))
    .take(MAX_LINKS_PER_SET);
}

// ───────────────────────────────────────────────────────────────────────────
// The single writer
// ───────────────────────────────────────────────────────────────────────────

const LINKABLE_LEVELS = new Set(["variantType", "insert", "parallel"]);
/** variantType → insert → parallel sits at most three below the set. */
const MAX_WALK = 8;

/**
 * Per-mutation cache, so a caller writing many rows' links in one mutation
 * (`storeReconciledOptions`) reads the set's ready checklist and its link
 * count once. Create one per mutation; never share across mutations.
 */
export type ChecklistLinkWriteCache = {
  ready: Map<string, Doc<"publishedChecklists"> | null>;
  setLinkCount: Map<string, number>;
};

export function newChecklistLinkWriteCache(): ChecklistLinkWriteCache {
  return { ready: new Map(), setLinkCount: new Map() };
}

async function rowIsUnderSet(
  db: ReadCtx["db"],
  row: Doc<"selectorOptions">,
  setId: Id<"selectorOptions">,
): Promise<boolean> {
  let cursor = row.parentId;
  for (let depth = 0; cursor && depth < MAX_WALK; depth += 1) {
    if (cursor === setId) return true;
    const node = await db.get(cursor);
    if (!node || node.level === "setName") return false;
    cursor = node.parentId;
  }
  return false;
}

/**
 * NEO-496 D2 — replace a row's checklist links with `keys`. THE ONLY code
 * that inserts into `publishedChecklistLinks` (`publishedChecklistLinks.pin.
 * test.ts` greps for any other); deletes happen here, in the row-delete
 * sweep, the variant-subtree wipe and the reset, and nowhere else.
 *
 * `keys` are section keys or names; they are folded and de-duplicated here.
 * Writes nothing when the row's links already equal them (no-op, no
 * invalidation). Refuses (ConvexError, nothing written) when:
 * - the row is not a variantType / insert / parallel under `setId`;
 * - more than `MAX_LINKS_PER_ROW` keys;
 * - a NEWLY added key is not a section of the set's current READY checklist
 *   (also when the set has none). A key the row ALREADY holds in this set
 *   passes through even when a replaced or removed checklist no longer has
 *   it (D2, rule 5: a link stays until the operator changes it), so a dialog
 *   that echoes the row's full key set, stale keys included, saves cleanly;
 * - the set would hold more than `MAX_LINKS_PER_SET` links.
 * `keys: []` clears the row's links, with or without a checklist.
 *
 * A link left under another set (the row was moved) is deleted by any write
 * here: links count only in the row's own set.
 */
export async function setRowChecklistSections(
  ctx: WriteCtx,
  args: {
    rowId: Id<"selectorOptions">;
    setId: Id<"selectorOptions">;
    keys: string[];
    userId: string;
  },
  cache: ChecklistLinkWriteCache = newChecklistLinkWriteCache(),
): Promise<{ added: number; removed: number }> {
  const { db } = ctx;
  const row = await db.get(args.rowId);
  if (!row) throw new ConvexError("That row no longer exists.");
  if (!LINKABLE_LEVELS.has(row.level) || !(await rowIsUnderSet(db, row, args.setId))) {
    throw new ConvexError("Only a variant, insert or parallel of this set can use its checklist.");
  }

  const wanted = [...new Set(args.keys.map(sectionKeyOf).filter((k) => k.length > 0))];
  if (wanted.length > MAX_LINKS_PER_ROW) {
    throw new ConvexError(
      `One row can use at most ${MAX_LINKS_PER_ROW} checklist sections; this asks for ${wanted.length}.`,
    );
  }
  for (const key of wanted) {
    if (key.length > MAX_SECTION_KEY) {
      throw new ConvexError("A checklist section name is too long.");
    }
  }

  const existing = await linksForRow(db, args.rowId);
  const keep = new Set<string>();
  const doomed: Doc<"publishedChecklistLinks">[] = [];
  for (const link of existing) {
    if (link.setId === args.setId && wanted.includes(link.sectionKey) && !keep.has(link.sectionKey)) {
      keep.add(link.sectionKey);
    } else {
      doomed.push(link);
    }
  }
  const toAdd = wanted.filter((key) => !keep.has(key));
  if (toAdd.length === 0 && doomed.length === 0) return { added: 0, removed: 0 };

  if (toAdd.length > 0) {
    const setKey = args.setId as string;
    let ready = cache.ready.get(setKey);
    if (ready === undefined) {
      ready = await readyChecklistForSet(db, args.setId);
      cache.ready.set(setKey, ready);
    }
    if (!ready) {
      throw new ConvexError("This set has no checklist to use sections from.");
    }
    // Only the keys this write adds: kept keys may be stale (see above).
    const missing = await missingChecklistSectionKeys(db, ready._id, toAdd);
    if (missing.length > 0) {
      throw new ConvexError(
        `The set's checklist has no section named “${missing[0]}”.`,
      );
    }
    let count = cache.setLinkCount.get(setKey);
    if (count === undefined) {
      count = (
        await db
          .query("publishedChecklistLinks")
          .withIndex("by_set_and_key", (q) => q.eq("setId", args.setId))
          .take(MAX_LINKS_PER_SET + 1)
      ).length;
    }
    const removedHere = doomed.filter((l) => l.setId === args.setId).length;
    const next = count - removedHere + toAdd.length;
    if (next > MAX_LINKS_PER_SET) {
      throw new ConvexError(
        `A set can use at most ${MAX_LINKS_PER_SET} checklist links across its rows.`,
      );
    }
    cache.setLinkCount.set(setKey, next);
  } else if (cache.setLinkCount.has(args.setId as string)) {
    const setKey = args.setId as string;
    cache.setLinkCount.set(
      setKey,
      cache.setLinkCount.get(setKey)! - doomed.filter((l) => l.setId === args.setId).length,
    );
  }

  for (const link of doomed) await db.delete(link._id);
  const now = Date.now();
  for (const sectionKey of toAdd) {
    await db.insert("publishedChecklistLinks", {
      setId: args.setId,
      selectorOptionId: args.rowId,
      sectionKey,
      createdAt: now,
      createdByUserId: args.userId,
    });
  }
  return { added: toAdd.length, removed: doomed.length };
}

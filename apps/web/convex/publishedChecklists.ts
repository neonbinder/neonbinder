/**
 * NEO-496 — a set's publisher checklist: upload, replace, remove, read.
 *
 * An admin uploads ONE publisher checklist per set (.xlsx / .pdf / .csv /
 * .tsv / .txt / paste, parsed in the browser). The client sends it in
 * batches of whole sections:
 *
 *   start → addSections × N → finish
 *
 * `start` writes an `uploading` header; each `addSections` re-checks its
 * sections (names, keys, every row through `checkPublishedChecklist`, row
 * and byte caps) and writes them with their rows in byte-bounded chunks;
 * `finish` checks the counts, retires the set's previous ready checklist and
 * makes this one ready. `remove` retires the ready one. A retired checklist,
 * or an upload idle for `ABANDON_MS`, is deleted by `purge`, a self-chaining
 * scheduled job (no cron).
 *
 * Upload, replace and remove write nothing to NB rows or cards, and never
 * touch `publishedChecklistLinks` (D2, rule 5): a link names a section KEY
 * and is resolved against the set's current ready checklist at read time.
 *
 * Every public function is `requireAdmin`. The subscribed reads return
 * null / an empty page to a signed-out caller (a sign-out mid-session must
 * not crash the screen) and throw for a signed-in non-admin. Every return is
 * an explicit projection, never a whole document.
 */
import { ConvexError, v, type Infer } from "convex/values";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUserIdentity, requireAdmin } from "./auth";
import { findSetForSelectorOption } from "./lib/selectorAncestry";
import {
  publishedChecklistFormatValidator,
  publishedChecklistStoredRowValidator,
} from "./schema";
import {
  checkPublishedChecklist,
  publishedChecklistRowValidator,
} from "./lib/publishedChecklistCheck";
import {
  ABANDON_MS,
  BATCH_MAX_BYTES,
  BATCH_MAX_ROWS,
  BATCH_MAX_SECTIONS,
  DELETED_UPLOADER,
  FORGET_UPLOADER_PER_RUN,
  LEAF_READ_MAX_BYTES,
  LEAF_READ_MAX_ROWS,
  MAX_CHECKLIST_BYTES,
  MAX_CHECKLIST_ROWS,
  MAX_SECTION_BYTES,
  MAX_SECTION_ROWS,
  MAX_SECTIONS,
  PURGE_CHUNKS_PER_RUN,
  PURGE_SECTIONS_PER_RUN,
  checkFileName,
  checkSectionName,
  chunkRowsByBytes,
  linksForRow,
  linksUnderSet,
  readyChecklistForSet,
  sectionByKey,
  sectionKeyOf,
  storedRowBytes,
} from "./lib/publishedChecklistSections";

// ───────────────────────────────────────────────────────────────────────────
// Return shapes
// ───────────────────────────────────────────────────────────────────────────

/** One section as a list or the variant sync reads it (no rows). */
export const sectionSummaryValidator = v.object({
  ordinal: v.number(),
  name: v.string(),
  sectionKey: v.string(),
  group: v.optional(v.string()),
  rowCount: v.number(),
  byteSize: v.number(),
  firstNumber: v.optional(v.string()),
  lastNumber: v.optional(v.string()),
});
export type SectionSummary = Infer<typeof sectionSummaryValidator>;

/** One section a leaf resolves to. */
export const leafSectionValidator = v.object({
  sectionKey: v.string(),
  name: v.string(),
  rowCount: v.number(),
});

function sectionSummary(doc: Doc<"publishedChecklistSections">): SectionSummary {
  return {
    ordinal: doc.ordinal,
    name: doc.name,
    sectionKey: doc.sectionKey,
    ...(doc.group !== undefined ? { group: doc.group } : {}),
    rowCount: doc.rowCount,
    byteSize: doc.byteSize,
    ...(doc.firstNumber !== undefined ? { firstNumber: doc.firstNumber } : {}),
    ...(doc.lastNumber !== undefined ? { lastNumber: doc.lastNumber } : {}),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Shared helpers
// ───────────────────────────────────────────────────────────────────────────

/** The header an upload call may write to: the caller's own, still uploading. */
async function ownUploadingHeader(
  ctx: MutationCtx,
  checklistId: Id<"publishedChecklists">,
  userId: string,
): Promise<Doc<"publishedChecklists">> {
  const header = await ctx.db.get(checklistId);
  if (!header || header.createdByUserId !== userId) {
    throw new ConvexError("That checklist upload was not found.");
  }
  if (header.status !== "uploading") {
    throw new ConvexError(
      "That checklist upload has already finished or was stopped. Upload the file again.",
    );
  }
  return header;
}

/** Retire one header and queue its purge. */
async function retire(ctx: MutationCtx, header: Doc<"publishedChecklists">): Promise<void> {
  const now = Date.now();
  await ctx.db.patch(header._id, { status: "retired", retiredAt: now });
  await ctx.scheduler.runAfter(0, internal.publishedChecklists.purge, {
    checklistId: header._id,
  });
}

/** Retire the set's ready checklist(s); returns how many. */
async function retireReady(ctx: MutationCtx, setId: Id<"selectorOptions">): Promise<number> {
  // One in practice: finish retires the old one in the same transaction as it
  // readies the new one, and two racing finishes conflict on this range.
  const ready = await ctx.db
    .query("publishedChecklists")
    .withIndex("by_set_and_status", (q) => q.eq("setId", setId).eq("status", "ready"))
    .take(10);
  for (const header of ready) await retire(ctx, header);
  return ready.length;
}

/**
 * Steps 1–5 of a leaf's read (D9): its set, the set's ready checklist, its
 * links in that set, and the sections they resolve to (ordinal order). No
 * chunk is read. A link whose key the current checklist lacks resolves to
 * nothing, silently (D2).
 */
async function resolveLeaf(
  db: QueryCtx["db"],
  selectorOptionId: Id<"selectorOptions">,
): Promise<
  | { kind: "noSet" }
  | {
      kind: "set";
      setId: Id<"selectorOptions">;
      ready: Doc<"publishedChecklists"> | null;
      linkedKeys: string[];
      sections: Doc<"publishedChecklistSections">[];
    }
> {
  const setId = await findSetForSelectorOption({ db }, selectorOptionId);
  if (!setId) return { kind: "noSet" };
  const links = (await linksForRow(db, selectorOptionId)).filter((l) => l.setId === setId);
  const linkedKeys = [...new Set(links.map((l) => l.sectionKey))];
  const ready = await readyChecklistForSet(db, setId);
  if (!ready) return { kind: "set", setId, ready: null, linkedKeys, sections: [] };
  const sections: Doc<"publishedChecklistSections">[] = [];
  for (const key of linkedKeys) {
    const section = await sectionByKey(db, ready._id, key);
    if (section) sections.push(section);
  }
  sections.sort((a, b) => a.ordinal - b.ordinal);
  return { kind: "set", setId, ready, linkedKeys, sections };
}

function sumOf(sections: Doc<"publishedChecklistSections">[]) {
  let rowCount = 0;
  let byteSize = 0;
  for (const s of sections) {
    rowCount += s.rowCount;
    byteSize += s.byteSize;
  }
  return { rowCount, byteSize };
}

const tooBig = (sum: { rowCount: number; byteSize: number }) =>
  sum.rowCount > LEAF_READ_MAX_ROWS || sum.byteSize > LEAF_READ_MAX_BYTES;

// ───────────────────────────────────────────────────────────────────────────
// Upload
// ───────────────────────────────────────────────────────────────────────────

/**
 * Begin an upload for a set. Retires the caller's own unfinished upload for
 * this set (a second tab, or a retry after a failed batch); another admin's
 * upload is left alone, and the last `finish` wins. The upload is abandoned
 * (retired and purged) after `ABANDON_MS` without a batch.
 */
export const start = mutation({
  args: {
    setId: v.id("selectorOptions"),
    fileName: v.string(),
    format: publishedChecklistFormatValidator,
  },
  returns: v.object({ checklistId: v.id("publishedChecklists") }),
  handler: async (ctx, args) => {
    const userId = await requireAdmin(ctx);
    const set = await ctx.db.get(args.setId);
    if (!set || set.level !== "setName") {
      throw new ConvexError("A checklist can only be added to a set.");
    }
    const fileName = checkFileName(args.fileName);

    const unfinished = await ctx.db
      .query("publishedChecklists")
      .withIndex("by_set_and_status", (q) =>
        q.eq("setId", args.setId).eq("status", "uploading"),
      )
      .take(50);
    for (const header of unfinished) {
      if (header.createdByUserId === userId) await retire(ctx, header);
    }

    const now = Date.now();
    const checklistId = await ctx.db.insert("publishedChecklists", {
      setId: args.setId,
      status: "uploading",
      fileName,
      format: args.format,
      createdByUserId: userId,
      startedAt: now,
      lastActivityAt: now,
      sectionCount: 0,
      rowCount: 0,
      byteSize: 0,
    });
    await ctx.scheduler.runAfter(ABANDON_MS, internal.publishedChecklists.expireUpload, {
      checklistId,
    });
    return { checklistId };
  },
});

/**
 * One batch of whole sections, in file order. `firstOrdinal` must equal the
 * sections received so far, so a replayed or skipped batch is refused rather
 * than doubled or gapped. Refused whole (nothing written) on any limit.
 */
export const addSections = mutation({
  args: {
    checklistId: v.id("publishedChecklists"),
    firstOrdinal: v.number(),
    sections: v.array(
      v.object({
        name: v.string(),
        group: v.optional(v.string()),
        rows: v.array(publishedChecklistRowValidator),
      }),
    ),
  },
  returns: v.object({
    sectionCount: v.number(),
    rowCount: v.number(),
    byteSize: v.number(),
  }),
  handler: async (ctx, args) => {
    const userId = await requireAdmin(ctx);
    const header = await ownUploadingHeader(ctx, args.checklistId, userId);
    if (args.firstOrdinal !== header.sectionCount) {
      throw new ConvexError(
        `This batch starts at section ${args.firstOrdinal + 1}, but ${header.sectionCount} sections have arrived. Upload the file again.`,
      );
    }
    if (args.sections.length === 0) {
      throw new ConvexError("A batch needs at least one section.");
    }
    if (args.sections.length > BATCH_MAX_SECTIONS) {
      throw new ConvexError(
        `A batch can carry at most ${BATCH_MAX_SECTIONS} sections; this one has ${args.sections.length}.`,
      );
    }
    const batchRows = args.sections.reduce((n, s) => n + s.rows.length, 0);
    if (batchRows > BATCH_MAX_ROWS) {
      throw new ConvexError(
        `A batch can carry at most ${BATCH_MAX_ROWS} rows; this one has ${batchRows}.`,
      );
    }
    if (header.sectionCount + args.sections.length > MAX_SECTIONS) {
      throw new ConvexError(`A checklist can have at most ${MAX_SECTIONS} sections.`);
    }

    // Check everything before writing anything (a throw rolls back anyway;
    // this keeps the refusal's wording independent of write order).
    const seenKeys = new Set<string>();
    const prepared: Array<{
      name: string;
      sectionKey: string;
      group?: string;
      rows: Infer<typeof publishedChecklistStoredRowValidator>[];
      sizes: number[];
      byteSize: number;
    }> = [];
    let batchBytes = 0;
    for (let i = 0; i < args.sections.length; i += 1) {
      const sent = args.sections[i];
      const position = header.sectionCount + i + 1;
      const name = checkSectionName(sent.name, `Section ${position}'s name`);
      const label = `section “${name}”`;
      const sectionKey = sectionKeyOf(name);
      if (seenKeys.has(sectionKey) || (await sectionByKey(ctx.db, header._id, sectionKey))) {
        throw new ConvexError(`Two sections are named “${name}”.`);
      }
      seenKeys.add(sectionKey);
      const groupText = sent.group?.trim();
      const group =
        groupText && groupText.length > 0
          ? checkSectionName(groupText, `The group of ${label}`)
          : undefined;
      if (sent.rows.length === 0) {
        throw new ConvexError(`Section “${name}” has no rows.`);
      }
      if (sent.rows.length > MAX_SECTION_ROWS) {
        throw new ConvexError(
          `Section “${name}” has ${sent.rows.length} rows; the limit is ${MAX_SECTION_ROWS}.`,
        );
      }
      const checked = checkPublishedChecklist(
        { rows: sent.rows },
        { label },
      )!;
      const sizes = checked.rows.map(storedRowBytes);
      const byteSize = sizes.reduce((n, s) => n + s, 0);
      if (byteSize > MAX_SECTION_BYTES) {
        throw new ConvexError(
          `Section “${name}” is too large to store (over ${MAX_SECTION_BYTES / (1024 * 1024)} MB).`,
        );
      }
      batchBytes += byteSize;
      prepared.push({ name, sectionKey, group, rows: checked.rows, sizes, byteSize });
    }
    if (batchBytes > BATCH_MAX_BYTES) {
      throw new ConvexError(
        `This batch is too large (over ${BATCH_MAX_BYTES / (1024 * 1024)} MB). Send fewer sections at a time.`,
      );
    }
    const rowCount = header.rowCount + batchRows;
    const byteSize = header.byteSize + batchBytes;
    if (rowCount > MAX_CHECKLIST_ROWS) {
      throw new ConvexError(`A checklist can have at most ${MAX_CHECKLIST_ROWS} rows.`);
    }
    if (byteSize > MAX_CHECKLIST_BYTES) {
      throw new ConvexError(
        `This checklist is too large to store (over ${MAX_CHECKLIST_BYTES / (1024 * 1024)} MB).`,
      );
    }

    let ordinal = header.sectionCount;
    for (const section of prepared) {
      const numbered = section.rows.filter((r) => r.noNumber !== true);
      const sizeOf = new Map(section.rows.map((r, i) => [r, section.sizes[i]]));
      const chunks = chunkRowsByBytes(section.rows, (r) => sizeOf.get(r)!);
      const sectionId = await ctx.db.insert("publishedChecklistSections", {
        checklistId: header._id,
        ordinal,
        name: section.name,
        sectionKey: section.sectionKey,
        ...(section.group !== undefined ? { group: section.group } : {}),
        rowCount: section.rows.length,
        byteSize: section.byteSize,
        chunkCount: chunks.length,
        ...(numbered.length > 0
          ? {
              firstNumber: numbered[0].number,
              lastNumber: numbered[numbered.length - 1].number,
            }
          : {}),
      });
      let firstRow = 0;
      for (let seq = 0; seq < chunks.length; seq += 1) {
        await ctx.db.insert("publishedChecklistChunks", {
          checklistId: header._id,
          sectionId,
          seq,
          firstRow,
          rows: chunks[seq],
        });
        firstRow += chunks[seq].length;
      }
      ordinal += 1;
    }

    await ctx.db.patch(header._id, {
      sectionCount: ordinal,
      rowCount,
      byteSize,
      lastActivityAt: Date.now(),
    });
    return { sectionCount: ordinal, rowCount, byteSize };
  },
});

/**
 * Make the upload the set's checklist. The counts must equal what arrived
 * (at least one section), so a client that lost a batch cannot finish a
 * short checklist. Retires the previous ready checklist in the same
 * transaction; two racing finishes conflict on that range and serialise, and
 * the last one wins.
 */
export const finish = mutation({
  args: {
    checklistId: v.id("publishedChecklists"),
    sectionCount: v.number(),
    rowCount: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireAdmin(ctx);
    const header = await ownUploadingHeader(ctx, args.checklistId, userId);
    if (header.sectionCount === 0) {
      throw new ConvexError("This checklist has no sections yet.");
    }
    if (args.sectionCount !== header.sectionCount || args.rowCount !== header.rowCount) {
      throw new ConvexError(
        `The upload is incomplete: ${header.sectionCount} sections and ${header.rowCount} rows arrived, not ${args.sectionCount} and ${args.rowCount}. Upload the file again.`,
      );
    }
    await retireReady(ctx, header.setId);
    const now = Date.now();
    await ctx.db.patch(header._id, { status: "ready", finishedAt: now, lastActivityAt: now });
    return null;
  },
});

/** Remove the set's checklist. Rows' links stay (D2): a later upload revives them. */
export const remove = mutation({
  args: { setId: v.id("selectorOptions") },
  returns: v.object({ removed: v.boolean() }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const retired = await retireReady(ctx, args.setId);
    return { removed: retired > 0 };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Public reads
// ───────────────────────────────────────────────────────────────────────────

/** Signed out → false (the caller answers empty); signed-in non-admin → throws. */
async function adminOrSignedOut(ctx: QueryCtx): Promise<boolean> {
  if ((await getCurrentUserIdentity(ctx)) === null) return false;
  await requireAdmin(ctx);
  return true;
}

/** The set's ready checklist, for the set's attributes panel. Subscribed: one document. */
export const getForSet = query({
  args: { setId: v.id("selectorOptions") },
  returns: v.union(
    v.null(),
    v.object({
      checklistId: v.id("publishedChecklists"),
      fileName: v.string(),
      format: publishedChecklistFormatValidator,
      sectionCount: v.number(),
      rowCount: v.number(),
      byteSize: v.number(),
      finishedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    if (!(await adminOrSignedOut(ctx))) return null;
    const ready = await readyChecklistForSet(ctx.db, args.setId);
    if (!ready) return null;
    return {
      checklistId: ready._id,
      fileName: ready.fileName,
      format: ready.format,
      sectionCount: ready.sectionCount,
      rowCount: ready.rowCount,
      byteSize: ready.byteSize,
      finishedAt: ready.finishedAt ?? ready.lastActivityAt,
    };
  },
});

/** A checklist's sections in file order, 100 per page. Read on demand, never subscribed. */
export const listSections = query({
  args: {
    checklistId: v.id("publishedChecklists"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(sectionSummaryValidator),
  handler: async (ctx, args) => {
    if (!(await adminOrSignedOut(ctx))) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const result = await ctx.db
      .query("publishedChecklistSections")
      .withIndex("by_checklist_and_ordinal", (q) => q.eq("checklistId", args.checklistId))
      .paginate({
        ...args.paginationOpts,
        numItems: Math.max(1, Math.min(args.paginationOpts.numItems, 100)),
      });
    return {
      page: result.page.map(sectionSummary),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
      ...(result.splitCursor !== undefined ? { splitCursor: result.splitCursor } : {}),
      ...(result.pageStatus !== undefined ? { pageStatus: result.pageStatus } : {}),
    };
  },
});

const leafSummaryValidator = v.union(
  v.null(),
  v.object({ kind: v.literal("none"), linkedKeys: v.array(v.string()) }),
  v.object({
    kind: v.union(v.literal("tooBig"), v.literal("rows")),
    checklistId: v.id("publishedChecklists"),
    linkedKeys: v.array(v.string()),
    sections: v.array(leafSectionValidator),
    rowCount: v.number(),
    byteSize: v.number(),
  }),
);

/**
 * What a leaf's fetch would read from the set's checklist, without reading
 * a row: subscribed by CardChecklist (its source count) and the Base picker
 * (its preselection). `linkedKeys` is the row's links in its own set, which
 * may name keys the current checklist lacks; `sections` are those that
 * resolve. Bounded: ≤51 links, ≤51 section lookups, 3 small reads.
 */
export const leafChecklistSummary = query({
  args: { selectorOptionId: v.id("selectorOptions") },
  returns: leafSummaryValidator,
  handler: async (ctx, args) => {
    if (!(await adminOrSignedOut(ctx))) return null;
    const leaf = await resolveLeaf(ctx.db, args.selectorOptionId);
    if (leaf.kind === "noSet") return { kind: "none" as const, linkedKeys: [] };
    if (!leaf.ready) return { kind: "none" as const, linkedKeys: leaf.linkedKeys };
    const sum = sumOf(leaf.sections);
    return {
      kind: tooBig(sum) ? ("tooBig" as const) : ("rows" as const),
      checklistId: leaf.ready._id,
      linkedKeys: leaf.linkedKeys,
      sections: leaf.sections.map((s) => ({
        sectionKey: s.sectionKey,
        name: s.name,
        rowCount: s.rowCount,
      })),
      ...sum,
    };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Internal reads (row A's fetch, variant sync and variant-type sync)
// ───────────────────────────────────────────────────────────────────────────

/** Every section of the set's ready checklist, file order (≤ MAX_SECTIONS, no rows). */
export const sectionsForSet = internalQuery({
  args: { setId: v.id("selectorOptions") },
  returns: v.union(
    v.null(),
    v.object({
      checklistId: v.id("publishedChecklists"),
      sections: v.array(sectionSummaryValidator),
    }),
  ),
  handler: async (ctx, args) => {
    const ready = await readyChecklistForSet(ctx.db, args.setId);
    if (!ready) return null;
    const sections = await ctx.db
      .query("publishedChecklistSections")
      .withIndex("by_checklist_and_ordinal", (q) => q.eq("checklistId", ready._id))
      .take(MAX_SECTIONS);
    return { checklistId: ready._id, sections: sections.map(sectionSummary) };
  },
});

/** Every link written under the set (≤ MAX_LINKS_PER_SET), key order. */
export const linksForSet = internalQuery({
  args: { setId: v.id("selectorOptions") },
  returns: v.array(
    v.object({
      selectorOptionId: v.id("selectorOptions"),
      sectionKey: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const links = await linksUnderSet(ctx.db, args.setId);
    return links.map((l) => ({ selectorOptionId: l.selectorOptionId, sectionKey: l.sectionKey }));
  },
});

/**
 * D9 — the rows a leaf's fetch uses: only its OWN linked sections in the
 * set's ready checklist (no parent fallback), in file order. `none` when the
 * leaf has no set, the set no ready checklist, or no link resolves;
 * `tooBig` (sizes summed before any chunk is read) when the sections exceed
 * `LEAF_READ_MAX_ROWS` / `LEAF_READ_MAX_BYTES`, and the fetch then runs
 * without them. A section whose chunks do not line up is skipped and logged.
 * The caller re-runs `checkPublishedChecklist` on the rows.
 */
export const rowsForLeaf = internalQuery({
  args: { selectorOptionId: v.id("selectorOptions") },
  returns: v.union(
    v.object({ kind: v.literal("none") }),
    v.object({ kind: v.literal("tooBig"), rowCount: v.number(), byteSize: v.number() }),
    v.object({
      kind: v.literal("rows"),
      checklistId: v.id("publishedChecklists"),
      sections: v.array(leafSectionValidator),
      rows: v.array(publishedChecklistStoredRowValidator),
    }),
  ),
  handler: async (ctx, args) => {
    const leaf = await resolveLeaf(ctx.db, args.selectorOptionId);
    if (leaf.kind === "noSet" || !leaf.ready || leaf.sections.length === 0) {
      return { kind: "none" as const };
    }
    const sum = sumOf(leaf.sections);
    if (tooBig(sum)) return { kind: "tooBig" as const, ...sum };

    const sections: Infer<typeof leafSectionValidator>[] = [];
    const rows: Infer<typeof publishedChecklistStoredRowValidator>[] = [];
    for (const section of leaf.sections) {
      const chunks = await ctx.db
        .query("publishedChecklistChunks")
        .withIndex("by_section_and_seq", (q) => q.eq("sectionId", section._id))
        .collect();
      const sectionRows: Infer<typeof publishedChecklistStoredRowValidator>[] = [];
      let intact = true;
      for (const chunk of chunks) {
        if (chunk.firstRow !== sectionRows.length) {
          intact = false;
          break;
        }
        sectionRows.push(...chunk.rows);
      }
      if (!intact || sectionRows.length !== section.rowCount) {
        console.warn(
          JSON.stringify({
            msg: "published_checklist_section_chunks_broken",
            checklistId: leaf.ready._id,
            sectionId: section._id,
            chunks: chunks.length,
            rows: sectionRows.length,
            expectedRows: section.rowCount,
          }),
        );
        continue;
      }
      sections.push({ sectionKey: section.sectionKey, name: section.name, rowCount: section.rowCount });
      rows.push(...sectionRows);
    }
    if (sections.length === 0) return { kind: "none" as const };
    return { kind: "rows" as const, checklistId: leaf.ready._id, sections, rows };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Clean-up
// ───────────────────────────────────────────────────────────────────────────

/**
 * Scheduled `ABANDON_MS` after `start`: an upload still uploading and idle
 * that long is retired and purged; one that is still receiving batches is
 * checked again `ABANDON_MS` after its last one.
 */
export const expireUpload = internalMutation({
  args: { checklistId: v.id("publishedChecklists") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const header = await ctx.db.get(args.checklistId);
    if (!header || header.status !== "uploading") return null;
    const now = Date.now();
    const due = header.lastActivityAt + ABANDON_MS;
    if (now >= due) {
      await retire(ctx, header);
    } else {
      await ctx.scheduler.runAfter(due - now, internal.publishedChecklists.expireUpload, {
        checklistId: header._id,
      });
    }
    return null;
  },
});

/**
 * Deletes retired checklists, a bounded slice per run, and chains itself.
 *
 * Target: the given checklist when it is retired; else the oldest retired
 * one; else an abandoned upload (idle past `ABANDON_MS`, retired first).
 * Per run: sections in ordinal order, at most `PURGE_CHUNKS_PER_RUN` chunk
 * deletes (~6 MiB read) and `PURGE_SECTIONS_PER_RUN` sections; the header
 * goes once its last section has. Work left → runs again on the same
 * target; target gone → runs again with no target to find the next; nothing
 * qualifies → stops. A throw stops the chain; the next finish, remove or
 * expiry starts it again.
 */
export const purge = internalMutation({
  args: { checklistId: v.optional(v.id("publishedChecklists")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    let target: Doc<"publishedChecklists"> | null = null;
    if (args.checklistId) {
      const given = await ctx.db.get(args.checklistId);
      if (given?.status === "retired") target = given;
    }
    if (!target) {
      target = await ctx.db
        .query("publishedChecklists")
        .withIndex("by_status_and_activity", (q) => q.eq("status", "retired"))
        .first();
    }
    if (!target) {
      const abandoned = await ctx.db
        .query("publishedChecklists")
        .withIndex("by_status_and_activity", (q) =>
          q.eq("status", "uploading").lt("lastActivityAt", Date.now() - ABANDON_MS),
        )
        .first();
      if (abandoned) {
        await ctx.db.patch(abandoned._id, { status: "retired", retiredAt: Date.now() });
        target = abandoned;
      }
    }
    if (!target) return null;
    const targetId = target._id;

    let chunksLeft = PURGE_CHUNKS_PER_RUN;
    for (let visited = 0; visited < PURGE_SECTIONS_PER_RUN; visited += 1) {
      const section = await ctx.db
        .query("publishedChecklistSections")
        .withIndex("by_checklist_and_ordinal", (q) => q.eq("checklistId", targetId))
        .first();
      if (!section) {
        await ctx.db.delete(targetId);
        await ctx.scheduler.runAfter(0, internal.publishedChecklists.purge, {});
        return null;
      }
      if (chunksLeft === 0) break;
      const chunks = await ctx.db
        .query("publishedChecklistChunks")
        .withIndex("by_section_and_seq", (q) => q.eq("sectionId", section._id))
        .take(chunksLeft);
      for (const chunk of chunks) await ctx.db.delete(chunk._id);
      chunksLeft -= chunks.length;
      if (chunksLeft === 0) {
        // The take may have emptied the section exactly; the next run finds out.
        break;
      }
      await ctx.db.delete(section._id);
    }
    await ctx.scheduler.runAfter(0, internal.publishedChecklists.purge, {
      checklistId: targetId,
    });
    return null;
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Account deletion
// ───────────────────────────────────────────────────────────────────────────

/**
 * Forget who uploaded: every header and link `userId` wrote gets
 * `createdByUserId: DELETED_UPLOADER`. The checklist itself stays, because it
 * belongs to the set, not to the person. Run it while deleting an account
 * (the privacy policy's "we delete it and the data tied to it"):
 *
 *   npx convex run publishedChecklists:forgetUploader '{"userId":"user_..."}'
 *
 * Per run: at most `FORGET_UPLOADER_PER_RUN` headers and as many links,
 * through each table's `by_created_by_user_id` index. A patched row leaves
 * the index range, so a full page means more may remain and the job runs
 * again; a short page on both tables ends the chain.
 */
export const forgetUploader = internalMutation({
  args: { userId: v.string() },
  returns: v.object({ headers: v.number(), links: v.number(), more: v.boolean() }),
  handler: async (ctx, args) => {
    if (args.userId.length === 0 || args.userId === DELETED_UPLOADER) {
      return { headers: 0, links: 0, more: false };
    }
    const headerRows = await ctx.db
      .query("publishedChecklists")
      .withIndex("by_created_by_user_id", (q) => q.eq("createdByUserId", args.userId))
      .take(FORGET_UPLOADER_PER_RUN);
    for (const header of headerRows) {
      await ctx.db.patch(header._id, { createdByUserId: DELETED_UPLOADER });
    }
    const linkRows = await ctx.db
      .query("publishedChecklistLinks")
      .withIndex("by_created_by_user_id", (q) => q.eq("createdByUserId", args.userId))
      .take(FORGET_UPLOADER_PER_RUN);
    for (const link of linkRows) {
      await ctx.db.patch(link._id, { createdByUserId: DELETED_UPLOADER });
    }
    const more =
      headerRows.length === FORGET_UPLOADER_PER_RUN || linkRows.length === FORGET_UPLOADER_PER_RUN;
    if (more) {
      await ctx.scheduler.runAfter(0, internal.publishedChecklists.forgetUploader, {
        userId: args.userId,
      });
    }
    return { headers: headerRows.length, links: linkRows.length, more };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Row delete (called from `selectorOptions.deleteSelectorOption`)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Transient checklist state that goes WITH a deleted selector row, in the
 * same transaction: a set row's checklists are retired (and purged by the
 * scheduled job) and the links written under it deleted; any row's own
 * links are deleted. Each read is capped at `cap` (TRANSIENT_DELETE_CAP);
 * the writer's own caps keep real counts far below it.
 */
export async function sweepPublishedChecklistStateForDeletedRow(
  ctx: MutationCtx,
  row: Doc<"selectorOptions">,
  cap: number,
): Promise<void> {
  const own = await ctx.db
    .query("publishedChecklistLinks")
    .withIndex("by_selector_option_and_key", (q) => q.eq("selectorOptionId", row._id))
    .take(cap);
  for (const link of own) await ctx.db.delete(link._id);
  if (row.level !== "setName") return;
  for (const status of ["uploading", "ready"] as const) {
    const headers = await ctx.db
      .query("publishedChecklists")
      .withIndex("by_set_and_status", (q) => q.eq("setId", row._id).eq("status", status))
      .take(cap);
    for (const header of headers) await retire(ctx, header);
  }
  const underSet = await ctx.db
    .query("publishedChecklistLinks")
    .withIndex("by_set_and_key", (q) => q.eq("setId", row._id))
    .take(cap);
  for (const link of underSet) await ctx.db.delete(link._id);
}

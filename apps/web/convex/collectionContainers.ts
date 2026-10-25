/**
 * NEO-359 — a collector's binders and boxes: the shelf.
 *
 * Every function is signed-in (`requireSignedIn`) and reads or writes ONLY the
 * caller's rows (`ownerId` is the caller's Clerk subject, never an argument).
 * A container that is not the caller's reads exactly like one that does not
 * exist.
 *
 * Three containers are NB's (`system`): Main (where a card lands when no
 * binder or box is named; made lazily on the first add, or here), the Want
 * List and Up for Trade (shelf rows only, never homes; made here by
 * `ensureSystem`). They are never renamed or deleted; only their label
 * changes. Everything else is the collector's own, at most `MAX_CONTAINERS`.
 * A copy whose home is a box is for sale; there is no other for-sale flag.
 *
 * Deleting a binder or box: the client loops `empty` (up to `EMPTY_BATCH`
 * line items back to Main per call, their pockets and rows cleared, folding
 * into identical lines there) until nothing is left, then calls `remove`,
 * which also un-scopes any wants that named it. There is no undo for either.
 *
 * Counts: every container carries its own `count`, moved by every copy write
 * (`collection.moveCounts`) and every want (`collectionWants.set`). `list`
 * reads it, deriving or hand-counting (bounded) a container that was never
 * counted, and says null when it cannot.
 *
 * Share links (NEO-360): a binder the collector made carries a `slug` (its
 * link name, unique among the owner's binders) from birth (`create`), so its
 * link survives a rename; a binder made before NEO-360 gets one from
 * `ensureLink`. `setSlug` and `setVisibility` are the only other writers. Binders and the Want List start
 * private; Main, boxes and Up for Trade never take a `visibility` here (Up for
 * Trade's switch is `publicProfile.setShelfVisibility`). The anonymous reads
 * are `publicCollection.ts`'s.
 *
 * NB fields only: no marketplace field exists on a container.
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireSignedIn } from "./auth";
import {
  COLLECTION_ERRORS,
  MAX_CONTAINERS,
  MAX_CONTAINER_RECOUNT_LINES,
  MAX_LINES_PER_CARD,
  MAX_COPY_QUANTITY,
  MAX_WANTS,
  cleanText,
  countContainer,
  detailsOf,
  foldsInto,
  getOrCreateMain,
  moveCounts,
  moveTally,
  refuse,
  type CountChange,
} from "./collection";
import {
  collectionContainerKindValidator,
  collectionContainerSystemValidator,
  collectionCountValidator,
  collectionLabelValidator,
  collectionRuleValidator,
} from "./schema";
import { SPINE_FONTS } from "../lib/print/spine-fonts";
import { SLUG_RULE, cleanSlug, freeSlug, suggestSlug } from "../lib/collection/share-links";

type ContainerRow = Doc<"collectionContainers">;

/** Line items one `empty` call sends back to Main. */
export const EMPTY_BATCH = 200;
/**
 * Copy documents one `empty` call may read finding fold twins in Main, so a
 * box full of one card's many lines cannot blow the transaction.
 */
const EMPTY_READ_BUDGET = 1500;
export const MAX_CONTAINER_NAME_CHARS = 60;
export const MAX_CONTAINER_DESCRIPTION_CHARS = 280;

/** The names NB gives its own containers. */
export const SYSTEM_NAMES = {
  main: "Main",
  want: "Want List",
  trade: "Up for Trade",
} as const;

/** Shelf order for the system rows: Main, then Up for Trade, then the Want List. */
const SYSTEM_ORDER: Record<string, number> = { main: 0, trade: 1, want: 2 };

/** A container as the shelf reads it. */
export const containerValidator = v.object({
  _id: v.id("collectionContainers"),
  kind: collectionContainerKindValidator,
  system: v.optional(collectionContainerSystemValidator),
  name: v.string(),
  description: v.optional(v.string()),
  label: v.optional(collectionLabelValidator),
  rule: v.optional(collectionRuleValidator),
  /**
   * A home: its copies and line items. Up for Trade: the flagged ones. The
   * Want List: the wants (both numbers). Null when it was never counted and
   * is too big to count here: show it as unknown, never as 0.
   */
  count: v.union(collectionCountValidator, v.null()),
  /** NEO-360 — a binder's link name; absent until minted (see `ensureLink`). */
  slug: v.optional(v.string()),
  /** NEO-360 — present only when public (a binder, or the Want List). */
  visibility: v.optional(v.literal("public")),
  lastUpdated: v.number(),
});

function containerOut(
  row: ContainerRow,
  count: typeof collectionCountValidator.type | null,
): typeof containerValidator.type {
  return {
    _id: row._id,
    kind: row.kind,
    ...(row.system ? { system: row.system } : {}),
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    ...(row.label ? { label: row.label } : {}),
    ...(row.rule ? { rule: row.rule } : {}),
    count,
    ...(row.slug ? { slug: row.slug } : {}),
    ...(row.visibility === "public" ? { visibility: "public" as const } : {}),
    lastUpdated: row.lastUpdated,
  };
}

/** NEO-360 — only a binder the collector made has a link of its own. */
function hasOwnLink(row: Pick<ContainerRow, "system" | "kind">): boolean {
  return !row.system && row.kind === "binder";
}

function refuseNoLink(row: Pick<ContainerRow, "system" | "kind" | "name">): never {
  if (row.system === "main") {
    refuse(COLLECTION_ERRORS.invalid, "Main is never shared. Build a binder to share some of it.");
  }
  if (row.kind === "box") {
    refuse(COLLECTION_ERRORS.invalid, "A box doesn't get its own link. Your for-sale page shows every box at once.");
  }
  refuse(COLLECTION_ERRORS.invalid, `${row.name} doesn't get a link of its own.`);
}

const HEX = /^#[0-9a-f]{6}$/i;
const FONT_IDS = new Set(SPINE_FONTS.map((font) => font.id));

/** A label as stored: both colours `#rrggbb`, lower-cased; a font the Print Shop has. */
function cleanLabel(
  raw: typeof collectionLabelValidator.type,
): typeof collectionLabelValidator.type {
  const background = raw.background.trim();
  const text = raw.text.trim();
  if (!HEX.test(background) || !HEX.test(text)) {
    refuse(COLLECTION_ERRORS.invalid, "Label colors need to be hex colors like #00d558.");
  }
  if (!FONT_IDS.has(raw.fontId)) {
    refuse(COLLECTION_ERRORS.invalid, "That font isn't one of the label fonts. Pick one from the list.");
  }
  return { background: background.toLowerCase(), text: text.toLowerCase(), fontId: raw.fontId };
}

function cleanName(raw: string): string {
  const name = cleanText(raw, MAX_CONTAINER_NAME_CHARS, "name");
  if (!name) refuse(COLLECTION_ERRORS.invalid, "Give it a name first.");
  return name;
}

/** The caller's container, or a not-found refusal. */
/**
 * The first free link name for one of the owner's binders, from `base`
 * (`base`, `base-2`, ...). `self` is the binder being named, whose own name
 * never counts as taken. Bounded: one collector has at most `MAX_CONTAINERS`.
 */
async function freeSlugFor(
  ctx: MutationCtx,
  ownerId: string,
  base: string,
  self?: Id<"collectionContainers">,
): Promise<string> {
  const own = await ctx.db
    .query("collectionContainers")
    .withIndex("by_owner_and_system", (q) => q.eq("ownerId", ownerId).eq("system", undefined))
    .take(MAX_CONTAINERS);
  const taken = new Set(own.filter((row) => row._id !== self && row.slug).map((row) => row.slug!));
  return freeSlug(base, taken);
}

async function ownContainer(
  ctx: MutationCtx,
  ownerId: string,
  containerId: Id<"collectionContainers">,
): Promise<ContainerRow> {
  const row = await ctx.db.get(containerId);
  if (!row || row.ownerId !== ownerId) {
    refuse(COLLECTION_ERRORS.notFound, "That binder or box isn't in your collection.");
  }
  return row;
}

/** The caller's Want List or Up for Trade row, made (and counted) on first use. */
async function getOrCreateShelfRow(
  ctx: MutationCtx,
  ownerId: string,
  system: "want" | "trade",
): Promise<Id<"collectionContainers">> {
  const existing = await ctx.db
    .query("collectionContainers")
    .withIndex("by_owner_and_system", (q) => q.eq("ownerId", ownerId).eq("system", system))
    .unique();
  if (existing) return existing._id;
  const id = await ctx.db.insert("collectionContainers", {
    ownerId,
    kind: "binder",
    system,
    name: SYSTEM_NAMES[system],
    lastUpdated: Date.now(),
  });
  // Counted at birth: the wants and flagged copies may predate the row.
  const row = await ctx.db.get(id);
  if (row) {
    const count = await countContainer(ctx, row, { left: MAX_CONTAINER_RECOUNT_LINES });
    if (count) await ctx.db.patch(id, { count });
  }
  return id;
}

// ───────────────────────────────────────────────────────────────────────────
// Queries
// ───────────────────────────────────────────────────────────────────────────

/**
 * The caller's shelf: the system rows first (Main, Up for Trade, the Want
 * List, whichever exist), then their own binders and boxes in the order they
 * were made, each with its count. A count never kept is derived (Main) or
 * counted by hand within one budget shared across the call
 * (`MAX_CONTAINER_RECOUNT_LINES`), and null past it.
 */
export const list = query({
  args: {},
  returns: v.array(containerValidator),
  handler: async (ctx) => {
    const ownerId = await requireSignedIn(ctx);
    const rows = await ctx.db
      .query("collectionContainers")
      .withIndex("by_owner_and_system", (q) => q.eq("ownerId", ownerId))
      .take(MAX_CONTAINERS + 3);
    const ordered = [...rows].sort((a, b) => {
      const ra = a.system ? SYSTEM_ORDER[a.system] : 3;
      const rb = b.system ? SYSTEM_ORDER[b.system] : 3;
      return ra - rb || a._creationTime - b._creationTime;
    });
    const budget = { left: MAX_CONTAINER_RECOUNT_LINES };
    const out = [];
    for (const row of ordered) {
      const count = row.count ?? (await countContainer(ctx, row, budget));
      out.push(containerOut(row, count));
    }
    return out;
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Mutations
// ───────────────────────────────────────────────────────────────────────────

/**
 * Make sure the caller has Main, the Want List and Up for Trade (My Binders
 * calls it on mount). Idempotent: writes only what is missing, and counts a
 * Main that was never counted when that is cheap. Two racing calls are
 * serialised by OCC on `by_owner_and_system`.
 */
export const ensureSystem = mutation({
  args: {},
  returns: v.object({
    mainId: v.id("collectionContainers"),
    wantId: v.id("collectionContainers"),
    tradeId: v.id("collectionContainers"),
  }),
  handler: async (ctx) => {
    const ownerId = await requireSignedIn(ctx);
    const mainId = await getOrCreateMain(ctx, ownerId);
    const main = await ctx.db.get(mainId);
    if (main && main.count === undefined) {
      const count = await countContainer(ctx, main, { left: MAX_CONTAINER_RECOUNT_LINES });
      if (count) await ctx.db.patch(mainId, { count });
    }
    const wantId = await getOrCreateShelfRow(ctx, ownerId, "want");
    const tradeId = await getOrCreateShelfRow(ctx, ownerId, "trade");
    return { mainId, wantId, tradeId };
  },
});

/**
 * A new binder or box, empty and counted. At most `MAX_CONTAINERS` per
 * collector. It takes no `rule` (a smart binder) until NEO-362 ships the
 * evaluator: the argument validator refuses one, so no row pins its shape
 * early.
 */
export const create = mutation({
  args: {
    kind: collectionContainerKindValidator,
    name: v.string(),
    description: v.optional(v.string()),
    label: v.optional(collectionLabelValidator),
  },
  returns: v.object({ containerId: v.id("collectionContainers") }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const name = cleanName(args.name);
    const description = cleanText(args.description, MAX_CONTAINER_DESCRIPTION_CHARS, "description");
    const label = args.label ? cleanLabel(args.label) : undefined;
    const own = await ctx.db
      .query("collectionContainers")
      .withIndex("by_owner_and_system", (q) => q.eq("ownerId", ownerId).eq("system", undefined))
      .take(MAX_CONTAINERS);
    if (own.length >= MAX_CONTAINERS) {
      refuse(COLLECTION_ERRORS.limit, `You have ${MAX_CONTAINERS} binders and boxes already. Delete one you're done with first.`);
    }
    const containerId = await ctx.db.insert("collectionContainers", {
      ownerId,
      kind: args.kind,
      name,
      ...(description ? { description } : {}),
      ...(label ? { label } : {}),
      count: { copies: 0, lines: 0 },
      // NEO-360 — the link is minted with the binder, so a rename never moves it.
      ...(args.kind === "binder" ? { slug: freeSlug(suggestSlug(name), new Set(own.map((row) => row.slug ?? ""))) } : {}),
      lastUpdated: Date.now(),
    });
    return { containerId };
  },
});

/**
 * Rename a binder or box, change its description, or its label. Absent
 * fields stay as they are; a blank description clears it; `label: null`
 * goes back to the default look. A system container takes a label only.
 * `previous` is what it was (undo = `update` with it, passing `""` for an
 * absent description and `null` for an absent label).
 */
export const update = mutation({
  args: {
    containerId: v.id("collectionContainers"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    label: v.optional(v.union(collectionLabelValidator, v.null())),
  },
  returns: v.object({
    previous: v.object({
      name: v.string(),
      description: v.optional(v.string()),
      label: v.optional(collectionLabelValidator),
    }),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const row = await ownContainer(ctx, ownerId, args.containerId);
    const previous = {
      name: row.name,
      ...(row.description ? { description: row.description } : {}),
      ...(row.label ? { label: row.label } : {}),
    };
    const name = args.name === undefined ? undefined : cleanName(args.name);
    const description =
      args.description === undefined
        ? undefined
        : cleanText(args.description, MAX_CONTAINER_DESCRIPTION_CHARS, "description") ?? "";
    if (row.system) {
      const renames = name !== undefined && name !== row.name;
      const redescribes = description !== undefined && description !== (row.description ?? "");
      if (renames || redescribes) {
        refuse(COLLECTION_ERRORS.invalid, "Main, Up for Trade and the Want List keep their names. You can change their label.");
      }
    }
    const patch: Partial<ContainerRow> = { lastUpdated: Date.now() };
    if (name !== undefined && !row.system) patch.name = name;
    if (description !== undefined && !row.system) {
      patch.description = description === "" ? undefined : description;
    }
    if (args.label !== undefined) {
      patch.label = args.label === null ? undefined : cleanLabel(args.label);
    }
    await ctx.db.patch(row._id, patch);
    return { previous };
  },
});

/**
 * Send up to `EMPTY_BATCH` of a binder's or box's line items back to Main,
 * their pockets and rows cleared, each folding into an identical line already
 * in Main (the trade flag travels with it). The client loops it until
 * `remaining` is 0, then calls `remove`. `moved` is physical cards (quantities
 * summed); `remaining` is the line items still in it (0 when empty): exact
 * up to `EMPTY_BATCH`, past that the container's kept count (at least
 * `EMPTY_BATCH + 1`). No undo.
 * Refuses a system container.
 */
export const empty = mutation({
  args: { containerId: v.id("collectionContainers") },
  returns: v.object({ moved: v.number(), remaining: v.number() }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const row = await ownContainer(ctx, ownerId, args.containerId);
    if (row.system) {
      refuse(COLLECTION_ERRORS.invalid, "Main, Up for Trade and the Want List can't be emptied or deleted.");
    }
    const mainId = await getOrCreateMain(ctx, ownerId);
    const lines = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_home_slot", (q) => q.eq("ownerId", ownerId).eq("homeId", row._id))
      .take(EMPTY_BATCH);
    const changes: CountChange[] = [];
    let linesDelta = 0;
    let moved = 0;
    let readsLeft = EMPTY_READ_BUDGET;
    const now = Date.now();
    for (const line of lines) {
      if (readsLeft <= 0) break;
      const siblings = await ctx.db
        .query("collectionCopies")
        .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId).eq("cardId", line.cardId))
        .take(MAX_LINES_PER_CARD + 1);
      readsLeft -= siblings.length;
      const next = { ...detailsOf(line), homeId: mainId };
      delete next.slot;
      const into = siblings.find(
        (other) =>
          other._id !== line._id &&
          other.quantity + line.quantity <= MAX_COPY_QUANTITY &&
          foldsInto(detailsOf(other), next),
      );
      const before = {
        homeId: line.homeId,
        quantity: line.quantity,
        ...(line.upForTrade ? { upForTrade: true as const } : {}),
      };
      if (into) {
        const quantity = into.quantity + line.quantity;
        await ctx.db.patch(into._id, { quantity, lastUpdated: now });
        await ctx.db.delete(line._id);
        changes.push(
          {
            before: { homeId: into.homeId, quantity: into.quantity, ...(into.upForTrade ? { upForTrade: true as const } : {}) },
            after: { homeId: into.homeId, quantity, ...(into.upForTrade ? { upForTrade: true as const } : {}) },
          },
          { before, after: null },
        );
        linesDelta -= 1;
      } else {
        await ctx.db.patch(line._id, { homeId: mainId, slot: undefined, lastUpdated: now });
        changes.push({ before, after: { ...before, homeId: mainId } });
      }
      moved += line.quantity;
    }
    await moveTally(ctx, ownerId, { copies: 0, lines: linesDelta, cards: 0 });
    await moveCounts(ctx, ownerId, changes);
    // What is left, counted off the rows (this transaction's writes
    // included), up to one more batch. Past that the kept count says how
    // many, never fewer than the rows just seen.
    const left = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_home_slot", (q) => q.eq("ownerId", ownerId).eq("homeId", row._id))
      .take(EMPTY_BATCH + 1);
    if (left.length <= EMPTY_BATCH) return { moved, remaining: left.length };
    const fresh = await ctx.db.get(row._id);
    return { moved, remaining: Math.max(left.length, fresh?.count?.lines ?? 0) };
  },
});

/**
 * Delete an EMPTY binder or box (`empty` it first). Wants scoped to it become
 * plain Want List wants. Refuses a system container and one that still holds
 * a card. `unscopedWants` is how many wants were un-scoped.
 */
export const remove = mutation({
  args: { containerId: v.id("collectionContainers") },
  returns: v.object({ unscopedWants: v.number() }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const row = await ownContainer(ctx, ownerId, args.containerId);
    if (row.system) {
      refuse(COLLECTION_ERRORS.invalid, "Main, Up for Trade and the Want List can't be emptied or deleted.");
    }
    const held = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_home_slot", (q) => q.eq("ownerId", ownerId).eq("homeId", row._id))
      .first();
    if (held) {
      refuse(COLLECTION_ERRORS.invalid, `"${row.name}" still holds cards. Send them back to Main first, then delete it.`);
    }
    const wants = await ctx.db
      .query("collectionWants")
      .withIndex("by_owner_and_binder", (q) => q.eq("ownerId", ownerId).eq("binderId", row._id))
      .take(MAX_WANTS);
    const now = Date.now();
    for (const want of wants) {
      await ctx.db.patch(want._id, { binderId: undefined, lastUpdated: now });
    }
    await ctx.db.delete(row._id);
    return { unscopedWants: wants.length };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// NEO-360 — share links
// ───────────────────────────────────────────────────────────────────────────

const linkValidator = v.object({ slug: v.string() });

/**
 * A binder's link name, minted now if it was made before NEO-360 (from its
 * current name, made unique among the owner's binders). Idempotent. The
 * Share panel calls it when it opens. Refuses Main, a box and the system
 * shelves.
 */
export const ensureLink = mutation({
  args: { containerId: v.id("collectionContainers") },
  returns: linkValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const row = await ownContainer(ctx, ownerId, args.containerId);
    if (!hasOwnLink(row)) refuseNoLink(row);
    if (row.slug) return { slug: row.slug };
    const slug = await freeSlugFor(ctx, ownerId, suggestSlug(row.name), row._id);
    await ctx.db.patch(row._id, { slug });
    return { slug };
  },
});

/**
 * Change a binder's link name (`slug`). Trimmed and lower-cased; spaces
 * become hyphens; anything else outside `[a-z0-9-]` is refused, not
 * rewritten. Refused when another of the collector's binders already has
 * it. The old link stops working at once. `previous` is what it was (undo =
 * `setSlug` with it).
 */
export const setSlug = mutation({
  args: { containerId: v.id("collectionContainers"), slug: v.string() },
  returns: v.object({ link: linkValidator, previous: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const row = await ownContainer(ctx, ownerId, args.containerId);
    if (!hasOwnLink(row)) refuseNoLink(row);
    const slug = cleanSlug(args.slug);
    if (!slug) refuse(COLLECTION_ERRORS.invalid, SLUG_RULE);
    if (slug !== row.slug && (await freeSlugFor(ctx, ownerId, slug, row._id)) !== slug) {
      refuse(COLLECTION_ERRORS.invalid, `Another of your binders already uses ${slug}. Pick a different link name.`);
    }
    await ctx.db.patch(row._id, { slug });
    return { link: { slug }, ...(row.slug ? { previous: row.slug } : {}) };
  },
});

/**
 * Switch a binder or the Want List public (anyone with its link can read
 * it) or private (the default; the link reads as not found). A binder made
 * before NEO-360 gets its link minted here too. Refuses Main, a box and Up
 * for Trade: Main is never public, a box is shared through the for-sale page,
 * and Up for Trade's switch is `publicProfile.setShelfVisibility`.
 */
export const setVisibility = mutation({
  args: {
    containerId: v.id("collectionContainers"),
    visibility: v.union(v.literal("public"), v.literal("private")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const row = await ownContainer(ctx, ownerId, args.containerId);
    if (row.system === "trade") {
      refuse(COLLECTION_ERRORS.invalid, "Up for Trade's switch is on its own Share panel.");
    }
    if (row.system !== "want" && !hasOwnLink(row)) refuseNoLink(row);
    const patch: Partial<ContainerRow> = {
      visibility: args.visibility === "public" ? "public" : undefined,
    };
    if (hasOwnLink(row) && !row.slug) patch.slug = await freeSlugFor(ctx, ownerId, suggestSlug(row.name), row._id);
    await ctx.db.patch(row._id, patch);
    return null;
  },
});

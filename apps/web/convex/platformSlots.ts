/**
 * NEO-137 — marketplace mapping slots.
 *
 * A `selectorOptions` row holds the marketplace sets it maps to, and its cards
 * point back up to that mapping rather than repeating a full BSC slug or
 * SportLots set id on every one of potentially thousands of rows.
 *
 * The pointer is a **slot key** (`b0`, `b1` … / `s0`, `s1` …), not an array
 * index. An index is positional: detaching one entry silently repoints every
 * card below it at a different marketplace set, and nothing would surface the
 * corruption. Slot keys are allocated from a monotonic per-side counter
 * (`platformSlotSeq`) that is never rewound, so a freed key is never handed
 * out again — a card referencing a detached slot resolves to nothing and is
 * reported as orphaned, which is recoverable. A card silently repointed at the
 * wrong set is not.
 *
 * Shape on the set row:
 *
 *   platformData:      { sportlots: { s0: "884412" } }   slot → marketplace set id
 *   platformLabels:    { sportlots: { s0: "Dugout Collection Artists Proofs" } }
 *   primaryPlatformId: { sportlots: "s0" }               which slot the reconciler owns
 *   platformSlotSeq:   { sportlots: 1 }                  next slot number to issue
 *
 * And on each card (convex/schema.ts, `cardChecklist.platformData`):
 *
 *   { sportlots: { ref: "#A1 Ken Griffey Jr.", src: "s0" } }
 *
 * Two sibling rows holding the SAME marketplace set id in their own slots is
 * exactly the M-NB-rows-to-1-marketplace-set mapping this ticket adds. Nothing
 * here enforces uniqueness of ids across rows, deliberately.
 */

export type PlatformSide = "bsc" | "sportlots";

/** Slot maps as stored: slot key → marketplace set id. */
export type SlotMap = Record<string, string>;

export type PlatformDataShape = {
  bsc?: SlotMap;
  sportlots?: SlotMap;
};

export type SlotSeqShape = {
  bsc?: number;
  sportlots?: number;
};

/** The minimum a row must expose for the helpers below to read it. */
export type SlotBearingRow = {
  platformData: PlatformDataShape;
  platformLabels?: { bsc?: Record<string, string>; sportlots?: Record<string, string> };
  primaryPlatformId?: { bsc?: string; sportlots?: string };
  platformSlotSeq?: SlotSeqShape;
};

/** Single-character namespace so a bare `src` value is self-describing in logs. */
const SLOT_PREFIX: Record<PlatformSide, string> = {
  bsc: "b",
  sportlots: "s",
};

export function isSlotKeyForSide(side: PlatformSide, slot: string): boolean {
  return new RegExp(`^${SLOT_PREFIX[side]}\\d+$`).test(slot);
}

/**
 * Slot entries for one side, in slot-number order.
 *
 * Ordering is by the numeric tail rather than object key order: `Object.keys`
 * on a record with integer-like keys is unreliable, and callers that pick "the
 * first" slot as an implicit primary need a stable answer.
 */
export function slotEntries(
  row: Pick<SlotBearingRow, "platformData">,
  side: PlatformSide,
): Array<{ slot: string; id: string }> {
  const map = row.platformData?.[side];
  if (!map) return [];
  return Object.entries(map)
    .map(([slot, id]) => ({ slot, id }))
    .sort((a, b) => slotNumber(a.slot) - slotNumber(b.slot));
}

function slotNumber(slot: string): number {
  const n = Number(slot.slice(1));
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * The marketplace set ids attached on one side, in slot order.
 *
 * This is what adapter calls filter on — they know nothing about slots.
 * Replaces NEO-6's `pdToArray`.
 */
export function slotIds(
  row: Pick<SlotBearingRow, "platformData">,
  side: PlatformSide,
): string[] {
  return slotEntries(row, side).map((e) => e.id);
}

/** The slot holding `id`, or undefined. First match wins if an id is attached twice. */
export function slotForId(
  row: Pick<SlotBearingRow, "platformData">,
  side: PlatformSide,
  id: string,
): string | undefined {
  return slotEntries(row, side).find((e) => e.id === id)?.slot;
}

/** The marketplace set id in `slot`, or undefined when the slot is detached. */
export function idForSlot(
  row: Pick<SlotBearingRow, "platformData">,
  side: PlatformSide,
  slot: string,
): string | undefined {
  return row.platformData?.[side]?.[slot];
}

/**
 * The slot the reconciler owns on this side.
 *
 * Falls back to the lowest-numbered slot when `primaryPlatformId` is absent,
 * matching NEO-6's "treat the first entry as primary" rule for rows written
 * before the field existed.
 */
export function primarySlot(
  row: SlotBearingRow,
  side: PlatformSide,
): string | undefined {
  const explicit = row.primaryPlatformId?.[side];
  if (explicit && idForSlot(row, side, explicit) !== undefined) return explicit;
  return slotEntries(row, side)[0]?.slot;
}

/** The marketplace set id the reconciler owns on this side. */
export function primaryId(
  row: SlotBearingRow,
  side: PlatformSide,
): string | undefined {
  const slot = primarySlot(row, side);
  return slot ? idForSlot(row, side, slot) : undefined;
}

/** Slots beyond the primary — operator-attached extras. */
export function extraSlots(
  row: SlotBearingRow,
  side: PlatformSide,
): Array<{ slot: string; id: string }> {
  const primary = primarySlot(row, side);
  return slotEntries(row, side).filter((e) => e.slot !== primary);
}

/**
 * True when the row carries operator-attached extras beyond the primary —
 * i.e. deleting it during reconciliation cleanup would be destructive (NEO-6).
 */
export function hasOperatorExtras(row: SlotBearingRow): boolean {
  return (
    extraSlots(row, "bsc").length > 0 ||
    extraSlots(row, "sportlots").length > 0
  );
}

/**
 * Display label for a slot, falling back to the marketplace set id.
 *
 * Under NEO-137 every slot gets a label at attach time, so the fallback only
 * covers a slot written before its label (or one whose label was cleared).
 */
export function slotLabel(
  row: SlotBearingRow,
  side: PlatformSide,
  slot: string,
): string {
  return row.platformLabels?.[side]?.[slot] ?? idForSlot(row, side, slot) ?? slot;
}

/**
 * Result of allocating slots: the new maps plus the bumped counter.
 *
 * Returned rather than applied so callers can fold it into one `ctx.db.patch`
 * — the counter and the map it guards must move together or a crash between
 * them would let the next allocation reuse a key.
 */
export type SlotAllocation = {
  platformData: PlatformDataShape;
  platformLabels: { bsc?: Record<string, string>; sportlots?: Record<string, string> };
  platformSlotSeq: SlotSeqShape;
  /** Slot key per attached marketplace set id, including ids already present. */
  slotByIdBySide: Record<PlatformSide, Record<string, string>>;
  /** How many ids were genuinely new (already-attached ids do not count). */
  attachedCount: number;
};

/**
 * Attach marketplace set ids to a row, allocating a fresh slot for each id not
 * already attached on that side. Re-attaching an existing id is a no-op for
 * `platformData` but still refreshes the label — an operator re-attaching with
 * a cleaner name expects it to stick.
 *
 * `platformSlotSeq` only ever increases, including across detach/re-attach
 * cycles, so slot keys are never recycled.
 */
export function allocateSlots(
  row: SlotBearingRow,
  additions: Partial<Record<PlatformSide, Array<{ id: string; label?: string }>>>,
): SlotAllocation {
  const platformData: PlatformDataShape = {
    ...(row.platformData?.bsc ? { bsc: { ...row.platformData.bsc } } : {}),
    ...(row.platformData?.sportlots
      ? { sportlots: { ...row.platformData.sportlots } }
      : {}),
  };
  const platformLabels: {
    bsc?: Record<string, string>;
    sportlots?: Record<string, string>;
  } = {
    ...(row.platformLabels?.bsc ? { bsc: { ...row.platformLabels.bsc } } : {}),
    ...(row.platformLabels?.sportlots
      ? { sportlots: { ...row.platformLabels.sportlots } }
      : {}),
  };
  const platformSlotSeq: SlotSeqShape = { ...(row.platformSlotSeq ?? {}) };
  const slotByIdBySide: Record<PlatformSide, Record<string, string>> = {
    bsc: {},
    sportlots: {},
  };
  let attachedCount = 0;

  for (const side of ["bsc", "sportlots"] as const) {
    // Seed with what is already attached so callers can resolve any id to its
    // slot, not just the ones added in this call.
    for (const { slot, id } of slotEntries({ platformData }, side)) {
      slotByIdBySide[side][id] = slot;
    }

    const sideAdditions = additions[side] ?? [];
    if (sideAdditions.length === 0) continue;

    // Seed the counter above the highest slot already in use. A row written
    // before platformSlotSeq existed has no counter, and starting from 0 would
    // collide with its existing slots.
    let next =
      platformSlotSeq[side] ??
      slotEntries({ platformData }, side).reduce(
        (max, e) => Math.max(max, slotNumber(e.slot) + 1),
        0,
      );

    for (const { id, label } of sideAdditions) {
      if (!id) continue;
      let slot = slotByIdBySide[side][id];
      if (!slot) {
        slot = `${SLOT_PREFIX[side]}${next}`;
        next += 1;
        platformData[side] = { ...(platformData[side] ?? {}), [slot]: id };
        slotByIdBySide[side][id] = slot;
        attachedCount += 1;
      }
      if (label !== undefined) {
        platformLabels[side] = { ...(platformLabels[side] ?? {}), [slot]: label };
      }
    }

    platformSlotSeq[side] = next;
  }

  return {
    platformData,
    platformLabels,
    platformSlotSeq,
    slotByIdBySide,
    attachedCount,
  };
}

/**
 * Detach one slot, leaving `platformSlotSeq` untouched so the key is retired
 * permanently. Labels for the removed slot go with it.
 */
export function detachSlot(
  row: SlotBearingRow,
  side: PlatformSide,
  slot: string,
): { platformData: PlatformDataShape; platformLabels: { bsc?: Record<string, string>; sportlots?: Record<string, string> } } {
  const platformData: PlatformDataShape = {
    ...(row.platformData?.bsc ? { bsc: { ...row.platformData.bsc } } : {}),
    ...(row.platformData?.sportlots
      ? { sportlots: { ...row.platformData.sportlots } }
      : {}),
  };
  const platformLabels: {
    bsc?: Record<string, string>;
    sportlots?: Record<string, string>;
  } = {
    ...(row.platformLabels?.bsc ? { bsc: { ...row.platformLabels.bsc } } : {}),
    ...(row.platformLabels?.sportlots
      ? { sportlots: { ...row.platformLabels.sportlots } }
      : {}),
  };

  if (platformData[side]) {
    const next = { ...platformData[side] };
    delete next[slot];
    if (Object.keys(next).length > 0) platformData[side] = next;
    else delete platformData[side];
  }
  if (platformLabels[side]) {
    const next = { ...platformLabels[side] };
    delete next[slot];
    if (Object.keys(next).length > 0) platformLabels[side] = next;
    else delete platformLabels[side];
  }

  return { platformData, platformLabels };
}

/**
 * Point this side's PRIMARY slot at `id`, allocating a slot if the side has
 * none yet, or retiring the primary slot when `id` is undefined.
 *
 * Shared by both sync paths (`storeSelectorOptions` and
 * `storeReconciledOptions`) so they agree on the rule that matters: the slot
 * KEY is reused when the marketplace ID is refreshed. A marketplace re-slug
 * changes the id, not which set it is, and every card already pointing at that
 * slot must keep resolving — retiring the key on a routine re-sync would
 * orphan the entire checklist.
 *
 * Operator-attached extras on the side are never touched.
 */
export function setPrimarySlotId(
  row: SlotBearingRow,
  side: PlatformSide,
  id: string | undefined,
  label?: string,
): {
  platformData: PlatformDataShape;
  platformLabels: { bsc?: Record<string, string>; sportlots?: Record<string, string> };
  platformSlotSeq: SlotSeqShape;
  /** The slot now holding `id`, or undefined when the side was cleared. */
  slot: string | undefined;
} {
  const existingPrimary = primarySlot(row, side);

  if (!id) {
    if (!existingPrimary) {
      return {
        platformData: { ...row.platformData },
        platformLabels: { ...(row.platformLabels ?? {}) },
        platformSlotSeq: { ...(row.platformSlotSeq ?? {}) },
        slot: undefined,
      };
    }
    const detached = detachSlot(row, side, existingPrimary);
    return {
      ...detached,
      // Counter deliberately NOT rewound — the freed key is retired.
      platformSlotSeq: { ...(row.platformSlotSeq ?? {}) },
      slot: undefined,
    };
  }

  if (existingPrimary) {
    const platformData: PlatformDataShape = {
      ...row.platformData,
      [side]: { ...(row.platformData?.[side] ?? {}), [existingPrimary]: id },
    };
    const platformLabels = { ...(row.platformLabels ?? {}) };
    if (label !== undefined) {
      platformLabels[side] = {
        ...(platformLabels[side] ?? {}),
        [existingPrimary]: label,
      };
    }
    return {
      platformData,
      platformLabels,
      platformSlotSeq: { ...(row.platformSlotSeq ?? {}) },
      slot: existingPrimary,
    };
  }

  const alloc = allocateSlots(row, {
    [side]: [{ id, ...(label !== undefined ? { label } : {}) }],
  });
  return {
    platformData: alloc.platformData,
    platformLabels: alloc.platformLabels,
    platformSlotSeq: alloc.platformSlotSeq,
    slot: alloc.slotByIdBySide[side][id],
  };
}

/** Drop empty side maps so we never store `{ bsc: {} }`. */
export function pruneEmptySides<T extends Record<string, Record<string, unknown> | undefined>>(
  maps: T,
): T {
  const out = { ...maps };
  for (const side of ["bsc", "sportlots"] as const) {
    const m = out[side as keyof T] as Record<string, unknown> | undefined;
    if (!m || Object.keys(m).length === 0) delete out[side as keyof T];
  }
  return out;
}

/**
 * Build a fresh row's slot maps from marketplace set ids — the
 * reconciler-insert path, where no prior slots exist. Slot numbering starts at
 * 0 and the counter is seeded past the last allocation.
 */
export function initialSlots(
  ids: Partial<Record<PlatformSide, Array<{ id: string; label?: string }>>>,
): SlotAllocation {
  return allocateSlots(
    { platformData: {}, platformSlotSeq: {} },
    ids,
  );
}

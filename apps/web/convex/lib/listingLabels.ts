/**
 * NEO-370 — how the Sync status tab names a set and a card, from NB's own
 * rows only (never a marketplace value or name).
 *
 * The words match the collection screens (`app/collection/final/data/labels.ts`):
 *   - a set + variant reads "1996 Playoff Contenders" for a Base variant and
 *     "2024 Topps Chrome Gold Refractor" / "1996 Playoff Contenders Pennant
 *     Flyers" otherwise (`setAndVariant`): the set's season and name, then the
 *     variant (its insert's name first for a parallel under an insert);
 *   - a card reads as its player names joined " / " (`playerNames`), or the
 *     card's own NB name when no player is linked (a team checklist card).
 *
 * Every read is cached per call (`CatalogReader` for the ancestors, maps for
 * cards and players), so a status read that names many cards of one set
 * reads that set's chain once. The caller bounds how many it names.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { CatalogReader } from "./catalogView";

type Ctx = Pick<QueryCtx, "db">;

/** What a variant reads as when its row (or its set) is gone from NB. */
export const MISSING_SET_LABEL = "A set no longer in NeonBinder";

/** The pieces of a variant's label, as the collection screens map them. */
export function setAndVariantLabel(parts: {
  season: string;
  setName: string;
  level: string;
  typeKind: "base" | "insert" | "parallel" | null;
  name: string;
  insertName: string | null;
}): string {
  const set = `${parts.season} ${parts.setName}`.trim();
  // A variant type row: Base reads as the set alone; any other type by name.
  if (parts.level === "variantType") {
    return parts.typeKind === "base" || !parts.name ? set : `${set} ${parts.name}`;
  }
  // A sub-variant under an insert: the insert's name first.
  if (parts.level === "parallel" && parts.insertName) {
    return `${set} ${parts.insertName} ${parts.name}`;
  }
  return parts.name ? `${set} ${parts.name}` : set;
}

/** Player names joined " / ", else the card's own NB name; undefined when both are blank. */
export function cardLabelOf(playerNames: ReadonlyArray<string>, cardName: string): string | undefined {
  const players = playerNames.map((n) => n.trim()).filter(Boolean);
  if (players.length > 0) return players.join(" / ");
  const own = cardName.trim();
  return own ? own : undefined;
}

export interface LabeledCard {
  cardNo: string;
  cardLabel?: string;
  /** The card's variant now (`cardChecklist.selectorOptionId`). */
  variantId: Id<"selectorOptions">;
}

export class ListingLabels {
  private readonly reader: CatalogReader;
  private readonly sets = new Map<string, string>();
  private readonly cards = new Map<string, LabeledCard | null>();
  private readonly players = new Map<string, Doc<"players"> | null>();

  constructor(private readonly ctx: Ctx) {
    this.reader = new CatalogReader(ctx);
  }

  /** The set + variant label of a card-bearing row (`MISSING_SET_LABEL` when it is gone). */
  async setLabel(variantId: Id<"selectorOptions">): Promise<string> {
    const key = variantId as string;
    const cached = this.sets.get(key);
    if (cached !== undefined) return cached;
    const set = await this.reader.setRef(variantId);
    const variant = await this.reader.variantRef(variantId);
    const label =
      set && variant
        ? setAndVariantLabel({
            season: set.season,
            setName: set.name,
            level: variant.level,
            typeKind: variant.kind,
            name: variant.name,
            insertName: variant.insert?.name ?? null,
          })
        : set
          ? `${set.season} ${set.name}`.trim()
          : MISSING_SET_LABEL;
    this.sets.set(key, label);
    return label;
  }

  /** A card's number and label, or null when the id is not a catalog card any more. */
  async card(rawId: string): Promise<LabeledCard | null> {
    const cached = this.cards.get(rawId);
    if (cached !== undefined) return cached;
    const id = this.ctx.db.normalizeId("cardChecklist", rawId);
    const row = id ? await this.ctx.db.get(id) : null;
    if (!row) {
      this.cards.set(rawId, null);
      return null;
    }
    const names: string[] = [];
    const seen = new Set<string>();
    const ids = row.playerLinks?.map((l) => l.playerId) ?? row.playerIds ?? [];
    for (const playerId of ids) {
      if (seen.has(playerId as string)) continue;
      seen.add(playerId as string);
      const player = await this.player(playerId);
      if (player) names.push(player.name);
    }
    const label = cardLabelOf(names, row.cardName);
    const out: LabeledCard = {
      cardNo: row.cardNumber,
      ...(label !== undefined ? { cardLabel: label } : {}),
      variantId: row.selectorOptionId,
    };
    this.cards.set(rawId, out);
    return out;
  }

  private async player(id: Id<"players">): Promise<Doc<"players"> | null> {
    const key = id as string;
    if (!this.players.has(key)) this.players.set(key, await this.ctx.db.get(id));
    return this.players.get(key) ?? null;
  }
}

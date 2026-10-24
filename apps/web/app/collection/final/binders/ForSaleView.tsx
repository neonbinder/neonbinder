import { useState } from "react";
import NeonButton from "@/components/modules/NeonButton";
import CardFace from "../../prototypes/_shared/CardFace";
import { LoadingNote, SkeletonBars } from "../catalog/Skeleton";
import { CONTAINER_COPIES_DEFAULT_LIMIT, useContainerCopies, useContainers } from "../data/store";
import { BOX_ROWS, type Card, type Container, type Copy } from "../data/types";
import { useCardMap } from "./hooks";
import { cardCount, havePocketLabel, rowName } from "./model";
import { forSaleCount } from "./Shelf";
import "./box.css";

/**
 * NEO-359 — the Inventory long box on the real collection: every copy that
 * is for sale, which is every copy whose home is a box, box by box. The
 * headline is the shelf's "N for sale" (the boxes' counts summed).
 *
 * Kept in this one component on purpose: what the long box opens on real
 * data is still being settled with Jason (a combined view here, or the real
 * Inventory page once it reads boxes), so changing it touches this file and
 * the shelf's `InventoryBox` only. The demo's long box still leads to the
 * Inventory tour.
 */
export default function ForSaleView({
  onOpenBox,
  onOpenCard,
}: {
  onOpenBox: (box: Container) => void;
  onOpenCard: (card: Card, copy: Copy) => void;
}) {
  const containers = useContainers();
  if (!containers) {
    return (
      <div className="mt-4">
        <LoadingNote>Counting what&apos;s for sale…</LoadingNote>
        <SkeletonBars rows={3} className="mt-3" />
      </div>
    );
  }
  const boxes = containers.filter((c) => c.kind === "box" && !c.rule);
  const total = forSaleCount(containers);
  if (boxes.length === 0) {
    return (
      <div className="mt-4 rounded-lg border border-dashed border-control px-4 py-8 text-center">
        <p className="text-ink">Nothing&apos;s for sale yet.</p>
        <p className="mt-1 text-sm text-ink-2">
          Make a box from the shelf (New binder or box), then move cards into it. Everything in a box is for sale.
        </p>
      </div>
    );
  }
  return (
    <div className="mt-2">
      <p className="text-lg font-bold text-ink tabular-nums">
        {total === null ? "Counting what's for sale" : `${cardCount(total)} for sale`} in {boxes.length}{" "}
        {boxes.length === 1 ? "box" : "boxes"}
      </p>
      {boxes.map((box) => (
        <BoxSection key={box.id} box={box} onOpenBox={() => onOpenBox(box)} onOpenCard={onOpenCard} />
      ))}
    </div>
  );
}

function BoxSection({
  box,
  onOpenBox,
  onOpenCard,
}: {
  box: Container;
  onOpenBox: () => void;
  onOpenCard: (card: Card, copy: Copy) => void;
}) {
  const [limit, setLimit] = useState(CONTAINER_COPIES_DEFAULT_LIMIT);
  const page = useContainerCopies(box.id, { limit });
  const cards = useCardMap(page ? page.copies.map((c) => c.cardId) : null);
  const n = box.count?.copies ?? null;
  return (
    <section aria-label={`${box.name}, for sale`} className="nb-sale-box mt-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-base font-bold text-ink">{box.name}</h3>
        <span className="text-sm tabular-nums text-ink-2">{n === null ? "counting" : cardCount(n)}</span>
        <NeonButton
          type="button"
          variant="secondary"
          outline
          size="1"
          onClick={onOpenBox}
          aria-label={`Open the box, ${box.name}`}
          className="ml-auto min-h-8 max-sm:min-h-11"
        >
          Open the box
        </NeonButton>
      </div>
      {!page || !cards ? (
        <SkeletonBars rows={1} className="mt-2" />
      ) : page.copies.length === 0 ? (
        <p className="mt-2 text-sm text-ink-2">Empty for now.</p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-2">
          {page.copies.map((copy) => {
            const card = cards.get(copy.cardId);
            if (!card) return null;
            const where = copy.slot !== undefined && copy.slot >= 0 && copy.slot < BOX_ROWS ? rowName(copy.slot) : "not in a row";
            return (
              <li key={copy.id} className="w-[88px]">
                <button
                  type="button"
                  aria-haspopup="dialog"
                  aria-label={`${havePocketLabel(card, [copy])}, ${box.name}, ${where}`}
                  onClick={() => onOpenCard(card, copy)}
                  className="block w-full rounded focus-outline"
                >
                  <CardFace model={card} size="sm" serial={copy.serialNumber} />
                </button>
                <p aria-hidden="true" className="mt-0.5 text-center text-[11px] text-ink-2">
                  {where}
                  {copy.quantity > 1 ? `, ×${copy.quantity}` : ""}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {page?.truncated && (
        <NeonButton
          type="button"
          variant="secondary"
          outline
          onClick={() => setLimit((l) => l + CONTAINER_COPIES_DEFAULT_LIMIT)}
          className="mt-2 min-h-10"
        >
          Show more from {box.name}
        </NeonButton>
      )}
    </section>
  );
}

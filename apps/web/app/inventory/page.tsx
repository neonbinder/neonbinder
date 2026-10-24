import { ConvexCollectionProvider } from "@/app/collection/final/data/convexStore";
import FinalCollectionPage from "@/app/collection/final/FinalCollectionPage";

/**
 * `/inventory` (NEO-359): the signed-in collector's cards for sale. A box is
 * the sale table, so Inventory is their boxes: the box shelf, "New box", an
 * open box with its five rows (`?b=<boxId>`), and every card in every box at
 * once (`?sale=1`). Each is a pushed view, so Back steps back through them.
 *
 * It is the collection page on its Inventory surface, on the same Convex
 * store `/collection` uses (`../collection/page.tsx`), so the card drawer,
 * the status line with Undo and the hunt tray are the same. Boxes never
 * stand on the collection's own screens, and binders never stand here
 * (Jason: "Inventory is things for sale and My Collection is things that are
 * for your collection. They should not mix on the screens"). A card goes up
 * for sale from its drawer anywhere (Sell), or by moving it into an open box
 * here.
 */
export default function InventoryPage() {
  return (
    <ConvexCollectionProvider>
      <FinalCollectionPage surface="inventory" />
    </ConvexCollectionProvider>
  );
}

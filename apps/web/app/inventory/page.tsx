import { ConvexCollectionProvider } from "@/app/collection/final/data/convexStore";
import FinalCollectionPage from "@/app/collection/final/FinalCollectionPage";

/**
 * `/inventory` (NEO-364): the signed-in collector's real inventory, the
 * other side of the collection page (hard line: Collection = Binders,
 * Inventory = Boxes). The same page as `/collection` on the same Convex
 * store, on its inventory side: the Inventory list (`tab=cards`, the
 * default), My Boxes (`tab=boxes`) and Checklists with quick quantity entry.
 * A card crosses between the two only through the card drawer's Sell and
 * Take off sale.
 */
export default function InventoryPage() {
  return (
    <ConvexCollectionProvider>
      <FinalCollectionPage surface="inventory" />
    </ConvexCollectionProvider>
  );
}

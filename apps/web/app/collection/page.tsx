import { ConvexCollectionProvider } from "./final/data/convexStore";
import FinalCollectionPage from "./final/FinalCollectionPage";

/**
 * `/collection` (NEO-358): the signed-in collector's real collection, on the
 * Convex store (`./final/data/convexStore`). Alpha, with no gate: every
 * signed-in collector gets it. What has not shipped yet (binders, wants,
 * trade, card requests) stays hidden through the store's capabilities.
 *
 * The hard-coded demo is public-only now, on `/binder-tracking?demo=on`
 * (`./final/PublicCollectionDemo`), and never touches Convex or Clerk. The
 * prototypes stay at `/collection/1` to `/5` as a signed-in reference.
 */
export default function CollectionPage() {
  return (
    <ConvexCollectionProvider>
      <FinalCollectionPage />
    </ConvexCollectionProvider>
  );
}

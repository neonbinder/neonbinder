import FinalCollectionPage from "./final/FinalCollectionPage";

/**
 * `/collection` (NEO-350): the collection demo, a permanent hard-coded
 * marketing demo built from prototypes 1-3. Signed-in collectors see it here
 * forever; it never connects to Convex and is not the future real
 * collection. The public plays with the same page on `/binder-tracking`
 * (`./final/PublicCollectionDemo`). The prototypes stay at `/collection/1`
 * to `/5` as a signed-in reference.
 */
export default function CollectionPage() {
  return <FinalCollectionPage />;
}

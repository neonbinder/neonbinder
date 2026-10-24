import { DemoCollectionProvider, PUBLIC_STORAGE_KEY } from "./data/demoStore";
import FinalCollectionPage from "./FinalCollectionPage";

/**
 * NEO-350 — the no-login collection demo, as the `/binder-tracking`
 * marketing page shows it (lazy-loaded there, so the fake catalog and its CSS
 * stay out of the main bundle).
 *
 * The same page signed-in collectors see at `/collection`, in public mode and
 * on the demo store (`./data/demoStore`): no Clerk, no Convex, its own
 * sessionStorage key, its views on the
 * marketing page's URL beside `demo=on` (so Back steps back through them),
 * and signed-in destinations pointed at the public tour (see `./mode`). This component only supplies the frame the signed-in binder
 * shell would: the content column (with the right-edge gutter the pack tray
 * expects on a wide screen) and the scroll headroom
 * (`src/layouts/binder-layout.tsx`, NEO-260; keep the 208px in step).
 */
export default function PublicCollectionDemo({
  onExit,
  keepParams,
}: {
  /** Leave the demo and go back to the tour. */
  onExit: () => void;
  /** The marketing page's own params, kept on every demo view URL (`demo=on`). */
  keepParams: Record<string, string>;
}) {
  return (
    <main className="min-h-screen min-w-0 bg-background lg:pr-[170px]">
      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        <DemoCollectionProvider storageKey={PUBLIC_STORAGE_KEY}>
          <FinalCollectionPage mode="public" keepParams={keepParams} onExit={onExit} />
        </DemoCollectionProvider>
      </div>
      <div aria-hidden="true" className="h-[208px]" />
    </main>
  );
}

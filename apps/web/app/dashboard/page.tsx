import { ConvexCollectionProvider } from "@/app/collection/final/data/convexStore";
import { useState } from "react";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import DashboardScreen from "./screen/DashboardScreen";
import { useRealDashboard } from "./real/useRealDashboard";

/**
 * `/dashboard` (NEO-464): the signed-in collector's dashboard, on their real
 * collection through the Convex collection store. The screen is the same
 * one the logged-out demo (`/demo`) draws on fake data.
 */
export default function DashboardPage() {
  useDocumentTitle("Dashboard | Neon Binder");
  return (
    <ConvexCollectionProvider>
      <RealDashboardPage />
    </ConvexCollectionProvider>
  );
}

function RealDashboardPage() {
  const data = useRealDashboard();
  // Loading shows once, on the way in. After that a read that starts over (a
  // want starred in the card panel re-reads the chase's cards) keeps the last
  // screen up until it answers: the screen, and the card panel open over it,
  // never drop out from under the collector.
  const [shown, setShown] = useState(data);
  if (data && data !== shown) setShown(data);
  const screen = data ?? shown;
  if (!screen) return <DashboardLoading />;
  return <DashboardScreen data={screen} />;
}

/** While the shelf loads: the greeting's place and a row of blank spines, quiet and still. */
function DashboardLoading() {
  return (
    <div role="status" className="space-y-12">
      <span className="sr-only">Loading your dashboard.</span>
      <div className="space-y-3" aria-hidden="true">
        <div className="h-9 w-72 max-w-full rounded-md bg-raised" />
        <div className="h-5 w-96 max-w-full rounded-md bg-raised" />
      </div>
      <div className="space-y-4" aria-hidden="true">
        <div className="h-7 w-40 rounded-md bg-raised" />
        <div className="flex h-56 items-end gap-2 border-b-4 border-rule px-2">
          {[58, 50, 62, 46, 54].map((w, i) => (
            <div key={i} className="h-48 rounded-t-md bg-raised" style={{ width: w }} />
          ))}
        </div>
      </div>
    </div>
  );
}

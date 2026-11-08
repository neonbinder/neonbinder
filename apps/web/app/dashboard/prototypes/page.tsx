import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router";
import { BrandMark } from "@/components/primitives/BrandMark";
import NeonButton from "@/components/modules/NeonButton";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import PrototypeBanner from "./_shared/PrototypeBanner";
import { DASHBOARD_BASE_PATH, dashboardPrototype, parseDashboardNumber, type DashboardNumber } from "./_shared/names";

/**
 * NEO-464 — the five dashboard prototypes, public and logged out at
 * `/dashboard-demo/:n`. Hard-coded data only (`./_shared/data`): no Convex,
 * no Clerk beyond the root provider the theme switch asks about.
 *
 * The page supplies the frame the signed-in shell would: a plain header
 * (brand, Sign up), the prototype bar, and the prototype itself, each its own
 * chunk. The prototype renders the page's one `<h1>`.
 *
 * An unknown `:n` goes to prototype 1, replacing the entry.
 */

const PROTOTYPES: Record<DashboardNumber, LazyExoticComponent<ComponentType>> = {
  1: lazy(() => import("./p1/Dashboard")),
  2: lazy(() => import("./p2/Dashboard")),
  3: lazy(() => import("./p3/Dashboard")),
  4: lazy(() => import("./p4/Dashboard")),
  5: lazy(() => import("./p5/Dashboard")),
};

export default function DashboardPrototypesPage() {
  const { n } = useParams();
  const { search } = useLocation();
  const current = parseDashboardNumber(n);
  if (current === null) return <Navigate to={`${DASHBOARD_BASE_PATH}/1${search}`} replace />;
  return <PrototypeFrame current={current} />;
}

function PrototypeFrame({ current }: { current: DashboardNumber }) {
  const { name } = dashboardPrototype(current);
  useDocumentTitle(`Dashboard ${current}: ${name} | Neon Binder`);
  const Prototype = PROTOTYPES[current];

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between gap-3 border-b-2 border-rule bg-surface px-4 py-3 sm:px-6">
        <Link to="/" aria-label="Neon Binder home" className="flex min-w-0 items-center gap-2 rounded-md focus-outline">
          <BrandMark size={36} />
          <span className="neon-header text-wordmark whitespace-nowrap max-sm:!text-xl">Neon Binder</span>
        </Link>
        <NeonButton asChild className="min-h-10 shrink-0 max-sm:min-h-11">
          <Link to="/sign-up">Sign up free</Link>
        </NeonButton>
      </header>
      <div className="mx-auto max-w-6xl px-4 py-4 sm:px-6 sm:py-6">
        <PrototypeBanner current={current} />
        <main className="mt-6 min-w-0">
          <Suspense
            fallback={
              <p role="status" className="text-sm text-ink-3">
                Sleeving the cards…
              </p>
            }
          >
            {/* Keyed: a jump between prototypes starts the new one fresh. */}
            <Prototype key={current} />
          </Suspense>
        </main>
      </div>
    </div>
  );
}

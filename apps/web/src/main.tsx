import "./sentry";
import "@/app/globals.css";
import "@radix-ui/themes/styles.css";

import { lazy, StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router";
import { ClerkProvider } from "@clerk/clerk-react";
import { Theme } from "@radix-ui/themes";
import { PostHogProvider } from "@/components/modules/PostHogProvider";
import ConvexClientProvider from "@/components/modules/ConvexClientProvider";
import * as Sentry from "@sentry/react";

import ProtectedLayout from "@/src/layouts/ProtectedLayout";
import BinderLayout from "@/src/layouts/binder-layout";
import AdminLayout from "@/src/layouts/AdminLayout";
import AdminSectionLayout from "@/src/layouts/admin-section-layout";
import ProfileLayout from "@/src/layouts/profile-layout";
import PrintLayout from "@/src/layouts/print-layout";

import {
  Deferred,
  PrefetchBinderTabs,
  loadAdminHub,
  loadCollection,
  loadDashboard,
  loadInventory,
  loadPrintHub,
  loadProfilePublic,
} from "@/src/routes/lazy-routes";

// Pages. Only Home (the landing page, and the first paint for most visitors)
// ships in the entry bundle; every other page is its own chunk, fetched when
// its route first renders (ui-audit 2026-10). Before this the entry carried
// all ~45 pages, the /testing harness and the admin set builder included, to
// every visitor of the landing page.
import Home from "@/app/page";
const About = lazy(() => import("@/app/about/page"));
const BinderTracking = lazy(() => import("@/app/binder-tracking/page"));
const AiCardIdentification = lazy(() => import("@/app/ai-card-identification/page"));
const ManagingInventory = lazy(() => import("@/app/managing-inventory/page"));
const ShippingLabelsMarketing = lazy(() => import("@/app/shipping-labels/page"));
const PrintShopMarketing = lazy(() => import("@/app/print-shop/page"));
const EasypostSetup = lazy(() => import("@/app/easypost-setup/page"));
const SignInPage = lazy(() => import("@/app/signin/[[...sign-in]]/page"));
const SignUpPage = lazy(() => import("@/app/sign-up/[[...sign-up]]/page"));
const PublicProfile = lazy(() => import("@/app/u/[username]/page"));
const SalePage = lazy(() => import("@/app/u/[username]/sale/page"));
const TestSignIn = lazy(() => import("@/app/testing/sign-in/page"));
const TestReset = lazy(() => import("@/app/testing/reset/page"));
const TestSeedCredentials = lazy(() => import("@/app/testing/seed-credentials/page"));
const TestNeedsReauth = lazy(() => import("@/app/testing/needs-reauth/page"));
const TestSeedPlaceholderRun = lazy(() => import("@/app/testing/seed-placeholder-run/page"));
const TestSeedPlaceholderUpload = lazy(() => import("@/app/testing/seed-placeholder-upload/page"));
const Dashboard = lazy(loadDashboard);
const ProfilePublic = lazy(loadProfilePublic);
const ProfileCredentials = lazy(() => import("@/app/profile/credentials/page"));
const ProfileShipping = lazy(() => import("@/app/profile/shipping/page"));
const ProfilePostage = lazy(() => import("@/app/profile/postage/page"));
const ProfilePrizes = lazy(() => import("@/app/profile/prizes/page"));
const ProfileApiKeys = lazy(() => import("@/app/profile/api-keys/page"));
const AdminHub = lazy(loadAdminHub);
const AdminSetBuilder = lazy(() => import("@/app/admin/set-builder/page"));
const AdminPlayers = lazy(() => import("@/app/admin/players/page"));
const AdminTeams = lazy(() => import("@/app/admin/teams/page"));
const AdminLeagues = lazy(() => import("@/app/admin/leagues/page"));
const AdminFranchises = lazy(() => import("@/app/admin/franchises/page"));
const PipelineRuns = lazy(() => import("@/app/pipeline-runs/page"));
const DesignPrimitives = lazy(() => import("@/app/design/primitives/page"));
const PrintHub = lazy(loadPrintHub);
const PrintLabelHistory = lazy(() => import("@/app/print/labels/page"));
const PrintPlaceholders = lazy(() => import("@/app/print/placeholders/page"));
const PrintQrCode = lazy(() => import("@/app/print/qr/page"));
const PrintShipping = lazy(() => import("@/app/print/shipping/page"));
const PrintBlackoutLabel = lazy(() => import("@/app/print/shipping/blackout/page"));
const PrintSpineLabel = lazy(() => import("@/app/print/spine-label/page"));
const Inventory = lazy(loadInventory);

// NEO-350 — the collection demo and its five reference prototypes are
// lazy-loaded: ~300 fake cards, their art and their CSS stay out of the main
// bundle until someone opens one. /binder-tracking lazy-loads the public copy
// of the demo the same way (app/binder-tracking/page.tsx).
const Collection = lazy(loadCollection);
const CollectionPrototype1 = lazy(() => import("@/app/collection/prototypes/p1/page"));
const CollectionPrototype2 = lazy(() => import("@/app/collection/prototypes/p2/page"));
const CollectionPrototype3 = lazy(() => import("@/app/collection/prototypes/p3/page"));
const CollectionPrototype4 = lazy(() => import("@/app/collection/prototypes/p4/page"));
const CollectionPrototype5 = lazy(() => import("@/app/collection/prototypes/p5/page"));

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

/**
 * The old /placeholders stopgap URL, forwarded to the real tool.
 *
 * Carries the QUERY STRING across, which a bare `<Navigate to="/print/placeholders">`
 * silently drops. `?jobId=…` is the whole point of the link: it is how a run is
 * reopened, and how /testing/seed-placeholder-upload hands the E2E suite its
 * freshly seeded batch. Dropping it lands the user on an empty page with their
 * run apparently gone.
 */
function LegacyPlaceholders() {
  const { search } = useLocation();
  return <Navigate to={`/print/placeholders${search}`} replace />;
}

/**
 * The old /set-selector URL, forwarded to the set builder WITH its query
 * string. NEO-224 put the builder's drill in the URL (`?sport=…&year=…`), so
 * an old bookmark or a flow that still navigates to /set-selector would lose
 * the spot it names to a bare `<Navigate>`. Same shape as LegacyPlaceholders.
 */
function LegacySetSelector() {
  const { search } = useLocation();
  return <Navigate to={`/admin/set-builder${search}`} replace />;
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

const SentryErrorBoundary = Sentry.withErrorBoundary(
  function AppContent() {
    return (
      <BrowserRouter>
        <ScrollToTop />
        <Routes>
          {/* Public routes */}
          <Route path="/" element={<Home />} />
          <Route path="/about" element={<Deferred><About /></Deferred>} />
          <Route path="/binder-tracking" element={<Deferred><BinderTracking /></Deferred>} />
          <Route
            path="/ai-card-identification"
            element={<Deferred><AiCardIdentification /></Deferred>}
          />
          <Route path="/managing-inventory" element={<Deferred><ManagingInventory /></Deferred>} />
          <Route
            path="/shipping-labels"
            element={<Deferred><ShippingLabelsMarketing /></Deferred>}
          />
          <Route path="/print-shop" element={<Deferred><PrintShopMarketing /></Deferred>} />
          <Route path="/easypost-setup" element={<Deferred><EasypostSetup /></Deferred>} />
          <Route path="/signin/*" element={<Deferred><SignInPage /></Deferred>} />
          <Route path="/sign-up/*" element={<Deferred><SignUpPage /></Deferred>} />
          <Route path="/u/:username/sale" element={<Deferred><SalePage /></Deferred>} />
          <Route path="/u/:username" element={<Deferred><PublicProfile /></Deferred>} />
          <Route path="/testing/sign-in" element={<Deferred><TestSignIn /></Deferred>} />
          <Route path="/testing/reset" element={<Deferred><TestReset /></Deferred>} />
          <Route
            path="/testing/seed-credentials"
            element={<Deferred><TestSeedCredentials /></Deferred>}
          />
          <Route path="/testing/needs-reauth" element={<Deferred><TestNeedsReauth /></Deferred>} />
          <Route
            path="/testing/seed-placeholder-run"
            element={<Deferred><TestSeedPlaceholderRun /></Deferred>}
          />
          {/* The E2E suite's door into the real upload path: only the file
              picker is bypassed. Built because the retired maestro-web driver
              could not drive a file input; the Playwright placeholder specs
              still enter through it. */}
          <Route
            path="/testing/seed-placeholder-upload"
            element={<Deferred><TestSeedPlaceholderUpload /></Deferred>}
          />

          {/* Protected routes — wrapped in binder shell */}
          <Route element={<ProtectedLayout />}>
            <Route
              element={
                <>
                  <PrefetchBinderTabs />
                  <BinderLayout />
                </>
              }
            >
              <Route path="/dashboard" element={<Deferred><Dashboard /></Deferred>} />
              {/* NEO-350 — the collection demo: a permanent, hard-coded
                  marketing demo (never Convex), the same page the public
                  plays with on /binder-tracking. Not the future real
                  collection. */}
              <Route path="/collection" element={<Deferred><Collection /></Deferred>} />
              {/* NEO-350 — the five collection prototypes the demo was built
                  from, kept signed-in only as a reference. Hard-coded data
                  (no Convex). Under /collection so the Collection tab stays
                  lit (NavLink matches the prefix). */}
              <Route path="/collection/1" element={<Deferred><CollectionPrototype1 /></Deferred>} />
              <Route path="/collection/2" element={<Deferred><CollectionPrototype2 /></Deferred>} />
              <Route path="/collection/3" element={<Deferred><CollectionPrototype3 /></Deferred>} />
              <Route path="/collection/4" element={<Deferred><CollectionPrototype4 /></Deferred>} />
              <Route path="/collection/5" element={<Deferred><CollectionPrototype5 /></Deferred>} />
              <Route path="/inventory" element={<Deferred><Inventory /></Deferred>} />
              {/* /placeholders was the NEO-170 stopgap intake. NEO-152 replaced
                  it with the real thing at /print/placeholders, so the old path
                  redirects rather than 404s: it was never in the nav, but it is
                  in browser histories and in the /testing entry point the E2E
                  suite uses. `replace` so Back does not bounce off it. */}
              <Route path="/placeholders" element={<LegacyPlaceholders />} />
              {/* One route per profile section (NEO-128). Bare /profile keeps
                  working — every existing link and redirect lands on the index
                  and is forwarded to Public Profile. */}
              <Route path="/profile" element={<ProfileLayout />}>
                <Route index element={<Navigate to="/profile/public" replace />} />
                <Route path="public" element={<Deferred><ProfilePublic /></Deferred>} />
                <Route path="credentials" element={<Deferred><ProfileCredentials /></Deferred>} />
                <Route path="shipping" element={<Deferred><ProfileShipping /></Deferred>} />
                <Route path="postage" element={<Deferred><ProfilePostage /></Deferred>} />
                <Route path="prizes" element={<Deferred><ProfilePrizes /></Deferred>} />
                {/* NEO-172 — self-service Clerk API keys. Protected by the
                    same ProtectedLayout gate as the rest of /profile. */}
                <Route path="api-keys" element={<Deferred><ProfileApiKeys /></Deferred>} />
              </Route>
              {/* Print Shop (NEO-145) — the print tools under one section.
                  Bare /print lists them; each tool is its own sub-route. */}
              <Route path="/print" element={<PrintLayout />}>
                <Route index element={<Deferred><PrintHub /></Deferred>} />
                <Route path="shipping" element={<Deferred><PrintShipping /></Deferred>} />
                {/* NEO-349 — a solid black 4x6 label to cover the old label on a
                    reused mailer. Nested under shipping in the URL because it
                    goes on the same roll; a sibling route, not a child, so it
                    renders in PrintLayout's Outlet like every other tool. */}
                <Route path="shipping/blackout" element={<Deferred><PrintBlackoutLabel /></Deferred>} />
                {/* NEO-213 — reprint a label already bought on /print/shipping.
                    Note the legacy top-level /labels below is the SHIPPING
                    redirect and predates this route; they are different pages
                    and the redirect deliberately stays where it points. */}
                <Route path="labels" element={<Deferred><PrintLabelHistory /></Deferred>} />
                <Route path="qr" element={<Deferred><PrintQrCode /></Deferred>} />
                <Route path="placeholders" element={<Deferred><PrintPlaceholders /></Deferred>} />
                <Route path="spine-label" element={<Deferred><PrintSpineLabel /></Deferred>} />
              </Route>
              {/* The old top-level routes. They are linked from outside the app
                  and sit in people's bookmarks, so they stay forever as
                  redirects rather than 404ing. */}
              <Route
                path="/labels"
                element={<Navigate to="/print/shipping" replace />}
              />
              <Route
                path="/qr-code"
                element={<Navigate to="/print/qr" replace />}
              />
              <Route path="/design/primitives" element={<Deferred><DesignPrimitives /></Deferred>} />
              {/* Admin-only routes — redirected to /dashboard for non-admins.
                  AdminLayout is the AUTHORIZATION gate; AdminSectionLayout
                  inside it is the visual shell with the sub-tabs (NEO-155). */}
              <Route element={<AdminLayout />}>
                <Route path="/admin" element={<AdminSectionLayout />}>
                  <Route index element={<Deferred><AdminHub /></Deferred>} />
                  <Route path="set-builder" element={<Deferred><AdminSetBuilder /></Deferred>} />
                  <Route path="players" element={<Deferred><AdminPlayers /></Deferred>} />
                  <Route path="teams" element={<Deferred><AdminTeams /></Deferred>} />
                  {/* NEO-240 — leagues got a table in NEO-156 and no screen
                      until now; every row a mid-import find-or-create wrote
                      stayed exactly as that caller left it. */}
                  <Route path="leagues" element={<Deferred><AdminLeagues /></Deferred>} />
                  {/* NEO-254 — franchises. Teams are one row per historical
                      name; this is where an operator says which of those rows
                      are one continuous club. */}
                  <Route path="franchises" element={<Deferred><AdminFranchises /></Deferred>} />
                  {/* NEO-170 — operator view of every user's placeholder
                      pipeline runs, with the abort lever. The queries behind
                      it are requireAdmin server-side. Landed top-level while
                      this section didn't exist yet; its own header comment
                      planned this exact move. */}
                  <Route path="pipeline-runs" element={<Deferred><PipelineRuns /></Deferred>} />
                </Route>
                {/* The old top-level routes. Kept forever rather than 404ing:
                    /set-selector is bookmarked, and most E2E specs navigate
                    here by URL (signIn("/set-selector") →
                    /testing/sign-in?redirect=/set-selector) instead of
                    tapping the nav tab — this redirect is what keeps them
                    green across the rename. /pipeline-runs gets the
                    same treatment for the NEO-170 era. */}
                <Route path="/set-selector" element={<LegacySetSelector />} />
                <Route
                  path="/pipeline-runs"
                  element={<Navigate to="/admin/pipeline-runs" replace />}
                />
              </Route>
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
    );
  },
  { fallback: <div>An error occurred. Please refresh the page.</div> },
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ClerkProvider publishableKey={clerkPubKey}>
      <Theme
        accentColor="green"
        grayColor="sage"
        radius="large"
        appearance="dark"
      >
        <PostHogProvider>
          <ConvexClientProvider>
            <SentryErrorBoundary />
          </ConvexClientProvider>
        </PostHogProvider>
      </Theme>
    </ClerkProvider>
  </StrictMode>,
);

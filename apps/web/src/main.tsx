import "./sentry";
import "@/app/globals.css";
import "@radix-ui/themes/styles.css";

import { StrictMode, useEffect } from "react";
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

// Pages
import Home from "@/app/page";
import LandingPage from "@/app/landing";
import About from "@/app/about/page";
import BinderTracking from "@/app/binder-tracking/page";
import AiCardIdentification from "@/app/ai-card-identification/page";
import ManagingInventory from "@/app/managing-inventory/page";
import ShippingLabelsMarketing from "@/app/shipping-labels/page";
import SignInPage from "@/app/signin/[[...sign-in]]/page";
import SignUpPage from "@/app/sign-up/[[...sign-up]]/page";
import PublicProfile from "@/app/u/[username]/page";
import SalePage from "@/app/u/[username]/sale/page";
import TestSignIn from "@/app/testing/sign-in/page";
import TestReset from "@/app/testing/reset/page";
import TestSeedCredentials from "@/app/testing/seed-credentials/page";
import TestNeedsReauth from "@/app/testing/needs-reauth/page";
import Dashboard from "@/app/dashboard/page";
import ProfileLayout from "@/src/layouts/profile-layout";
import ProfilePublic from "@/app/profile/public/page";
import ProfileCredentials from "@/app/profile/credentials/page";
import ProfileShipping from "@/app/profile/shipping/page";
import ProfilePrizes from "@/app/profile/prizes/page";
import AdminHub from "@/app/admin/page";
import AdminSetBuilder from "@/app/admin/set-builder/page";
import AdminTeams from "@/app/admin/teams/page";
import DesignPrimitives from "@/app/design/primitives/page";
import PrintLayout from "@/src/layouts/print-layout";
import PrintHub from "@/app/print/page";
import PrintQrCode from "@/app/print/qr/page";
import PrintShipping from "@/app/print/shipping/page";
import PrintSpineLabel from "@/app/print/spine-label/page";
import Collection from "@/app/collection/page";
import Inventory from "@/app/inventory/page";

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

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
          <Route path="/about" element={<About />} />
          <Route path="/binder-tracking" element={<BinderTracking />} />
          <Route
            path="/ai-card-identification"
            element={<AiCardIdentification />}
          />
          <Route path="/managing-inventory" element={<ManagingInventory />} />
          <Route
            path="/shipping-labels"
            element={<ShippingLabelsMarketing />}
          />
          <Route path="/signin/*" element={<SignInPage />} />
          <Route path="/sign-up/*" element={<SignUpPage />} />
          <Route path="/u/:username/sale" element={<SalePage />} />
          <Route path="/u/:username" element={<PublicProfile />} />
          <Route path="/testing/sign-in" element={<TestSignIn />} />
          <Route path="/testing/reset" element={<TestReset />} />
          <Route
            path="/testing/seed-credentials"
            element={<TestSeedCredentials />}
          />
          <Route path="/testing/needs-reauth" element={<TestNeedsReauth />} />

          {/* Protected routes — wrapped in binder shell */}
          <Route element={<ProtectedLayout />}>
            <Route element={<BinderLayout />}>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/collection" element={<Collection />} />
              <Route path="/inventory" element={<Inventory />} />
              {/* One route per profile section (NEO-128). Bare /profile keeps
                  working — every existing link and redirect lands on the index
                  and is forwarded to Public Profile. */}
              <Route path="/profile" element={<ProfileLayout />}>
                <Route index element={<Navigate to="/profile/public" replace />} />
                <Route path="public" element={<ProfilePublic />} />
                <Route path="credentials" element={<ProfileCredentials />} />
                <Route path="shipping" element={<ProfileShipping />} />
                <Route path="prizes" element={<ProfilePrizes />} />
              </Route>
              {/* Print Shop (NEO-145) — the print tools under one section.
                  Bare /print lists them; each tool is its own sub-route. */}
              <Route path="/print" element={<PrintLayout />}>
                <Route index element={<PrintHub />} />
                <Route path="shipping" element={<PrintShipping />} />
                <Route path="qr" element={<PrintQrCode />} />
                <Route path="spine-label" element={<PrintSpineLabel />} />
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
              <Route path="/design/primitives" element={<DesignPrimitives />} />
              {/* Admin-only routes — redirected to /dashboard for non-admins.
                  AdminLayout is the AUTHORIZATION gate; AdminSectionLayout
                  inside it is the visual shell with the sub-tabs (NEO-155). */}
              <Route element={<AdminLayout />}>
                <Route path="/admin" element={<AdminSectionLayout />}>
                  <Route index element={<AdminHub />} />
                  <Route path="set-builder" element={<AdminSetBuilder />} />
                  <Route path="teams" element={<AdminTeams />} />
                </Route>
                {/* The old top-level route. Kept forever rather than 404ing:
                    it is bookmarked, and ~48 Maestro flows navigate here by
                    URL (/testing/sign-in?redirect=/set-selector) instead of
                    tapping the nav tab — this redirect is what keeps them
                    green across the rename. */}
                <Route
                  path="/set-selector"
                  element={<Navigate to="/admin/set-builder" replace />}
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

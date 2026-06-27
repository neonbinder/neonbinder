import "./sentry";
import "@/app/globals.css";
import "@radix-ui/themes/styles.css";

import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, useLocation } from "react-router";
import { ClerkProvider } from "@clerk/clerk-react";
import { Theme } from "@radix-ui/themes";
import { PostHogProvider } from "@/components/modules/PostHogProvider";
import ConvexClientProvider from "@/components/modules/ConvexClientProvider";
import * as Sentry from "@sentry/react";

import ProtectedLayout from "@/src/layouts/ProtectedLayout";
import BinderLayout from "@/src/layouts/binder-layout";
import AdminLayout from "@/src/layouts/AdminLayout";

// Pages
import Home from "@/app/page";
import LandingPage from "@/app/landing";
import About from "@/app/about/page";
import BinderTracking from "@/app/binder-tracking/page";
import AiCardIdentification from "@/app/ai-card-identification/page";
import ManagingInventory from "@/app/managing-inventory/page";
import SignInPage from "@/app/signin/[[...sign-in]]/page";
import SignUpPage from "@/app/sign-up/[[...sign-up]]/page";
import PublicProfile from "@/app/u/[username]/page";
import SalePage from "@/app/u/[username]/sale/page";
import TestSignIn from "@/app/testing/sign-in/page";
import TestReset from "@/app/testing/reset/page";
import TestSeedCredentials from "@/app/testing/seed-credentials/page";
import Dashboard from "@/app/dashboard/page";
import Profile from "@/app/profile/page";
import SetSelector from "@/app/set-selector/page";
import DesignPrimitives from "@/app/design/primitives/page";
import QrCode from "@/app/qr-code/page";
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

          {/* Protected routes — wrapped in binder shell */}
          <Route element={<ProtectedLayout />}>
            <Route element={<BinderLayout />}>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/collection" element={<Collection />} />
              <Route path="/inventory" element={<Inventory />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/qr-code" element={<QrCode />} />
              <Route path="/design/primitives" element={<DesignPrimitives />} />
              {/* Admin-only routes — redirected to /dashboard for non-admins */}
              <Route element={<AdminLayout />}>
                <Route path="/set-selector" element={<SetSelector />} />
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

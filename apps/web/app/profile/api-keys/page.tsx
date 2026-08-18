import { useEffect, useRef } from "react";
import { APIKeys } from "@clerk/clerk-react";
import * as Sentry from "@sentry/react";
import { ErrorAlert } from "@/components/primitives/ErrorAlert";
import { clerkNeonAppearance } from "@/components/modules/clerk-appearance";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";

/**
 * NEO-172 — /profile/api-keys, the self-service API key screen.
 *
 * Clerk owns the whole key lifecycle (create, list, reveal-once, revoke), so
 * `<APIKeys />` is the feature and this file is the shell around it: a heading,
 * the three things a person has to understand before they mint a credential
 * that acts as them, and a boundary so a Clerk failure cannot take the page
 * with it.
 *
 * WHY IT LIVES UNDER /profile: /profile is already the account-settings area
 * (Public Profile, Credentials, Shipping, Prize Pool), it is already behind
 * `<ProtectedLayout>`, and its shell already renders the "Profile Settings"
 * heading and section nav. A parallel /settings area would have duplicated all
 * of that for one page. The heading here is an `<h2>` because ProfileLayout
 * owns the `<h1>`.
 *
 * THE EXPLANATION IS NOT DECORATION. Clerk's component shows a key's secret
 * exactly once, at creation, and never again — a person who closes that dialog
 * without copying has to revoke and start over. It also cannot tell a leaked
 * key from a legitimate one, so "revoke immediately" is the entire mitigation.
 * Both facts have to be readable BEFORE the create button, not discovered after.
 *
 * FEATURE-NOT-ENABLED RESILIENCE: API keys are a per-instance Clerk setting, so
 * an instance where the feature is off (or a clerk-js that fails to load) is a
 * normal runtime state, not a bug. Everything above the boundary is our own
 * markup and always paints; `<APIKeys />` is free to render its own empty or
 * error state inside it, and if it throws instead, the Sentry boundary swaps in
 * an alert rather than blanking the route. The `fallback` prop covers the third
 * case — clerk-js still downloading — so the slot is never an unexplained gap.
 */
export default function ApiKeysPanel() {
  useDocumentTitle("API Keys | Neon Binder");

  // Give every form Clerk mounts an accessible name. Two reasons, both real:
  //
  // 1. Accessibility: clerk-js renders its create/search forms with no
  //    accessible name, so assistive tech announces an anonymous form.
  // 2. Clerk's create form contains <input name="name">, and per the HTML
  //    spec that makes `form.name` evaluate to the INPUT ELEMENT (named
  //    controls override the form's IDL attributes). Maestro's web driver
  //    reads `node.name` unguarded when building its hierarchy, so that
  //    element makes the whole page's hierarchy unserializable and every
  //    E2E command fails: "Could not retrieve hierarchy through
  //    maestro.getContentDescription()". An aria-label short-circuits the
  //    driver's lookup chain before `node.name` is read. Upstream issue:
  //    https://github.com/mobile-dev-inc/Maestro/issues/3213 (fix PR'd);
  //    the a11y half stands on its own even after the driver is fixed.
  //
  // MutationObserver because the forms are Clerk's DOM, mounted and remounted
  // on its schedule — there is no prop or appearance hook that sets an
  // attribute on them.
  const clerkSlotRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const slot = clerkSlotRef.current;
    if (!slot) return;
    const nameClerkForms = () => {
      for (const form of slot.querySelectorAll("form:not([aria-label]):not([id])")) {
        form.setAttribute("aria-label", "API key form");
      }
    };
    nameClerkForms();
    const observer = new MutationObserver(nameClerkForms);
    observer.observe(slot, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <section aria-labelledby="api-keys-heading" className="space-y-6">
      <header className="space-y-3">
        <h2 id="api-keys-heading" className="text-2xl font-bold">
          API Keys
        </h2>
        <p className="text-slate-400 max-w-2xl">
          An API key lets a script, spreadsheet or tool talk to Neon Binder as
          you, without your password. Create one per tool so you can revoke a
          single key without breaking everything else.
        </p>
        <ul className="list-disc pl-5 space-y-1 text-sm text-slate-400 max-w-2xl">
          <li>
            A key acts as your account. Anything holding it can read and change
            your collection, listings and marketplace connections.
          </li>
          <li>
            The secret is shown once, when you create the key. Copy it then —
            Neon Binder cannot show it to you again.
          </li>
          <li>
            Revoke a key the moment you think it has leaked. Revoking takes
            effect immediately and cannot be undone.
          </li>
        </ul>
      </header>

      <div ref={clerkSlotRef}>
        <Sentry.ErrorBoundary
          fallback={
            <ErrorAlert error="API keys are unavailable right now. Refresh the page, and if this keeps happening the feature may not be enabled for this account yet." />
          }
        >
          <APIKeys
            appearance={clerkNeonAppearance}
            fallback={
              <p role="status" className="text-sm text-slate-400">
                Loading API keys…
              </p>
            }
          />
        </Sentry.ErrorBoundary>
      </div>
    </section>
  );
}

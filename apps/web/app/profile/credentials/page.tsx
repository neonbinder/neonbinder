import { useState, useEffect, useRef } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";

const SUPPORTED_SITES = [
  { key: "buysportscards", label: "BuySportsCards" },
  // NEO-141: "SportLots" is the marketplace's own casing and matches every
  // server-returned message. Maestro text matching is case-insensitive, so the
  // flows that select on "Sportlots" keep working.
  { key: "sportlots", label: "SportLots" },
  // Add more sites here as needed (eBay coming soon)
];

export default function CredentialsPanel() {
  const [selectedSite, setSelectedSite] = useState(SUPPORTED_SITES[0].key);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [messageDetails, setMessageDetails] = useState<string | undefined>(
    undefined,
  );
  const [messageType, setMessageType] = useState<"success" | "error">(
    "success",
  );
  // NEO-141: "has this browser session seen the connection actually work?".
  // This is deliberately NOT a claim about whether the connection is healthy —
  // the server owns that, via `needsReauth`. It only suppresses the "not yet
  // verified" nudge once a connect or test has proved the session works, and it
  // resets when the user switches platforms because it is per-site knowledge.
  //
  // It replaces the old `isAuthenticated`, which asked the browser service
  // whether a secret existed and then optimistically assumed `true` when that
  // call failed — guesswork that could contradict the server. Nothing here
  // guesses any more.
  const [verifiedThisSession, setVerifiedThisSession] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);

  // Refs for clear-confirm modal focus management (2.4.3 Focus Order, 2.1.1 Keyboard)
  const clearTriggerRef = useRef<HTMLElement | null>(null);
  const clearCancelButtonRef = useRef<HTMLButtonElement>(null);
  const clearDialogRef = useRef<HTMLDivElement>(null);

  // Actions and Mutations
  // NEO-89: save (store or clear) is a single action now — the Convex
  // hasCredentials flag is updated server-side inside saveCredentials itself,
  // not as a second client-triggered mutation, so the two can't drift apart.
  // NEO-141: it is also connect-and-store — it performs the live marketplace
  // login itself and stores nothing on failure, so the client no longer chases
  // it with a separate verification call.
  const saveCredentials = useAction(api.credentials.saveCredentials);
  const testSiteCredentials = useAction(api.credentials.testSiteCredentials);

  // Get user profile to check if credentials are stored
  const profile = useQuery(api.userProfile.getUserProfile);
  const siteMeta = SUPPORTED_SITES.find((s) => s.key === selectedSite);

  const siteCredential = profile?.siteCredentials?.find(
    (cred) => cred.site === selectedSite,
  );
  const hasStoredCredentials = !!siteCredential?.hasCredentials;
  // NEO-141: a `reauth_required` failure sets this and LEAVES hasCredentials
  // true — the account is still connected, only the session died. So this must
  // be checked BEFORE the plain connected summary, or the state never renders.
  const needsReauth = !!siteCredential?.needsReauth;

  // Reactive in-flight guard. A credential op (store / test-login / delete)
  // holds a per-(user, site) lock on the backend, surfaced as `lockedAt` on the
  // profile. While ANY site has a LIVE lock, disable every credential control
  // AND the site tabs so a Clear can't race an in-flight marketplace login. The
  // backend release patches the row → this recomputes false (the disable lifts
  // on completion, not on lease expiry). Must be >= the server lease in
  // convex/userProfile.ts (CRED_LOCK_LEASE_MS); a stale lock (crashed op) is
  // ignored after the lease and reclaimed by the next op. `profile === undefined`
  // (loading) and legacy rows without the field read as not-busy.
  const CRED_LOCK_LEASE_MS = 5 * 60 * 1000;
  const anyCredentialOpInFlight =
    profile?.siteCredentials?.some(
      (cred) =>
        typeof cred.lockedAt === "number" &&
        // eslint-disable-next-line react-hooks/purity -- Date.now() for a lock-lease staleness check. Advisory only, and the row it reads re-renders on its own Convex subscription, so a stale frame self-corrects
        cred.lockedAt + CRED_LOCK_LEASE_MS > Date.now(),
    ) || false;
  const credsBusy = isLoading || anyCredentialOpInFlight;

  // Reset form fields and edit mode when site changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate reset-on-prop-change: a different platform is a different credential form
    setUsername("");
    setPassword("");
    setMessage("");
    setVerifiedThisSession(false);
    setEditMode(false);
  }, [selectedSite]);

  // Escape closes the clear-confirm modal (keyboard parity with the Cancel button).
  useEffect(() => {
    if (!confirmingClear) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !credsBusy) setConfirmingClear(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmingClear, credsBusy]);

  // Focus management for the clear-confirm modal: move focus into the Cancel button
  // on open (safe default for a destructive dialog), and return focus to the trigger
  // on close. WCAG 2.4.3 Focus Order requires focus to enter a dialog when it opens
  // and return to the invoking element when it closes.
  useEffect(() => {
    if (confirmingClear) {
      // rAF defers until after the browser has painted the dialog, avoiding a
      // VoiceOver timing edge case where focus lands before the node is visible.
      const raf = requestAnimationFrame(() => clearCancelButtonRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    } else {
      clearTriggerRef.current?.focus();
      clearTriggerRef.current = null;
    }
  }, [confirmingClear]);

  const handleSaveCredentials = async () => {
    if (!username || !password) {
      setMessage("Enter both username and password to connect.");
      setMessageType("error");
      setMessageDetails(undefined);
      return;
    }
    setIsLoading(true);
    setMessage("");
    setMessageDetails(undefined);
    try {
      // NEO-141: one round-trip. `saveCredentials` signs in live, stores only
      // the resulting session, and stores NOTHING when the login is rejected —
      // so the old "saved, but authentication failed" outcome cannot occur and
      // there is no follow-up testSiteCredentials call to make.
      //
      // Its message is already complete and user-facing (it names the site and
      // says the password was not stored), so it is rendered verbatim. Setting
      // a second client-side success string on top would double up.
      const result = await saveCredentials({
        site: selectedSite,
        username,
        password,
      });
      setMessage(result.message);
      setMessageType(result.success ? "success" : "error");
      if (result.success) {
        setPassword("");
        setEditMode(false);
        setVerifiedThisSession(true);
      } else {
        setVerifiedThisSession(false);
      }
    } catch (error) {
      setMessage(
        `Couldn't connect to ${siteMeta?.label}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      setMessageType("error");
      setVerifiedThisSession(false);
    } finally {
      setIsLoading(false);
    }
  };

  const handleTestCredentials = async () => {
    if (!hasStoredCredentials) {
      setMessage(`Connect your ${siteMeta?.label} account first.`);
      setMessageType("error");
      setMessageDetails(undefined);
      return;
    }
    setIsLoading(true);
    // Reset the type before the in-flight message: it is progress, not a
    // failure. Left at a previous "error" it would render red and, now that the
    // banner is a live region, announce assertively (NEO-127).
    setMessageType("success");
    setMessage(`Testing your ${siteMeta?.label} connection...`);
    setMessageDetails(undefined);
    try {
      const testResult = await testSiteCredentials({ site: selectedSite });

      setMessage(testResult.message);
      setMessageDetails(testResult.details);
      setMessageType(testResult.success ? "success" : "error");
      setVerifiedThisSession(testResult.success);
    } catch (error) {
      console.error("Error testing credentials:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      setMessage(`Couldn't test the ${siteMeta?.label} connection. Please try again.`);
      setMessageDetails(
        `An unexpected error occurred while testing credentials: ${errorMessage}`,
      );
      setMessageType("error");
      setVerifiedThisSession(false);
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearCredentials = () => {
    // Capture the trigger before opening so focus can be returned on close (WCAG 2.4.3).
    clearTriggerRef.current = document.activeElement as HTMLElement;
    setConfirmingClear(true);
  };

  // Focus trap for the clear-confirm modal. While the dialog is open, Tab and
  // Shift+Tab must cycle only within the dialog's focusable elements (WCAG 2.1.1,
  // WAI-ARIA Dialog Pattern).
  const handleClearModalKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const dialog = clearDialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const handleConfirmClear = async () => {
    setConfirmingClear(false);
    setIsLoading(true);
    setMessage("");
    // Must clear alongside `message`: details are rendered whenever truthy, so a
    // previous failure's diagnostic would otherwise survive under the green
    // "cleared successfully" banner — and `aria-atomic` reads the two as one
    // unit, announcing a success glued to a stale error (NEO-127).
    setMessageDetails(undefined);
    try {
      const result = await saveCredentials({ site: selectedSite });
      if (!result.success) {
        // e.g. "Another credential operation is in progress — try again."
        setMessage(result.message);
        setMessageType("error");
        return;
      }
      setUsername("");
      setPassword("");
      setVerifiedThisSession(false);
      // The server's clear message interpolates the raw site KEY
      // ("...for sportlots"), so this path keeps a client-side string that can
      // use the display label. The connect path does the opposite — see
      // handleSaveCredentials.
      setMessage(`Cleared your ${siteMeta?.label} connection.`);
      setMessageType("success");
    } catch {
      setMessage("Couldn't clear the connection. Please try again.");
      setMessageType("error");
    } finally {
      setIsLoading(false);
    }
  };

  return (
  <section className="space-y-6 p-6 border border-slate-200 dark:border-slate-800 rounded-lg">
    {profile === undefined ? (
      <p
        data-testid="credentials-loading"
        className="text-sm text-slate-400"
      >
        Loading credentials…
      </p>
    ) : (
      <>
      {/* Site Selector — tab-style buttons. Native <select> is not
          drivable by Maestro web (it can focus the element but
          cannot tap inside the native <option> popup, and
          inputText doesn't simulate the keyboard event the
          browser needs to type-to-select). Buttons are
          click-driven, accessible (role="tab" each + role="tablist"),
          and announce as a platform group to screen readers. */}
      <div>
        <span
          id="site-select-label"
          className="block text-sm font-medium mb-2"
        >
          Select Platform
        </span>
        <div
          role="tablist"
          aria-labelledby="site-select-label"
          className="flex flex-wrap gap-2"
        >
          {SUPPORTED_SITES.map((site) => {
            const isSelected = selectedSite === site.key;
            return (
              <button
                key={site.key}
                type="button"
                role="tab"
                aria-selected={isSelected}
                aria-controls="site-credentials-panel"
                onClick={() => { if (!credsBusy) setSelectedSite(site.key); }}
                disabled={credsBusy}
                className={
                  "px-4 py-2 rounded-md border text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-50 disabled:cursor-not-allowed " +
                  (isSelected
                    ? "border-green-500 bg-green-500/10 text-green-700 dark:text-green-300"
                    : "border-slate-300 dark:border-slate-600 hover:border-green-500 text-foreground")
                }
              >
                {site.label}
              </button>
            );
          })}
        </div>
      </div>
    <div
      id="site-credentials-panel"
      role="tabpanel"
    >
      <h2 className="text-xl font-semibold mb-2">
        {siteMeta?.label} Credentials
      </h2>
      <p className="text-sm text-muted-foreground mb-4">
        Sign in to {siteMeta?.label} to connect your account. Your password is used once to sign in and is never stored — we keep only a session that expires and can be revoked.
      </p>
    </div>

    {/* Credentials UI - same for all sites including BSC.
        Three mutually exclusive states, in this order:
          1. needsReauth (server-owned)  → amber "sign in again" card
          2. connected, not editing      → blue summary card
          3. otherwise                   → the sign-in form
        Order matters: `needsReauth` leaves `hasCredentials` true, so testing it
        second would make the state unreachable (NEO-141). */}
    {needsReauth && !editMode ? (
      <div className="space-y-4">
        <div className="p-4 bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200 border border-amber-300 dark:border-amber-700 rounded-md">
          <strong>Sign in to {siteMeta?.label} again</strong>
          <p className="text-sm mt-1">
            Your {siteMeta?.label} session expired or was revoked, so we can&apos;t
            reach {siteMeta?.label} for you. Sign in again to reconnect — nothing
            else was lost.
          </p>
        </div>
        {/* No "Test Credentials" here on purpose. `reauth_required` means the
            stored session cannot be renewed from anything we hold, so a test
            would fail by construction — offering it would be a control that
            claims to be useful when it is not (same rule as the busy labels
            below). Signing in again is the only repair; clearing is the only
            other legitimate exit. */}
        <div className="flex flex-col sm:flex-row gap-4">
          <NeonButton
            type="button"
            onClick={() => setEditMode(true)}
            disabled={credsBusy}
            className="flex-1"
          >
            Sign in again
          </NeonButton>
          <NeonButton
            type="button"
            onClick={handleClearCredentials}
            disabled={credsBusy}
            className="flex-1 bg-red-600 hover:bg-red-700"
          >
            {credsBusy ? "Clearing..." : "Clear Credentials"}
          </NeonButton>
        </div>
      </div>
    ) : hasStoredCredentials && !editMode ? (
      <div className="space-y-4">
        <div className="p-4 bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200 border border-blue-200 dark:border-blue-800 rounded-md">
          <strong>Connected to {siteMeta?.label}</strong>
          <p className="text-sm mt-1">
            We hold a {siteMeta?.label} session, not your password. You can test
            it or clear it below.
          </p>
        </div>
        {/* Every busy label below is keyed off `credsBusy` — the SAME condition
            as `disabled`, and deliberately NOT off `isLoading` (NEO-128).
            `credsBusy` is `isLoading || anyCredentialOpInFlight`, and that
            second half is a server-side lock held by an op on any site. Keyed
            off `isLoading` alone, the button read "Test Credentials" and looked
            actionable while being disabled: the click did nothing and said
            nothing about why. Keep the two conditions identical — a control
            must never claim to be actionable when it is not.

            This also gives e2e a truthful signal. Maestro cannot read `enabled`
            on web (the web driver reports it as null), so the label is the only
            evidence that the button is tappable; waiting for "Test Credentials"
            now genuinely means waiting for the lock to clear. The seed track
            failed exactly this way when the flows stopped scrolling: they
            reached the button in 0.7s instead of 17s and tapped it while it was
            still locked. */}
        <div className="flex flex-col sm:flex-row gap-4">
          <NeonButton
            type="button"
            onClick={() => setEditMode(true)}
            disabled={credsBusy}
            className="flex-1"
          >
            Sign in again
          </NeonButton>
          <NeonButton
            type="button"
            onClick={handleTestCredentials}
            disabled={credsBusy}
            className="flex-1 bg-slate-600 hover:bg-slate-700"
          >
            {credsBusy ? "Testing..." : "Test Credentials"}
          </NeonButton>
          <NeonButton
            type="button"
            onClick={handleClearCredentials}
            disabled={credsBusy}
            className="flex-1 bg-red-600 hover:bg-red-700"
          >
            {credsBusy ? "Clearing..." : "Clear Credentials"}
          </NeonButton>
        </div>
      </div>
    ) : (
      // Show input fields and Connect/Test buttons if editing or not connected.
      // A real <form> so Enter submits from either field — the project keyboard
      // rule (Enter confirms, Escape cancels); see ReturnAddressEditor. Every
      // other control inside carries type="button" so it neither submits on
      // click nor becomes the implicit-submission default.
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSaveCredentials();
        }}
      >
        <div className="space-y-4">
          <div>
            <label
              htmlFor="username"
              className="block text-sm font-medium mb-2"
            >
              {siteMeta?.label} Username/Email
            </label>
            {/* Explicit `id` is required: Input never generates one (Maestro
                derives resource-id from node.id || node.ariaLabel, so an auto
                id would clobber aria-label selectors) and .maestro flows
                target these two by id. */}
            <Input
              bare
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2"
              autoComplete="username"
              placeholder={`Enter your ${siteMeta?.label} username or email`}
            />
          </div>
          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium mb-2"
            >
              {siteMeta?.label} Password
            </label>
            <Input
              bare
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2"
              autoComplete="current-password"
              aria-describedby={
                selectedSite === "sportlots"
                  ? "sportlots-password-advice"
                  : undefined
              }
              placeholder={`Enter your ${siteMeta?.label} password`}
            />
          </div>
          {selectedSite === "sportlots" && (
            <p
              id="sportlots-password-advice"
              className="text-xs text-amber-600 dark:text-amber-400"
            >
              SportLots has no API, so we sign in as you. We never store your password — but a unique one for SportLots is still a good idea.
            </p>
          )}
        </div>
        <div className="flex flex-col sm:flex-row gap-4 mt-4">
          <NeonButton
            type="submit"
            disabled={credsBusy || !username || !password}
            className="flex-1"
          >
            {credsBusy ? "Connecting..." : "Connect"}
          </NeonButton>
          <NeonButton
            type="button"
            onClick={handleTestCredentials}
            disabled={credsBusy || !hasStoredCredentials}
            className="flex-1 bg-slate-600 hover:bg-slate-700"
          >
            {credsBusy ? "Testing..." : "Test Stored Credentials"}
          </NeonButton>
          {hasStoredCredentials && (
            <NeonButton
              type="button"
              onClick={handleClearCredentials}
              disabled={credsBusy}
              className="flex-1 bg-red-600 hover:bg-red-700"
            >
              {credsBusy ? "Clearing..." : "Clear Credentials"}
            </NeonButton>
          )}
        </div>
        {hasStoredCredentials && (
          <NeonButton
            type="button"
            onClick={() => setEditMode(false)}
            disabled={credsBusy}
            className="mt-2"
          >
            Cancel
          </NeonButton>
        )}
      </form>
    )}
    {confirmingClear && (
      // Centered modal overlay (not inline): a destructive confirm
      // belongs in a modal, and rendering it fixed/centered keeps it out
      // of the sticky-header occlusion band that was stealing the
      // "Yes, Clear" tap when the panel scrolled near the top (NEO-39).
      <div
        ref={clearDialogRef}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="clear-confirm-title"
        onClick={() => !credsBusy && setConfirmingClear(false)}
        onKeyDown={handleClearModalKeyDown}
      >
        <div
          className="w-full max-w-md p-6 bg-white dark:bg-slate-800 border border-amber-200 dark:border-amber-800 rounded-lg shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <p
            id="clear-confirm-title"
            className="text-amber-800 dark:text-amber-200 font-medium mb-4"
          >
            Clear your {siteMeta?.label} connection?
          </p>
          <div className="flex gap-3">
            <NeonButton
              cancel
              type="button"
              onClick={handleConfirmClear}
              disabled={credsBusy}
            >
              {/* Keyed off `credsBusy`, the same condition as `disabled` — see
                  the NEO-128 note above. This button was the one place still
                  keyed off `isLoading`, so a lock held by another site left it
                  reading "Yes, Clear" while it was inert. */}
              {credsBusy ? "Clearing..." : "Yes, Clear"}
            </NeonButton>
            <NeonButton
              ref={clearCancelButtonRef}
              type="button"
              onClick={() => setConfirmingClear(false)}
              disabled={credsBusy}
            >
              Cancel
            </NeonButton>
          </div>
        </div>
      </div>
    )}
    {/* WCAG 2.2 AA §4.1.3 Status Messages (NEO-127). This banner is the
        only feedback for whether a marketplace credential saved,
        authenticated, or failed, and it is inserted after an async
        action without moving focus — so it must be a live region.
        Role is driven off messageType, matching how the rest of the
        codebase splits it: a failed login interrupts (role="alert",
        implicitly assertive), everything else queues politely.
        `key` remounts the node when the type flips, because screen
        readers do not reliably re-evaluate a live region whose role
        changed in place. `aria-atomic` makes the message and its
        details read as one unit rather than only the changed child. */}
    {message && (
      <div
        key={messageType}
        role={messageType === "error" ? "alert" : "status"}
        aria-live={messageType === "error" ? undefined : "polite"}
        aria-atomic="true"
        className={`p-4 rounded-md ${
          messageType === "success"
            ? "bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200 border border-green-200 dark:border-green-800"
            : "bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200 border border-red-200 dark:border-red-800"
        }`}
      >
        <div className="font-medium">{message}</div>
        {messageDetails && (
          <div className="mt-2 text-sm opacity-90">
            <hr
              className={`my-2 border-t ${
                messageType === "success"
                  ? "border-green-200 dark:border-green-700"
                  : "border-red-200 dark:border-red-700"
              }`}
            />
            {messageDetails}
          </div>
        )}
      </div>
    )}
    {/* Not a fourth state — a nudge that sits alongside the connected card
        until something proves the session still works. Suppressed while
        `needsReauth` is set, because then we already know the answer and the
        amber card says so. */}
    {hasStoredCredentials && !needsReauth && !verifiedThisSession && (
      <div className="p-4 bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200 border border-blue-200 dark:border-blue-800 rounded-md">
        <strong>Connection not yet verified</strong>
        <p className="text-sm mt-1">
          Click &quot;Test Stored Credentials&quot; to check that{" "}
          {siteMeta?.label} still accepts this session.
        </p>
      </div>
    )}

      {/* Security Information */}
      <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
        <h3 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">
          Security Information
        </h3>
        <ul className="text-sm text-blue-800 dark:text-blue-200 space-y-1">
          <li>
            • Your password is used once to sign in and is never stored
          </li>
          <li>
            • We keep only a marketplace session, which expires and can be revoked
          </li>
          <li>
            • Your session is only accessible to your account
          </li>
          <li>• We never share your credentials or sessions with third parties</li>
          <li>• You can clear your credentials at any time</li>
        </ul>
      </div>
      </>
    )}
  </section>
  );
}

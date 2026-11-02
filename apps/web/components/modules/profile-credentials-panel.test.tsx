/**
 * NEO-140 / NEO-141 — the credential panel's state machine and its copy.
 *
 * Two things are worth locking down here and nowhere else:
 *
 * 1. **State ORDER.** A `reauth_required` failure sets `needsReauth: true` and
 *    deliberately LEAVES `hasCredentials: true` — the account is still
 *    connected, only the marketplace session died. So the re-auth branch has to
 *    be evaluated before the plain connected summary; evaluated after, it is
 *    unreachable and the user drops back to a bare "enter your credentials"
 *    form with no explanation. That silent fallback is exactly the NEO-140 bug.
 *
 * 2. **Busy label ⇔ disabled.** Every busy label must be keyed off the SAME
 *    condition as `disabled` (NEO-128). Maestro cannot read `enabled` on web,
 *    so the label is the only evidence a control is tappable.
 *
 * ## Why this file is not co-located with the component
 * The `components` Vitest project collects `components/**` and `src/**` only
 * (see vitest.config.ts). A `page.test.tsx` next to
 * `app/profile/credentials/page.tsx` would be collected by nothing and would
 * silently never run — the same trap the config comment already documents for
 * `src/layouts`. Widening that glob is a config change and out of scope for
 * this pass, so the test lives where it is guaranteed to execute.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Theme } from "@radix-ui/themes";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { expectAccessibleInBothModes } from "@/lib/testing/axe";
import { CONSENT_HEADING, CONSENT_LINE } from "@/lib/marketplace/listing-copy";

type SiteCredential = {
  site: string;
  hasCredentials: boolean;
  needsReauth?: boolean;
  needsReauthSince?: number;
  lockedAt?: number;
  lastUpdated?: number;
};

const mocks = vi.hoisted(() => ({
  profile: undefined as { siteCredentials?: unknown[] } | undefined,
  paused: [] as string[],
  saveCredentials: vi.fn(),
  testSiteCredentials: vi.fn(),
  getSiteCredentials: vi.fn(),
  ebayDisconnect: vi.fn(),
  ebayReadPolicies: vi.fn(),
}));

// Stub the generated api with plain string tokens so `useAction` can tell the
// two actions apart without pulling in the real Convex client.
vi.mock("@/convex/_generated/api", () => ({
  api: {
    credentials: {
      saveCredentials: "credentials:saveCredentials",
      testSiteCredentials: "credentials:testSiteCredentials",
      getSiteCredentials: "credentials:getSiteCredentials",
    },
    userProfile: { getUserProfile: "userProfile:getUserProfile" },
    marketplacePause: {
      getPausedPlatforms: "marketplacePause:getPausedPlatforms",
    },
    // NEO-370: the BSC listing section under the sign-in (its own tests are
    // in app/profile/credentials/BscListingSection.test.tsx). Loading here,
    // so it draws only its empty status line.
    listingSync: {
      listingSettings: "listingSync:listingSettings",
    },
    // NEO-415: the eBay tab draws the eBay panel (its own tests are in
    // app/profile/credentials/ebay/). Not connected here.
    ebayConnect: {
      connectionState: "ebayConnect:connectionState",
      beginConnect: "ebayConnect:beginConnect",
      completeConnect: "ebayConnect:completeConnect",
      disconnect: "ebayConnect:disconnect",
      readPolicies: "ebayConnect:readPolicies",
      savePolicies: "ebayConnect:savePolicies",
      saveLocation: "ebayConnect:saveLocation",
      setBestOffer: "ebayConnect:setBestOffer",
      createStandardPolicies: "ebayConnect:createStandardPolicies",
    },
  },
}));

const EBAY_NOT_CONNECTED = {
  configured: true,
  environment: "production",
  status: "notConnected",
  ebayUsername: null,
  since: null,
  settings: {
    fulfillmentPolicyUnder20Id: null,
    fulfillmentPolicy20PlusId: null,
    paymentPolicyId: null,
    returnPolicyId: null,
    location: null,
    bestOffer: true,
  },
  setupComplete: false,
  missing: ["shippingUnder20", "shipping20Plus", "payment", "returns", "location"],
};
const EBAY_CONNECTED = { ...EBAY_NOT_CONNECTED, status: "connected", ebayUsername: "cardshark88" };
let ebayConnection: unknown = EBAY_NOT_CONNECTED;

vi.mock("convex/react", () => ({
  // Routed by ref: the panel subscribes to the NEO-287 pause query as well as
  // the profile; `mocks.paused` defaults to "nothing paused".
  useQuery: (ref: string) =>
    ref === "marketplacePause:getPausedPlatforms"
      ? mocks.paused
      : ref === "listingSync:listingSettings"
        ? undefined
        : ref === "ebayConnect:connectionState"
          ? ebayConnection
          : mocks.profile,
  // The eBay panel's Best Offer switch chains an optimistic update.
  useMutation: () => {
    const mutation = vi.fn();
    return Object.assign(mutation, { withOptimisticUpdate: () => mutation });
  },
  useAction: (ref: string) => {
    if (ref === "ebayConnect:disconnect") return mocks.ebayDisconnect;
    if (ref === "ebayConnect:readPolicies") return mocks.ebayReadPolicies;
    if (ref === "credentials:saveCredentials") return mocks.saveCredentials;
    if (ref === "credentials:testSiteCredentials")
      return mocks.testSiteCredentials;
    return mocks.getSiteCredentials;
  },
}));

import CredentialsPanel from "@/app/profile/credentials/page";

/** The platform rides in the URL (`?platform=`), so every render needs a router. */
function Router({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

/** Where the panel left the URL, and a Back button, for the history cases. */
let here = "";
let back: () => void = () => {};
function Here() {
  const loc = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    here = `${loc.pathname}${loc.search}`;
    back = () => navigate(-1);
  }, [loc, navigate]);
  return null;
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <CredentialsPanel />
      <Here />
    </MemoryRouter>,
  );
}

function setProfile(siteCredentials: SiteCredential[]) {
  mocks.profile = { siteCredentials };
}

function setPaused(sites: string[]) {
  mocks.paused = sites;
}

const BSC = "buysportscards";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveCredentials.mockResolvedValue({ success: true, message: "ok" });
  mocks.testSiteCredentials.mockResolvedValue({ success: true, message: "ok" });
  setProfile([]);
  setPaused([]);
  ebayConnection = EBAY_NOT_CONNECTED;
  mocks.ebayReadPolicies.mockResolvedValue({ ok: true, fulfillment: [], payment: [], returns: [] });
});

describe("CredentialsPanel — state matrix", () => {
  it("renders the re-auth state when needsReauth is true (and credentials are still held)", () => {
    setProfile([{ site: BSC, hasCredentials: true, needsReauth: true }]);
    render(<CredentialsPanel />, { wrapper: Router });

    expect(
      screen.queryByText("Sign in to BuySportsCards again"),
    ).not.toBeNull();
    expect(
      screen.queryByText(/session expired or was revoked/),
    ).not.toBeNull();

    // It REPLACES the connected summary — it is a state, not an extra banner.
    expect(screen.queryByText("Connected to BuySportsCards")).toBeNull();
    // And it must not fall back to the "never connected" form.
    expect(
      screen.queryByRole("button", { name: "Connect" }),
    ).toBeNull();
    // Testing cannot repair a dead session, so that control is not offered.
    expect(
      screen.queryByRole("button", { name: "Test Credentials" }),
    ).toBeNull();
    // The nudge is suppressed: we already know the answer.
    expect(screen.queryByText("Connection not yet verified")).toBeNull();
  });

  it("renders the connected state when needsReauth is false", () => {
    setProfile([{ site: BSC, hasCredentials: true, needsReauth: false }]);
    render(<CredentialsPanel />, { wrapper: Router });

    expect(screen.queryByText("Connected to BuySportsCards")).not.toBeNull();
    expect(screen.queryByText("Sign in to BuySportsCards again")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Test Credentials" }),
    ).not.toBeNull();
    // Nothing has proved the session works yet this visit.
    expect(screen.queryByText("Connection not yet verified")).not.toBeNull();
  });

  it("treats a missing needsReauth field (legacy row) as connected, not as re-auth", () => {
    setProfile([{ site: BSC, hasCredentials: true }]);
    render(<CredentialsPanel />, { wrapper: Router });

    expect(screen.queryByText("Connected to BuySportsCards")).not.toBeNull();
    expect(screen.queryByText("Sign in to BuySportsCards again")).toBeNull();
  });

  it("renders the sign-in form when no credentials are held", () => {
    setProfile([]);
    render(<CredentialsPanel />, { wrapper: Router });

    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeNull();
    expect(screen.queryByText("Connected to BuySportsCards")).toBeNull();
    expect(screen.queryByText("Connection not yet verified")).toBeNull();
  });

  it("NEO-415: the eBay tab is eBay's whole setup, in place, with no sign-in form", () => {
    setProfile([]);
    render(<CredentialsPanel />, { wrapper: Router });
    fireEvent.click(screen.getByRole("tab", { name: "eBay" }));
    const panel = screen.getByRole("tabpanel", { name: "eBay" });
    expect(within(panel).getByRole("heading", { level: 2, name: "eBay" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Connect eBay" })).toBeTruthy();
    // No pointer away: the setup lives here now.
    expect(screen.queryByRole("link", { name: /own page/ })).toBeNull();
    // Nothing password-shaped: no sign-in form, no password security notes.
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(document.getElementById("password")).toBeNull();
    expect(screen.queryByText("Security Information")).toBeNull();
  });

  it("NEO-415: ?platform= opens that platform, and an unknown one opens the first", () => {
    setProfile([]);
    const view = renderAt("/profile/credentials?platform=ebay");
    expect(screen.getByRole("tab", { name: "eBay" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "Connect eBay" })).toBeTruthy();
    view.unmount();
    renderAt("/profile/credentials?platform=sportlots");
    expect(screen.getByRole("tab", { name: "SportLots" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "SportLots Credentials" })).toBeTruthy();
  });

  it("NEO-415: an unknown or missing platform opens BuySportsCards", () => {
    setProfile([]);
    renderAt("/profile/credentials?platform=mercari");
    expect(screen.getByRole("tab", { name: "BuySportsCards" }).getAttribute("aria-selected")).toBe("true");
  });

  it("NEO-415: switching platforms puts it in the URL, and Back steps back through them", () => {
    setProfile([]);
    renderAt("/profile/credentials");
    fireEvent.click(screen.getByRole("tab", { name: "SportLots" }));
    expect(here).toBe("/profile/credentials?platform=sportlots");
    fireEvent.click(screen.getByRole("tab", { name: "eBay" }));
    expect(here).toBe("/profile/credentials?platform=ebay");
    expect(screen.getByRole("button", { name: "Connect eBay" })).toBeTruthy();
    act(() => back());
    expect(here).toBe("/profile/credentials?platform=sportlots");
    expect(screen.getByRole("tab", { name: "SportLots" }).getAttribute("aria-selected")).toBe("true");
    act(() => back());
    expect(here).toBe("/profile/credentials");
    expect(screen.getByRole("tab", { name: "BuySportsCards" }).getAttribute("aria-selected")).toBe("true");
  });

  it("NEO-415: every site's panel is named by its own tab", () => {
    setProfile([]);
    render(
      <MemoryRouter>
        <CredentialsPanel />
      </MemoryRouter>,
    );
    for (const name of ["BuySportsCards", "SportLots", "eBay"]) {
      fireEvent.click(screen.getByRole("tab", { name }));
      expect(screen.getByRole("tabpanel", { name })).toBeTruthy();
    }
  });

  it("routes the re-auth primary action into the sign-in form", () => {
    setProfile([{ site: BSC, hasCredentials: true, needsReauth: true }]);
    render(<CredentialsPanel />, { wrapper: Router });

    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));

    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeNull();
    expect(
      (document.getElementById("password") as HTMLInputElement | null)?.type,
    ).toBe("password");
  });
});

describe("CredentialsPanel — paused (NEO-287)", () => {
  it("paused and connected: names the platform, disables Sign-in/Test with distinct labels, keeps Clear enabled", () => {
    setPaused([BSC]);
    setProfile([{ site: BSC, hasCredentials: true, needsReauth: false }]);
    render(<CredentialsPanel />, { wrapper: Router });

    expect(screen.getByText("BuySportsCards is on pause")).not.toBeNull();
    expect(
      screen.getByText(/Your saved session stays right where it is/),
    ).not.toBeNull();

    const signIn = screen.getByRole("button", { name: "Sign-in paused" });
    const test = screen.getByRole("button", { name: "Test paused" });
    expect(signIn).toHaveProperty("disabled", true);
    expect(test).toHaveProperty("disabled", true);
    // Distinct accessible names from the live controls and from each other.
    expect(screen.queryByRole("button", { name: "Test Credentials" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();

    const clear = screen.getByRole("button", { name: /Clear Credentials/ });
    expect(clear).toHaveProperty("disabled", false);
  });

  it("paused and connected: no re-auth card even when needsReauth is also true", () => {
    setPaused([BSC]);
    setProfile([{ site: BSC, hasCredentials: true, needsReauth: true }]);
    render(<CredentialsPanel />, { wrapper: Router });

    expect(screen.getByText("BuySportsCards is on pause")).not.toBeNull();
    expect(screen.queryByText("Sign in to BuySportsCards again")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
  });

  it("paused and NOT connected: the paused card renders, and no sign-in form", () => {
    setPaused([BSC]);
    setProfile([]);
    render(<CredentialsPanel />, { wrapper: Router });

    expect(screen.getByText("BuySportsCards is on pause")).not.toBeNull();
    expect(
      screen.getByText(/we can't hook up a new account just yet/),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign-in paused" })).toBeNull();
    expect(screen.queryByText("Connected to BuySportsCards")).toBeNull();
  });

  it("the SportLots tab is untouched by a BSC-only pause", () => {
    setPaused([BSC]);
    setProfile([{ site: "sportlots", hasCredentials: true, needsReauth: false }]);
    render(<CredentialsPanel />, { wrapper: Router });

    fireEvent.click(screen.getByRole("tab", { name: "SportLots" }));

    expect(screen.queryByText("SportLots is on pause")).toBeNull();
    expect(screen.getByText("Connected to SportLots")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Test Credentials" }),
    ).not.toBeNull();
  });

  it("suppresses the 'Connection not yet verified' nudge while paused", () => {
    setPaused([BSC]);
    setProfile([{ site: BSC, hasCredentials: true, needsReauth: false }]);
    render(<CredentialsPanel />, { wrapper: Router });

    expect(screen.queryByText("Connection not yet verified")).toBeNull();
  });
});

describe("CredentialsPanel — keyboard submit", () => {
  it("submits the form (Enter) rather than requiring a click", async () => {
    setProfile([]);
    const { container } = render(<CredentialsPanel />, { wrapper: Router });

    fireEvent.change(document.getElementById("username")!, {
      target: { value: "collector" },
    });
    fireEvent.change(document.getElementById("password")!, {
      target: { value: "hunter2" },
    });

    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    // Implicit submission is native behaviour driven by the default button's
    // type; assert the wiring that makes Enter reach the handler.
    expect(
      screen.getByRole("button", { name: "Connect" }).getAttribute("type"),
    ).toBe("submit");

    fireEvent.submit(form!);

    await waitFor(() =>
      expect(mocks.saveCredentials).toHaveBeenCalledWith({
        site: BSC,
        username: "collector",
        password: "hunter2",
      }),
    );
  });

  it("keeps every other control in the form out of the submit path", () => {
    setProfile([{ site: BSC, hasCredentials: true }]);
    render(<CredentialsPanel />, { wrapper: Router });
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));

    for (const name of [
      "Test Stored Credentials",
      "Clear Credentials",
      "Cancel",
    ]) {
      expect(
        screen.getByRole("button", { name }).getAttribute("type"),
      ).toBe("button");
    }
  });

  it("renders the server's connect message verbatim, with no second client success string", async () => {
    const serverMessage =
      "Connected to BuySportsCards successfully. Your password was not stored — only the session it created.";
    mocks.saveCredentials.mockResolvedValue({
      success: true,
      message: serverMessage,
    });
    setProfile([]);
    const { container } = render(<CredentialsPanel />, { wrapper: Router });

    fireEvent.change(document.getElementById("username")!, {
      target: { value: "collector" },
    });
    fireEvent.change(document.getElementById("password")!, {
      target: { value: "hunter2" },
    });
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() =>
      expect(screen.queryByText(serverMessage)).not.toBeNull(),
    );
    // The old flow chased a save with a separate verification call; the action
    // now does the login itself, so a second round-trip would be a duplicate
    // marketplace sign-in.
    expect(mocks.testSiteCredentials).not.toHaveBeenCalled();
    expect(screen.queryByText(/securely encrypted/)).toBeNull();
  });
});

describe("CredentialsPanel — busy label matches the disabled condition", () => {
  it("shows 'Clearing...' on the confirm button whenever it is disabled", () => {
    setProfile([{ site: BSC, hasCredentials: true }]);
    const { rerender } = render(<CredentialsPanel />, { wrapper: Router });

    fireEvent.click(screen.getByRole("button", { name: "Clear Credentials" }));
    const dialog = () => within(screen.getByRole("dialog"));
    expect(
      (dialog().getByRole("button", {
        name: "Yes, Clear",
      }) as HTMLButtonElement).disabled,
    ).toBe(false);

    // A live lock held by an op on ANY site disables every credential control.
    setProfile([
      { site: BSC, hasCredentials: true, lockedAt: Date.now() },
    ]);
    rerender(<CredentialsPanel />);

    const busy = dialog().getByRole("button", {
      name: "Clearing...",
    }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    // The bug this replaces: the label stayed "Yes, Clear" while inert.
    expect(
      dialog().queryByRole("button", { name: "Yes, Clear" }),
    ).toBeNull();
  });

  it("keys every summary-card label off the same lock", () => {
    setProfile([
      { site: BSC, hasCredentials: true, lockedAt: Date.now() },
    ]);
    render(<CredentialsPanel />, { wrapper: Router });

    for (const name of ["Testing...", "Clearing..."]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    }
    expect(
      screen.queryByRole("button", { name: "Test Credentials" }),
    ).toBeNull();
  });
});

describe("CredentialsPanel — copy no longer claims we store passwords", () => {
  it("drops every storage claim from the security list", () => {
    setProfile([]);
    render(<CredentialsPanel />, { wrapper: Router });

    // The claim appears twice on purpose — once in the panel intro, once as a
    // security bullet — so match the bullet exactly.
    expect(
      screen.queryByText(
        "• Your password is used once to sign in and is never stored",
      ),
    ).not.toBeNull();
    expect(
      screen.queryByText(
        "• We keep only a marketplace session, which expires and can be revoked",
      ),
    ).not.toBeNull();
    expect(screen.queryByText(/securely encrypted and stored/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Save Credentials" })).toBeNull();
  });

  it("uses the marketplace's own casing for SportLots", () => {
    setProfile([]);
    render(<CredentialsPanel />, { wrapper: Router });

    expect(screen.queryByRole("tab", { name: "SportLots" })).not.toBeNull();
  });

  it("describes the password field with the SportLots advice, on SportLots only", () => {
    setProfile([]);
    render(<CredentialsPanel />, { wrapper: Router });

    expect(
      document.getElementById("password")?.getAttribute("aria-describedby"),
    ).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "SportLots" }));

    expect(
      document.getElementById("password")?.getAttribute("aria-describedby"),
    ).toBe("sportlots-password-advice");
    expect(
      document.getElementById("sportlots-password-advice")?.textContent,
    ).toContain("never store your password");
  });

  it("gives the credential fields real autocomplete tokens", () => {
    setProfile([]);
    render(<CredentialsPanel />, { wrapper: Router });

    expect(
      document.getElementById("username")?.getAttribute("autocomplete"),
    ).toBe("username");
    expect(
      document.getElementById("password")?.getAttribute("autocomplete"),
    ).toBe("current-password");
  });
});

/**
 * NEO-370 Rev 5 — a saved, unpaused BuySportsCards sign-in IS syncing, so
 * what connecting does is said beside Connect, before it is pressed, and
 * describes the button. No Start anywhere.
 */
describe("CredentialsPanel — the listing consent beside Connect", () => {
  const connect = () => screen.getByRole("button", { name: "Connect" });

  it("BuySportsCards, not connected: the warning sits before Connect and describes it", async () => {
    setProfile([]);
    const tree = () => (
      <Theme>
        <CredentialsPanel />
      </Theme>
    );
    const view = render(tree(), { wrapper: Router });
    const description = document.getElementById(connect().getAttribute("aria-describedby")!);
    expect(description?.textContent).toBe(`${CONSENT_HEADING}${CONSENT_LINE}`);
    expect(CONSENT_HEADING).toBe("Heads up: connecting starts listing");
    expect(CONSENT_LINE).toMatch(/^Connecting lists every card in your boxes on BuySportsCards/);
    expect(CONSENT_LINE).toMatch(/goes to 0\.$/);
    // Before the button in reading order.
    expect(description!.compareDocumentPosition(connect()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Start listing/ })).toBeNull();
    await expectAccessibleInBothModes(view.container, {
      label: "Credentials, BuySportsCards not connected, listing consent",
      rerender: () => view.rerender(tree()),
    });
  });

  it("signing in again over a saved sign-in still says it, beside Connect", () => {
    setProfile([{ site: BSC, hasCredentials: true, needsReauth: true }]);
    render(<CredentialsPanel />, { wrapper: Router });
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(document.getElementById(connect().getAttribute("aria-describedby")!)?.textContent).toContain(CONSENT_LINE);
  });

  it("SportLots does not list yet: no warning, and Connect describes nothing", () => {
    setProfile([]);
    render(<CredentialsPanel />, { wrapper: Router });
    fireEvent.click(screen.getByRole("tab", { name: "SportLots" }));
    expect(connect().getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByText(CONSENT_HEADING)).toBeNull();
  });

  it("connected: the form (and its warning) are gone", () => {
    setProfile([{ site: BSC, hasCredentials: true, needsReauth: false }]);
    render(<CredentialsPanel />, { wrapper: Router });
    expect(screen.queryByText(CONSENT_HEADING)).toBeNull();
  });
});

/**
 * NEO-415 audit — the platform rides in the URL, so Back and Forward can
 * move it while a request is still out (the tabs are off then, history is
 * not). The page holds the platform the request belongs to until it
 * settles, and puts the URL back on it.
 */
describe("CredentialsPanel — Back while a request is out", () => {
  function deferred<T>() {
    let resolve: (v: T) => void = () => {};
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  it("a sign-in's answer is said under its own platform, never the one Back went to", async () => {
    setProfile([]);
    const answer = deferred<{ success: boolean; message: string }>();
    mocks.saveCredentials.mockReturnValue(answer.promise);
    renderAt("/profile/credentials?platform=sportlots");
    fireEvent.click(screen.getByRole("tab", { name: "BuySportsCards" }));
    expect(here).toBe("/profile/credentials?platform=buysportscards");
    fireEvent.change(document.getElementById("username")!, { target: { value: "collector" } });
    fireEvent.change(document.getElementById("password")!, { target: { value: "hunter2" } });
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(mocks.saveCredentials).toHaveBeenCalledWith(expect.objectContaining({ site: BSC })));

    act(() => back());
    // Held: still BuySportsCards, and the URL is put back on it.
    await waitFor(() => expect(here).toBe("/profile/credentials?platform=buysportscards"));
    expect(screen.getByRole("tab", { name: "BuySportsCards" }).getAttribute("aria-selected")).toBe("true");

    await act(async () => answer.resolve({ success: false, message: "BuySportsCards turned that sign-in down." }));
    expect(screen.getByRole("alert").textContent).toContain("BuySportsCards turned that sign-in down.");
    expect(screen.getByRole("tab", { name: "BuySportsCards" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "BuySportsCards" })).toBeTruthy();
    expect(here).toBe("/profile/credentials?platform=buysportscards");
    // Never switched away underneath: what was typed is still there to fix and resend.
    expect((document.getElementById("username") as HTMLInputElement).value).toBe("collector");
  });

  it("eBay's Disconnect holds the tabs (inert behind the confirm, off while it runs) and Back can't drop its alert", async () => {
    setProfile([]);
    ebayConnection = EBAY_CONNECTED;
    const answer = deferred<{ ok: true; notEnded: number }>();
    mocks.ebayDisconnect.mockReturnValue(answer.promise);
    renderAt("/profile/credentials?platform=sportlots");
    fireEvent.click(screen.getByRole("tab", { name: "eBay" }));
    expect(here).toBe("/profile/credentials?platform=ebay");

    const ebayTab = screen.getByRole("tab", { name: "eBay" });
    expect(ebayTab.closest("[inert]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect eBay" }));
    const dialog = screen.getByRole("dialog", { name: "Disconnect eBay?" });
    // Behind the confirm, the platform picker is out of reach.
    expect(ebayTab.closest("[inert]")).not.toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, disconnect" }));
    await waitFor(() => expect(mocks.ebayDisconnect).toHaveBeenCalledTimes(1));
    expect((screen.getByRole("tab", { name: "SportLots" }) as HTMLButtonElement).disabled).toBe(true);

    act(() => back());
    await waitFor(() => expect(here).toBe("/profile/credentials?platform=ebay"));
    expect(screen.getByRole("tab", { name: "eBay" }).getAttribute("aria-selected")).toBe("true");

    ebayConnection = EBAY_NOT_CONNECTED;
    await act(async () => answer.resolve({ ok: true, notEnded: 2 }));
    expect(screen.getByRole("alert").textContent).toContain("2 NeonBinder listings are still up on eBay");
    expect(screen.getByRole("tab", { name: "eBay" }).getAttribute("aria-selected")).toBe("true");
    // Settled: the tabs work again.
    expect((screen.getByRole("tab", { name: "SportLots" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("tab", { name: "eBay" }).closest("[inert]")).toBeNull();
  });
});

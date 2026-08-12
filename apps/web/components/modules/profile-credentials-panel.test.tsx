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
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

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
  saveCredentials: vi.fn(),
  testSiteCredentials: vi.fn(),
  getSiteCredentials: vi.fn(),
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
  },
}));

vi.mock("convex/react", () => ({
  useQuery: () => mocks.profile,
  useMutation: () => vi.fn(),
  useAction: (ref: string) => {
    if (ref === "credentials:saveCredentials") return mocks.saveCredentials;
    if (ref === "credentials:testSiteCredentials")
      return mocks.testSiteCredentials;
    return mocks.getSiteCredentials;
  },
}));

import CredentialsPanel from "@/app/profile/credentials/page";

function setProfile(siteCredentials: SiteCredential[]) {
  mocks.profile = { siteCredentials };
}

const BSC = "buysportscards";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveCredentials.mockResolvedValue({ success: true, message: "ok" });
  mocks.testSiteCredentials.mockResolvedValue({ success: true, message: "ok" });
  setProfile([]);
});

describe("CredentialsPanel — state matrix", () => {
  it("renders the re-auth state when needsReauth is true (and credentials are still held)", () => {
    setProfile([{ site: BSC, hasCredentials: true, needsReauth: true }]);
    render(<CredentialsPanel />);

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
    render(<CredentialsPanel />);

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
    render(<CredentialsPanel />);

    expect(screen.queryByText("Connected to BuySportsCards")).not.toBeNull();
    expect(screen.queryByText("Sign in to BuySportsCards again")).toBeNull();
  });

  it("renders the sign-in form when no credentials are held", () => {
    setProfile([]);
    render(<CredentialsPanel />);

    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeNull();
    expect(screen.queryByText("Connected to BuySportsCards")).toBeNull();
    expect(screen.queryByText("Connection not yet verified")).toBeNull();
  });

  it("routes the re-auth primary action into the sign-in form", () => {
    setProfile([{ site: BSC, hasCredentials: true, needsReauth: true }]);
    render(<CredentialsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));

    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeNull();
    expect(
      (document.getElementById("password") as HTMLInputElement | null)?.type,
    ).toBe("password");
  });
});

describe("CredentialsPanel — keyboard submit", () => {
  it("submits the form (Enter) rather than requiring a click", async () => {
    setProfile([]);
    const { container } = render(<CredentialsPanel />);

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
    render(<CredentialsPanel />);
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
    const { container } = render(<CredentialsPanel />);

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
    const { rerender } = render(<CredentialsPanel />);

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
    render(<CredentialsPanel />);

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
    render(<CredentialsPanel />);

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
    render(<CredentialsPanel />);

    expect(screen.queryByRole("tab", { name: "SportLots" })).not.toBeNull();
  });

  it("describes the password field with the SportLots advice, on SportLots only", () => {
    setProfile([]);
    render(<CredentialsPanel />);

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
    render(<CredentialsPanel />);

    expect(
      document.getElementById("username")?.getAttribute("autocomplete"),
    ).toBe("username");
    expect(
      document.getElementById("password")?.getAttribute("autocomplete"),
    ).toBe("current-password");
  });
});

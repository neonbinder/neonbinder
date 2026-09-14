/**
 * NEO-278 — the "your marketplace session lapsed" notice on the sync surface.
 *
 * Locks down the three things that matter:
 *
 * 1. It renders ONLY off the server-owned `needsReauth` flag — never off
 *    `hasCredentials`, never off a site's name — and names every flagged
 *    platform with the same join `MissingCredentialsBanner` uses.
 * 2. It is a warning, not a gate: a `role="status"` region with a focusable
 *    link to /profile/credentials, and nothing else on the page changes.
 * 3. Dismiss is per browser session and per SET of flagged platforms, so a
 *    second platform lapsing after a dismiss brings it back.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import ReauthNotice, { type ReauthNoticeProps } from "./ReauthNotice";
import {
  REAUTH_NOTICE_COPY,
  joinSiteLabels,
} from "@/lib/marketplace/reauth-notice";

function renderNotice(siteCredentials: ReauthNoticeProps["siteCredentials"]) {
  return render(
    <MemoryRouter>
      <ReauthNotice siteCredentials={siteCredentials} />
    </MemoryRouter>,
  );
}

const BSC = "buysportscards";
const SL = "sportlots";

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("ReauthNotice", () => {
  it("renders nothing while the profile is loading or absent", () => {
    const { container: loading } = renderNotice(undefined);
    expect(loading.textContent).toBe("");
    const { container: none } = renderNotice(null);
    expect(none.textContent).toBe("");
  });

  it("renders nothing when every connected platform is healthy", () => {
    const { container } = renderNotice([
      { site: BSC, needsReauth: false },
      { site: SL },
    ]);
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("names the one platform that needs a sign-in and links to Profile → Credentials", () => {
    renderNotice([{ site: BSC }, { site: SL, needsReauth: true }]);

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Your SportLots session ran out.");
    expect(status.textContent).not.toContain("BuySportsCards");
    expect(status.textContent).toContain(REAUTH_NOTICE_COPY.body);

    const link = screen.getByRole("link", { name: REAUTH_NOTICE_COPY.link });
    expect(link.getAttribute("href")).toBe("/profile/credentials");
    // A real anchor: reachable by Tab, activatable by Enter.
    expect(link.tagName).toBe("A");
  });

  it("joins both platforms as 'BuySportsCards and SportLots' when both are flagged", () => {
    renderNotice([
      { site: SL, needsReauth: true },
      { site: BSC, needsReauth: true },
    ]);
    // Sorted by key, so the order is stable regardless of row order.
    expect(screen.getByRole("status").textContent).toContain(
      "Your BuySportsCards and SportLots sessions ran out.",
    );
  });

  it("falls through to the raw key for a platform the label map has not learned", () => {
    renderNotice([{ site: "mercari", needsReauth: true }]);
    expect(screen.getByRole("status").textContent).toContain(
      "Your mercari session ran out.",
    );
  });

  it("dismisses for the session and comes back when a second platform lapses", () => {
    const { rerender } = renderNotice([{ site: SL, needsReauth: true }]);
    fireEvent.click(
      screen.getByRole("button", { name: REAUTH_NOTICE_COPY.dismissLabel }),
    );
    expect(screen.queryByRole("status")).toBeNull();

    // Same set of flagged platforms → stays dismissed across a remount.
    rerender(
      <MemoryRouter>
        <ReauthNotice siteCredentials={[{ site: SL, needsReauth: true }]} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("status")).toBeNull();

    // A different set → the dismissal no longer applies.
    rerender(
      <MemoryRouter>
        <ReauthNotice
          siteCredentials={[
            { site: SL, needsReauth: true },
            { site: BSC, needsReauth: true },
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Your BuySportsCards and SportLots sessions ran out.",
    );
  });

  it("honours a dismissal recorded earlier in the same session on a fresh mount", () => {
    renderNotice([{ site: BSC, needsReauth: true }]);
    fireEvent.click(
      screen.getByRole("button", { name: REAUTH_NOTICE_COPY.dismissLabel }),
    );
    // A navigation away and back mounts a fresh component.
    const { container } = renderNotice([{ site: BSC, needsReauth: true }]);
    expect(container.textContent).toBe("");
  });
});

describe("joinSiteLabels", () => {
  it("joins one, two and three the way a sentence would", () => {
    expect(joinSiteLabels([])).toBe("");
    expect(joinSiteLabels([SL])).toBe("SportLots");
    expect(joinSiteLabels([BSC, SL])).toBe("BuySportsCards and SportLots");
    expect(joinSiteLabels([BSC, SL, "ebay"])).toBe(
      "BuySportsCards, SportLots, and ebay",
    );
  });
});

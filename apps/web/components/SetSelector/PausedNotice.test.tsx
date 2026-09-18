/**
 * NEO-287 — the "this marketplace is on pause" notice on the sync surface.
 *
 * Mirrors ReauthNotice.test.tsx's shape (same component grammar, see the
 * component's own doc comment): renders off the paused SITE list alone,
 * `role="status"`, Dismiss is per-session and keyed on WHICH sites are
 * paused, and Dismiss parks focus on the page heading once its own button
 * unmounts.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import PausedNotice, {
  PAUSED_NOTICE_FOCUS_PARK_ID,
} from "./PausedNotice";
import { PAUSE_NOTICE_COPY } from "@/lib/marketplace/pause-notice";

const BSC = "buysportscards";
const SL = "sportlots";

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("PausedNotice", () => {
  it("renders nothing when no site is paused", () => {
    const { container } = render(<PausedNotice sites={[]} />);
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("names the one paused site and says what stays true", () => {
    render(<PausedNotice sites={[SL]} />);

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("SportLots is on pause.");
    expect(status.textContent).not.toContain("BuySportsCards is on pause");
    // The other marketplace keeps rolling — named explicitly, not implied.
    expect(status.textContent).toContain("BuySportsCards only");
    expect(status.textContent).toContain("nothing gets unlinked");
  });

  it("joins both known sites and drops the 'rolls on with X' sentence entirely", () => {
    render(<PausedNotice sites={[BSC, SL]} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain(
      "BuySportsCards and SportLots are on pause.",
    );
    expect(status.textContent).toContain("Syncs are benched");
  });

  it("sorts regardless of the iteration order it is given", () => {
    render(<PausedNotice sites={[SL, BSC]} />);
    expect(screen.getByRole("status").textContent).toContain(
      "BuySportsCards and SportLots are on pause.",
    );
  });

  it("dismisses for the session and comes back when a second platform is paused", () => {
    const { rerender } = render(<PausedNotice sites={[SL]} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: PAUSE_NOTICE_COPY.strip.dismissLabel,
      }),
    );
    expect(screen.queryByRole("status")).toBeNull();

    // Same paused set → stays dismissed across a remount.
    rerender(<PausedNotice sites={[SL]} />);
    expect(screen.queryByRole("status")).toBeNull();

    // A different set → the dismissal no longer applies.
    rerender(<PausedNotice sites={[SL, BSC]} />);
    expect(screen.getByRole("status").textContent).toContain(
      "BuySportsCards and SportLots are on pause.",
    );
  });

  it("parks focus on the page heading after Dismiss unmounts the button", async () => {
    const heading = document.createElement("h2");
    heading.id = PAUSED_NOTICE_FOCUS_PARK_ID;
    heading.tabIndex = -1;
    document.body.appendChild(heading);
    try {
      render(<PausedNotice sites={[SL]} />);
      const dismiss = screen.getByRole("button", {
        name: PAUSE_NOTICE_COPY.strip.dismissLabel,
      });
      dismiss.focus();
      fireEvent.click(dismiss);
      expect(screen.queryByRole("status")).toBeNull();
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      expect(document.activeElement).toBe(heading);
    } finally {
      heading.remove();
    }
  });

  it("honours a dismissal recorded earlier in the same session on a fresh mount", () => {
    const { unmount } = render(<PausedNotice sites={[BSC]} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: PAUSE_NOTICE_COPY.strip.dismissLabel,
      }),
    );
    unmount();
    const { container } = render(<PausedNotice sites={[BSC]} />);
    expect(container.textContent).toBe("");
  });

  it("the dismiss control's accessible name is distinct from ReauthNotice's", () => {
    render(<PausedNotice sites={[SL]} />);
    expect(
      screen.getByRole("button", { name: "Dismiss pause notice" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Dismiss sign-in notice" }),
    ).toBeNull();
  });
});

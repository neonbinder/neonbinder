/**
 * NEO-287 — the copy and join rules behind the "this marketplace is on
 * pause" surfaces (Profile card, Set Builder strip, picker panes).
 *
 * Pure functions, no DOM — the same shape as `reauth-notice.ts`'s own
 * untested-until-now join rule, pinned here alongside its sibling.
 */

import { describe, expect, test } from "vitest";
import {
  PAUSE_NOTICE_COPY,
  pausedStripText,
  sideLabel,
} from "./pause-notice";
import { joinSiteLabels, siteLabel } from "./reauth-notice";

describe("sideLabel", () => {
  test("resolves a slot side to its display name", () => {
    expect(sideLabel("bsc")).toBe("BuySportsCards");
    expect(sideLabel("sportlots")).toBe("SportLots");
  });

  test("an unrecognised side falls through to 'A marketplace' — never itself", () => {
    // platformNames' fallback for a key it does not know is the fixed
    // "A marketplace" string (NEO-47/NEO-211 B security property), not the
    // raw key — sideLabel must not silently promise a display name it cannot
    // guarantee stays safe.
    expect(sideLabel("mercari")).toBe("A marketplace");
  });
});

describe("re-exported siteLabel / joinSiteLabels", () => {
  test("re-exports the SAME functions reauth-notice.ts uses", () => {
    expect(siteLabel("sportlots")).toBe("SportLots");
    expect(joinSiteLabels(["buysportscards", "sportlots"])).toBe(
      "BuySportsCards and SportLots",
    );
  });
});

describe("PAUSE_NOTICE_COPY.profile", () => {
  test("heading and body both name the platform", () => {
    expect(PAUSE_NOTICE_COPY.profile.heading("SportLots")).toBe(
      "SportLots is on pause",
    );
    expect(PAUSE_NOTICE_COPY.profile.bodyConnected("SportLots")).toContain(
      "SportLots",
    );
    expect(PAUSE_NOTICE_COPY.profile.bodyNotConnected("SportLots")).toContain(
      "SportLots",
    );
  });

  test("connected vs not-connected bodies are different sentences", () => {
    expect(PAUSE_NOTICE_COPY.profile.bodyConnected("SportLots")).not.toBe(
      PAUSE_NOTICE_COPY.profile.bodyNotConnected("SportLots"),
    );
  });

  test("the two disabled control labels are distinct from each other and from the live labels", () => {
    const labels = [
      PAUSE_NOTICE_COPY.profile.signInPaused,
      PAUSE_NOTICE_COPY.profile.testPaused,
      "Sign in again",
      "Test Credentials",
    ];
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("PAUSE_NOTICE_COPY.strip", () => {
  test("lead pluralises the verb by count", () => {
    expect(PAUSE_NOTICE_COPY.strip.lead("SportLots", 1)).toBe(
      "SportLots is on pause.",
    );
    expect(
      PAUSE_NOTICE_COPY.strip.lead("BuySportsCards and SportLots", 2),
    ).toBe("BuySportsCards and SportLots are on pause.");
  });

  test("body names the surviving marketplace when one is still active", () => {
    const body = PAUSE_NOTICE_COPY.strip.body("SportLots", "BuySportsCards");
    expect(body).toContain("BuySportsCards only");
    expect(body).toContain("SportLots links stay put");
    expect(body).not.toContain("benched until a marketplace is back");
  });

  test("body changes shape entirely when NOTHING is left active", () => {
    const body = PAUSE_NOTICE_COPY.strip.body("BuySportsCards and SportLots", "");
    expect(body).toBe("Syncs are benched until a marketplace is back.");
  });
});

describe("PAUSE_NOTICE_COPY.pane", () => {
  test("names the marketplace twice — once for the pane, once for the reassurance", () => {
    const out = PAUSE_NOTICE_COPY.pane("SportLots");
    expect(out).toContain("SportLots is on pause");
    expect(out).toContain("SportLots links stay put");
  });
});

describe("pausedStripText", () => {
  const KNOWN = ["buysportscards", "sportlots"];

  test("one paused site: singular lead, the OTHER site named as still active", () => {
    const { lead, body } = pausedStripText(["sportlots"], KNOWN);
    expect(lead).toBe("SportLots is on pause.");
    expect(body).toContain("BuySportsCards only");
    expect(body).toContain("SportLots links stay put");
  });

  test("both known sites paused: plural lead, no active marketplace left", () => {
    const { lead, body } = pausedStripText(
      ["buysportscards", "sportlots"],
      KNOWN,
    );
    expect(lead).toBe("BuySportsCards and SportLots are on pause.");
    expect(body).toBe("Syncs are benched until a marketplace is back.");
  });

  test("the join follows the CALLER's list order — pausedStripText does not sort it", () => {
    // Not a sorted/canonical join: `joinSiteLabels` renders `pausedSites`
    // exactly as given. `usePausedPlatforms` already returns them sorted
    // (see the query's own `.sort()`), so in practice the order is stable —
    // but that stability is the CALLER's property, not this function's.
    const reordered = pausedStripText(["sportlots", "buysportscards"], KNOWN);
    expect(reordered.lead).toBe("SportLots and BuySportsCards are on pause.");
  });
});

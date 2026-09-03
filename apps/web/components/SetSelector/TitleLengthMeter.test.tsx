/**
 * NEO-101 — `titleLengthState` and the two components built on it
 * (`TitleLengthMeter`, `TitleLengthAlert`), plus `TitleFieldNote`.
 *
 * This is the ONE place the 55/70/80 bands are pinned as a pure function, so
 * a boundary regression here is a red test rather than something only
 * discoverable by eyeballing a rendered drawer. `CardDetailPanel.titleLimits`
 * and `TitleFixer.test.tsx` both exercise this component through a real
 * field, which is the right coverage for "does the drawer behave correctly"
 * — but neither one walks every boundary (54/55/56, 69/70/71, 79/80/81), and
 * a boundary is exactly where an off-by-one hides.
 */

import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import {
  ASPECT_VALUE_MAX,
  LISTING_TITLE_MAX,
  TitleFieldNote,
  TitleLengthAlert,
  TitleLengthMeter,
  titleLengthState,
} from "./TitleLengthMeter";
// The two soft-band constants are NOT re-exported from TitleLengthMeter.tsx
// (only the two caps are — see its own `export { ASPECT_VALUE_MAX,
// LISTING_TITLE_MAX }`), so this test goes to the same source module the
// component itself imports them from, exactly like `CardDetailPanel` and
// `listingLimits.test.ts` do.
import {
  LISTING_TITLE_MOBILE_CLIP,
  LISTING_TITLE_SEARCH_CLIP,
} from "../../convex/features/listingLimits";

describe("titleLengthState — hard cap, no soft bands requested", () => {
  it("is 'ok' for everything up to and including the cap when soft is false (the default)", () => {
    for (const length of [0, 1, 40, 54, 55, 56, 69, 70, 71, 79, 80]) {
      const state = titleLengthState(length);
      expect(state, `length ${length}`).toMatchObject({
        tone: "ok",
        over: false,
        overBy: 0,
        hint: null,
        alert: null,
      });
    }
  });

  it("flips to 'over' at exactly one character past the cap, never at the cap itself", () => {
    expect(titleLengthState(LISTING_TITLE_MAX).over).toBe(false);
    expect(titleLengthState(LISTING_TITLE_MAX + 1).over).toBe(true);
  });

  it("reports overBy and the alert text precisely", () => {
    const state = titleLengthState(94);
    expect(state.tone).toBe("over");
    expect(state.over).toBe(true);
    expect(state.overBy).toBe(14);
    expect(state.hint).toBe("14 over");
    expect(state.alert).toBe(
      "94 characters — 14 over the 80-character limit.",
    );
  });

  it("one over the cap is exactly '1 over', not '0 over' or '2 over'", () => {
    const state = titleLengthState(LISTING_TITLE_MAX + 1);
    expect(state.overBy).toBe(1);
    expect(state.hint).toBe("1 over");
    expect(state.alert).toBe("81 characters — 1 over the 80-character limit.");
  });
});

describe("titleLengthState — soft display bands (soft: true), the title field's own usage", () => {
  it("is silent below the mobile band", () => {
    for (const length of [0, 1, 40, LISTING_TITLE_MOBILE_CLIP - 1]) {
      expect(titleLengthState(length, LISTING_TITLE_MAX, true)).toMatchObject({
        tone: "ok",
        hint: null,
      });
    }
  });

  it("54 is ok, 55 enters the mobile band, 56 is still mobile", () => {
    expect(titleLengthState(54, LISTING_TITLE_MAX, true).tone).toBe("ok");
    expect(titleLengthState(55, LISTING_TITLE_MAX, true)).toMatchObject({
      tone: "mobile",
      hint: "may clip on mobile",
      over: false,
    });
    expect(titleLengthState(56, LISTING_TITLE_MAX, true).tone).toBe("mobile");
  });

  it("69 is still mobile, 70 crosses into the search band, 71 is still search", () => {
    expect(titleLengthState(69, LISTING_TITLE_MAX, true).tone).toBe("mobile");
    expect(titleLengthState(70, LISTING_TITLE_MAX, true)).toMatchObject({
      tone: "search",
      hint: "may clip in search",
      over: false,
    });
    expect(titleLengthState(71, LISTING_TITLE_MAX, true).tone).toBe("search");
  });

  it("79 is search, 80 (at the cap) is still search — not over —, 81 is over and wins over the soft band", () => {
    expect(titleLengthState(79, LISTING_TITLE_MAX, true).tone).toBe("search");
    const atCap = titleLengthState(80, LISTING_TITLE_MAX, true);
    expect(atCap.tone).toBe("search");
    expect(atCap.over).toBe(false);
    expect(atCap.alert).toBeNull();

    const overCap = titleLengthState(81, LISTING_TITLE_MAX, true);
    expect(overCap.tone).toBe("over");
    expect(overCap.hint).toBe("1 over");
    // The over-cap fact wins outright — a title cannot be simultaneously
    // "may clip in search" and "will be rejected"; the more serious one is
    // the only one reported.
    expect(overCap.alert).not.toBeNull();
  });

  it("the two bands are strictly ordered: MOBILE_CLIP < SEARCH_CLIP < MAX (sanity against the constants, not just the literals above)", () => {
    expect(LISTING_TITLE_MOBILE_CLIP).toBeLessThan(LISTING_TITLE_SEARCH_CLIP);
    expect(LISTING_TITLE_SEARCH_CLIP).toBeLessThan(LISTING_TITLE_MAX);
  });
});

describe("titleLengthState — a non-title field (the aspect value), soft left false", () => {
  // This is exactly how TitleFixer and CardDetailPanel call it for
  // `cardVariation`: a custom `max` and no `soft` argument. The 55/70 bands
  // are title-specific display truncation and must never leak onto a field
  // that isn't shown in eBay search results.
  it("never enters a mobile/search band even past where those bands would sit on the title scale", () => {
    for (const length of [0, 50, 55, 60, 64, 65]) {
      expect(titleLengthState(length, ASPECT_VALUE_MAX)).toMatchObject({
        tone: "ok",
        hint: null,
      });
    }
  });

  it("65 is fine, 66 is over — the aspect cap is independent of the title cap", () => {
    expect(titleLengthState(65, ASPECT_VALUE_MAX).over).toBe(false);
    const over = titleLengthState(66, ASPECT_VALUE_MAX);
    expect(over.over).toBe(true);
    expect(over.overBy).toBe(1);
    expect(over.alert).toBe("66 characters — 1 over the 65-character limit.");
  });
});

describe("TitleLengthMeter — rendering", () => {
  it("renders the raw count and no hint inside the safe band", () => {
    render(<TitleLengthMeter length={40} soft />);
    expect(screen.getByText("40/80")).toBeTruthy();
    expect(screen.queryByText("may clip on mobile")).toBeNull();
    expect(screen.queryByText("may clip in search")).toBeNull();
  });

  it("renders the hint text at the mobile and search bands when soft", () => {
    const { rerender } = render(<TitleLengthMeter length={55} soft />);
    expect(screen.getByText("55/80")).toBeTruthy();
    expect(screen.getByText("may clip on mobile")).toBeTruthy();

    rerender(<TitleLengthMeter length={70} soft />);
    expect(screen.getByText("70/80")).toBeTruthy();
    expect(screen.getByText("may clip in search")).toBeTruthy();
  });

  it("does not show a hint at the same lengths when soft is omitted (default false)", () => {
    render(<TitleLengthMeter length={70} />);
    expect(screen.getByText("70/80")).toBeTruthy();
    expect(screen.queryByText("may clip in search")).toBeNull();
  });

  it("uses a custom max verbatim (the aspect-value field)", () => {
    render(<TitleLengthMeter length={70} max={ASPECT_VALUE_MAX} />);
    expect(screen.getByText("70/65")).toBeTruthy();
  });
});

describe("TitleLengthAlert — rendering and semantics", () => {
  it("renders nothing within the cap, at any length", () => {
    const { container } = render(<TitleLengthAlert length={80} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("blocking (default): role=alert, and tells the operator to shorten it", () => {
    render(<TitleLengthAlert length={84} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("84 characters");
    expect(alert.textContent).toContain("4 over the 80-character limit");
    expect(alert.textContent).toContain("Shorten it before saving.");
  });

  it("non-blocking (aspect value): role=status, and warns rather than instructs", () => {
    render(
      <TitleLengthAlert
        length={70}
        max={ASPECT_VALUE_MAX}
        what="Variation"
        blocking={false}
      />,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Variation is 70 characters");
    expect(status.textContent).toContain("5 over the 65-character limit");
    expect(status.textContent).toContain("You can still save it");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("carries the id through, for aria-describedby wiring", () => {
    render(<TitleLengthAlert id="my-alert-id" length={84} />);
    expect(screen.getByRole("alert").id).toBe("my-alert-id");
  });
});

describe("TitleFieldNote", () => {
  it("renders its children as plain advisory text", () => {
    render(<TitleFieldNote>Auto title was cut short — rewrite it</TitleFieldNote>);
    expect(
      screen.getByText("Auto title was cut short — rewrite it"),
    ).toBeTruthy();
  });
});

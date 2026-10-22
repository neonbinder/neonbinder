/**
 * NEO-341 — `PickerPopover` keeps itself inside the viewport.
 *
 * A `fixed` element cannot be scrolled into view, so a popover that always
 * opened below its trigger put the player/team options off-screen whenever
 * the "+ Add" trigger sat near the bottom of the window (the CI failure had
 * it at y≈617 in a 629px-tall viewport; a 412px phone hits it all over the
 * card drawer).
 *
 * Two layers: `placePopover` is pure geometry and is tested as such, and the
 * component tests check the geometry reaches the element. happy-dom computes
 * no layout, so the component tests route `getBoundingClientRect` and the box
 * metrics through prototype stubs keyed on the element.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import React, { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PickerPopover, {
  POPOVER_EDGE,
  POPOVER_GAP,
  placePopover,
} from "./PickerPopover";

// ---------------------------------------------------------------------------
// placePopover — the geometry
// ---------------------------------------------------------------------------

/** The E2E desktop window. */
const CI = { width: 1024, height: 629 };
/** Pixel 7, the E2E phone project. */
const PHONE = { width: 412, height: 839 };

describe("placePopover", () => {
  it("opens below the trigger when the whole popover fits there", () => {
    const pos = placePopover(
      { top: 100, bottom: 120, left: 40 },
      { width: 256, height: 220 },
      CI,
    );
    expect(pos).toMatchObject({ placement: "below", top: 120, left: 40 });
    expect(pos.bottom).toBeUndefined();
    expect(pos.maxHeight).toBeUndefined();
  });

  it("flips above a trigger near the bottom of the window (the CI failure)", () => {
    // "+ Add player" at y≈617: 4px of room below it, ~600 above.
    const pos = placePopover(
      { top: 605, bottom: 625, left: 300 },
      { width: 256, height: 220 },
      CI,
    );
    expect(pos.placement).toBe("above");
    // Pinned by its bottom edge to the trigger's top (the 4px is `mb-1`).
    expect(pos.bottom).toBe(CI.height - 605);
    expect(pos.top).toBeUndefined();
    expect(pos.maxHeight).toBeUndefined();
  });

  it("stays below, clamped, when neither side fits and below has more room", () => {
    const pos = placePopover(
      { top: 100, bottom: 120, left: 40 },
      { width: 256, height: 900 },
      CI,
    );
    expect(pos.placement).toBe("below");
    expect(pos.top).toBe(120);
    expect(pos.maxHeight).toBe(CI.height - 120 - POPOVER_GAP - POPOVER_EDGE);
  });

  it("flips above, clamped, when neither side fits and above has more room", () => {
    const pos = placePopover(
      { top: 500, bottom: 520, left: 40 },
      { width: 256, height: 900 },
      CI,
    );
    expect(pos.placement).toBe("above");
    expect(pos.bottom).toBe(CI.height - 500);
    expect(pos.maxHeight).toBe(500 - POPOVER_GAP - POPOVER_EDGE);
  });

  it("stays above while it still fits there, so typing never bounces it", () => {
    // The list shrank as the operator typed and would now fit below too.
    const anchor = { top: 200, bottom: 220, left: 40 };
    const small = { width: 256, height: 120 };
    expect(placePopover(anchor, small, CI, "above").placement).toBe("above");
    // Without the history it would have chosen below.
    expect(placePopover(anchor, small, CI, "below").placement).toBe("below");
    // And once it no longer fits above, it goes back below.
    expect(
      placePopover(anchor, { width: 256, height: 300 }, CI, "above").placement,
    ).toBe("below");
  });

  it("clamps horizontally so a 256px box stays on a 412px phone", () => {
    const pos = placePopover(
      { top: 100, bottom: 120, left: 300 },
      { width: 256, height: 200 },
      PHONE,
    );
    expect(pos.left).toBe(PHONE.width - POPOVER_EDGE - 256);
    expect(pos.left + 256).toBeLessThanOrEqual(PHONE.width - POPOVER_EDGE);
  });

  it("keeps the edge gutter on the left, and narrows a box wider than the viewport", () => {
    expect(
      placePopover(
        { top: 100, bottom: 120, left: 2 },
        { width: 256, height: 200 },
        PHONE,
      ).left,
    ).toBe(POPOVER_EDGE);

    const narrow = placePopover(
      { top: 100, bottom: 120, left: 60 },
      { width: 256, height: 200 },
      { width: 200, height: 600 },
    );
    expect(narrow.maxWidth).toBe(200 - 2 * POPOVER_EDGE);
    expect(narrow.left).toBe(POPOVER_EDGE);
  });
});

// ---------------------------------------------------------------------------
// The component — geometry reaching the element
// ---------------------------------------------------------------------------

type Rect = { top: number; bottom: number; left: number; right?: number };

const geometry: {
  anchor: Rect;
  popover: { width: number; height: number; box?: Rect };
  rows: Record<string, Rect>;
} = { anchor: { top: 0, bottom: 0, left: 0 }, popover: { width: 0, height: 0 }, rows: {} };

const POPOVER_LABEL = "Thing results";
const isPopover = (el: Element) => el.getAttribute("aria-label") === POPOVER_LABEL;

function toDomRect(r: Rect): DOMRect {
  const right = r.right ?? r.left + 100;
  return {
    top: r.top,
    bottom: r.bottom,
    left: r.left,
    right,
    width: right - r.left,
    height: r.bottom - r.top,
    x: r.left,
    y: r.top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** Prototype stubs this file installs, restored after each test. */
const METRICS = ["scrollHeight", "offsetHeight", "clientHeight", "offsetWidth"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

function installMetrics() {
  for (const key of METRICS) {
    saved.set(key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get(this: HTMLElement) {
        if (!isPopover(this)) return 0;
        const { width, height } = geometry.popover;
        const maxHeight = parseFloat(this.style.maxHeight);
        const shown = Number.isNaN(maxHeight) ? height : Math.min(height, maxHeight);
        if (key === "scrollHeight") return height;
        if (key === "offsetWidth") return width;
        return shown; // no borders in this fixture
      },
    });
  }
  saved.set("innerHeight", Object.getOwnPropertyDescriptor(window, "innerHeight"));
}

function restoreMetrics() {
  for (const key of METRICS) {
    const d = saved.get(key);
    if (d) Object.defineProperty(HTMLElement.prototype, key, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
  const ih = saved.get("innerHeight");
  if (ih) Object.defineProperty(window, "innerHeight", ih);
}

function setViewport(height: number) {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

function Harness({ highlight = 0, rows = 3 }: { highlight?: number; rows?: number }) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  return (
    <>
      <button ref={anchorRef} type="button">
        Add thing
      </button>
      <PickerPopover
        anchorRef={anchorRef}
        popoverRef={popoverRef}
        onTabOut={() => {}}
        role="listbox"
        aria-label={POPOVER_LABEL}
        className="w-64"
      >
        {Array.from({ length: rows }, (_, i) => (
          <button
            key={i}
            type="button"
            role="option"
            aria-selected={i === highlight}
            data-row={String(i)}
          >
            Thing {i}
          </button>
        ))}
      </PickerPopover>
    </>
  );
}

const popover = () => screen.getByRole("listbox", { name: POPOVER_LABEL });

describe("PickerPopover — stays inside the viewport (NEO-341)", () => {
  beforeEach(() => {
    installMetrics();
    geometry.anchor = { top: 100, bottom: 120, left: 40 };
    geometry.popover = { width: 256, height: 220 };
    geometry.rows = {};
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.textContent === "Add thing") return toDomRect(geometry.anchor);
        if (isPopover(this) && geometry.popover.box) return toDomRect(geometry.popover.box);
        const row = this.getAttribute("data-row");
        if (row !== null && geometry.rows[row]) return toDomRect(geometry.rows[row]);
        return toDomRect({ top: 0, bottom: 0, left: 0, right: 0 });
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreMetrics();
  });

  it("opens below with its `mt-1` gap when there is room", () => {
    setViewport(CI.height);
    render(<Harness />);

    expect(popover().getAttribute("data-placement")).toBe("below");
    expect(popover().style.top).toBe("120px");
    expect(popover().style.bottom).toBe("");
    expect(popover().className).toContain("mt-1");
    expect(popover().className).not.toContain("mb-1");
    // Unclamped boxes never become overflow boxes (SportSwitch's list hangs
    // off the footer and an overflow box would clip it).
    expect(popover().style.maxHeight).toBe("");
    expect(popover().style.overflowY).toBe("");
  });

  it("flips above a trigger at the bottom of the CI window", () => {
    setViewport(CI.height);
    geometry.anchor = { top: 605, bottom: 625, left: 300 };
    render(<Harness />);

    expect(popover().getAttribute("data-placement")).toBe("above");
    expect(popover().style.bottom).toBe(`${CI.height - 605}px`);
    expect(popover().style.top).toBe("");
    expect(popover().className).toContain("mb-1");
    expect(popover().className).not.toContain("mt-1");
  });

  it("clamps its height and scrolls inside itself when neither side fits", () => {
    setViewport(CI.height);
    geometry.popover = { width: 256, height: 900 };
    render(<Harness />);

    expect(popover().style.maxHeight).toBe(
      `${CI.height - 120 - POPOVER_GAP - POPOVER_EDGE}px`,
    );
    expect(popover().style.overflowY).toBe("auto");
  });

  it("re-places itself when the window shrinks under it", () => {
    setViewport(900);
    geometry.anchor = { top: 560, bottom: 580, left: 40 };
    render(<Harness />);
    expect(popover().getAttribute("data-placement")).toBe("below");

    setViewport(CI.height);
    act(() => {
      fireEvent.resize(window);
    });
    expect(popover().getAttribute("data-placement")).toBe("above");
    expect(popover().style.bottom).toBe(`${CI.height - 560}px`);
  });

  it("keeps the ArrowDown row in view while clamped, without touching a wheel scroll", () => {
    setViewport(CI.height);
    geometry.popover = { width: 256, height: 900, box: { top: 124, bottom: 400, left: 40 } };
    geometry.rows = {
      "0": { top: 130, bottom: 150, left: 40 },
      "5": { top: 430, bottom: 450, left: 40 },
    };
    const { rerender } = render(<Harness rows={8} highlight={0} />);
    expect(popover().style.overflowY).toBe("auto");
    expect(popover().scrollTop).toBe(0);

    // ArrowDown lands on a row below the box's bottom edge.
    rerender(<Harness rows={8} highlight={5} />);
    expect(popover().scrollTop).toBe(450 - 400);

    // A re-render with the same highlight (a keystroke elsewhere, a query
    // landing) does not snap a scroll the operator made back to the row.
    popover().scrollTop = 0;
    rerender(<Harness rows={8} highlight={5} />);
    expect(popover().scrollTop).toBe(0);
  });

  describe("re-measuring on scroll", () => {
    beforeEach(() => {
      setViewport(CI.height);
    });

    it("skips a scroll that happens inside the popover", () => {
      render(<Harness />);
      expect(popover().style.top).toBe("120px");

      // The trigger "moved", but the popover scrolling inside itself cannot
      // have moved it: the popover keeps the place it had.
      geometry.anchor = { top: 200, bottom: 220, left: 40 };
      fireEvent.scroll(popover());
      expect(popover().style.top).toBe("120px");

      // The same holds for a scroll on something inside the popover.
      fireEvent.scroll(screen.getByText("Thing 1"));
      expect(popover().style.top).toBe("120px");
    });

    it("re-measures on a scroll outside the popover (the window, an ancestor)", () => {
      render(<Harness />);
      geometry.anchor = { top: 200, bottom: 220, left: 40 };
      fireEvent.scroll(window);
      expect(popover().style.top).toBe("220px");

      geometry.anchor = { top: 300, bottom: 320, left: 40 };
      fireEvent.scroll(screen.getByRole("button", { name: "Add thing" }));
      expect(popover().style.top).toBe("320px");
    });
  });
});

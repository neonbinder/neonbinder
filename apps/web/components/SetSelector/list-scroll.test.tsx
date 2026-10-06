/**
 * NEO-276 / NEO-224 — `scrollRowIntoList`: the one place the listbox's
 * `scrollTop` arithmetic lives. (`.tsx` only because component tests are
 * collected by that extension; there is no JSX here.)
 *
 * happy-dom has no layout, so each test builds a list whose geometry is set by
 * hand: a row's viewport top is its offset minus the list's `scrollTop`, the
 * way a browser reports it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { scrollRowIntoList } from "./list-scroll";

const FOLD = 400;
const ROW_H = 50;
const PITCH = 58;

function makeList(opts: { fold?: number; rowHeight?: number; scrollTop?: number } = {}) {
  const fold = opts.fold ?? FOLD;
  const rowHeight = opts.rowHeight ?? ROW_H;
  const list = document.createElement("div");
  Object.defineProperty(list, "clientHeight", { configurable: true, value: fold });
  list.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
  const rows = Array.from({ length: 30 }, (_, i) => {
    const row = document.createElement("div");
    Object.defineProperty(row, "offsetHeight", {
      configurable: true,
      value: rowHeight,
    });
    row.getBoundingClientRect = () =>
      ({ top: 100 + i * PITCH - list.scrollTop }) as DOMRect;
    list.appendChild(row);
    return row;
  });
  // happy-dom lets scrollTop be assigned freely (no clamp), like the tests
  // that depend on this file.
  list.scrollTop = opts.scrollTop ?? 0;
  return { list, rows };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scrollRowIntoList — centre", () => {
  it("centres a row below the fold", () => {
    const { list, rows } = makeList();

    const wrote = scrollRowIntoList(list, rows[20], "centre");

    expect(wrote).toBe(true);
    expect(list.scrollTop).toBe(20 * PITCH - (FOLD - ROW_H) / 2);
  });

  it("clamps at 0 for a row near the top", () => {
    const { list, rows } = makeList();

    const wrote = scrollRowIntoList(list, rows[1], "centre");

    expect(wrote).toBe(false); // already 0: no write needed
    expect(list.scrollTop).toBe(0);
  });

  it("centres a row ABOVE the fold of a scrolled list", () => {
    const { list, rows } = makeList({ scrollTop: 1200 });

    const wrote = scrollRowIntoList(list, rows[10], "centre");

    expect(wrote).toBe(true);
    expect(list.scrollTop).toBe(10 * PITCH - (FOLD - ROW_H) / 2);
  });

  it("reports false when the list is already centred on the row", () => {
    const { list, rows } = makeList();
    scrollRowIntoList(list, rows[20], "centre");

    expect(scrollRowIntoList(list, rows[20], "centre")).toBe(false);
  });
});

describe("scrollRowIntoList — nearest", () => {
  it("does nothing for a row wholly inside the fold", () => {
    const { list, rows } = makeList();

    expect(scrollRowIntoList(list, rows[3], "nearest")).toBe(false);
    expect(list.scrollTop).toBe(0);
  });

  it("does nothing for a row exactly flush with the bottom of the fold", () => {
    // Row 6: 6*58 + 50 = 398 <= 400. A row ending exactly at the fold needs no move.
    const { list, rows } = makeList({ fold: 398 });

    expect(scrollRowIntoList(list, rows[6], "nearest")).toBe(false);
  });

  it("scrolls just far enough to bring a row below the fold into view, bottom flush", () => {
    const { list, rows } = makeList();

    expect(scrollRowIntoList(list, rows[10], "nearest")).toBe(true);
    expect(list.scrollTop).toBe(10 * PITCH + ROW_H - FOLD);
  });

  it("scrolls up to a row above the fold, top flush", () => {
    const { list, rows } = makeList({ scrollTop: 1000 });

    expect(scrollRowIntoList(list, rows[5], "nearest")).toBe(true);
    expect(list.scrollTop).toBe(5 * PITCH);
  });

  it("aligns the TOP of a row taller than the fold", () => {
    const { list, rows } = makeList({ fold: 40, rowHeight: 100 });

    expect(scrollRowIntoList(list, rows[3], "nearest")).toBe(true);
    expect(list.scrollTop).toBe(3 * PITCH);
  });

  it("writes nothing when the list has no layout (fold of 0)", () => {
    const { list, rows } = makeList({ fold: 0 });

    expect(scrollRowIntoList(list, rows[10], "nearest")).toBe(false);
    expect(list.scrollTop).toBe(0);
  });

  it("never scrolls below 0", () => {
    const { list, rows } = makeList({ scrollTop: 30 });

    // Row 0 top is at 0 < viewTop 30: next = 0.
    expect(scrollRowIntoList(list, rows[0], "nearest")).toBe(true);
    expect(list.scrollTop).toBe(0);
  });
});

describe("scrollRowIntoList — scope", () => {
  it("touches nothing but the list's own scrollTop", () => {
    const { list, rows } = makeList();
    const spy = vi.fn();
    (rows[20] as HTMLElement).scrollIntoView = spy;
    const winScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    scrollRowIntoList(list, rows[20], "centre");
    scrollRowIntoList(list, rows[25], "nearest");

    expect(spy).not.toHaveBeenCalled();
    expect(winScroll).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { contrastRatio } from "@/lib/print/contrast";
import type { ContainerLabel } from "@/app/collection/final/data/types";
import { bindersOf, getDashboard, type ShelfBox } from "../fake-data";
import type { ShelfBinder } from "./shelf-model";
import Shelf from "./Shelf";

/**
 * NEO-464 — the dashboard's shelf checks each label's contrast at the size it
 * draws the lettering: a box end's tape at its fixed 15px hand, a binder's
 * name at the dashboard's shorter spine, less a smart binder's Smart chip,
 * across the width the spine is actually drawn (a narrow shelf caps it).
 * Each case is a label whose pair reaches 3:1 but not 4.5:1: kept for large
 * lettering, swapped to black or white for normal-size lettering.
 */

// Bears navy and orange, about 3.4:1.
const BETWEEN: ContainerLabel = { background: "#0B162A", text: "#C83803", fontId: "anton" };

const base = bindersOf(getDashboard()).find((b) => !b.checklist)!;
/** 50 cards: the widest spine (62px) on a wide screen. */
const binder = (id: string, name: string, kind: ShelfBinder["kind"] = "manual"): ShelfBinder => ({
  ...base,
  id,
  name,
  kind,
  checklist: null,
  checklistCards: null,
  newCards: [],
  cardCount: 50,
  label: BETWEEN,
});

function draw(binders: ShelfBinder[], boxes: ShelfBox[] = []) {
  return render(
    <MemoryRouter initialEntries={["/demo"]}>
      <Shelf binders={binders} boxes={boxes} openId={null} pocketId="pocket" onOpen={() => {}} onClose={() => {}} />
    </MemoryRouter>,
  );
}

const swappedOn = (el: Element) => el.querySelector(".nb-label")?.getAttribute("data-ink-swapped") ?? null;
const spineOf = (id: string) => document.querySelector(`[data-cb-spine="${id}"]`)!;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the dashboard shelf checks contrast at the size it draws", () => {
  it("uses a pair between 3:1 and 4.5:1", () => {
    const ratio = contrastRatio(BETWEEN.text, BETWEEN.background);
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(4.5);
  });

  it("a box end's tape is checked at its fixed 15px hand, so the pair is swapped", () => {
    const box: ShelfBox = { id: "box-show", name: "Show box", cardCount: 18, unsorted: false, label: BETWEEN };
    draw([binder("b1", "Bears")], [box]);
    expect(swappedOn(screen.getByRole("link", { name: "Show box, 18 cards for sale" }))).toBe("true");
  });

  it("a 14-character name is checked at the dashboard's shorter spine, so the pair is swapped", () => {
    draw([binder("b1", "Green Bay 1996"), binder("b2", "Bears")]);
    expect(swappedOn(spineOf("b1"))).toBe("true");
    // A short name is lettered large even here: its pair is kept.
    expect(swappedOn(spineOf("b2"))).toBeNull();
  });

  it("a smart binder's Smart chip shortens the lettering's run, so its pair is swapped; the same name on a plain binder keeps it", () => {
    draw([binder("plain", "Green Bay"), binder("smart", "Green Bay", "smart")]);
    expect(spineOf("smart").textContent).toContain("Smart");
    expect(swappedOn(spineOf("smart"))).toBe("true");
    expect(swappedOn(spineOf("plain"))).toBeNull();
  });

  it("a spine drawn thinner than it asks for (a narrow shelf's share) is checked at the width drawn", () => {
    // happy-dom lays nothing out; a spine drawn 36px wide, as a cramped shelf caps it.
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.matches(".cb-spine") ? new DOMRect(0, 0, 36, 150) : real.call(this);
    });
    draw([binder("b1", "Bears")]);
    expect(swappedOn(spineOf("b1"))).toBe("true");
  });

  it("before a spine is laid out it is checked at the width it asks for", () => {
    draw([binder("b1", "Bears")]);
    expect(swappedOn(spineOf("b1"))).toBeNull();
  });
});

/**
 * NEO-481 — the demo's picture for the card photo viewer. The demo has no
 * scanned files (its faces are drawn), so the viewer gets an SVG the size of a
 * card to turn and crop; the tiles draw the same edit over the drawn face.
 */

import { describe, expect, it } from "vitest";
import { cards } from "../../prototypes/_shared/catalog";
import { getTeam, playerNames } from "../../prototypes/_shared/data";
import type { Item } from "./sim";
import { demoScanUrl } from "./ui";

const svgOf = (url: string | undefined) => {
  expect(url?.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
  return decodeURIComponent(url!.slice(url!.indexOf(",") + 1));
};

const card = cards.find((c) => c.teamIds.length > 0)!;
const item = (extra: Partial<Item> = {}): Item =>
  ({
    id: "i1",
    truth: card.id,
    front: { file: "IMG_0001.jpg", rotation: 0, recropping: false, failed: false },
    back: { file: "IMG_0002.jpg", rotation: 0, recropping: false, failed: false },
    ...extra,
  }) as Item;

describe("demoScanUrl", () => {
  it("draws the front at a card's 5 by 7, in the team's colour, with the player and the number", () => {
    const svg = svgOf(demoScanUrl(item(), "front"));
    expect(svg).toContain('width="500" height="700"');
    expect(svg).toContain(getTeam(card.teamIds[0]).primary);
    expect(svg).toContain(`#${card.cardNumber}`);
    expect(svg).toContain(playerNames(card).replace(/&/g, "&amp;").replace(/'/g, "&apos;"));
  });

  it("draws the back as a stats panel with the number", () => {
    const svg = svgOf(demoScanUrl(item(), "back"));
    expect(svg).toContain(`#${card.cardNumber}`);
  });

  it("has no picture for a side not scanned yet", () => {
    expect(demoScanUrl(item({ back: null }), "back")).toBeUndefined();
  });

  it("names an unknown card by its file, escaped", () => {
    const svg = svgOf(demoScanUrl(item({ truth: null, front: { file: "Tom & Jerry's <1>.jpg", rotation: 0, recropping: false, failed: false } }), "front"));
    expect(svg).toContain("Tom &amp; Jerry&apos;s &lt;1&gt;.jpg");
    expect(svg).toContain("#?");
  });
});

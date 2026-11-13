/**
 * NEO-481 — the demo's picture for the card photo viewer. The demo has no
 * scanned files (its faces are drawn), so the viewer gets an SVG the size of a
 * card to turn and crop; the tiles draw the same edit over the drawn face.
 */

import { describe, expect, it } from "vitest";
import { cards } from "../../prototypes/_shared/catalog";
import { getTeam, leadPlayer, playerInitials } from "../../prototypes/_shared/data";
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
  it("draws the front the way the tile's CardFace does: livery stripes, initials, number badge, nameplate", () => {
    const svg = svgOf(demoScanUrl(item(), "front"));
    expect(svg).toContain('width="500" height="700"');
    const team = getTeam(card.teamIds[0]);
    expect(svg).toContain(`patternTransform="rotate(45)"><rect width="35" height="45" fill="${team.primary}"/>`);
    expect(svg).toContain(`fill="${team.secondary}"/>`);
    expect(svg).toContain(`>${playerInitials(leadPlayer(card))}</text>`);
    expect(svg).toContain(`>#${card.cardNumber}</text>`);
    expect(svg).toContain(leadPlayer(card).name.replace(/&/g, "&amp;").replace(/'/g, "&apos;").slice(0, 8));
  });

  it("draws the back as a stats panel with the number", () => {
    const svg = svgOf(demoScanUrl(item(), "back"));
    expect(svg).toContain(`#${card.cardNumber}`);
  });

  it("has no picture for a side not scanned yet", () => {
    expect(demoScanUrl(item({ back: null }), "back")).toBeUndefined();
  });

  it("an unknown card's front is drawn as a back with no number, as the tile draws it", () => {
    const svg = svgOf(demoScanUrl(item({ truth: null }), "front"));
    expect(svg).toContain(">#?</text>");
  });
});

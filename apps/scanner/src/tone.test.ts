import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { toneScan, toneTable, whitePoint } from "./tone.js";

describe("whitePoint", () => {
  test("is where the top percent of pixels starts", () => {
    const h = new Array(256).fill(0);
    h[50] = 99;
    h[176] = 1;
    expect(whitePoint(h, 1)).toBe(176);
  });
  test("leaves a near-black image alone", () => {
    const h = new Array(256).fill(0);
    h[3] = 100;
    expect(whitePoint(h, 1)).toBe(255);
  });
});

describe("toneTable", () => {
  test("maps the white point to white and keeps black black", () => {
    const lut = toneTable(176, 2.2);
    expect(lut[0]).toBe(0);
    expect(lut[176]).toBe(255);
    expect(lut[255]).toBe(255);
    expect(lut[58]).toBeGreaterThan(140);
  });
});

describe("toneScan", () => {
  test("brightens a dull scan and records the scan resolution", async () => {
    const raw = await sharp({ create: { width: 40, height: 60, channels: 3, background: { r: 60, g: 60, b: 60 } } })
      .jpeg()
      .toBuffer();
    const out = await toneScan(raw, { whiteClipPercent: 1, gamma: 2.2, jpegQuality: 95, dpi: 400 });
    expect(out).not.toBeNull();
    const meta = await sharp(out!).metadata();
    expect(meta.density).toBe(400);
    const { data } = await sharp(out!).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(200);
  });
  test("gives up quietly on bytes that aren't an image", async () => {
    expect(await toneScan(Buffer.from("nope"), { whiteClipPercent: 1, gamma: 2.2, jpegQuality: 95, dpi: 400 })).toBeNull();
  });
});

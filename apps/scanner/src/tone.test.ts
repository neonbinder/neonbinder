import jpeg from "jpeg-js";
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
    const raw = Buffer.from(jpeg.encode({ data: Buffer.alloc(40 * 60 * 4, 60), width: 40, height: 60 }, 95).data);
    const out = await toneScan(raw, { whiteClipPercent: 1, gamma: 2.2, jpegQuality: 95, dpi: 400 });
    expect(out).not.toBeNull();
    expect(out![13]).toBe(1);
    expect(out!.readUInt16BE(14)).toBe(400);
    expect(out!.readUInt16BE(16)).toBe(400);
    const { data, width, height } = jpeg.decode(out!, { useTArray: true });
    expect([width, height]).toEqual([40, 60]);
    expect(data[0]).toBeGreaterThan(200);
  });
  test("gives up quietly on bytes that aren't an image", async () => {
    expect(await toneScan(Buffer.from("nope"), { whiteClipPercent: 1, gamma: 2.2, jpegQuality: 95, dpi: 400 })).toBeNull();
  });
});

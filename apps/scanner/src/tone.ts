import jpeg from "jpeg-js";

/**
 * Tone for raw SANE scans.
 *
 * The fi-series SANE backend hands back near-linear data that never reaches
 * white (one card measured p50 = 58, nothing above 176, 15% crushed to black).
 * VueScan looks far better on the same card only because it post-processes:
 * a per-image white point and the usual ~2.2 gamma encode. This does the same:
 * stretch so the top `whiteClipPercent` of pixels reach white, then
 * gamma-encode. Measured against VueScan on the same card it lands p50 154 vs
 * 153 while clipping less highlight detail.
 */
export interface ToneOptions {
  whiteClipPercent: number;
  gamma: number;
  jpegQuality: number;
  /** The resolution scanned at, written into the JPEG when the source has none. */
  dpi: number;
}

/** The luminance level below which all but `whiteClipPercent` of pixels sit. */
export function whitePoint(histogram: ArrayLike<number>, whiteClipPercent: number): number {
  let total = 0;
  for (let v = 0; v < 256; v++) total += histogram[v];
  let seen = 0;
  for (let v = 255; v >= 0; v--) {
    seen += histogram[v];
    if (seen >= (total * whiteClipPercent) / 100) {
      // A near-black image is left alone rather than blown out.
      return v < 16 ? 255 : v;
    }
  }
  return 255;
}

/** The 256-entry stretch-then-gamma table for a white point. */
export function toneTable(white: number, gamma: number): Uint8Array {
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(255 * Math.pow(Math.min(1, v / white), 1 / gamma));
  return lut;
}

/**
 * The toned JPEG for one raw scan. Returns null when the scan cannot be
 * decoded, so the caller sends the untouched bytes rather than losing a card.
 *
 * Pure JavaScript (jpeg-js), so the scanner app compiles to one file with no
 * native image library beside it. About half a second a side at 400 dpi,
 * which the upload overlaps with the next card's scan.
 */
export async function toneScan(raw: Buffer, options: ToneOptions): Promise<Buffer | null> {
  try {
    const { data, width, height } = jpeg.decode(raw, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
    const histogram = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 4) {
      histogram[Math.round((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000)]++;
    }
    const lut = toneTable(whitePoint(histogram, options.whiteClipPercent), options.gamma);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = lut[data[i]];
      data[i + 1] = lut[data[i + 1]];
      data[i + 2] = lut[data[i + 2]];
    }
    return withDensity(Buffer.from(jpeg.encode({ data, width, height }, options.jpegQuality).data), options.dpi);
  } catch {
    return null;
  }
}

/**
 * Write the scan resolution into the JPEG's JFIF header (preprocess reads the
 * DPI). jpeg-js always writes a JFIF APP0 segment first, with "no units".
 */
export function withDensity(jpg: Buffer, dpi: number): Buffer {
  const isJfif = jpg[2] === 0xff && jpg[3] === 0xe0 && jpg.toString("latin1", 6, 11) === "JFIF\0";
  if (!isJfif) return jpg;
  jpg[13] = 1; // dots per inch
  jpg.writeUInt16BE(dpi, 14);
  jpg.writeUInt16BE(dpi, 16);
  return jpg;
}

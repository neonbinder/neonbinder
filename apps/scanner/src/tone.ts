import sharp from "sharp";

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
 */
export async function toneScan(raw: Buffer, options: ToneOptions): Promise<Buffer | null> {
  try {
    const input = sharp(raw);
    // libvips reports 72 when a file records no resolution, and no scanner here
    // runs that low, so 72 or less counts as "none". Preprocess reads the DPI.
    const meta = await input.metadata();
    const density = meta.density && meta.density > 72 ? meta.density : options.dpi;
    const { data, info } = await input.raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const histogram = new Uint32Array(256);
    for (let i = 0; i < width * height * channels; i += channels) {
      const luma = channels >= 3 ? (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000 : data[i];
      histogram[Math.round(luma)]++;
    }
    const lut = toneTable(whitePoint(histogram, options.whiteClipPercent), options.gamma);
    for (let i = 0; i < data.length; i++) data[i] = lut[data[i]];
    return await sharp(data, { raw: { width, height, channels } })
      .withMetadata({ density })
      .jpeg({ quality: options.jpegQuality })
      .toBuffer();
  } catch {
    return null;
  }
}

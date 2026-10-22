import { afterEach, describe, expect, test, vi } from "vitest";
import { QR_FONT_CSS_URL, base64, embeddedQrFontCss } from "./embedded-font";

/**
 * The QR PNG is drawn from an SVG inside an <img>, which may fetch nothing, so
 * the Lexend font is inlined as a data URL. These tests stub `fetch` (never
 * Google Fonts) with CSS shaped like Google's: several unicode-range blocks,
 * of which only the two `/* latin *\/` ones (400 and 700) matter.
 */

const FONT_A = "https://fonts.gstatic.com/s/lexend/v1/latin-a.woff2";
const FONT_B = "https://fonts.gstatic.com/s/lexend/v1/latin-b.woff2";
const VIETNAMESE = "https://fonts.gstatic.com/s/lexend/v1/vietnamese.woff2";

const block = (label: string, weight: number, url: string) => `/* ${label} */
@font-face {
  font-family: 'Lexend';
  font-style: normal;
  font-weight: ${weight};
  font-display: swap;
  src: url(${url}) format('woff2');
  unicode-range: U+0000-00FF;
}`;

const cssOf = (...blocks: string[]) => blocks.join("\n");

const bytesFor = (url: string) =>
  new Uint8Array(Array.from(url).map((c) => c.charCodeAt(0) % 256));

/** A fetch stub: the stylesheet at QR_FONT_CSS_URL, font bytes per URL. */
function stubFetch(css: string) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === QR_FONT_CSS_URL) return new Response(css);
    return new Response(bytesFor(url));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const faces = (out: string) => out.split("\n").filter(Boolean);
const decodedSrc = (face: string) => {
  const m = face.match(/url\(data:font\/woff2;base64,([^)]+)\)/);
  return m ? new Uint8Array(Buffer.from(m[1], "base64")) : null;
};

describe("embeddedQrFontCss", () => {
  test("two latin blocks over one file become exactly one 400-700 face", async () => {
    stubFetch(
      cssOf(
        block("vietnamese", 400, VIETNAMESE),
        block("latin-ext", 400, VIETNAMESE),
        block("latin", 400, FONT_A),
        block("vietnamese", 700, VIETNAMESE),
        block("latin", 700, FONT_A),
      ),
    );
    const out = faces(await embeddedQrFontCss());
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("font-family: 'Lexend'");
    expect(out[0]).toContain("font-weight: 400 700;");
    expect(out[0]).toContain("src: url(data:font/woff2;base64,");
    expect(out[0]).toContain("format('woff2')");
    expect(decodedSrc(out[0])).toEqual(bytesFor(FONT_A));
  });

  test("fetches the shared latin file once, and never the other subsets", async () => {
    const fetchMock = stubFetch(
      cssOf(
        block("vietnamese", 400, VIETNAMESE),
        block("latin", 400, FONT_A),
        block("latin", 700, FONT_A),
      ),
    );
    await embeddedQrFontCss();
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.filter((u) => u === FONT_A)).toHaveLength(1);
    expect(urls).not.toContain(VIETNAMESE);
  });

  test("two distinct latin files become two faces, each with its own bytes", async () => {
    stubFetch(cssOf(block("latin", 400, FONT_A), block("latin", 700, FONT_B)));
    const out = faces(await embeddedQrFontCss());
    expect(out).toHaveLength(2);
    expect(out.map(decodedSrc)).toEqual([bytesFor(FONT_A), bytesFor(FONT_B)]);
  });

  test("a stylesheet with no latin block yields no faces", async () => {
    stubFetch(cssOf(block("vietnamese", 400, VIETNAMESE)));
    expect(await embeddedQrFontCss()).toBe("");
  });

  test("a rejected fetch resolves to an empty string", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(embeddedQrFontCss()).resolves.toBe("");
  });

  test("a failing font download resolves to an empty string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === QR_FONT_CSS_URL) {
          return new Response(cssOf(block("latin", 400, FONT_A)));
        }
        throw new TypeError("font blocked");
      }),
    );
    await expect(embeddedQrFontCss()).resolves.toBe("");
  });
});

describe("base64", () => {
  test("round-trips a buffer larger than one 0x8000 chunk", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 123);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) % 256;
    expect(base64(bytes.buffer)).toBe(Buffer.from(bytes).toString("base64"));
  });

  test("encodes the bytes at a chunk boundary exactly", () => {
    for (const n of [0, 1, 0x7fff, 0x8000, 0x8001]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 13) % 256);
      expect(base64(bytes.buffer)).toBe(Buffer.from(bytes).toString("base64"));
    }
  });
});

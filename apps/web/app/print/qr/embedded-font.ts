/** The QR's centre text: a Lexend 400 "$" and a Lexend 700 amount. */
export const QR_FONT_CSS_URL =
  "https://fonts.googleapis.com/css2?family=Lexend:wght@400;700&display=swap";

export function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Lexend's latin @font-face rules with each font file inlined as a data URL.
 * An SVG drawn through an <img> may not fetch anything (no @import, no font
 * URL), so a linked font never reached the PNG and its text fell back to a
 * generic sans. Inlined, the font travels inside the SVG. Resolves to "" if
 * the fonts cannot be fetched, which leaves the old fallback behaviour.
 */
export async function embeddedQrFontCss(): Promise<string> {
  try {
    const css = await fetch(QR_FONT_CSS_URL).then((r) => r.text());
    const blocks = css.match(/\/\* latin \*\/\s*@font-face\s*\{[^}]*\}/g) ?? [];
    // Google serves Lexend as one variable font, so the 400 and 700 rules
    // name the same file. Two rules over one inlined file render both weights
    // bold; one rule spanning the range lets the weight axis do its job, and
    // inlines the file once.
    const urls = new Set(
      blocks.map((block) => block.match(/url\((https:[^)]+)\)/)?.[1]).filter(Boolean),
    );
    const faces = await Promise.all(
      [...urls].map(async (url) => {
        const font = await fetch(url as string).then((r) => r.arrayBuffer());
        return `@font-face { font-family: 'Lexend'; font-style: normal; font-weight: 400 700; src: url(data:font/woff2;base64,${base64(font)}) format('woff2'); }`;
      }),
    );
    return faces.join("\n");
  } catch {
    return "";
  }
}

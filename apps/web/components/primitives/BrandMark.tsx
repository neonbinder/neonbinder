import { useTheme } from "@/src/theme/ThemeProvider";

/**
 * NEO-356 — the Neon Binder logo for a header, in either mode.
 *
 * - **Dark:** the neon logo art (`/logo-120.png`), unchanged.
 * - **Light:** the "Mark": the binder outline alone (`/logo-mark.svg`, a
 *   single-colour vector), no black tile, painted in the deep brand green
 *   (`text-neon-green-text`, #007A3B, 5.1:1 on the light page) through a CSS
 *   mask, so it is one colour and follows the token.
 *
 * Both carry the same accessible name (an `<img alt>` in dark, `role="img"` +
 * `aria-label` in light), so `getByRole("img", { name })` finds either.
 */
export interface BrandMarkProps {
  /** Rendered width and height in px. */
  size?: number;
  /** Accessible name. */
  alt?: string;
  className?: string;
}

export function BrandMark({ size = 40, alt = "Neon Binder", className = "" }: BrandMarkProps) {
  const { mode } = useTheme();
  if (mode === "light") {
    return (
      <span
        role="img"
        aria-label={alt}
        className={`brand-mark-mask inline-block shrink-0 text-neon-green-text ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }
  return <img src="/logo-120.png" alt={alt} width={size} height={size} className={className} />;
}

export default BrandMark;

import type { CSSProperties, ReactNode } from "react";
import { spineFontById, spineFontFacesCss, spineFontFamilyCss } from "@/lib/print/spine-fonts";
import type { ContainerLabel } from "../data/types";
import { letteringSizeCss, shelfColors, smallestLetteringPx } from "./label";
import "./spine-label.css";

/**
 * A binder's spine label in the Print Shop's look: the label's background as
 * a solid field, the name lettered down it in the chosen display face, sized
 * by the Print Shop's own fitter, and the count on a small paper sticker at
 * the foot.
 *
 * Decoration only: the spine button around it carries the accessible name in
 * plain text, so nothing here is read out. The lettering is never drawn below
 * WCAG AA; `shelfColors` swaps it to black or white when the collector's pair
 * falls short (their pick is kept for printing).
 */

/** Declares the spine faces once per page; harmless if rendered twice. */
export function SpineFontFaces() {
  return <style>{SPINE_FACES}</style>;
}
const SPINE_FACES = spineFontFacesCss();

export default function SpineLabel({
  name,
  label,
  spineWidth,
  spineHeight,
  letteringPx,
  count,
  badge,
}: {
  name: string;
  label: ContainerLabel;
  /** The spine's width in px, for the contrast check at its smallest size. */
  spineWidth: number;
  /** The shortest the shelf draws this spine, in px, when shorter than My Binders' phone spine. */
  spineHeight?: number;
  /**
   * The lettering's size in px when CSS fixes it rather than the fitter (a
   * box end's tape, `BOX_LETTERING_PX`). The contrast check then reads this
   * instead of estimating from the spine.
   */
  letteringPx?: number;
  count?: ReactNode;
  badge?: ReactNode;
}) {
  const font = spineFontById(label.fontId);
  const colors = shelfColors(label, letteringPx ?? smallestLetteringPx(name, font, spineWidth, spineHeight));
  return (
    <span
      aria-hidden="true"
      className="nb-label"
      data-ink-swapped={colors.swapped ? "true" : undefined}
      style={{ background: colors.background, color: colors.text } as CSSProperties}
    >
      {badge}
      <span className="nb-label-field">
        <span
          className="nb-label-name"
          style={{ fontFamily: spineFontFamilyCss(font), fontSize: letteringSizeCss(name, font) }}
        >
          {name}
        </span>
      </span>
      {count !== undefined && <span className="nb-label-count">{count}</span>}
    </span>
  );
}

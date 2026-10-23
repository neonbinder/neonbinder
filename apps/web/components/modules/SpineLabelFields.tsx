import { Input } from "@/components/primitives";
import NeonButton from "@/components/modules/NeonButton";
import { contrastRatio, gradeContrast, normalizeHexColor } from "@/lib/print/contrast";
import { SPINE_FONTS, spineFontById, spineFontFamilyCss } from "@/lib/print/spine-fonts";

/**
 * The spine label designer's two style sections (NEO-147), shared.
 *
 * Lifted out of the Print Shop's `/print/spine-label` page unchanged, so the
 * collection page's binder label editor (NEO-350) picks colours and lettering
 * with the very same controls: the two hex fields, Invert, the contrast
 * readout, and the typeface picker that sets each option in its own face.
 *
 * Both are controlled: the caller owns the values and decides what a change
 * means (the Print Shop marks its colours as hand-edited, for instance).
 */

export interface SpineLabelColorsProps {
  /** The background as typed: may be mid-edit and not a colour yet. */
  background: string;
  /** The lettering as typed. */
  text: string;
  onBackgroundChange: (value: string) => void;
  onTextChange: (value: string) => void;
  onInvert: () => void;
}

/**
 * Background and lettering, Invert, and the contrast readout.
 *
 * Contrast is shown, never enforced: a collector choosing their team's livery
 * is making a legitimate choice. The readout grades on WCAG's large-text
 * thresholds (see `gradeContrast`).
 *
 * A poor pair's advice is to move the lettering lighter or darker, never to
 * Invert: swapping the two colours leaves the ratio exactly where it was.
 * Invert stays because it changes the look, not the legibility.
 */
export function SpineLabelColors({
  background,
  text,
  onBackgroundChange,
  onTextChange,
  onInvert,
}: SpineLabelColorsProps) {
  const normalizedBackground = normalizeHexColor(background);
  const normalizedText = normalizeHexColor(text);
  const ratio =
    normalizedBackground !== null && normalizedText !== null
      ? contrastRatio(normalizedText, normalizedBackground)
      : null;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-ink-2">Colors</h3>
      <div className="flex flex-wrap items-end gap-3">
        <Input
          label="Background"
          value={background}
          onChange={(e) => onBackgroundChange(e.target.value)}
          className="w-32"
        />
        <Input
          label="Lettering"
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          className="w-32"
        />
        <NeonButton type="button" variant="secondary" onClick={onInvert}>
          Invert
        </NeonButton>
      </div>

      <p className="text-xs" aria-live="polite">
        {ratio === null ? (
          <span className="text-notice-warn-ink">
            Enter two hex colors (e.g. #01214b) to see contrast.
          </span>
        ) : (
          <span
            className={
              gradeContrast(ratio) === "poor"
                ? "text-notice-warn-ink"
                : "text-ink-3"
            }
          >
            Contrast {ratio.toFixed(1)}:1 —{" "}
            {gradeContrast(ratio) === "poor"
              ? "hard to read on a shelf. Try a lighter or darker lettering color."
              : "easy to read on a shelf."}
          </span>
        )}
      </p>
    </section>
  );
}

export interface SpineLabelLetteringProps {
  fontId: string;
  onFontChange: (fontId: string) => void;
}

/**
 * The typeface picker. Each option is set in its OWN face, which is the whole
 * point — a list of ten names in one font tells you nothing about how a spine
 * will look. Rendering them is also what triggers the downloads, so the caller
 * must have declared the faces (`spineFontFacesCss`) somewhere on the page.
 */
export function SpineLabelLettering({ fontId, onFontChange }: SpineLabelLetteringProps) {
  const font = spineFontById(fontId);
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-ink-2">Lettering</h3>
      <div
        className="flex flex-wrap gap-2"
        role="radiogroup"
        aria-label="Label typeface"
      >
        {SPINE_FONTS.map((option) => {
          const isActive = option.id === fontId;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={isActive}
              onClick={() => onFontChange(option.id)}
              title={option.note}
              className={`rounded-md border px-3 py-1.5 text-lg leading-tight transition-colors focus-outline ${
                isActive
                  ? "border-neon-teal-text text-neon-teal-text"
                  : "border-rule-strong text-ink-2 hover:border-control"
              }`}
              style={{ fontFamily: spineFontFamilyCss(option) }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-ink-3">{font.note}</p>
    </section>
  );
}

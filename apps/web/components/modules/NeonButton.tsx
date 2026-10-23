import { Button, ButtonProps } from "@radix-ui/themes";
import React, { forwardRef } from "react";
import { useTheme } from "@/src/theme/ThemeProvider";

/**
 * The one action button (NEO-356, Jason 2026-10-23: "we should be using that
 * button everywhere so that when we try to update things like the color again
 * it is one single button"). This file is the only place a button's colour is
 * decided; the `theme/no-raw-palette` lint rule refuses a neon fill on a raw
 * `<button>` anywhere else.
 *
 * - `primary`   Neon Green: the main action (Save, Next, Create).
 * - `secondary` Neon Blue: a second action beside the main one.
 * - `tertiary`  Neon Purple: a third action, beside green and blue.
 * - `negative`  Show-Sign Pink: back out (Cancel, Close) or take something
 *               away (Delete, Remove, Discard, Abort, Clear).
 *
 * `outline` draws any of the four as an outline instead of a fill: the hue as
 * text and edge on a clear ground, filling with the neon (and its ink) under
 * the pointer, as the collection's pack tray always has. A quiet neutral
 * action (Back, Style the spine) is `secondary outline`.
 */
export type NeonButtonVariant = "primary" | "secondary" | "tertiary" | "negative";

export interface NeonButtonProps extends Omit<ButtonProps, "color" | "variant"> {
  variant?: NeonButtonVariant;
  outline?: boolean;
  children: React.ReactNode;
}

/** Each hue's roles (app/theme.css): the fill, its hover, the ink on it, and the hue as text. */
const HUES: Record<NeonButtonVariant, { fill: string; hover: string; ink: string; text: string }> = {
  primary: {
    fill: "var(--neon-green)",
    hover: "var(--neon-green-hover)",
    ink: "var(--on-neon-green)",
    text: "var(--neon-green-text)",
  },
  secondary: {
    fill: "var(--neon-blue)",
    hover: "var(--neon-blue-hover)",
    ink: "var(--on-neon-blue)",
    text: "var(--neon-blue-text)",
  },
  tertiary: {
    fill: "var(--neon-purple)",
    hover: "var(--neon-purple-hover)",
    ink: "var(--on-neon-purple)",
    text: "var(--neon-purple-text)",
  },
  negative: {
    fill: "var(--neon-pink)",
    hover: "var(--neon-pink-hover)",
    ink: "var(--on-neon-pink)",
    text: "var(--neon-pink-text)",
  },
};

/**
 * The button's paint, as `--nb-*` custom properties that the `.neon-button`
 * rule in app/globals.css reads at rest and under the pointer. Radix's
 * stylesheet is unlayered, so a Tailwind class cannot outrank its fill, and an
 * inline `backgroundColor` would freeze the hover; a custom property set on
 * the element does neither.
 */
export type NeonButtonPaint = Record<
  "--nb-fill" | "--nb-fill-hover" | "--nb-ink" | "--nb-ink-hover" | "--nb-edge" | "--nb-edge-hover",
  string
>;

export function neonButtonPaint(variant: NeonButtonVariant, outline = false): NeonButtonPaint {
  const hue = HUES[variant];
  if (outline) {
    return {
      "--nb-fill": "transparent",
      "--nb-fill-hover": hue.fill,
      "--nb-ink": hue.text,
      "--nb-ink-hover": hue.ink,
      "--nb-edge": hue.text,
      "--nb-edge-hover": hue.fill,
    };
  }
  return {
    "--nb-fill": hue.fill,
    "--nb-fill-hover": hue.hover,
    "--nb-ink": hue.ink,
    "--nb-ink-hover": hue.ink,
    "--nb-edge": "transparent",
    "--nb-edge-hover": "transparent",
  };
}

/**
 * A disabled button must look off, or you press it and nothing happens with
 * no clue why. Keys off `aria-disabled` as well as `disabled`: a caller that
 * keeps the button in the tab order (CardPairingModal's Confirm while a fetch
 * streams) uses aria-disabled, because native `disabled` removes it from the
 * tab order and makes the reason unreachable by keyboard.
 *
 * A fill: dark dims the neon (a lit tube switched off); light swaps it for the
 * neutral button fill and quiet ink, because a neon fill at 45% on white reads
 * as a pale, still-pressable button. An outline fades to half. Set inline, so
 * it outranks the hover and Radix's grey disabled fill.
 */
function disabledStyle(paint: NeonButtonPaint, filled: boolean, mode: "light" | "dark"): React.CSSProperties {
  const off: React.CSSProperties = {
    backgroundColor: paint["--nb-fill"],
    color: paint["--nb-ink"],
    boxShadow: `inset 0 0 0 1px ${paint["--nb-edge"]}`,
    cursor: "not-allowed",
  };
  if (!filled) return { ...off, opacity: 0.5 };
  if (mode === "light") {
    return { ...off, backgroundColor: "var(--button-neutral)", color: "var(--ink-3)" };
  }
  return { ...off, opacity: 0.45 };
}

const NeonButton = forwardRef<HTMLButtonElement, NeonButtonProps>(function NeonButton(
  { variant = "primary", outline = false, size = "2", className, style, children, ...props },
  ref,
) {
  const { mode } = useTheme();
  const paint = neonButtonPaint(variant, outline);
  const ariaDisabled = props["aria-disabled"];
  const isDisabled = Boolean(props.disabled) || ariaDisabled === true || ariaDisabled === "true";
  return (
    <Button
      {...props}
      ref={ref}
      size={size}
      variant="solid"
      className={className ? `neon-button focus-outline ${className}` : "neon-button focus-outline"}
      style={{
        ...(paint as React.CSSProperties),
        ...(isDisabled ? disabledStyle(paint, !outline, mode) : null),
        ...style,
      }}
    >
      {children}
    </Button>
  );
});

export default NeonButton;

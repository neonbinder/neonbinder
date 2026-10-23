import { Button, ButtonProps } from "@radix-ui/themes";
import React, { forwardRef } from "react";
import { useTheme } from "@/src/theme/ThemeProvider";

interface NeonButtonProps extends ButtonProps {
  cancel?: boolean;
  secondary?: boolean;
  children: React.ReactNode;
}

const NeonButton = forwardRef<HTMLButtonElement, NeonButtonProps>(
  function NeonButton(
    { cancel = false, secondary = false, children, ...props },
    ref,
  ) {
    const { mode } = useTheme();
    let colorClass: ButtonProps["color"] = "green";
    if (cancel) {
      colorClass = "pink";
    }
    if (secondary) {
      colorClass = "blue";
    }
    return (
      <Button
        {...props}
        ref={ref}
        color={colorClass}
        style={{
          // The neon fill and its ink, as role variables (app/theme.css,
          // NEO-356) so both follow the mode.
          backgroundColor: cancel
            ? "var(--neon-pink)"
            : secondary
              ? "var(--neon-blue)"
              : "var(--neon-green)",
          // Black ink on every neon fill, in both modes: white measured
          // 3.44:1 on the pink and 2.07:1 on the cyan (SC 1.4.3 needs 4.5:1);
          // black is 6.11:1, 10.16:1 and 10.66:1 on pink, cyan and green. One
          // ink for all three keeps the buttons reading as one family.
          color: cancel
            ? "var(--on-neon-pink)"
            : secondary
              ? "var(--on-neon-blue)"
              : "var(--on-neon-green)",
          // The inline backgroundColor above overrides Radix's own disabled
          // styling, so without this a disabled button renders at full neon
          // and reads as clickable — you press it and nothing happens, with
          // no clue why. Dim it and switch the cursor so the state is visible.
          //
          // Also keys off `aria-disabled`, not just `disabled`: a caller that
          // needs the button to stay in the tab order (e.g. CardPairingModal's
          // Confirm while a background fetch streams) uses aria-disabled
          // instead of the native attribute — native `disabled` removes a
          // button from the tab order entirely, which would make the reason
          // for the disablement unreachable by keyboard. That button still
          // needs the same "this isn't live" visual treatment.
          //
          // NEO-356: dark dims the neon (a lit tube switched off); light
          // swaps it for the neutral button fill and quiet ink, because a
          // neon fill at 45% on white reads as a pale, still-pressable
          // button rather than an off one.
          ...(props.disabled || props["aria-disabled"]
            ? mode === "light"
              ? {
                  backgroundColor: "var(--button-neutral)",
                  color: "var(--ink-3)",
                  cursor: "not-allowed",
                }
              : { opacity: 0.45, cursor: "not-allowed" }
            : null),
          ...props.style,
        }}
      >
        {children}
      </Button>
    );
  },
);

export default NeonButton;

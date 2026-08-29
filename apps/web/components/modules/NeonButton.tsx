import { Button, ButtonProps } from "@radix-ui/themes";
import React, { forwardRef } from "react";

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
          backgroundColor: cancel
            ? "#FF2E9A"
            : secondary
              ? "#00C2FF"
              : "#00D558",
          color: cancel || secondary ? "white" : "black",
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
          ...(props.disabled || props["aria-disabled"]
            ? { opacity: 0.45, cursor: "not-allowed" }
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

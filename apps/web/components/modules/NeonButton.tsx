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
          ...props.style,
        }}
      >
        {children}
      </Button>
    );
  },
);

export default NeonButton;

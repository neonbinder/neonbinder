import React from "react";

export interface PullingLogoProps {
  size?: "small" | "medium" | "large";
  animate?: boolean;
}

export const PullingLogo = React.forwardRef<HTMLDivElement, PullingLogoProps>(
  (
    {
      size = "medium",
      animate = false,
    },
    ref,
  ) => {
    const sizeMap = {
      small: { width: 40, height: 40 },
      medium: { width: 60, height: 60 },
      large: { width: 120, height: 120 },
    };

    const { width, height } = sizeMap[size];
    const animateClass = animate ? "animate-pulse" : "";

    return (
      <div ref={ref} className={animateClass}>
        <img
          src="/logo.png"
          alt="Neon Binder"
          width={width}
          height={height}
        />
      </div>
    );
  },
);

PullingLogo.displayName = "PullingLogo";

import React from "react";
import { useTheme } from "@/src/theme/ThemeProvider";
import { BrandMark } from "./BrandMark";

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
    // Each size points at a downscaled copy of /logo.png (1024px, 740 KB) that
    // still covers a 2-3x screen: 120px for small and medium, 360px for large.
    const sizeMap = {
      small: { width: 40, height: 40, src: "/logo-120.png" },
      medium: { width: 60, height: 60, src: "/logo-120.png" },
      large: { width: 120, height: 120, src: "/logo-360.png" },
    };

    const { mode } = useTheme();
    const { width, height, src } = sizeMap[size];
    // Switches on once, like a neon sign (globals.css, `neon-sign-ignite`).
    const animateClass = animate ? "animate-neon-ignite" : "";

    // Light mode (NEO-356): the single-colour Mark, never the black tile.
    return (
      <div ref={ref} className={animateClass}>
        {mode === "light" ? (
          <BrandMark size={width} />
        ) : (
          <img
            src={src}
            alt="Neon Binder"
            width={width}
            height={height}
          />
        )}
      </div>
    );
  },
);

PullingLogo.displayName = "PullingLogo";

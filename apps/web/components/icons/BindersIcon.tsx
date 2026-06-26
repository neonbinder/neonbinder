import React from "react";

export interface BindersIconProps extends React.SVGAttributes<SVGSVGElement> {
  size?: number;
}

export const BindersIcon = React.forwardRef<SVGSVGElement, BindersIconProps>(
  (
    {
      size = 100,
      className = "",
      ...props
    },
    ref,
  ) => {
    return (
      <svg
        ref={ref}
        viewBox="0 0 200 240"
        width={size}
        height={size}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        {...props}
      >
        {/* Left Binder - Neon Green */}
        <rect
          x="20"
          y="25"
          width="40"
          height="120"
          rx="6"
          stroke="#00D558"
          strokeWidth="6"
        />
        <circle cx="40" cy="45" r="6" fill="#00D558" />
        <line x1="28" y1="85" x2="52" y2="85" stroke="#00D558" strokeWidth="4" strokeLinecap="round" />
        <line x1="28" y1="100" x2="52" y2="100" stroke="#00D558" strokeWidth="4" strokeLinecap="round" />
        <line x1="28" y1="115" x2="52" y2="115" stroke="#00D558" strokeWidth="4" strokeLinecap="round" />

        {/* Middle Binder - Neon Pink */}
        <rect
          x="80"
          y="25"
          width="40"
          height="120"
          rx="6"
          stroke="#FF2E9A"
          strokeWidth="6"
        />
        <circle cx="100" cy="45" r="6" fill="#FF2E9A" />
        <line x1="88" y1="85" x2="112" y2="85" stroke="#FF2E9A" strokeWidth="4" strokeLinecap="round" />
        <line x1="88" y1="100" x2="112" y2="100" stroke="#FF2E9A" strokeWidth="4" strokeLinecap="round" />
        <line x1="88" y1="115" x2="112" y2="115" stroke="#FF2E9A" strokeWidth="4" strokeLinecap="round" />

        {/* Right Binder - Neon Blue */}
        <rect
          x="140"
          y="25"
          width="40"
          height="120"
          rx="6"
          stroke="#00C2FF"
          strokeWidth="6"
        />
        <circle cx="160" cy="45" r="6" fill="#00C2FF" />
        <line x1="148" y1="85" x2="172" y2="85" stroke="#00C2FF" strokeWidth="4" strokeLinecap="round" />
        <line x1="148" y1="100" x2="172" y2="100" stroke="#00C2FF" strokeWidth="4" strokeLinecap="round" />
        <line x1="148" y1="115" x2="172" y2="115" stroke="#00C2FF" strokeWidth="4" strokeLinecap="round" />

        {/* Shelf - Neon Purple */}
        <rect
          x="10"
          y="160"
          width="180"
          height="16"
          rx="4"
          stroke="#A44AFF"
          strokeWidth="5"
        />
      </svg>
    );
  },
);

BindersIcon.displayName = "BindersIcon";

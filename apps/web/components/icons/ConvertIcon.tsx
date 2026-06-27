import React from "react";

export interface ConvertIconProps extends React.SVGAttributes<SVGSVGElement> {
  size?: number;
}

export const ConvertIcon = React.forwardRef<SVGSVGElement, ConvertIconProps>(
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
        viewBox="0 0 250 140"
        width={size}
        height={(size * 140) / 250}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        {...props}
      >
        {/* Database - Neon Green */}
        {/* Top ellipse */}
        <ellipse
          cx="45"
          cy="50"
          rx="25"
          ry="15"
          stroke="#00D558"
          strokeWidth="5"
          fill="none"
        />
        {/* Right side line */}
        <line
          x1="70"
          y1="50"
          x2="70"
          y2="110"
          stroke="#00D558"
          strokeWidth="5"
          strokeLinecap="round"
        />
        {/* Bottom ellipse */}
        <ellipse
          cx="45"
          cy="110"
          rx="25"
          ry="15"
          stroke="#00D558"
          strokeWidth="5"
          fill="none"
        />
        {/* Left side line */}
        <line
          x1="20"
          y1="50"
          x2="20"
          y2="110"
          stroke="#00D558"
          strokeWidth="5"
          strokeLinecap="round"
        />
        {/* Middle line */}
        <line
          x1="20"
          y1="75"
          x2="70"
          y2="75"
          stroke="#00D558"
          strokeWidth="5"
          strokeLinecap="round"
        />

        {/* Arrow - Neon Pink */}
        {/* Arrow shaft */}
        <line
          x1="85"
          y1="80"
          x2="130"
          y2="80"
          stroke="#FF2E9A"
          strokeWidth="6"
          strokeLinecap="round"
        />
        {/* Arrow head - right point */}
        <line
          x1="130"
          y1="80"
          x2="115"
          y2="65"
          stroke="#FF2E9A"
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Arrow head - bottom point */}
        <line
          x1="130"
          y1="80"
          x2="115"
          y2="95"
          stroke="#FF2E9A"
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Form/Document - Neon Blue */}
        {/* Outer box */}
        <rect
          x="140"
          y="35"
          width="50"
          height="90"
          rx="6"
          stroke="#00C2FF"
          strokeWidth="5"
          fill="none"
        />
        {/* Top dots (menu/options) */}
        <circle cx="150" cy="50" r="3" fill="#00C2FF" />
        <circle cx="165" cy="50" r="3" fill="#00C2FF" />
        <circle cx="180" cy="50" r="3" fill="#00C2FF" />
        {/* Content line 1 */}
        <line
          x1="150"
          y1="70"
          x2="185"
          y2="70"
          stroke="#00C2FF"
          strokeWidth="3"
          strokeLinecap="round"
        />
        {/* Content line 2 */}
        <line
          x1="150"
          y1="85"
          x2="185"
          y2="85"
          stroke="#00C2FF"
          strokeWidth="3"
          strokeLinecap="round"
        />
        {/* Content box/image placeholder */}
        <rect
          x="150"
          y="100"
          width="30"
          height="20"
          rx="3"
          stroke="#00C2FF"
          strokeWidth="3"
          fill="none"
        />
        {/* Bottom line */}
        <line
          x1="150"
          y1="130"
          x2="185"
          y2="130"
          stroke="#00C2FF"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
    );
  },
);

ConvertIcon.displayName = "ConvertIcon";

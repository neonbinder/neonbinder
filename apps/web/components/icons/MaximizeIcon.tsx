import React from "react";

export interface MaximizeIconProps extends React.SVGAttributes<SVGSVGElement> {
  size?: number;
}

export const MaximizeIcon = React.forwardRef<SVGSVGElement, MaximizeIconProps>(
  ({ size = 100, className = "", ...props }, ref) => {
    return (
      <svg
        ref={ref}
        viewBox="0 0 512 512"
        width={size}
        height={size}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        {...props}
      >
        <rect x="0" y="0" width="512" height="512" fill="#000000" />

        <line
          x1="80"
          y1="360"
          x2="260"
          y2="360"
          stroke="#00D558"
          strokeWidth="16"
          strokeLinecap="round"
        />

        <rect
          x="96"
          y="300"
          width="32"
          height="60"
          rx="8"
          fill="none"
          stroke="#00D558"
          strokeWidth="16"
        />
        <rect
          x="144"
          y="270"
          width="32"
          height="90"
          rx="8"
          fill="none"
          stroke="#00D558"
          strokeWidth="16"
        />
        <rect
          x="192"
          y="230"
          width="32"
          height="130"
          rx="8"
          fill="none"
          stroke="#00D558"
          strokeWidth="16"
        />
        <rect
          x="240"
          y="190"
          width="32"
          height="170"
          rx="8"
          fill="none"
          stroke="#00D558"
          strokeWidth="16"
        />

        <path
          d="M90 260 L160 210 L220 240 L310 150"
          fill="none"
          stroke="#FF2BBF"
          strokeWidth="16"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        <path d="M310 150 L305 185 L340 180 Z" fill="#FF2BBF" />

        <path
          d="M280 260
                L360 230
                L360 330
                L280 300 Z"
          fill="none"
          stroke="#00B7FF"
          strokeWidth="16"
          strokeLinejoin="round"
        />

        <rect
          x="260"
          y="280"
          width="40"
          height="60"
          rx="10"
          fill="none"
          stroke="#00B7FF"
          strokeWidth="16"
        />

        <path
          d="M380 255 Q410 270 430 255"
          fill="none"
          stroke="#00B7FF"
          strokeWidth="12"
          strokeLinecap="round"
        />
        <path
          d="M385 290 Q420 310 445 290"
          fill="none"
          stroke="#00B7FF"
          strokeWidth="12"
          strokeLinecap="round"
        />
      </svg>
    );
  },
);

MaximizeIcon.displayName = "MaximizeIcon";

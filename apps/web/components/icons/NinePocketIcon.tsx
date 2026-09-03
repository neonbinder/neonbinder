import React from "react";

export interface NinePocketIconProps
  extends React.SVGAttributes<SVGSVGElement> {
  size?: number;
}

/**
 * A 9-pocket binder page: 3 × 3 pockets, the center one holding a card —
 * the landing-grid icon for the placeholder-sheets feature (NEO-207).
 */
export const NinePocketIcon = React.forwardRef<
  SVGSVGElement,
  NinePocketIconProps
>(({ size = 100, className = "", ...props }, ref) => {
  const pocketColor = (row: number, col: number) =>
    row === 1 && col === 1 ? "#00D558" : "#00C2FF";

  return (
    <svg
      ref={ref}
      viewBox="0 0 200 200"
      width={size}
      height={size}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      {...props}
    >
      {[0, 1, 2].map((row) =>
        [0, 1, 2].map((col) => (
          <rect
            key={`${row}-${col}`}
            x={14 + col * 62}
            y={14 + row * 62}
            width="48"
            height="54"
            rx="6"
            stroke={pocketColor(row, col)}
            strokeWidth="6"
            opacity={row === 1 && col === 1 ? 1 : 0.55}
          />
        )),
      )}
      {/* The card sliding into the center pocket */}
      <rect
        x="86"
        y="86"
        width="28"
        height="34"
        rx="3"
        stroke="#00D558"
        strokeWidth="4"
      />
      <circle cx="100" cy="98" r="5" stroke="#00D558" strokeWidth="3" />
      <line
        x1="92"
        y1="112"
        x2="108"
        y2="112"
        stroke="#00D558"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
});

NinePocketIcon.displayName = "NinePocketIcon";

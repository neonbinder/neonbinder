import type { FinderPatternProps } from "./types";

/**
 * Default QR finder pattern: concentric rounded rectangles.
 * Dark outer border → white ring → dark center dot.
 */
export function DefaultFinderPattern({
  x,
  y,
  size,
  color = "#000000",
}: FinderPatternProps) {
  const unit = size / 7;
  const r = unit * 0.6; // corner radius

  return (
    <g>
      {/* Outer dark border (7×7) */}
      <rect x={x} y={y} width={size} height={size} rx={r} fill={color} />
      {/* White ring (5×5 centered) */}
      <rect
        x={x + unit}
        y={y + unit}
        width={unit * 5}
        height={unit * 5}
        rx={r * 0.7}
        fill="#FFFFFF"
      />
      {/* Inner dark center (3×3 centered) */}
      <rect
        x={x + unit * 2}
        y={y + unit * 2}
        width={unit * 3}
        height={unit * 3}
        rx={r * 0.5}
        fill={color}
      />
    </g>
  );
}

/**
 * Rounded rect path with individual corner radii.
 * Allows making some corners rounder and others sharper.
 */
function varRadiusRectPath(
  x: number,
  y: number,
  w: number,
  h: number,
  rtl: number,
  rtr: number,
  rbr: number,
  rbl: number,
): string {
  return [
    `M${x + rtl},${y}`,
    `L${x + w - rtr},${y}`,
    `A${rtr} ${rtr} 0 0 1 ${x + w},${y + rtr}`,
    `L${x + w},${y + h - rbr}`,
    `A${rbr} ${rbr} 0 0 1 ${x + w - rbr},${y + h}`,
    `L${x + rbl},${y + h}`,
    `A${rbl} ${rbl} 0 0 1 ${x},${y + h - rbl}`,
    `L${x},${y + rtl}`,
    `A${rtl} ${rtl} 0 0 1 ${x + rtl},${y}`,
    "Z",
  ].join(" ");
}

/**
 * Leaf-clover finder pattern.
 *
 * Uses the same 3-layer structure as the default but with:
 * - Variable corner radii: 3 rounder corners + 1 tight corner (bottom-right by default)
 *   to create a subtle leaf/eye shape.
 * - A 4-petal clover drawn OVER the solid dark center so the center's
 *   scanning structure is preserved underneath.
 *
 * The pointed corner faces the QR center via the rotation prop.
 */
export function LeafCloverFinderPattern({
  x,
  y,
  size,
  color = "#000000",
  rotation = 0,
}: FinderPatternProps) {
  const unit = size / 7;
  const cx = x + size / 2;
  const cy = y + size / 2;

  // Corner radii: 3 rounder corners, 1 tight corner (bottom-right = pointed)
  const bigR = unit * 1.3;
  const smallR = unit * 0.15;

  // White ring (5×5 zone)
  const ix = x + unit;
  const iy = y + unit;
  const iw = unit * 5;
  const bigRi = bigR * (5 / 7);
  const smallRi = smallR * (5 / 7);

  // Clover petals
  const petalR = unit * 0.72;
  const petalOffset = unit * 0.55;

  return (
    <g transform={rotation ? `rotate(${rotation} ${cx} ${cy})` : undefined}>
      {/* Outer dark border (7×7) — leaf shape */}
      <path
        d={varRadiusRectPath(x, y, size, size, bigR, bigR, smallR, bigR)}
        fill={color}
      />
      {/* White ring (5×5) — matching leaf shape */}
      <path
        d={varRadiusRectPath(ix, iy, iw, iw, bigRi, bigRi, smallRi, bigRi)}
        fill="#FFFFFF"
      />
      {/* Solid dark center (3×3) — preserves scanning ratio */}
      <rect
        x={x + unit * 2}
        y={y + unit * 2}
        width={unit * 3}
        height={unit * 3}
        rx={unit * 0.3}
        fill={color}
      />
      {/* White clover cutout over the solid center for visual effect */}
      <circle cx={cx} cy={cy} r={petalR * 0.45} fill="#FFFFFF" />
      <circle cx={cx - petalOffset} cy={cy - petalOffset} r={petalR * 0.35} fill="#FFFFFF" />
      <circle cx={cx + petalOffset} cy={cy - petalOffset} r={petalR * 0.35} fill="#FFFFFF" />
      <circle cx={cx - petalOffset} cy={cy + petalOffset} r={petalR * 0.35} fill="#FFFFFF" />
      <circle cx={cx + petalOffset} cy={cy + petalOffset} r={petalR * 0.35} fill="#FFFFFF" />
    </g>
  );
}

/**
 * Binder finder pattern — recreates the NeonBinder logo silhouette.
 *
 * The main binder body fills the standard 7×7 zone (preserving the
 * 1:1:3:1:1 scan ratio). Four binding rings extend left and a C-shaped
 * clasp extends right, both beyond the zone boundary.
 *
 * Each finder rotates so its spine faces outward from the QR center.
 */
export function BinderFinderPattern({
  x,
  y,
  size,
  color = "#000000",
  rotation = 0,
}: FinderPatternProps) {
  const unit = size / 7;
  const cx = x + size / 2;
  const cy = y + size / 2;
  const bodyR = unit * 0.3; // slight corner radius matching the logo

  // ── Binding rings (extend left of body) ──
  const ringExtend = unit * 0.7;
  const ringW = unit * 2.0;
  const ringH = unit * 0.5;
  const ringR = ringH / 2; // capsule ends
  const ringLeft = x - ringExtend;
  const ringYOffsets = [1.05, 2.5, 3.95, 5.4];

  // ── Clasp notch in outer border (right side, centered) ──
  const claspSize = unit * 0.6;
  const claspX = x + size - unit + (unit - claspSize) / 2; // centered in the 1-unit right border
  const claspY = y + size / 2 - claspSize / 2;

  return (
    <g transform={rotation ? `rotate(${rotation} ${cx} ${cy})` : undefined}>
      {/* Main binder body — fills 7×7 zone */}
      <rect x={x} y={y} width={size} height={size} rx={bodyR} fill="#00D558" />

      {/* 4 binding rings — capsules crossing the spine */}
      {ringYOffsets.map((ry, i) => (
        <rect
          key={i}
          x={ringLeft}
          y={y + unit * ry}
          width={ringW}
          height={ringH}
          rx={ringR}
          fill="#00D558"
        />
      ))}

      {/* White ring (5×5 centered) */}
      <rect
        x={x + unit}
        y={y + unit}
        width={unit * 5}
        height={unit * 5}
        fill="#FFFFFF"
      />

      {/* Inner center (3×3) — NeonBinder blue */}
      <rect
        x={x + unit * 2}
        y={y + unit * 2}
        width={unit * 3}
        height={unit * 3}
        fill="#00B7FF"
      />

      {/* Clasp — white square notch in the right border */}
      <rect x={claspX} y={claspY} width={claspSize} height={claspSize} fill="#FFFFFF" />
    </g>
  );
}

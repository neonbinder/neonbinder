export type DotShape = "star" | "circle" | "diamond";

export interface FinderPatternProps {
  /** Top-left x position in SVG units */
  x: number;
  /** Top-left y position in SVG units */
  y: number;
  /** Total size of the finder pattern (7 cells worth) */
  size: number;
  /** Size of a single QR module cell */
  cellSize: number;
  /** Color for the finder pattern */
  color?: string;
  /** Extra rotation in degrees around the pattern center (default 0) */
  rotation?: number;
}

/**
 * A React component that renders a QR code finder pattern.
 *
 * Custom implementations MUST preserve the dark-border / light-ring / dark-center
 * contrast structure — QR scanners rely on this pattern for orientation.
 */
export type FinderPatternRenderer = React.ComponentType<FinderPatternProps>;

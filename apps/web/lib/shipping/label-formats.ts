/**
 * NEO-118 — printable label geometry, as data.
 *
 * There is one format today. It is a constant rather than inline `6in`/`4in`
 * literals in the layout because the sizes that will follow (a PWE-sized
 * indicia label, say) differ only in these numbers — a new entry here plus a
 * picker, not a new layout component.
 *
 * Dimensions are inches because that is the unit CSS `@page size` and the label
 * markup both use, so nothing has to convert and no DPI is assumed anywhere.
 */

export interface LabelFormat {
  id: string;
  /** Shown in the UI. */
  label: string;
  widthIn: number;
  heightIn: number;
  /** Printer-safe inner margin. Thermal printers clip near the edge. */
  paddingIn: number;
}

/**
 * A 4×6 label fed landscape: 6 inches across, 4 inches tall. This is the
 * orientation on a Rollo / Zebra / DYMO 4XL roll, and it is also what you get
 * printing onto a sheet of 4×6 labels.
 */
export const LABEL_4X6_LANDSCAPE: LabelFormat = {
  id: "4x6-landscape",
  label: '4" × 6" (landscape)',
  widthIn: 6,
  heightIn: 4,
  paddingIn: 0.25,
};

export const DEFAULT_LABEL_FORMAT = LABEL_4X6_LANDSCAPE;

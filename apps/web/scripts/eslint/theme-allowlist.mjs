/**
 * NEO-356 — who may still use palette classes (theme/no-raw-palette): only
 * PERMANENT, the things whose colours are fixed by design. Everything else
 * paints with colour roles (app/theme.css, DESIGN.md).
 * Paths are apps/web-relative. Only .ts/.tsx files are linted; stylesheets
 * (app/collection/final/binders/*.css, prototypes/_shared/card-face.css) are
 * outside the rule and keep their fixed colours by design.
 */

/**
 * PERMANENT: fixed colours by design. A path ending in `/**` covers the folder.
 * Every entry says why; adding one needs the same justification.
 */
export const PERMANENT = [
  // Paper. Print documents are black on white whatever the screen mode.
  "lib/print/**",
  "components/modules/ShippingLabel/**",
  "components/modules/PlaceholderSheet/**",
  // A QR code must be dark modules on a light ground to scan.
  "components/modules/QrCode/**",
  // Art: white type on its own pink-to-indigo gradient, the same in both modes.
  "components/primitives/Poster.tsx",
  // The NEO-350 reference prototypes (/collection/1-5): forced dark by
  // ForceDark, never migrated. The modules the shipped demo imports are not
  // covered: see SHARED_PROTOTYPE_FILES.
  "app/collection/prototypes/**",
];

/**
 * Prototype modules the shipped collection demo (/collection,
 * /binder-tracking) imports. They render in both modes, so PERMANENT's
 * prototypes entry does not cover them: the rule checks them like any file.
 * theme-allowlist.test.mjs recomputes this from the imports and fails on drift.
 */
export const SHARED_PROTOTYPE_FILES = [
  "app/collection/prototypes/_shared/CardFace.tsx",
  "app/collection/prototypes/_shared/CopyDetailsForm.tsx",
  "app/collection/prototypes/_shared/catalog.ts",
  "app/collection/prototypes/_shared/collector.ts",
  "app/collection/prototypes/_shared/data.ts",
  "app/collection/prototypes/_shared/search.ts",
  "app/collection/prototypes/_shared/types.ts",
  "app/collection/prototypes/p1/Overlay.tsx",
  "app/collection/prototypes/p1/StaticColumn.tsx",
  "app/collection/prototypes/p1/drill.ts",
  "app/collection/prototypes/p1/notice.tsx",
  "app/collection/prototypes/p1/ui.ts",
  "app/collection/prototypes/p2/Modal.tsx",
  "app/collection/prototypes/p2/hooks.ts",
  "app/collection/prototypes/p3/Chip.tsx",
  "app/collection/prototypes/p3/Dialog.tsx",
  "app/collection/prototypes/p3/classes.ts",
  "app/collection/prototypes/p3/hooks.ts",
];

const SHARED_SET = new Set(SHARED_PROTOTYPE_FILES);

function matches(pattern, rel) {
  return pattern.endsWith("/**") ? rel.startsWith(pattern.slice(0, -2)) : rel === pattern;
}

/** Fixed colours by design (a shared prototype module never is). */
export function isPermanent(rel) {
  if (SHARED_SET.has(rel)) return false;
  return PERMANENT.some((pattern) => matches(pattern, rel));
}

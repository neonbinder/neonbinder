import { useId } from "react";

/**
 * Returns a builder that produces a **stable, document-unique CSS class** for an
 * `<input>` / `<textarea>`, e.g. `mb-field-r7-cardtitle`. Spread it onto the
 * element's `className`. Pass a short `key` to disambiguate multiple fields that
 * live in the same component; omit it for a single-field component.
 *
 * ## Legacy (NEO-39): kept for the primitives, not used by the E2E suite
 * This marker class was built for the retired Maestro web driver, whose
 * `inputText` re-found the focused field by an XPath built from its unique
 * `id`, else its `class`, else its position. Our inputs share identical
 * Tailwind classes and carry no `id`, so keystrokes landed in the FIRST
 * matching field (mobile-dev-inc/maestro#1083, closed "not planned"). A unique
 * class per field made that XPath resolve to the right element.
 *
 * The Playwright suite locates fields by role and accessible name and never
 * reads this class. The hook stays because the primitives and their unit tests
 * still emit and assert it; removing it is a separate cleanup.
 *
 * `useId()` gives a value that is stable across re-renders and unique per
 * component instance (so two instances, or two rows in a list, never collide);
 * the per-field `key` disambiguates fields within one instance.
 */
export function useFieldTestClass(): (key?: string) => string {
  const base = useId().replace(/[^a-z0-9]/gi, "");
  return (key?: string) => {
    const suffix = key
      ? `-${key.replace(/[^a-z0-9]+/g, "-").toLowerCase().replace(/^-+|-+$/g, "")}`
      : "";
    return `mb-field-${base}${suffix}`;
  };
}

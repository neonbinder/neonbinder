import { useId } from "react";

/**
 * Returns a builder that produces a **stable, document-unique CSS class** for an
 * `<input>` / `<textarea>`, e.g. `mb-field-r7-cardtitle`. Spread it onto the
 * element's `className`. Pass a short `key` to disambiguate multiple fields that
 * live in the same component; omit it for a single-field component.
 *
 * ## Why this exists (NEO-39)
 * Maestro's `--platform web` driver implements `inputText` by reading
 * `document.activeElement`, then RE-FINDING that element via
 * `findElement(By.xpath( window.maestro.createXPathFromElement(activeElement) ))`
 * before `sendKeys`. `createXPathFromElement` builds the XPath from a unique
 * `id` if present, else from the element's `class`, else positional index.
 *
 * Our editable inputs have no `id` and frequently share an identical Tailwind
 * `className`, so the generated XPath (`input[@class="…"]`) matches EVERY such
 * input and Selenium types into the FIRST match instead of the field the test
 * tapped — i.e. a metadata edit lands in a feature field, etc. This is the
 * upstream issue mobile-dev-inc/maestro#1083 (closed "not planned"), so the fix
 * has to live on our side.
 *
 * A unique class per field makes that XPath resolve to the exact element, so
 * `inputText` lands where a human tapped. We use a **class** (not an `id`)
 * deliberately: Maestro's hierarchy sets `resource-id = node.id || node.ariaLabel
 * || …`, so adding an `id` would override the aria-label and break every
 * `tapOn id: "<aria-label>"` selector. A class never touches `resource-id`, so
 * selection and accessibility are unaffected.
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

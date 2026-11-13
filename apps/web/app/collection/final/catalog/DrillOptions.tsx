import type { DrillItem } from "../data/types";
import { LOOSE_SETS_LABEL, splitBrandColumn } from "./drill";

/**
 * A drill column's rows as a native select's options. NEO-527 — majors
 * first: in the brand column the brands come first, then the sets listed in
 * place of the brand-unknown row under a "More sets" group. Every other
 * column has no such sets and lists as it always has.
 */
export function DrillOptions({ items }: { items: readonly DrillItem[] }) {
  const { main, more } = splitBrandColumn(items);
  const option = (i: DrillItem) => (
    <option key={i.id} value={i.id}>
      {i.name}
    </option>
  );
  return (
    <>
      {main.map(option)}
      {more.length > 0 && <optgroup label={LOOSE_SETS_LABEL}>{more.map(option)}</optgroup>}
    </>
  );
}

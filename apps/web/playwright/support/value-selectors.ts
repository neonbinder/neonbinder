/**
 * Selectors for Maestro `text:` / `id:` combinations the driver has no single
 * method for (NEO-338 admin batch). Same SELECTOR RULE as maestro.ts: only
 * role / text / label / placeholder / title, never CSS, ids or XPath.
 *
 *  - valueOrText: Maestro `text: X` (+ optional `below:` / `above:`) where X
 *    can be an input's VALUE as well as plain text. maestro.ts keeps these
 *    apart (`m.text` vs `m.value`) and its `below()`/`above()` drop the
 *    geometry when the target is a Relational, so the union lives here.
 *  - idWithText: Maestro `{ id: X, text: Y }` — one element that is both
 *    labelled X and reads Y (value for an input, text otherwise).
 */
import type { Locator } from "@playwright/test";
import { mrx, type Maestro, type Relational, type Sel } from "./maestro";

type Box = { x: number; y: number; width: number; height: number };

function isRelational(sel: Sel): sel is Relational {
  return typeof sel === "object" && sel !== null && (sel as Relational).kind === "relational";
}

async function anchorBox(m: Maestro, sel: Sel): Promise<Box | null> {
  let loc: Locator | null;
  if (isRelational(sel)) loc = await sel.probe();
  else loc = (typeof sel === "string" ? m.text(sel) : sel).first();
  if (!loc) return null;
  if (!(await loc.isVisible().catch(() => false))) return null;
  return loc.boundingBox().catch(() => null);
}

async function candidates(m: Maestro, pattern: string): Promise<Locator[]> {
  const out: Locator[] = [];
  const texts = m.text(pattern);
  const n = await texts.count();
  for (let i = 0; i < n; i++) out.push(texts.nth(i));
  const re = mrx(pattern);
  const p = m.page;
  const fields = p
    .getByRole("textbox")
    .or(p.getByRole("searchbox"))
    .or(p.getByRole("combobox"))
    .or(p.getByRole("spinbutton"))
    .filter({ visible: true });
  const fn = await fields.count();
  for (let i = 0; i < fn; i++) {
    const v = await fields.nth(i).inputValue().catch(() => null);
    if (v !== null && re.test(v)) out.push(fields.nth(i));
  }
  return out;
}

/** Maestro `text: pattern` (text OR input value), optionally `below:` and/or `above:` an anchor. */
export function valueOrText(
  m: Maestro,
  pattern: string,
  rel: { below?: Sel; above?: Sel } = {},
): Relational {
  return {
    kind: "relational",
    description: `text-or-value ${JSON.stringify(pattern)}${rel.below ? " below an anchor" : ""}${
      rel.above ? " above an anchor" : ""
    }`,
    probe: async () => {
      const below = rel.below ? await anchorBox(m, rel.below) : null;
      if (rel.below && !below) return null;
      const above = rel.above ? await anchorBox(m, rel.above) : null;
      if (rel.above && !above) return null;
      let best: { loc: Locator; d: number } | null = null;
      for (const loc of await candidates(m, pattern)) {
        const t = await loc.boundingBox().catch(() => null);
        if (!t) continue;
        let d = 0;
        if (below) {
          if (t.y < below.y + below.height - 1) continue;
          d = t.y - (below.y + below.height);
        }
        if (above && t.y + t.height > above.y + 1) continue;
        if (best === null || d < best.d) best = { loc, d };
      }
      return best ? best.loc : null;
    },
  };
}

/** Maestro `{ id: idPattern, text: textPattern }` — a labelled element that also reads the text. */
export function idWithText(m: Maestro, idPattern: string, textPattern: string): Relational {
  const re = mrx(textPattern);
  return {
    kind: "relational",
    description: `id ${JSON.stringify(idPattern)} reading ${JSON.stringify(textPattern)}`,
    probe: async () => {
      const labelled = m.id(idPattern);
      const n = await labelled.count();
      for (let i = 0; i < n; i++) {
        const el = labelled.nth(i);
        const reads = await el
          .evaluate((node) => {
            const f = node as HTMLInputElement;
            return [f.value, f.placeholder, (node as HTMLElement).innerText, node.textContent]
              .filter((s): s is string => typeof s === "string")
              .map((s) => s.trim());
          })
          .catch(() => [] as string[]);
        if (reads.some((s) => re.test(s))) return el;
      }
      return null;
    },
  };
}

/**
 * Maestro taps a native <select> open and then taps the option text. Playwright
 * cannot click an <option>, so the open-then-pick pair is one selectOption on
 * the first select that offers `option` (Maestro resolved the option tap against
 * the first <select> in the page too). Role/name only, no CSS.
 */
import { mrx, type Maestro } from "../maestro";

export async function pickNativeOption(m: Maestro, option: string): Promise<void> {
  const select = m.page
    .getByRole("combobox")
    .filter({ has: m.page.getByRole("option", { name: mrx(option) }) })
    .first();
  await select.selectOption({ label: option });
}

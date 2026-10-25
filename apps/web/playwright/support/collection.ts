/**
 * The signed-in collector's `/collection` Checklists cascade (group "Sport,
 * year, brand and set"). This is the collector's catalog, a different screen
 * from the admin Set Builder, so the `drillTo*` helpers in `set-builder.ts`
 * do not apply (R3/R9). Used by the `collection/*` specs; one implementation.
 */
import { expect, type Locator, type Page } from "@playwright/test";

/** The cascade and a `drill` that picks one option and waits for its summary card. */
export function collectorCascade(page: Page) {
  const cascade = page.getByRole("group", { name: "Sport, year, brand and set" });
  const drill = async (column: string, option: string, next?: string) => {
    await cascade
      .getByRole("listbox", { name: column })
      .getByRole("option")
      .filter({ has: page.getByText(option, { exact: true }) })
      .click();
    // The picked column collapses to its summary.
    await expect(cascade.getByRole("button", { name: `${column}: ${option}, change` })).toBeVisible();
    if (next) {
      // The columns sit in one row that scrolls sideways; on a phone the next
      // one starts off screen. It must be reachable (and on a desktop, it is).
      const nextList = cascade.getByRole("listbox", { name: next });
      await nextList.scrollIntoViewIfNeeded();
      await expect(nextList).toBeInViewport();
    }
  };
  return { cascade, drill };
}

/** From the Checklists tab to the seed's 2024 Topps Chrome Base checklist; returns its region. */
export async function drillToCollectorBase(page: Page): Promise<Locator> {
  const { drill } = collectorCascade(page);
  await drill("Sports", "Baseball", "Years");
  await drill("Years", "2024", "Brands");
  await drill("Brands", "Topps", "Sets");
  await drill("Sets", "Topps Chrome", "Variant Types");
  await drill("Variant Types", "Base");
  const checklist = page.getByRole("region", { name: "2024 Topps Chrome Base" });
  await expect(checklist.getByRole("heading", { level: 3, name: "2024 Topps Chrome Base" })).toBeVisible();
  return checklist;
}

/**
 * The Base rows that read `#N First Last` (two or more words, one player, no
 * variation), never #300 (the signed-by spec's card). The `Details` button of
 * a card with two or more lines carries the line in its name (a comma), so
 * read the names you need BEFORE writing to any of them.
 */
export function ordinaryBaseRows(checklist: Locator): Locator {
  return checklist.getByRole("button", { name: /^Details for #(?!300 )\S+ [^,/\s]+ [^,/]+$/ });
}

/** `#N First Last` off an ordinary row's own accessible name. */
export async function shortNameOf(row: Locator): Promise<{ short: string; number: string; player: string }> {
  const snapshot = await row.ariaSnapshot();
  const short = /button "Details for ([^"]+)"/.exec(snapshot)?.[1] ?? "";
  const parsed = /^#(\S+) (.+)$/.exec(short);
  expect(parsed, `a Base row named "#N First Last" (read: ${short})`).not.toBeNull();
  return { short, number: parsed![1], player: parsed![2] };
}

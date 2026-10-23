/**
 * NEO-356: what the light and dark themes look like, as a user sees them.
 *
 * A spec proves a mode by what is painted, never by the root attribute: the
 * page colour (the header banner sits on it) and the colour of a heading. The
 * values are the `surface` and `ink` roles of app/theme.css (mirrored in
 * src/theme/tokens.ts); change them together.
 *
 * The suite runs as a dark-OS user (playwright.config.ts pins
 * `colorScheme: "dark"`). Only the theme specs call `page.emulateMedia` or
 * change the saved theme, and each restores what it changed.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export type Look = "light" | "dark";

const LOOKS: Record<Look, { page: string; ink: string }> = {
  dark: { page: "rgb(10, 10, 10)", ink: "rgb(255, 255, 255)" },
  light: { page: "rgb(247, 248, 252)", ink: "rgb(24, 18, 43)" },
};

/** The page is painted in `look`: the colour behind the header banner. */
export async function expectPageLook(page: Page, look: Look): Promise<void> {
  await expect(page.getByRole("banner")).toHaveCSS("background-color", LOOKS[look].page);
}

/** The page colour AND one heading drawn in the primary ink colour are `look`. */
export async function expectLook(page: Page, look: Look, heading: Locator): Promise<void> {
  await expectPageLook(page, look);
  await expect(heading).toHaveCSS("color", LOOKS[look].ink);
}

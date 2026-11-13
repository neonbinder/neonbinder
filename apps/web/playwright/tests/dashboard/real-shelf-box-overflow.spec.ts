// R1: the boxes' shelf (the third) holds as many box ends as fit the screen, and when the
// collector has more, its last place is an outline box saying how many more, a link into My
// Boxes (NEO-464). A desktop shelf fits more box ends than a phone's (the public demo's
// collector has one box, so only a real account can be given enough). The spec makes seven
// boxes, so even with none of the account's other boxes counted both screens overflow: a
// desktop shows five ends and "N more", a phone three and "N more".
//
// R7/R7a: writes only the signed-in user's own rows (`collectionContainers`): seven empty
// boxes, no cards, so nothing of any set. Self-cleaning, and on a failure too: an afterEach
// deletes whatever boxes the body made, through the UI. The names are single tokens minted
// from `env.ATTEMPT_TOKEN` (R-companion), each with its own letter.
import { backToBoxes, createBox, deleteBoxNamed } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const made: string[] = [];

test.afterEach(async ({ context }) => {
  const clean = await context.newPage();
  const failures: unknown[] = [];
  try {
    for (const name of made.splice(0)) {
      try {
        await deleteBoxNamed(clean, name);
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    await clean.close();
  }
  if (failures.length > 0) throw failures[0];
});

test(
  "Dashboard: more boxes than fit a shelf leave an N more box into My Boxes, fewer ends on a phone than a desktop",
  { tag: ["@dashboard"] },
  async ({ page, signIn, env, isMobile }) => {
    const names = ["a", "b", "c", "d", "e", "f", "g"].map((letter) => `Over${env.ATTEMPT_TOKEN}${letter}`);

    await signIn("/inventory?tab=boxes");
    await expect(page.getByRole("list", { name: "Your boxes" })).toBeVisible({ timeout: LAUNCH_GATE });
    for (const name of names) {
      await createBox(page, name);
      made.push(name);
      await backToBoxes(page);
    }

    // --- The dashboard: the third shelf is boxes, and it overflows --------------------------------------
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { level: 1, name: "Welcome back, slugger." })).toBeVisible();
    const boxShelf = page.getByRole("list", { name: /^Shelf \d+, boxes$/ });
    await expect(boxShelf).toBeVisible();
    // A box end is one link, "<name>, box, 0 cards for sale"; the last place is the N more link.
    const ends = boxShelf.getByRole("link", { name: /, box, [\d,]+ cards? for sale$/ });
    const more = boxShelf.getByRole("link", { name: /^\d+ more boxes? on My Boxes$/ });
    await expect(more).toBeVisible();
    // Five ends on a desktop, three on a phone (the last place is the sixth, the fourth).
    const fit = isMobile ? 3 : 5;
    await expect(ends).toHaveCount(fit);
    await expect(boxShelf.getByRole("link")).toHaveCount(fit + 1);
    // Seven boxes at least: what is not on the shelf is at least what is left over.
    const left = Number(/^(\d+) more/.exec(await more.innerText())?.[1]);
    expect(left, "boxes past the shelf").toBeGreaterThanOrEqual(names.length - fit);
    await expectAccessible(page, { label: "Dashboard, the boxes' shelf with more boxes than fit" });

    // --- The N more box leads into My Boxes, where every one of them stands; Back comes home -----------
    await more.click();
    await expect(page).toHaveURL(/\/inventory\?tab=boxes$/);
    const boxes = page.getByRole("list", { name: "Your boxes" });
    for (const name of names) {
      await expect(boxes.getByLabel(new RegExp(`^${name}, box, 0 cards for sale$`))).toBeVisible();
    }
    await page.goBack();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(more).toBeVisible();
  },
);

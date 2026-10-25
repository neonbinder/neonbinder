// NEO-364 (R1): quick quantity entry. On the inventory's Checklists every card
// row is a number field: how many raw copies of the card sit in the "Adding to"
// box (Unsorted unless the collector picks another). Type 2, Tab, type 3, Tab and
// the box holds 5, each field writing as it is left, with the row Details one
// arrow key away and never a Tab stop. Lowering a count pulls copies out (down to
// 0), the status line says what changed with an Undo, and the box picked sticks
// across a reload (the URL's `box=`) and across tabs. Ctrl/Cmd+Z in an untouched
// field takes the last count back, as the status line's Undo does.
//
// A phone's number pad has no Tab: its "Next" key sends Enter, which commits the
// field and moves to the next row's. So the spec presses Tab on a desktop and
// Enter on the phone project (GUIDE "Desktop and mobile": branch on `isMobile`),
// and both end in the same hard asserts. The fields declare that keypad
// (`inputmode="numeric"`, `enterkeyhint="next"`) on both projects.
//
// Hard line: the numbers are BOX copies. The spine on My Boxes is the proof, and
// it is read before and after, as deltas.
//
// R7/R7a: writes only the signed-in user's own rows (`collectionContainers`,
// `collectionCopies`; the bootstrap reset clears the account) on the first two
// rows of the seed's 2024 Topps Chrome Base, registered in SET-REGISTRY.md. It
// never writes the set, its cards, players or teams. Self-cleaning: every count
// is typed back to 0 and the minted box is deleted through the UI.
//
// Minted names are single tokens from `env.ATTEMPT_TOKEN`.
import {
  backToBoxes,
  cardsWord,
  countOf,
  createBox,
  deleteOpenBox,
  drillToCollectorBase,
  inventoryTabs,
  nameOf,
  quantityField,
} from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Inventory Checklists: type a quantity, Tab on, and the box takes it; lower, Undo, pick another box",
  { tag: ["@smoke", "@collection"] },
  async ({ page, signIn, env, isMobile }) => {
    const boxName = `Qty${env.ATTEMPT_TOKEN}`;
    // The phone's Next key is Enter; a desktop keyboard has Tab.
    const advance = isMobile ? "Enter" : "Tab";
    const said = (text: string) => page.getByRole("status").filter({ hasText: text });

    // --- My Boxes first: the numbers to measure against, and a box to pick later ---
    await signIn("/inventory?tab=boxes");
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
    const tabs = inventoryTabs(page);
    await expect(tabs.getByRole("link", { name: "My Boxes", exact: true })).toHaveAttribute("aria-current", "page");
    const boxes = page.getByRole("list", { name: "Your boxes" });
    const unsortedRe = /^Unsorted, box, ([\d,]+) cards? for sale$/;
    const unsortedBase = await countOf(boxes.getByRole("button", { name: unsortedRe }), unsortedRe);
    const unsorted = (cards: number) =>
      boxes.getByRole("button", { name: `Unsorted, box, ${cardsWord(cards)} for sale`, exact: true });
    const boxSpine = (cards: number) =>
      boxes.getByRole("button", { name: `${boxName}, box, ${cardsWord(cards)} for sale`, exact: true });
    await createBox(page, boxName);
    await backToBoxes(page);
    await expect(boxSpine(0)).toBeVisible();

    // --- Checklists: "Adding to" reads Unsorted; drill to Base ---------------------
    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    const adding = page.getByRole("combobox", { name: "Adding to" });
    await expect(adding).toBeVisible();
    await expect(adding.getByRole("option", { selected: true })).toHaveText("Unsorted");
    // Unsorted stands first among the boxes, and the minted box is offered.
    await expect(adding.getByRole("option").first()).toHaveText("Unsorted");
    await expect(adding.getByRole("option", { name: boxName, exact: true })).toBeAttached();
    const checklist = await drillToCollectorBase(page);
    const unsortedList = checklist.getByRole("list", { name: "Quantities in Unsorted" });
    await expect(unsortedList.getByRole("textbox").nth(2)).toBeVisible();
    // The first two rows of the checklist, whatever the seed makes them.
    const shortOf = async (n: number) => {
      const name = await nameOf(unsortedList.getByRole("textbox").nth(n));
      const m = /^Quantity of (.+) in Unsorted$/.exec(name);
      expect(m, `a quantity field named "Quantity of <card> in Unsorted" (read: ${name})`).not.toBeNull();
      return m![1];
    };
    const a = await shortOf(0);
    const b = await shortOf(1);
    expect(a, "two different cards").not.toBe(b);
    const fieldA = quantityField(unsortedList, a, "Unsorted");
    const fieldB = quantityField(unsortedList, b, "Unsorted");
    const fieldC = unsortedList.getByRole("textbox").nth(2);
    const detailsA = checklist.getByRole("button", { name: `Details for ${a}`, exact: true });
    await expect(fieldA).toHaveValue("0");
    await expect(fieldB).toHaveValue("0");
    // The number pad a phone shows, and the Next key on it.
    await expect(fieldA).toHaveAttribute("inputmode", "numeric");
    await expect(fieldA).toHaveAttribute("enterkeyhint", "next");
    await expectAccessible(page, { label: "Inventory Checklists, quantity rows" });

    // --- The row keyboard: the field is the only stop; → reaches Details -------------
    await fieldA.focus();
    await page.keyboard.press("ArrowRight");
    await expect(detailsA).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(fieldA).toBeFocused();

    // --- Type 2, Tab, type 3, Tab: two fields, one pass -----------------------------
    await fieldA.fill("2");
    await page.keyboard.press(advance);
    // Past A's field the keyboard lands on the next row's field, not on A's Details.
    await expect(fieldB).toBeFocused();
    await fieldB.fill("3");
    await page.keyboard.press(advance);
    await expect(fieldC).toBeFocused();
    // A row says Saved beside its field once its write has landed (`has` takes a locator
    // of its own, relative to the row, not one chained from the list).
    const rowOf = (short: string) =>
      unsortedList
        .getByRole("listitem")
        .filter({ has: page.getByRole("textbox", { name: `Quantity of ${short} in Unsorted`, exact: true }) });
    await expect(rowOf(a).getByText("Saved")).toBeVisible();
    await expect(rowOf(b).getByText("Saved")).toBeVisible();
    await expect(said(`Boxed 3 more ${b}. 3 in Unsorted.`)).toBeVisible();
    await expect(fieldA).toHaveValue("2");
    await expect(fieldB).toHaveValue("3");

    // --- My Boxes counts five more in Unsorted; Back returns to the typed numbers ---
    await tabs.getByRole("link", { name: "My Boxes", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=boxes/);
    await expect(unsorted(unsortedBase + 5)).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    await expect(fieldA).toHaveValue("2");
    await expect(fieldB).toHaveValue("3");

    // --- Lower: 2 to 1, then 1 to 0 pulls copies out; Undo puts the last back -------
    await fieldA.fill("1");
    await page.keyboard.press(advance);
    await expect(said(`Pulled 1 ${a} from Unsorted. 1 left.`)).toBeVisible();
    await expect(fieldA).toHaveValue("1");
    // Ctrl/Cmd+Z in an untouched field (the keyboard is on B's now) takes the last count back.
    await expect(fieldB).toBeFocused();
    await page.keyboard.press("ControlOrMeta+Z");
    await expect(said("Undone.")).toBeVisible();
    await expect(fieldA).toHaveValue("2");
    await fieldA.fill("1");
    await page.keyboard.press(advance);
    await expect(said(`Pulled 1 ${a} from Unsorted. 1 left.`)).toBeVisible();
    await expect(fieldA).toHaveValue("1");
    await fieldA.fill("0");
    await page.keyboard.press(advance);
    await expect(said(`Pulled 1 ${a} from Unsorted. 0 left.`)).toBeVisible();
    await expect(fieldA).toHaveValue("0");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(said("Undone.")).toBeVisible();
    await expect(fieldA).toHaveValue("1");

    // --- Pick the minted box: the fields now count THAT box -------------------------
    await adding.selectOption({ label: boxName });
    await expect(adding.getByRole("option", { selected: true })).toHaveText(boxName);
    await expect(page).toHaveURL(/[?&]box=[^&]+/);
    const boxList = checklist.getByRole("list", { name: `Quantities in ${boxName}` });
    const boxA = quantityField(boxList, a, boxName);
    await expect(boxA).toHaveValue("0");
    const show = checklist.getByRole("radiogroup", { name: "Show" });
    await expect(show.getByRole("radio", { name: `In ${boxName}`, exact: true })).toBeVisible();
    await expect(show.getByRole("radio", { name: `Not in ${boxName}`, exact: true })).toBeVisible();
    await boxA.fill("4");
    await page.keyboard.press(advance);
    await expect(said(`Boxed 4 more ${a}. 4 in ${boxName}.`)).toBeVisible();
    await expect(boxA).toHaveValue("4");
    // "In <box>" narrows the list to what the box holds.
    await show.getByRole("radio", { name: `In ${boxName}`, exact: true }).click();
    await expect(boxList.getByRole("listitem")).toHaveCount(1);
    await show.getByRole("radio", { name: "All", exact: true }).click();
    await expect(boxList.getByRole("listitem").nth(2)).toBeVisible();
    await expectAccessible(page, { label: "Inventory Checklists, adding to a box" });

    // --- The pick sticks: a reload keeps it (URL box=), and so do other tabs --------
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible();
    await expect(page).toHaveURL(/[?&]box=[^&]+/);
    await expect(adding.getByRole("option", { selected: true })).toHaveText(boxName);
    await expect(quantityField(checklist, a, boxName)).toHaveValue("4");
    await tabs.getByRole("link", { name: "My Boxes", exact: true }).click();
    await expect(boxSpine(4)).toBeVisible();
    await expect(unsorted(unsortedBase + 4)).toBeVisible();
    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    // No `box=` rides a tab change: the device remembers the last pick instead.
    await expect(adding.getByRole("option", { selected: true })).toHaveText(boxName);

    // --- Cleanup: type everything back to 0, delete the box (R7) ---------------------
    await quantityField(checklist, a, boxName).fill("0");
    await page.keyboard.press(advance);
    await expect(said(`Pulled 4 ${a} from ${boxName}. 0 left.`)).toBeVisible();
    await adding.selectOption({ label: "Unsorted" });
    await expect(adding.getByRole("option", { selected: true })).toHaveText("Unsorted");
    await fieldA.fill("0");
    await page.keyboard.press(advance);
    await expect(said(`Pulled 1 ${a} from Unsorted. 0 left.`)).toBeVisible();
    await fieldB.fill("0");
    await page.keyboard.press(advance);
    await expect(said(`Pulled 3 ${b} from Unsorted. 0 left.`)).toBeVisible();

    await tabs.getByRole("link", { name: "My Boxes", exact: true }).click();
    await expect(unsorted(unsortedBase)).toBeVisible();
    await expect(boxSpine(0)).toBeVisible();
    await boxSpine(0).click();
    await expect(page.getByRole("heading", { level: 2, name: boxName, exact: true })).toBeVisible();
    await deleteOpenBox(page, boxName);
    await expect(page.getByRole("status").filter({ hasText: `${boxName} is off the shelf.` })).toBeVisible();
    await expect(boxes.getByRole("button", { name: new RegExp(`^${boxName},`) })).toHaveCount(0);
    await expect(unsorted(unsortedBase)).toBeVisible();
  },
);

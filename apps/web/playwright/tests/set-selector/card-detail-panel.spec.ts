// Origin: .maestro/flows/set-selector/card-detail-panel.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { addCustomCard } from "../../support/cards";

test(
  "Card detail drawer — every field autosaves as you leave it (no Save button)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const id = env.ATTEMPT_ID;
    const cardNumber = `888-${id}`;
    const renamed = `Renamed Detail Player ${id}`;
    const editCard = page.getByRole("button", { name: new RegExp(`^Edit card ${cardNumber}(, .*)?$`) });
    const deleteCard = page.getByRole("button", { name: new RegExp(`^Delete card ${cardNumber}(, .*)?$`) });
    const confirmDelete = page.getByRole("button", {
      name: new RegExp(`^Confirm delete card ${cardNumber}(, .*)?$`),
    });
    const cardName = page.getByRole("textbox", { name: "Card name", exact: true });
    const done = page.getByRole("button", { name: "Done editing card" });

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await addCustomCard(page, env, {
      set: `cd-${env.WORKER_INDEX}`,
      cardNumber,
      playerName: `Detail Panel Test ${id}`,
    });

    await editCard.click();
    await expect(cardName).toBeVisible();
    await expect(page.getByText(new RegExp(`Card #${cardNumber}`))).toBeVisible();
    await expect(page.getByText("Changes save as you leave each field.")).toBeVisible();
    await expect(done).toBeVisible();
    await expectAccessible(page, { within: page.getByRole("dialog"), label: "Card detail drawer" });

    // Each field saves on Enter / blur, and says so.
    await cardName.fill(renamed);
    await cardName.press("Enter");
    await expect(page.getByText(/Saved Card name/)).toBeVisible();

    const title = page.getByRole("textbox", { name: "Card title", exact: true });
    await title.fill(`T${id}`);
    await title.press("Enter");
    await expect(page.getByText(/Saved Card title/)).toBeVisible();

    const description = page.getByRole("textbox", { name: "Card description", exact: true });
    await description.fill(`NEO-25 description body for ${id}`);
    await cardName.click(); // leaving the field saves it
    await expect(page.getByText(/Saved Card description/)).toBeVisible();

    await page.getByRole("button", { name: "Toggle RC" }).click();
    await expect(page.getByText(/Saved Attributes/)).toBeVisible();

    const printRun = page.getByRole("spinbutton", { name: "Print run", exact: true });
    await printRun.fill("99");
    await printRun.press("Enter");
    await expect(page.getByText(/Saved Print run/)).toBeVisible();

    await done.click();
    await expect(cardName).toBeHidden();
    await expect(page.getByText(/\/99/)).toBeVisible();

    // Reopen: everything was persisted.
    await editCard.click();
    await expect(cardName).toBeVisible();
    await expect(cardName).toHaveValue(renamed);
    await expect(title).toHaveValue(`T${id}`);
    await expect(description).toHaveValue(`NEO-25 description body for ${id}`);
    await expect(page.getByRole("button", { name: "Toggle RC" })).toBeVisible();
    await expect(printRun).toHaveValue("99");

    // Clearing a field saves the empty value.
    await printRun.clear();
    await expect(printRun).toHaveAttribute("placeholder", "e.g. 99");
    await printRun.press("Enter");
    await expect(page.getByText(/Cleared Print run/)).toBeVisible();
    await done.click();
    await expect(cardName).toBeHidden();
    await expect(page.getByText(renamed).first()).toBeVisible();
    await expect(page.getByText(/\/99/)).toBeHidden();

    await deleteCard.click();
    await expect(page.getByText("Confirm?")).toBeVisible();
    await confirmDelete.click();
    await expect(page.getByText(renamed)).toBeHidden();
  },
);

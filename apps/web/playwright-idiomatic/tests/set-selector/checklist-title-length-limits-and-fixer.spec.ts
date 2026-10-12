// Spec: .maestro/flows/set-selector/checklist-title-length-limits-and-fixer.yaml
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { drillToCustom } from "../../support/batch3/custom";

test(
  "Listing length limits — an over-long card title is refused, and an over-long variation is walked to a fix",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const id = env.ATTEMPT_ID;
    const num = `101-${id}`;
    const team = `TLF${env.ATTEMPT_TOKEN}`;
    const set = `tlf-${env.WORKER_INDEX}-${id}`;
    const edit = page.getByRole("button", { name: new RegExp(`^Edit card ${num}(, .*)?$`) });
    const cardName = page.getByRole("textbox", { name: "Card name" });
    const cardTitle = page.getByRole("textbox", { name: "Card title", exact: true });
    const attentionBadge = page.getByRole("img", {
      name: new RegExp(`^Card ${num}(, .*)? needs attention: variation text is over the 65-character limit$`),
    });
    const generated = new RegExp(`^2024 Topps .*#${num} ${team} Baseball$`);

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // A hand-made Base insert under the real Baseball / 2024 / Topps.
    await drillToCustom(page, {
      sport: "Baseball",
      year: "2024",
      manufacturer: "Topps",
      set,
      variantType: "Insert",
      variant: "Base",
    });

    // ── A card with a brand-new team, so the generated title has a team in it ──
    await page.getByRole("button", { name: "Open add card form" }).click();
    await page.getByRole("textbox", { name: "Card number" }).fill(num);
    await cardName.fill(`Title Cap ${id}`);
    await page.getByRole("button", { name: "Add team" }).click();
    const teamSearch = page.getByRole("textbox", { name: "Search teams" });
    await teamSearch.fill(team);
    await teamSearch.press("Enter");
    const newTeam = page.getByRole("dialog", { name: `New team: ${team}` });
    await expect(newTeam).toBeVisible();
    await expect(newTeam.getByRole("textbox", { name: "New team name" })).toHaveValue(team);
    await newTeam.getByRole("button", { name: `Create team ${team}` }).click();
    await expect(page.getByRole("button", { name: `Remove team ${team}` })).toBeVisible();
    // Focusing another field closes the team search.
    await cardName.click();
    await expect(page.getByRole("textbox", { name: "Search teams" })).toBeHidden();
    await page.getByRole("button", { name: "Submit new card" }).click();

    await edit.click();
    await expect(cardName).toBeVisible();

    // ── An over-long listing title is refused ──
    await expect(cardTitle).toBeVisible();
    await cardTitle.fill("NEO101PAD-EXTREMELY-LONG-LISTING-TITLE-SUFFIX-THAT-BLOWS-PAST-THE-EIGHTY-CHARACTER-CAP");
    await expect(page.getByText(/over the 80-character limit/)).toBeVisible();
    const shorten = page.getByText(/Shorten it before saving/);
    await expect(shorten).toBeVisible();

    await cardTitle.press("Enter");
    await expect(page.getByText(/Saved Card title/)).toBeHidden();
    await expect(cardName).toBeVisible();
    await expect(cardTitle).toHaveValue(/NEO101PAD/);
    await expect(shorten).toBeVisible();

    // Regenerating asks twice before it replaces typed text, then rebuilds it.
    const regenerate = page.getByRole("button", { name: "Regenerate card title" });
    await regenerate.click();
    await expect(page.getByText(/Regenerate again to replace the title you have typed/)).toBeVisible();
    await regenerate.click();
    await expect(cardTitle).not.toHaveValue(/NEO101PAD/);
    await expect(cardTitle).toHaveValue(generated);
    await expect(shorten).toBeHidden();

    // ── An over-long variation is saved, but flagged ──
    const variation = page.getByRole("textbox", { name: "Card variation", exact: true });
    await variation.fill("Gold Refractor Image Variation Wearing Sunglasses Holding Bat In Dugout");
    await expect(page.getByText(/a marketplace that caps this field will reject the value/)).toBeVisible();
    await variation.press("Enter");
    await expect(page.getByText(/Saved Variation/)).toBeVisible();
    await page.getByRole("button", { name: "Done editing card" }).click();
    await expect(cardName).toBeHidden();

    // The row carries an attention badge, and the checklist counts it.
    await expect(attentionBadge).toBeVisible();
    await expect(page.getByText("1 need attention")).toBeVisible();

    // ── Walk it to a fix ──
    await page.getByRole("button", { name: /^Fix cards needing attention one at a time/ }).click();
    const fixer = page.getByRole("dialog", { name: "Cards Needing Attention" });
    await expect(fixer).toBeVisible();
    await expect(fixer.getByRole("button", { name: `Skip card ${num} for now` })).toBeVisible();
    await expect(fixer.getByText(/1 card needs attention .{1,3} 0 fixed/)).toBeVisible();
    await expect(fixer.getByText("variation text is over the 65-character limit")).toBeVisible();
    await expect(fixer.getByRole("textbox", { name: `Card title for #${num}` })).toHaveValue(generated);

    await expect(fixer.getByRole("button", { name: /Save \(Enter\)/ })).toBeVisible();
    await fixer.getByRole("textbox", { name: `Card variation for #${num}` }).clear();
    await expect(fixer.getByText(/a marketplace that caps this field will reject the value/)).toBeHidden();
    await fixer.getByRole("button", { name: /Save \(Enter\)/ }).click();

    await expect(fixer.getByText(/All clear.*nothing on this checklist needs attention/)).toBeVisible();
    await expect(fixer.getByText(/0 cards need attention .{1,3} 1 fixed/)).toBeVisible();
    await fixer.getByRole("button", { name: /Done \(Esc\)/ }).click();
    await expect(fixer).toBeHidden();

    await expect(attentionBadge).toBeHidden();
    await expect(page.getByRole("button", { name: /^Fix cards needing attention one at a time/ })).toBeHidden();
    await expect(page.getByText(`#${num}`, { exact: true })).toBeVisible();
  },
);

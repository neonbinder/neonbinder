// Origin: .maestro/flows/set-selector/checklist-title-length-limits-and-fixer.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, drillToCustom } from "../../support/set-builder";

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
    // The row's mark, by its full list of reasons.
    const markFor = (reasons: string) =>
      page.getByRole("img", { name: new RegExp(`^Card ${num}(, .*)? needs attention: ${reasons}$`) });
    const attentionBadge = markFor("variation text is over the 65-character limit");
    const drawer = page.getByRole("dialog", { name: /^Card #/ });
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
    await cardName.fill(`TitleCap${env.ATTEMPT_TOKEN}`);
    await page.getByRole("button", { name: "Add team" }).click();
    const teamSearch = page.getByRole("textbox", { name: "Search teams" });
    await teamSearch.fill(team);
    await teamSearch.press("Enter");
    const newTeam = page.getByRole("dialog", { name: `New team: ${team}` });
    await expect(newTeam).toBeVisible();
    await expect(newTeam.getByRole("textbox", { name: "New team name" })).toHaveValue(team);
    await expectAccessible(page, { within: newTeam, label: "New team dialog" });
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
    await expectAccessible(page, { within: drawer, label: "Card detail drawer, over-long title refused" });

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
    await expectAccessible(page, { within: drawer, label: "Card detail drawer, over-long variation warned" });
    await variation.press("Enter");
    await expect(page.getByText(/Saved Variation/)).toBeVisible();
    await page.getByRole("button", { name: "Done editing card" }).click();
    await expect(cardName).toBeHidden();

    // The row carries an attention badge, and the checklist counts it. NEO-339:
    // the card links no player (none was picked), so its mark says that first.
    const playerAndVariation = markFor("no player on this card yet; variation text is over the 65-character limit");
    await expect(playerAndVariation).toBeVisible();
    // The header's amber pill (NEO-335): singular for one card, and its visible
    // text is its accessible name, so the exact name is the exact count.
    const pill = page.getByRole("button", { name: "1 needs you", exact: true });
    await expect(pill).toBeVisible();
    await expectAccessible(page, { label: "Checklist with an attention badge for an over-long variation" });

    // ── Walk it to a fix: opened by hand from the pill (the walker never opens itself) ──
    await pill.click();
    const fixer = page.getByRole("dialog", { name: "Tidy up this set" });
    await expect(fixer).toBeVisible();
    // The walker and the wizard share title and counter; its own Skip control
    // says which this is, and the subtitle names the question.
    await expect(fixer.getByRole("button", { name: `Skip for now, card ${num}` })).toBeVisible();
    await expect(fixer.getByText("Step 1 of 1", { exact: true })).toBeVisible();

    // NEO-339: the player is asked first. This card shows nobody, so the answer
    // is "No player on this card", recorded on the card.
    await expect(fixer.getByText("Cards with no player", { exact: true })).toBeVisible();
    await expect(fixer.getByText(/^No player is linked to this card yet\./)).toBeVisible();
    await expectAccessible(page, { within: fixer, label: "Attention walker, card with no player" });
    await fixer.getByRole("button", { name: "No player on this card", exact: true }).click();

    // The same card comes straight back for its variation: the sitting's second
    // question, so the counter reads 2 of 2.
    await expect(fixer.getByText("Card titles", { exact: true })).toBeVisible();
    await expect(fixer.getByText("Step 2 of 2", { exact: true })).toBeVisible();
    await expect(fixer.getByRole("button", { name: `Skip for now, card ${num}` })).toBeVisible();
    await expect(fixer.getByText("variation text is over the 65-character limit")).toBeVisible();
    await expect(fixer.getByRole("textbox", { name: `Card title for #${num}` })).toHaveValue(generated);
    await expectAccessible(page, { within: fixer, label: "Attention walker, over-long variation" });

    await expect(fixer.getByRole("button", { name: /Save \(Enter\)/ })).toBeVisible();
    await fixer.getByRole("textbox", { name: `Card variation for #${num}` }).clear();
    await expect(fixer.getByText(/a marketplace that caps this field will reject the value/)).toBeHidden();
    await fixer.getByRole("button", { name: /Save \(Enter\)/ }).click();

    await expect(fixer.getByText(/All clear.*nothing on this checklist needs attention/)).toBeVisible();
    // No "fixed" count any more (NEO-335 Phase 2): the counter holds y of y, and
    // that the save WROTE is proved on the grid below, where the badge is gone.
    await expect(fixer.getByText("Step 2 of 2", { exact: true })).toBeVisible();
    await expectAccessible(page, { within: fixer, label: "Attention walker, all clear" });
    await fixer.getByRole("button", { name: /Done \(Esc\)/ }).click();
    await expect(fixer).toBeHidden();

    // Both answers stood: no mark of either kind, and nothing left to count.
    await expect(attentionBadge).toBeHidden();
    await expect(playerAndVariation).toBeHidden();
    await expect(page.getByRole("img", { name: new RegExp(`^Card ${num}(, .*)? needs attention: `) })).toBeHidden();
    await expect(page.getByRole("button", { name: /^[0-9]+ needs? you$/ })).toBeHidden();
    await expect(page.getByText(`#${num}`, { exact: true })).toBeVisible();
  },
);

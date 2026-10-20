// NEO-339 (R1): the card form's player picker "+ Create" means a NEW player. A name that
// already answers to someone on file is refused with a sentence naming the player on file
// and a "Use <player>" button, never silently linked, and one press on that button links
// the player on file.
//
// The route to a refusal that is reachable by hand: the picker hides "Create player <x>"
// when a player's PRIMARY name matches, but a player on file under that name as an ALIAS
// (NEO-254: "cards from different years read differently for one person") leaves it on
// offer, and the server then finds the alias holder and refuses. So the fixture is a
// player added through /admin/players with an alias, and the typed name is that alias.
//
// FIXTURE (R7a): the player `RfP<token>` with the alias `RfA<token>` (minted, Baseball,
// never deleted: no affordance deletes a player). The set `ppx-<worker>` is a hand-made
// Baseball > 2024 > Topps > Insert > Base set that only gives the card form a Baseball
// picker. WRITES NO CARD: the form's chips are local state and the form is cancelled.
// Registered in SET-REGISTRY.md (`ppx-`, `RfP`, `RfA`).
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { addPlayerByHand } from "../../support/players";
import { drillToCustom } from "../../support/set-builder";

test(
  "Player picker — \"+ Create\" on a name already on file is refused, and \"Use\" links the player on file (NEO-339)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const holder = `RfP${env.ATTEMPT_TOKEN}`;
    const alias = `RfA${env.ATTEMPT_TOKEN}`;

    // ── The player on file, with an alias, made by hand (the fixture comes from the UI).
    await signIn("/admin/players");
    await expect(page.getByText(/^[\d,]+ players?$/)).toBeVisible({ timeout: LAUNCH_GATE });
    await addPlayerByHand(page, holder, "Baseball", { otherNames: alias });
    // R2 precondition: the alias really is on file, or there is nothing to refuse.
    await expect(page.getByRole("textbox", { name: "Aliases", exact: true })).toHaveValue(alias);

    // ── A Baseball card form, so the picker searches Baseball.
    await drillToCustom(page, {
      sport: "Baseball",
      year: "2024",
      manufacturer: "Topps",
      set: `ppx-${env.WORKER_INDEX}`,
      variantType: "Insert",
      variant: "Base",
    });
    await page.getByRole("button", { name: "Open add card form" }).click();
    await expect(page.getByRole("textbox", { name: "Card name", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Add a player to the new card" }).click();
    await page.getByRole("textbox", { name: "Find a player for the new card" }).fill(alias);
    const create = page.getByRole("option", { name: `Create player ${alias}` });
    await expect(create).toBeVisible();
    await create.click();

    // ── Refused: the sentence, the player on file offered, nothing linked or made.
    const refusal = page
      .getByRole("alert")
      .filter({ hasText: `${alias} is already in the binder. Use that player instead of adding a second one.` });
    await expect(refusal).toBeVisible();
    const use = page.getByRole("button", { name: `Use ${holder}, already on file`, exact: true });
    await expect(use).toBeVisible();
    // Focus lands on the first "Use": taking the player on file is the likely next move.
    await expect(use).toBeFocused();
    // Rides on the positives above (R2): no chip, so the refused create linked nobody.
    await expect(page.getByRole("button", { name: /^Remove player / })).toHaveCount(0);
    await expectAccessible(page, { label: "Player picker, create refused with a Use button" });

    // ── One press links the player on file (not a second one named for the alias).
    await use.click();
    await expect(page.getByRole("button", { name: `Remove player ${holder}` })).toBeVisible();
    await expect(page.getByRole("button", { name: `Remove player ${alias}` })).toHaveCount(0);
    await expect(refusal).toHaveCount(0);

    // Leave without writing a card.
    await page.getByRole("textbox", { name: "Card name", exact: true }).click();
    await page.getByRole("button", { name: "Cancel new card" }).click();
    await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();
  },
);

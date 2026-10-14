// Origin: .maestro/flows/set-selector/card-title-uses-short-name-for-titles.yaml (Maestro suite retired in NEO-341; see git history)
//
// R1 - ONE feature (NEO-335 Phase 2, "follow the old script title builder"): a
// set whose name is too long for an 80-character listing title can be given a
// SHORT NAME FOR TITLES, and a card's regenerated title uses it in place of the
// set name.
//   * A card added under a set whose name cannot fit gets a title whose core
//     was CUT at a word boundary (the set name is one space-free token, so it
//     goes whole) and is stamped `listingTitleTruncated`: the drawer says "Auto
//     title was cut short - rewrite it" under the Card title.
//   * The Attributes panel's "Short name for titles" row (textbox `Value for
//     Short name for titles`) saves `metadata.listingShortName` on the selected
//     row; the title reads the nearest one from that row up to the set.
//   * The drawer's Regenerate rebuilds the title through `assessListingTitle`
//     with the short name in place of the set (and insert) names - the maker
//     stays - and commits it like a hand-typed title.
//
// R2 - what makes it fail if the feature breaks:
//   * The cut is proved twice: the product's own note, and the title holding
//     NONE of the set name while it still ends in the card number.
//   * The short name is read back off the panel's field after its own "Saved
//     Short name for titles" confirmation, so a save that went nowhere fails
//     before Regenerate is pressed.
//   * The regenerated title must be "2024 Topps <short name> #SN1" plus
//     whatever optional tokens fit: a Regenerate that ignored the short name
//     rebuilds the cut title again and fails on the full match.
//
// R3 - no other spec sets a short name on a hand-made set.
// `checklist-title-length-limits-and-fixer` owns the 80-character refusal and
// the variation cap; `inserts-1996-score-one-nb-set-two-bsc-sources` drives the
// wizard's "Shorter set name for titles" field on a real fetch. This spec owns
// the panel row and the drawer's Regenerate.
//
// R7a / data isolation - a PER-ATTEMPT hand-made set `stn-<worker>-<attempt>-
// <long hyphenated tail>` under the REAL Baseball / 2024 / Topps ancestors
// (SET-REGISTRY.md), `Insert` > `Base` beneath it. Hand-made, so no marketplace
// call fires; per attempt, so card `SN1` is the only card in its checklist.
// Nothing is deleted or restored: the set is this attempt's alone.
//
// Fixture arithmetic - why the core MUST be cut on every runner: the core is
// "<year> <maker> <set> [<insert>] #<number>" capped at 80 with " #SN1"
// reserved, so the words before it get 75 characters. "2024 Topps " is 11 and
// the set name is 6 + ATTEMPT_ID + 1 + a 60-character tail with NO spaces, so
// the core is over 75 before the insert name and `cutAtWordBoundary` (spaces
// only) can only cut at the space after "Topps": the title becomes "2024 Topps
// #SN1" plus whatever optional tokens fit (the sport). With the short name
// (`SNT<token>`) the core is short and fits whole. The tail is hyphenated, not
// one long word, so the Sets column's search result can wrap it inside the list.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, drillToCustom } from "../../support/set-builder";

test(
  "Listing titles - a set name too long to fit is cut, and the set's Short name for titles brings it back on Regenerate",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    // ONE alphanumeric token per attempt (GUIDE, "Minted names are single tokens").
    const short = `SNT${env.ATTEMPT_TOKEN}`;
    const set = `stn-${env.WORKER_INDEX}-${env.ATTEMPT_ID}-Commemorative-anniversary-collectors-edition-hologram-series`;
    const edit = page.getByRole("button", { name: /^Edit card SN1(, .*)?$/ });
    const cardTitle = page.getByRole("textbox", { name: "Card title", exact: true });
    const drawer = page.getByRole("dialog", { name: /^Card #/ });
    const doneEditing = page.getByRole("button", { name: "Done editing card" });

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // R9: the drill helper owns the six-level navigation and its waits.
    // Baseball > 2024 > Topps > stn-... > Insert > Base, checklist open.
    await drillToCustom(page, {
      sport: "Baseball",
      year: "2024",
      manufacturer: "Topps",
      set,
      variantType: "Insert",
      variant: "Base",
    });

    // ── STEP 1: ONE card, and its title is cut ──
    // Card number only: no player, no team, so every character of the core is
    // the set's and the arithmetic above holds.
    await page.getByRole("button", { name: "Open add card form" }).click();
    await page.getByRole("textbox", { name: "Card number" }).fill("SN1");
    await page.getByRole("button", { name: "Submit new card" }).click();
    await edit.click();
    // `Card title` is the drawer's alone (the add form has no such field).
    await expect(cardTitle).toBeVisible();

    // The cut, in the product's words (stamped at creation, read off the row)...
    await expect(page.getByText("Auto title was cut short — rewrite it")).toBeVisible();
    // ...and in the title itself: it still ends in the card number (the number
    // is never cut) and holds nothing of the set.
    await expect(cardTitle).toHaveValue(/^2024 Topps #SN1( .*)?$/);
    await expect(cardTitle).not.toHaveValue(/stn-/);
    await expectAccessible(page, { within: drawer, label: "Card detail drawer, auto title cut short" });

    await doneEditing.click();
    await expect(cardTitle).toBeHidden();

    // ── STEP 2: "Short name for titles" on the row the card hangs from ──
    // The selected row is `Base` under the hand-made `Insert` type: an insert
    // level, where the row is shown. The title reads the nearest short name
    // from the card's row up to the set, so this one is the card's.
    const editAttributes = page.getByRole("button", { name: "Edit attributes" });
    const hideAttributes = page.getByRole("button", { name: "Hide attributes" });
    // The panel remembers whether it was left open, so open it only if needed.
    await expect(editAttributes.or(hideAttributes)).toBeVisible();
    if (await editAttributes.isVisible()) await editAttributes.click();
    await expect(hideAttributes).toBeVisible();

    const shortName = page.getByRole("textbox", { name: "Value for Short name for titles" });
    await expect(shortName).toBeVisible();
    await expectAccessible(page, { label: "Set attributes panel, Short name for titles row" });
    await shortName.fill(short);
    // Enter commits a single-line feature field in place (NEO-216).
    await shortName.press("Enter");
    await expect(page.getByText(/Saved Short name for titles/)).toBeVisible();
    // The stored value, read back off the field: the confirmation is
    // optimistic, the field re-hydrates from the row.
    await expect(shortName).toHaveValue(short);

    // ── STEP 3: Regenerate uses the short name ──
    // Into the drawer and one press of Regenerate: nothing was typed into the
    // title, so it does not ask twice. It fetches `previewListingTitle`, puts
    // the rebuilt title in the field and commits it.
    await edit.click();
    await expect(cardTitle).toBeVisible();
    await page.getByRole("button", { name: "Regenerate card title" }).click();
    // THE FEATURE: the maker stays, the short name stands where the set name
    // was, and the core fits now, so nothing before the number is cut. A query
    // and our own write: the default 7 s budget.
    await expect(cardTitle).toHaveValue(new RegExp(`^2024 Topps ${short} #SN1( .*)?$`));
    // Committed through the same per-field path as typing it (useTitlePreview).
    await expect(page.getByText(/Saved Card title/)).toBeVisible();

    await doneEditing.click();
    await expect(cardTitle).toBeHidden();
  },
);

// Origin: .maestro/flows/set-selector/variant-type-title-is-its-kind.yaml (Maestro suite retired in NEO-341; see git history)
//
// R1 - ONE FEATURE (NEO-334, Jason 2026-10-10): a variant type's TITLE is its
// kind. "Base" is the set's Base, "Insert"/"Inserts" an Insert type,
// "Parallel"/"Parallels" a Parallel type; nothing else has a kind, and no flag
// mirrors the title. Every claim below is that one rule seen from a different
// side, on a type the operator titled by hand:
//
//   1. "Inserts" is an Insert type: its column reads "Inserts", and an insert
//      under it opens the Sub-Variants column, which takes a sub-variant.
//   2. Singular and plural are one word: "Insert" beside "Inserts" is refused.
//   3. "Parallel" is a Parallel type: an insert under it opens NO Sub-Variants
//      column, and its checklist holds the build-from-Base stand-in instead of
//      a marketplace fetch.
//   4. Renaming "Inserts" -> "Promos" while sub-variants sit beneath it is
//      refused and the title stands; "Inserts" -> "Insert" is the same kind and
//      goes through, and the sub-variant is still there under its insert.
//   5. An EMPTY type renamed "Base" becomes the Base: terminal (no Variants
//      column), its checklist hangs off the type, and the Base mapping panel
//      answers. A second type renamed "Base" is refused.
//
// R2 - WHY HAND-MADE TYPES: before NEO-334 the kind was a flag that only a sync
// conferred, so a type an operator typed in had no kind at all and every claim
// above would have gone the other way (no Sub-Variants column under "Inserts",
// no terminal "Base"). A regression to a flag, or to substring matching, fails
// here at the claim it breaks.
//
// R7/R7a - ISOLATION: every write lands in ONE per-attempt hand-made set,
// `vtk<token>`, under the real Baseball > 2024 > Topps (SET-REGISTRY.md,
// Custom sets). Hand-made, so neither marketplace side is resolvable at any
// level below it and nothing here waits on BSC or SportLots: every wait is the
// 7 s budget. Per-attempt because the spec renames types and makes a Base: a
// rerun in a set that already holds "Insert", "Base" and the rest would refuse
// the very creates it needs. Nothing is deleted; the set is the debris.
//
// MINTED NAMES are single tokens: `vtk<token>` (set) and `vtkins` / `vtksub` /
// `vtkpar` / `vtkpro` / `vtksec` + token (rows), from env.ATTEMPT_TOKEN, which
// carries the project marker, so desktop and mobile never meet. The kind words
// themselves ("Inserts", "Insert", "Parallel", "Base", "Promos") are the inputs
// under test and are deliberately NOT minted: the per-attempt set scopes them.
//
// R9: the Sport > Year > Manufacturer > Set drill goes through drillToCustom.
// The variant types and rows are created inline from the selected set, because
// the drill helpers cannot drill to two of these types: they wait for
// `${type}s` as the Variants header, which would be "Insertss" for "Inserts",
// and "Base" has no Variants column at all (claim 5).
//
// DRAFT COPY (NEO-245, no copywriter; Jason signs off): two refusal anchors
// below are draft sentences from convex/variantRole.ts and may be reworded at
// sign-off. Each anchors on the clause most likely to survive:
//   - same-word sibling: `"Inserts" is already here, and one word gets one
//     row. Use that one instead.`  -> anchored on "one word gets one row"
//   - second Base: "This set already has a Base."  -> "already has a Base"
// The Insert-with-sub-variants sentence is Jason-approved; it is anchored on
// "only live under an Insert type". A reworded draft fails its step loudly:
// update the anchor, never loosen it to a match-anything pattern.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  setBuilderReady,
  drillToCustom,
  selectOrCreate,
  addCustomEntry,
  columnHeading,
  columnSearch,
  columnOption,
  columnSelection,
  pick,
} from "../../support/set-builder";
import type { Page } from "@playwright/test";

/** A refusal rendered in a role=alert line (the custom form's, or the rename's). */
const refusal = (page: Page, text: RegExp) => page.getByRole("alert").filter({ hasText: text });

/** The attributes panel's header, e.g. "Attributes for Inserts (Variant Type)". */
const panelFor = (page: Page, title: string) =>
  page.getByRole("heading", { name: new RegExp(`^Attributes for ${title} \\(`) });

/** Re-point the Variant Types column at `name`: reopen it from its card, then pick. */
async function repickVariantType(page: Page, from: string, name: string) {
  await columnSelection(page, "Variant Types", from).click();
  await pick(page, "Variant Types", name);
  await expect(columnSelection(page, "Variant Types", name)).toBeVisible();
}

/** Open the attributes panel's rename field for the option it is showing. */
async function openRename(page: Page, current: string) {
  await page.getByRole("button", { name: `Rename ${current}`, exact: true }).click();
  const field = page.getByRole("textbox", { name: `Edit name for ${current}` });
  await expect(field).toBeVisible();
  return field;
}

test(
  "A variant type's title is its kind — Inserts nests sub-variants through a rename, Parallel does not, and one type titled Base is terminal (hand-made set, NEO-334)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const T = env.ATTEMPT_TOKEN;
    const SET = `vtk${T}`;
    const INSERT = `vtkins${T}`;
    const SUB = `vtksub${T}`;
    const PARALLEL_ROW = `vtkpar${T}`;
    const PROMO_TYPE = `vtkpro${T}`;
    const SECOND_TYPE = `vtksec${T}`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── STEP 0: a fresh per-attempt set (R9); its Variant Types column is open and empty.
    await drillToCustom(page, { sport: "Baseball", year: "2024", manufacturer: "Topps", set: SET });
    await expect(columnHeading(page, "Variant Types")).toBeVisible();

    // ── CLAIM 1: "Inserts" IS AN INSERT TYPE ──
    await selectOrCreate(page, "Variant Types", "Inserts", { via: "list", confirm: "required" });
    await expect(columnSelection(page, "Variant Types", "Inserts")).toBeVisible();

    // The column reads "Inserts": its header, its Sync button and its search box
    // all derive from the type's title. Not getByText("Inserts"): the collapsed
    // Variant Types card shows that same word. A title stored as "Insertss" or a
    // generic "Variants" header fails all of these handles.
    await expect(columnHeading(page, "Inserts")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sync Inserts" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add custom Inserts" })).toBeVisible();
    await expect(columnSearch(page, "Inserts")).toBeVisible();

    // ── CLAIM 2: "Insert" BESIDE "Inserts" IS REFUSED (same word) ──
    // EntityColumn says it before any round trip, in the server's own sentence
    // (sameWordSiblingMessage); addCustomSelectorOption refuses it again for a
    // stale tab. No confirm renders, so nothing is written.
    await page.getByRole("button", { name: "Add custom Variant Types" }).click();
    await expect(page.getByText("Add Custom Entry")).toBeVisible();
    const customValue = page.getByPlaceholder("Enter custom value...");
    await customValue.fill("Insert");
    await customValue.press("Enter");
    // DRAFT copy, see the header.
    await expect(refusal(page, /one word gets one row/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Create variant type", exact: true })).toBeHidden();
    await page.getByRole("button", { name: "Cancel new variant type" }).click();
    await expect(page.getByText("Add Custom Entry")).toBeHidden();
    // Positive after the negative: the column is back on its card, and "Inserts" is still the pick.
    await expect(columnSelection(page, "Variant Types", "Inserts")).toBeVisible();

    // ── CLAIM 1, continued: AN INSERT UNDER "Inserts" OPENS THE SUB-VARIANTS COLUMN ──
    await addCustomEntry(page, "Inserts", INSERT, { confirm: "required" });
    await columnOption(page, "Inserts", INSERT).click();
    await expect(columnSelection(page, "Inserts", INSERT)).toBeVisible();

    // The Sub-Variants column is there. Its "+ Custom" is named from its Sync
    // button ("Sync Sub-Variants" -> "Add custom Sub-Variants"), a name no other
    // column carries; the column's own header reads "Parallels", so it is
    // reached by these button names, not by a heading.
    await expect(page.getByRole("button", { name: "Add custom Sub-Variants" })).toBeVisible();
    await addCustomEntry(page, "Sub-Variants", SUB, { confirm: "required" });
    // A refusal here would mean "Inserts" was not read as an Insert type (the
    // server guard assertSubVariantParent reads the parent type's TITLE). The row
    // is in the column.
    const subRow = page.getByRole("option").filter({ has: page.getByText(SUB, { exact: true }) });
    await expect(subRow).toBeVisible();
    await expectAccessible(page, { label: "Sub-Variants column under an Insert type" });

    // ── CLAIM 3: "Parallel" IS A PARALLEL TYPE, SO THERE IS NO SUB-VARIANTS COLUMN ──
    await addCustomEntry(page, "Variant Types", "Parallel", { confirm: "required" });
    await repickVariantType(page, "Inserts", "Parallel");

    await addCustomEntry(page, "Parallels", PARALLEL_ROW, { confirm: "required" });
    // Scoped to the Parallels listbox: the Base-parallels section under the
    // columns lists this row too ("<row> - skipped: not linked to a marketplace
    // yet"), and must not be what gets clicked.
    await columnOption(page, "Parallels", PARALLEL_ROW).click();
    // The pick has rendered: its column is on its card. The Sub-Variants column
    // is decided in the SAME render (it reads the selection and the
    // already-loaded type title), so the negatives below cannot be early.
    await expect(columnSelection(page, "Parallels", PARALLEL_ROW)).toBeVisible();
    // Two handles of column 7, both rendered from its first frame: its
    // "+ Custom" and its search box. Under this type the Variants column is ALSO
    // titled "Parallels", but it is collapsed to the card above, which drops its
    // own search box, so "Search parallels" can only be column 7's.
    await expect(page.getByRole("button", { name: "Add custom Sub-Variants" })).toBeHidden();
    await expect(columnSearch(page, "Parallels")).toBeHidden();
    // Positive, and the Parallel half of the rule: the checklist opened on the
    // insert, and its Sync slot is the build-from-Base stand-in (this set has no
    // Base yet) rather than a marketplace fetch. An Insert type, or a type with
    // no kind, shows "Fetch from Marketplaces" here. `.first()`: any one copy of
    // the stand-in is the proof.
    await expect(page.getByRole("button", { name: "Can't build yet" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Fetch from Marketplaces" })).toBeHidden();

    // ── CLAIM 4: "Inserts" -> "Promos" IS REFUSED WHILE SUB-VARIANTS EXIST;
    // "Inserts" -> "Insert" IS THE SAME KIND AND GOES THROUGH ──
    // Back to "Inserts" with nothing picked beneath it, so the attributes panel
    // (which follows the DEEPEST selection) is on the variant type.
    await repickVariantType(page, "Parallel", "Inserts");
    await expect(panelFor(page, "Inserts")).toBeVisible();

    const field = await openRename(page, "Inserts");
    await field.fill("Promos");
    await field.press("Enter");
    // THE REFUSAL (Jason-approved sentence).
    await expect(refusal(page, /only live under an Insert type/)).toBeVisible();
    // The title stands: the header renders the stored row, not the field.
    await expect(panelFor(page, "Inserts")).toBeVisible();
    await expectAccessible(page, { label: "Rename refused while sub-variants exist" });

    // The field stays open holding "Promos" after a refusal, so replace it.
    await field.fill("Insert");
    await field.press("Enter");
    // Same kind (insert -> insert), so the guard lets it through. The header is
    // the stored row, still the selection.
    await expect(panelFor(page, "Insert")).toBeVisible();

    // THE COLUMN IS STILL THERE: the Variants column still reads "Inserts"
    // ("Insert" + "s"), the insert still opens the Sub-Variants column, and the
    // sub-variant is still under it.
    await expect(page.getByRole("button", { name: "Add custom Inserts" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sync Inserts" })).toBeVisible();
    await columnOption(page, "Inserts", INSERT).click();
    await expect(columnSelection(page, "Inserts", INSERT)).toBeVisible();
    await expect(page.getByRole("button", { name: "Add custom Sub-Variants" })).toBeVisible();
    await expect(subRow).toBeVisible();

    // ── CLAIM 5a: AN EMPTY TYPE RENAMED "Base" BECOMES THE BASE ──
    await addCustomEntry(page, "Variant Types", PROMO_TYPE, { confirm: "required" });
    await repickVariantType(page, "Insert", PROMO_TYPE);
    // R2 precondition: titled with no kind, the type is NOT terminal. It has a
    // Variants column ("vtkpro<token>s"). Claim 5a is that this goes away.
    await expect(page.getByRole("button", { name: `Add custom ${PROMO_TYPE}s` })).toBeVisible();
    await expect(panelFor(page, PROMO_TYPE)).toBeVisible();

    const toBase = await openRename(page, PROMO_TYPE);
    await toBase.fill("Base");
    await toBase.press("Enter");

    // The Base mapping panel answers: it mounts only for a Base type, auto-runs
    // its fetch, and on a set with no marketplace ids both sides are skipped
    // without a round trip.
    await expect(page.getByText(/Nothing to link yet/).first()).toBeVisible();
    // The type's card now reads "Base" ...
    await expect(columnSelection(page, "Variant Types", "Base")).toBeVisible();
    // ... and Base is terminal: no Variants column beside it (positive above,
    // so this negative is read on a live page).
    await expect(page.getByRole("combobox", { name: "Search bases" })).toBeHidden();
    await expect(page.getByRole("button", { name: `Add custom ${PROMO_TYPE}s` })).toBeHidden();
    // The panel header is the stored title, with the static Base tag beside it ...
    await expect(panelFor(page, "Base")).toBeVisible();
    await expect(page.getByTitle("Titled Base, so this type holds the set's base checklist.")).toBeVisible();
    // ... and the checklist hangs off the type itself, with no variant picked.
    await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();
    await expectAccessible(page, { label: "A type titled Base: terminal, with its checklist" });

    // ── CLAIM 5b: A SECOND TYPE RENAMED "Base" IS REFUSED ──
    await addCustomEntry(page, "Variant Types", SECOND_TYPE, { confirm: "required" });
    await repickVariantType(page, "Base", SECOND_TYPE);
    await expect(page.getByRole("button", { name: `Add custom ${SECOND_TYPE}s` })).toBeVisible();
    await expect(panelFor(page, SECOND_TYPE)).toBeVisible();

    const second = await openRename(page, SECOND_TYPE);
    await second.fill("Base");
    await second.press("Enter");
    // DRAFT copy, see the header. The one-Base rule runs before the sibling
    // clash in renameSelectorOption, so this is the sentence, not the same-word one.
    await expect(refusal(page, /already has a Base/)).toBeVisible();
    // The title stands: the spec ends on a positive.
    await expect(panelFor(page, SECOND_TYPE)).toBeVisible();
  },
);

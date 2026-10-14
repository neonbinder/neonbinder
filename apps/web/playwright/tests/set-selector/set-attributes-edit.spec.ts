// Origin: .maestro/flows/set-selector/set-attributes-edit.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-38/39/217: the SetAttributesPanel on the worker's own custom set
// (Baseball > 2024 > Topps > attr-edit-<n>): breadcrumb scope, editing a
// metadata field, CLEARING it ("Cleared", not "Saved"), collapse/expand, and
// the scope following a child pick. The real Topps Chrome set is never touched.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, drillToCustom, selectOrCreate } from "../../support/set-builder";

test(
  "SetAttributesPanel — breadcrumb scope, metadata editing, CLEARING an attribute, collapse/expand, child scope (per-worker custom set)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const set = `attr-edit-${env.WORKER_INDEX}`;
    const child = `BaseAttr-${env.WORKER_INDEX}`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await drillToCustom(page, {
      sport: "Baseball",
      year: "2024",
      manufacturer: "Topps",
      set,
    });

    const panel = page.getByRole("region", { name: "Set attributes panel" });
    const edit = panel.getByRole("button", { name: "Edit attributes" });
    const hide = panel.getByRole("button", { name: "Hide attributes" });

    // The panel defaults expanded at the set level; a prior run may have left
    // it collapsed, so settle into one state and open it if needed.
    async function ensureExpanded() {
      await expect(edit.or(hide)).toBeVisible();
      if (await edit.isVisible()) await edit.click();
      await expect(hide).toBeVisible();
    }
    await ensureExpanded();

    // Breadcrumb: the panel names the node it edits and its ancestry.
    await expect(panel.getByText(new RegExp(`›.*${set}`)).first()).toBeVisible();
    await expectAccessible(page, { label: "Set attributes panel open on a set" });

    // Edit Release Date. A sentinel first, so the stored value really changes
    // whatever an earlier attempt left behind (even a blank record).
    const releaseDate = panel.getByLabel("Value for Release Date");
    const totalCards = panel.getByLabel("Value for Total Cards");
    await expect(releaseDate).toBeVisible();

    await releaseDate.fill("1900-01-01");
    await releaseDate.press("Enter");
    await expect(page.getByText(/Saved Release Date/)).toBeVisible();

    await releaseDate.fill("2024-08-01");
    await releaseDate.press("Enter");
    await expect(page.getByText(/Saved Release Date/)).toBeVisible();
    await expect(releaseDate).toHaveValue("2024-08-01");

    // NEO-217: an empty commit REMOVES the attribute and says "Cleared".
    await releaseDate.fill("");
    await expect(releaseDate).toHaveAttribute("placeholder", "—");
    await releaseDate.press("Enter");
    await expect(page.getByText(/Cleared Release Date/)).toBeVisible();

    // Leave the field so it re-renders from the database: the attribute is
    // gone from the stored record, not merely blanked on screen.
    await totalCards.click();
    await expect(releaseDate).toHaveValue("");
    await expect(releaseDate).toHaveAttribute("placeholder", "—");

    // Collapse by hand, then expand again.
    await hide.click();
    await expect(edit).toBeVisible();
    await expect(hide).toBeHidden();
    await edit.click();
    await expect(hide).toBeVisible();

    // Child scope: create (or reuse) a custom variant type and pick it.
    await selectOrCreate(page, "Variant Types", child, { via: "list" });
    await expect(page.getByRole("heading", { name: `${child}s`, exact: true })).toBeVisible();

    // The panel's breadcrumb followed the pick down to the variant type.
    await ensureExpanded();
    await expect(panel.getByText(new RegExp(`›.*${child}`)).first()).toBeVisible();
    await expectAccessible(page, { label: "Set attributes panel scoped to a variant type" });
  },
);

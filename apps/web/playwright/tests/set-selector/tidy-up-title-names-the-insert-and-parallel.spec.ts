// NEO-497: the tidy-up dialog's title names the checklist it tidies
// ("Tidy up <year> <set> <variant>"; a Base checklist's title leaves "Base"
// out). The Base case is proved wherever a wizard or walker opens on "Base"
// (the fetch-to-wizard helpers, the attention-walker spec); this spec proves
// the two other shapes against the
// product: an INSERT other than Base reads as its own name, and a PARALLEL
// (a sub-variant under an insert) carries its insert's name first, because
// "Gold" alone does not say which insert's Gold.
//
// The set's name is ONE unbroken 100-character token (200 is the set-name
// cap): the worst case for the title's wrap, since it has no space to break
// at. The heading clamps it visually, so beside the exact full name each
// dialog proves the layout on both projects: the heading and the "Step x of y"
// counter are on screen, never overlap, and stay inside the viewport's width.
// NEO-499: at 100 characters the Set Builder's own "Attributes for <set>
// (Set)" heading used to run off a phone's right edge and widen the page, so
// a tap on "Create variant type" landed on the page instead. The drill stops
// at the set once to prove that heading now wraps inside the viewport, clear
// of the panel's toggle, before it goes on to the Insert type. NEO-496: the
// set's panel opens by itself, so the toggle reads "Hide attributes" here.
// (It lives here, not in the attention-walker spec, because a long set name
// also cuts every auto-generated listing title short, which adds a second
// attention reason to each card and would change that spec's counts.)
//
// R7/R7a: every write lands in ONE per-attempt hand-made set, `tuplongset...`,
// under `E2E Test Sport <worker>` > 2026 > Topps (drillToCustomSet;
// SET-REGISTRY.md). Hand-made, so no marketplace side is resolvable beneath it
// and every wait is the 7 s budget. A card with no team is what makes the
// attention pill, the walker's one door; the dialog is read, then dismissed.
// Minted names are single tokens from env.ATTEMPT_TOKEN: `tuplongset` + `x`
// padding + the token (set),
// `tuphost<token>` (insert) and `tupgold<token>` (its parallel). Neither
// parallel name starts with the insert's, so the prefix rule is the only thing
// that can put the insert's name in the title. R9: the drill goes through
// drillToCustomSet (its first stop at the set is drillToCustom, the helper
// drillToCustomSet wraps, then drillToCustomSet re-drills to the Insert
// type, selecting what is already there); the grouping is the same Group Parallels move the
// sub-variants spec makes.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { addCardViaForm } from "../../support/cards";
import type { Locator, Page } from "@playwright/test";
import {
  addCustomEntry,
  columnOption,
  columnSelection,
  customSport,
  drillToCustom,
  drillToCustomSet,
  setBuilderReady,
} from "../../support/set-builder";
import { tidyUpName } from "../../support/wizard";

/**
 * Two controls on screen, clear of each other, and both inside the viewport's
 * width: the layout proof for a long unbroken name on both projects.
 */
async function expectClearAndInside(page: Page, a: Locator, b: Locator, what: string): Promise<void> {
  const boxA = await a.boundingBox();
  const boxB = await b.boundingBox();
  const viewport = page.viewportSize();
  if (!boxA || !boxB || !viewport) throw new Error(`${what}: both boxes and the viewport must be measurable`);
  const clear =
    boxA.x + boxA.width <= boxB.x ||
    boxB.x + boxB.width <= boxA.x ||
    boxA.y + boxA.height <= boxB.y ||
    boxB.y + boxB.height <= boxA.y;
  expect(clear, `${what}: the two overlap`).toBe(true);
  for (const box of [boxA, boxB]) {
    expect(box.x, `${what}: starts left of the viewport`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${what}: runs past the viewport's right edge`).toBeLessThanOrEqual(viewport.width);
  }
}

test(
  "The tidy-up title names an insert by its own name and a parallel after its insert (NEO-497)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const T = env.ATTEMPT_TOKEN;
    const SET = `tuplongset${"x".repeat(100 - "tuplongset".length - T.length)}${T}`;
    const HOST = `tuphost${T}`;
    const PARALLEL = `tupgold${T}`;
    const year = "2026";

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // NEO-499: the set open on its own, its attributes heading wrapped inside
    // the viewport and clear of the panel's toggle. NEO-496: a set opens its
    // panel by default (a fresh tab remembers no close), so the one toggle
    // reads "Hide attributes", with the panel open beneath it.
    await drillToCustom(page, { sport: customSport(env), year, manufacturer: "Topps", set: SET });
    const setHeading = page.getByRole("heading", { name: `Attributes for ${SET} (Set)`, exact: true });
    const attributesToggle = page.getByRole("button", { name: "Hide attributes", exact: true });
    await expect(setHeading).toBeVisible();
    await expect(attributesToggle).toBeVisible();
    await expect(attributesToggle).toHaveAttribute("aria-expanded", "true");
    await expectClearAndInside(page, setHeading, attributesToggle, "the set's Attributes heading and Hide attributes");

    // An insert, and a parallel moved under it with Group Parallels.
    await drillToCustomSet(page, env, { set: SET, variantType: "Insert" });
    await addCustomEntry(page, "Inserts", HOST, { confirm: "required" });
    await addCustomEntry(page, "Inserts", PARALLEL, { confirm: "required" });
    await columnOption(page, "Inserts", HOST).click();
    await expect(columnSelection(page, "Inserts", HOST)).toBeVisible();
    const grouping = page.getByRole("dialog", { name: "Group Parallels" });
    await page.getByRole("button", { name: "Group Parallels" }).click();
    await expect(grouping.getByText(/Drag inserts under a parent/)).toBeVisible();
    await grouping.getByRole("checkbox", { name: `Select ${PARALLEL}` }).click();
    await grouping.getByText(`Parallels of "${HOST}"`).click();
    await expect(grouping.getByText("1 promotion, 0 demotions")).toBeVisible();
    await grouping.getByRole("button", { name: "Save 1 change" }).click();
    await expect(grouping).toBeHidden();
    await expect(columnOption(page, "Parallels", PARALLEL)).toBeVisible();

    // One walker per checklist: a card with no team, the pill, the dialog's name.
    const openWalker = async (cardNumber: string, name: string) => {
      await addCardViaForm(page, { cardNumber, playerName: `Tup${cardNumber}${T}` });
      const pill = page.getByRole("button", { name: "1 needs you", exact: true });
      await expect(pill).toBeVisible();
      await pill.click();
      const walker = page.getByRole("dialog", { name, exact: true });
      await expect(walker).toBeVisible();
      await expect(walker.getByRole("heading", { name, exact: true })).toBeVisible();
      await expect(walker.getByRole("button", { name: `Skip for now, card ${cardNumber}` })).toBeVisible();

      // Layout: heading and counter both on screen, clear of each other, and
      // inside the viewport's width (stacked below `sm`, side by side above).
      const counter = walker.getByText(/^Step [0-9]+ of [0-9]+$/);
      await expect(counter).toBeVisible();
      await expectClearAndInside(
        page,
        walker.getByRole("heading", { name, exact: true }),
        counter,
        "the tidy-up heading and the Step x of y counter",
      );

      await page.keyboard.press("Escape");
      await expect(walker).toBeHidden();
    };

    // The insert itself (not Base): its own name, no variant type word.
    await openWalker("901", tidyUpName({ year, set: SET, variant: HOST }));

    // The parallel under it: the insert's name first.
    await columnOption(page, "Parallels", PARALLEL).click();
    await expect(columnSelection(page, "Parallels", PARALLEL)).toBeVisible();
    await openWalker("902", tidyUpName({ year, set: SET, variant: `${HOST} ${PARALLEL}` }));
  },
);

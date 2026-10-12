// Origin: .maestro/flows/admin/admin-franchises-start-and-rename.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Franchise Management — start a franchise under a sport and rename the thread",
  { tag: ["@admin"] },
  async ({ page, signIn, env }) => {
    const started = `Fran${env.ATTEMPT_TOKEN}`;
    const renamed = `Ren${env.ATTEMPT_TOKEN}`;
    const counter = page.getByText(/ of .* franchises/);
    const filter = page.getByLabel("Filter franchises");

    await signIn("/admin/franchises");
    await expect(counter.first()).toBeVisible({ timeout: LAUNCH_GATE });

    // Empty the list, choose Baseball, then clear the filter: the form opens
    // under the sport the list is scoped to.
    await filter.fill("zzzznotafranchise");
    await expect(page.getByText(/^No franchises (match that filter|yet)/)).toBeVisible();
    await page.getByLabel("Sport", { exact: true }).selectOption({ label: "Baseball" });
    await filter.clear();

    await page.getByRole("button", { name: "Start a franchise" }).click();
    await expect(page.getByText(/^One name for a team.s whole run/)).toBeVisible();
    await page.getByLabel("Franchise name").fill(started);
    await page.getByRole("button", { name: "Start franchise" }).click();

    // The new thread's panel: confirmation, empty roster, sport read back.
    await expect(page.getByText(new RegExp(`Started ${started}`))).toBeVisible();
    await expect(page.getByText(/0 teams on this thread/)).toBeVisible();
    await expect(page.getByText("Sport: Baseball")).toBeVisible();
    await expect(page.getByText(/^No teams yet/)).toBeVisible();

    // Rename the thread.
    await page.getByLabel("Franchise name").fill(renamed);
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(page.getByText(new RegExp(`Renamed to ${renamed}`))).toBeVisible();

    // Reload: the old name is gone, the new one is listed.
    await page.goto("/admin/franchises");
    await expect(counter.first()).toBeVisible({ timeout: 30_000 });
    await filter.fill(started);
    await expect(page.getByText("No franchises match that filter.")).toBeVisible();
    await filter.fill(renamed);
    await expect(page.getByText(/^1 of .* franchises/).first()).toBeVisible();
    await page.getByRole("button", { name: renamed }).click();
    await expect(page.getByText(/0 teams on this thread/)).toBeVisible();
  },
);

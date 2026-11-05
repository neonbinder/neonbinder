// NEO-431 (R1): a copy line's photo upload rides out a storage hiccup and, when
// storage really is down, tells the collector so in plain words. A signed-in
// collector marks the FIRST ordinary Base row Have, opens its one line in the
// drawer and picks photos while the test answers the browser's PUTs to the
// photo store: one 503 then success is saved with no word to the collector
// (three PUTs: the image twice, the thumbnail once); a 503 every time gives up
// after three tries with the collector copy in the alert and a log line that
// carries the status and no address; a 403 is not retried; a network failure
// gives up after three tries and never shows the browser's own "Failed to
// fetch"; then storage recovers and the same field saves; a try the store never
// answers is cut off by the page's own attempt timeout: with the page clock moved past
// each try's window, three held tries give up with the collector copy (the log line
// says it timed out), and one held try followed by a live store saves.
//
// Why this mocks: a live third party cannot be made to fail on demand, so the
// test answers ONLY the browser's PUTs to the photo store (the signed upload
// addresses) and lets everything else, Convex included, go through. Nothing
// is sent to the store while a failure is being forced.
//
// R7/R7a: writes ONLY the signed-in user's `collectionCopies` and
// `collectionCopyPhotos` on one Base card (the row choice every collection
// spec shares, as `copy-photos-add-replace-remove`; see SET-REGISTRY.md), never
// the set, its cards, players or teams. Self-cleaning: the copy is removed
// through the UI, which detaches its photos for the hourly sweep; the
// bootstrap reset clears any left behind. Only the successful saves reach
// the photo store. Same drawer on both projects (phone and desktop): no branch.
import { drillToCollectorBase, ordinaryBaseRows, photoFile, shortNameOf } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

/** The photo store's signed upload addresses (a different host from the app and Convex). */
const PHOTO_STORE = /^https:\/\/[^/]+\.r2\.cloudflarestorage\.com\//;
const GAVE_UP = "copy_photo_put_failed";
const COLLECTOR_COPY = "That photo didn't upload.";

test(
  "Collection: a copy's photo upload retries a storage hiccup, and says plainly when it gives up",
  { tag: ["@collection"] },
  async ({ page, signIn }) => {
    const logged: string[] = [];
    page.on("console", (message) => {
      if (message.text().includes(GAVE_UP)) logged.push(message.text());
    });
    // The give-up line, awaited by event: start it BEFORE the photo is picked.
    const gaveUp = async () =>
      (await page.waitForEvent("console", { predicate: (message) => message.text().includes(GAVE_UP) })).text();

    // The page clock runs at the real pace from here (install only swaps the page's timers
    // for ones the test can also push forward); it is installed BEFORE the first page loads so
    // every timer the app and the upload code set is one the test can move.
    await page.clock.install();
    await signIn("/collection");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
    await page.getByRole("navigation", { name: "Collection sections" }).getByRole("link", { name: "Checklists", exact: true }).click();
    const checklist = await drillToCollectorBase(page);
    const row = ordinaryBaseRows(checklist).first();
    await expect(row).toBeVisible();
    const { short, number } = await shortNameOf(row);
    // The Binder picker opens on All, a view that adds nothing (NEO-374): pick Main first.
    await checklist.getByRole("combobox", { name: "Binder" }).selectOption({ label: "Main" });
    await checklist.getByRole("button", { name: `Have ${short}`, exact: true, pressed: false }).click();
    await expect(checklist.getByRole("button", { name: `Have ${short}, Raw, Excellent`, exact: true, pressed: true })).toBeVisible();

    await checklist.getByText(`#${number}`, { exact: true }).click();
    const drawer = page.getByRole("dialog", { name: /^2024 Topps Chrome / });
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${short}` });
    const form = yourCopies.getByRole("form", { name: "Edit Raw, Excellent", exact: true });
    await expect(form).toBeVisible();
    const panel = form.getByRole("region", { name: /^Photos of / });
    const front = panel.getByLabel("Front photo file", { exact: true });
    const back = panel.getByLabel("Back photo file", { exact: true });

    // What the store is made to answer for each PUT, by its number since the last reset: a
    // status, "abort" (the connection fails), "hold" (the request is never answered), or null
    // (let the real store answer).
    let puts = 0;
    let heldBytes = 0;
    let answer: (n: number) => number | "abort" | "hold" | null = () => null;
    await page.route(PHOTO_STORE, async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      puts += 1;
      const forced = answer(puts);
      if (forced === null) return route.fallback();
      if (forced === "abort") return route.abort("failed");
      if (forced === "hold") {
        heldBytes = route.request().postDataBuffer()?.length ?? 0;
        return new Promise<never>(() => {});
      }
      // The CORS header keeps the status readable to the page, as a real store's answer is.
      return route.fulfill({ status: forced, headers: { "access-control-allow-origin": "*" }, body: "" });
    });
    const forceStore = (next: typeof answer) => {
      puts = 0;
      logged.length = 0;
      answer = next;
    };

    // --- One 503, then storage is fine: saved, and the collector never hears of it ----
    forceStore((n) => (n === 1 ? 503 : null));
    await front.setInputFiles(photoFile("front.jpg"));
    await expect(panel.getByRole("status")).toHaveText("Front photo saved.");
    expect(puts, "image 503, image ok, thumbnail ok").toBe(3);
    expect(logged, "a recovered hiccup is not logged").toEqual([]);
    await expect(panel.getByRole("alert")).toBeEmpty();

    // --- 503 every time: three tries, the collector copy, the status (no address) in the log ----
    forceStore(() => 503);
    let line = gaveUp();
    await back.setInputFiles(photoFile("back.jpg"));
    expect(await line).toContain('"status":503');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('"attempts":3');
    expect(logged[0], "the signed address is never logged").not.toContain("http");
    expect(puts).toBe(3);
    await expect(panel.getByRole("alert")).toContainText(COLLECTOR_COPY);
    await expectAccessible(page, { within: drawer, label: "Card drawer, photo upload failed" });

    // --- 403: a refusal a retry cannot fix, so no retry ----------------------------------
    forceStore(() => 403);
    line = gaveUp();
    await back.setInputFiles(photoFile("back.jpg"));
    expect(await line).toContain('"status":403');
    expect(puts).toBe(1);
    await expect(panel.getByRole("alert")).toContainText(COLLECTOR_COPY);

    // --- The connection fails: three tries, the collector copy, never the browser's words ----
    forceStore(() => "abort");
    line = gaveUp();
    await back.setInputFiles(photoFile("back.jpg"));
    expect(await line).toContain('"status":null');
    expect(puts).toBe(3);
    await expect(panel.getByRole("alert")).toContainText(COLLECTOR_COPY);
    await expect(panel.getByRole("alert")).not.toContainText("Failed to fetch");

    // --- Storage recovers: the same field just works -------------------------------------
    forceStore(() => null);
    await back.setInputFiles(photoFile("back.jpg"));
    await expect(panel.getByRole("status")).toHaveText("Back photo saved.");
    await expect(panel.getByRole("alert")).toBeEmpty();

    // --- The store never answers: each try is cut off at its own window, ---------------------
    // --- three held tries give up, and the collector is not left on "Saving" --------------
    // The next PUT to the store, awaited by event (the page's default 7 s bounds it): start it
    // BEFORE the thing that sends it.
    const nextPut = () => page.waitForRequest((request) => request.method() === "PUT" && PHOTO_STORE.test(request.url()));
    // A try's window is 20 s plus a second per 32 KB of the file, so a photo under 64 KB is
    // given up on after 22 s at the most; moving the page clock 22 s puts every try past it.
    const STALL = 22_000;
    forceStore(() => "hold");
    line = gaveUp();
    let arrived = nextPut();
    await back.setInputFiles(photoFile("back.jpg"));
    await arrived;
    await expect(panel.getByRole("status")).toHaveText("Saving the back photo…");
    expect(heldBytes, "a small photo, so one STALL clears its window").toBeLessThan(64_000);
    await expectAccessible(page, { within: drawer, label: "Card drawer, photo upload not answering" });
    for (let retry = 0; retry < 2; retry++) {
      arrived = nextPut();
      await page.clock.fastForward(STALL);
      await arrived;
    }
    await page.clock.fastForward(STALL);
    const stalled = await line;
    expect(stalled).toContain('"timedOut":true');
    expect(stalled).toContain('"status":null');
    expect(stalled).toContain('"attempts":3');
    expect(stalled, "the signed address is never logged").not.toContain("http");
    expect(puts).toBe(3);
    await expect(panel.getByRole("alert")).toContainText(COLLECTOR_COPY);
    await expect(panel.getByRole("status")).toBeEmpty();

    // --- One try is never answered, the next one is: saved, and the collector never hears of it ----
    forceStore((n) => (n === 1 ? "hold" : null));
    arrived = nextPut();
    await back.setInputFiles(photoFile("back.jpg"));
    await arrived;
    await page.clock.fastForward(STALL);
    await expect(panel.getByRole("status")).toHaveText("Back photo saved.");
    expect(puts, "image held, image ok, thumbnail ok").toBe(3);
    expect(logged, "a recovered stall is not logged").toEqual([]);
    await expect(panel.getByRole("alert")).toBeEmpty();

    // --- Remove the copy (self-cleaning) -------------------------------------------------
    await page.unroute(PHOTO_STORE);
    await panel.getByRole("button", { name: "Replace front", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(form).toBeHidden();
    await yourCopies.getByRole("button", { name: `Remove ${short}, Raw, Excellent`, exact: true }).click();
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    await expect(checklist.getByRole("button", { name: `Have ${short}`, exact: true, pressed: false })).toBeVisible();
  },
);

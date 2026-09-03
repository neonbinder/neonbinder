/**
 * NEO-170 — the stopgap scan intake page.
 *
 * The ordering guarantees live in lib/placeholders/upload-run.test.ts; what is
 * asserted here is the WIRING that test cannot see: that picking files and
 * pressing the button opens a session and runs the loop against it, that the run
 * view is addressable by `?jobId=`, and that the reactive sections render what
 * the queries return. All of it was only ever exercised by hand before, which is
 * exactly how a page ends up calling `confirmPlaceholderImageUpload` with the
 * wrong job id.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `?raw` gives the route table as text — importing src/main.tsx for real mounts
// the whole app.
import mainSource from "@/src/main.tsx?raw";

const REFS = {
  job: "placeholderPipeline:getPlaceholderJob",
  images: "placeholderPipeline:listPlaceholderImages",
  pairs: "placeholderPipeline:listPlaceholderPairs",
  cancel: "placeholderPipeline:cancelPlaceholderBatch",
  start: "placeholderStream:startPlaceholderStream",
  confirm: "placeholderStream:confirmPlaceholderImageUpload",
  close: "placeholderStream:closePlaceholderStream",
  uploadUrl: "placeholderUploads:createPlaceholderImageUploadUrl",
  downloadUrl: "placeholderUploads:createPlaceholderImageDownloadUrl",
  unpair: "placeholderPairing:unpairPlaceholderImages",
  manualPair: "placeholderPairing:manuallyPairPlaceholderImages",
} as const;

const mocks = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  fns: {} as Record<string, ReturnType<typeof vi.fn>>,
  warm: vi.fn(),
}));

// The mount warm-up has its own unit test (src/hooks/useWarmPreprocess.test.tsx);
// here it is a spy so this test can assert the page MOUNTS it without pulling in
// its opaque action reference.
vi.mock("@/src/hooks/useWarmPreprocess", () => ({
  useWarmPreprocess: () => mocks.warm(),
}));

vi.mock("@/convex/_generated/api", () => ({
  api: {
    placeholderPipeline: {
      getPlaceholderJob: "placeholderPipeline:getPlaceholderJob",
      listPlaceholderImages: "placeholderPipeline:listPlaceholderImages",
      listPlaceholderPairs: "placeholderPipeline:listPlaceholderPairs",
      cancelPlaceholderBatch: "placeholderPipeline:cancelPlaceholderBatch",
    },
    placeholderStream: {
      startPlaceholderStream: "placeholderStream:startPlaceholderStream",
      confirmPlaceholderImageUpload:
        "placeholderStream:confirmPlaceholderImageUpload",
      closePlaceholderStream: "placeholderStream:closePlaceholderStream",
    },
    // The review grid reaches for these; without the key the mocked `api`
    // object yields undefined and the component throws during render.
    placeholderPairing: {
      unpairPlaceholderImages: "placeholderPairing:unpairPlaceholderImages",
      manuallyPairPlaceholderImages:
        "placeholderPairing:manuallyPairPlaceholderImages",
    },
    adapters: {
      placeholderUploads: {
        createPlaceholderImageUploadUrl:
          "placeholderUploads:createPlaceholderImageUploadUrl",
        createPlaceholderImageDownloadUrl:
          "placeholderUploads:createPlaceholderImageDownloadUrl",
      },
    },
  },
}));

vi.mock("convex/react", () => ({
  // `"skip"` is what the page passes before a session exists; the real hook
  // returns undefined for it, and so does this.
  useQuery: (ref: string, args: unknown) =>
    args === "skip" ? undefined : mocks.queries[ref],
  useMutation: (ref: string) => mocks.fns[ref],
  useAction: (ref: string) => mocks.fns[ref],
}));

import CardIntake from "./intake";

/**
 * The page reads its session id from the query string now, so every render needs
 * a router. `initialEntry` is how the "open an existing run" case arrives.
 */
function renderPage(initialEntry = "/print/placeholders") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/print/placeholders" element={<CardIntake />} />
      </Routes>
    </MemoryRouter>,
  );
}

function selectFiles(names: string[]) {
  const input = screen.getByLabelText(/Drag your card photos here/) as HTMLInputElement;
  const files = names.map(
    (name) => new File(["bytes"], name, { type: "image/jpeg" }),
  );
  // happy-dom's `files` is read-only, so it is defined onto the node directly
  // rather than through fireEvent's target shorthand.
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input);
  return files;
}

describe("CardIntake", () => {
  beforeEach(() => {
    mocks.queries = {};
    mocks.warm = vi.fn();
    mocks.fns = {
      [REFS.start]: vi.fn().mockResolvedValue({ started: true, jobId: "job-1234abcd" }),
      [REFS.confirm]: vi
        .fn()
        .mockResolvedValue({ confirmed: true, alreadyConfirmed: false, totalImages: 1 }),
      [REFS.close]: vi.fn().mockResolvedValue({ closed: true, status: "processing" }),
      [REFS.cancel]: vi.fn().mockResolvedValue({ canceled: true, canceledCount: 3 }),
      [REFS.uploadUrl]: vi.fn(async () => ({
        uploadUrl: "https://storage.example/bucket",
        fields: { key: "k" },
        entryIndex: 0,
        expiresAt: Date.now() + 900_000,
        maxUploadBytes: 25 * 1024 * 1024,
      })),
      [REFS.downloadUrl]: vi.fn(async ({ entryIndex }: { entryIndex: number }) => ({
        url: `https://storage.example/signed/${entryIndex}`,
        entryIndex,
        expiresAt: Date.now() + 900_000,
      })),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response),
    );
  });

  it("warms the card processor on mount", () => {
    renderPage();
    // Kicked the moment the page loads, so the model is warming while the user
    // is still choosing files — not only from the first upload.
    expect(mocks.warm).toHaveBeenCalled();
  });

  it("explains what the page is for and starts with nothing selected", () => {
    renderPage();
    expect(
      // level 3, not 1: PrintLayout owns the h1 ("Print Shop") and the page
      // owns the h2 ("Placeholder Sheets") — intake is a section of it now.
      screen.getByRole("heading", { level: 3, name: "Upload your cards" }),
    ).not.toBeNull();
    expect(screen.getByText("Nothing selected yet.")).not.toBeNull();
    // Nothing to upload yet, and the label says so rather than the button
    // silently doing nothing.
    // There is no Start button — choosing files IS the upload. The guarantee
    // worth pinning is that nothing has been sent before a choice is made.
    expect(screen.queryByRole("button", { name: /Start Upload/ })).toBeNull();
    expect(mocks.fns[REFS.start]).not.toHaveBeenCalled();
  });

  it("sends the files the moment they are chosen, with no Start step", async () => {
    // The behaviour that replaced the button: a selection is a send. The old
    // assertion here counted files sitting in a tray waiting for a click; that
    // tray no longer exists, and its absence is the point.
    renderPage();
    selectFiles(["front.jpg", "back.jpg"]);

    await waitFor(() =>
      expect(mocks.fns[REFS.start]).toHaveBeenCalled(),
    );
    expect(screen.queryByRole("button", { name: /Start Upload/ })).toBeNull();
  });

  it("refuses an impossible selection instead of sending it", async () => {
    // With no button to intercept, the classification IS the guard: two zips
    // would become two batches, so nothing is sent and the reason is shown.
    renderPage();
    selectFiles(["one.zip", "two.zip"]);

    expect(screen.getByText(/one zip at a time/)).not.toBeNull();
    expect(mocks.fns[REFS.start]).not.toHaveBeenCalled();
  });

  it("opens one session and uploads every file into it", async () => {
    renderPage();
    selectFiles(["front.jpg", "back.jpg"]);

    await waitFor(() =>
      expect(screen.getByText("Uploaded 2 of 2 images.")).not.toBeNull(),
    );
    // One session for the whole selection — a session per file would give every
    // card its own job and pair nothing. Started as a web-originated run.
    expect(mocks.fns[REFS.start]).toHaveBeenCalledTimes(1);
    expect(mocks.fns[REFS.start]).toHaveBeenCalledWith({ source: "web" });
    expect(mocks.fns[REFS.uploadUrl]).toHaveBeenCalledTimes(2);
    // Confirms are addressed to the session that was just opened.
    expect(mocks.fns[REFS.confirm]).toHaveBeenCalledWith({
      jobId: "job-1234abcd",
      entryIndex: 0,
    });
    // Race: `jobId` reaches the DOM through react-router's setSearchParams,
    // which commits through the router's own external store rather than in
    // the same batch as the local `setNotice` update the counter text above
    // just waited on — under load its render can land a tick later, so this
    // heading needs its own wait rather than following the counter's for free.
    expect(
      await screen.findByRole("heading", { name: /Your cards/ }),
    ).not.toBeNull();
  });

  it("says why a session could not be started", async () => {
    mocks.fns[REFS.start] = vi.fn().mockResolvedValue({
      started: false,
      reason: "you already have 2 active batches (limit 2) — wait for one to finish",
    });
    renderPage();
    selectFiles(["front.jpg"]);

    const notice = await screen.findByText(
      "Couldn't start a scan session — you already have 2 active batches (limit 2) — wait for one to finish.",
    );
    expect(notice.getAttribute("role")).toBe("alert");
    expect(mocks.fns[REFS.uploadUrl]).not.toHaveBeenCalled();
  });

  it("renders the session's images, pairs and cropped sides", async () => {
    mocks.queries = {
      [REFS.job]: {
        jobId: "job-1234abcd",
        status: "collecting",
        mode: "stream",
        createdAt: Date.now(),
        totalImages: 2,
        processedImages: 2,
        failedImages: 0,
        rejectedEntries: 0,
        pairCount: 1,
      },
      [REFS.images]: [
        {
          entryIndex: 0,
          originalName: "front.jpg",
          status: "done",
          players: ["Ken Griffey Jr."],
          cardNumber: "24",
          side: "front",
          pairStatus: "paired",
        },
        {
          entryIndex: 1,
          originalName: "back.jpg",
          status: "done",
          side: "back",
          pairStatus: "paired",
        },
        {
          entryIndex: 2,
          originalName: "stray.jpg",
          status: "done",
          side: "front",
          pairStatus: "unmatched",
        },
      ],
      [REFS.pairs]: [
        {
          frontIndex: 0,
          backIndex: 1,
          player: "Ken Griffey Jr.",
          cardNumber: "24",
          confidence: "exact",
          mechanism: "adjacency",
          score: 0.98,
          createdAt: Date.now(),
        },
      ],
    };

    renderPage();
    selectFiles(["front.jpg"]);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Your cards/ })).not.toBeNull(),
    );

    // Status line, composed rather than scattered across cells.
    expect(
      screen.getByText("All 3 photos read."),
    ).not.toBeNull();

    const pairsSection = within(
      screen.getByRole("heading", { name: /Your cards/ })
        .parentElement as HTMLElement,
    );
    // The card, and what the matcher had to go on. That used to be one
    // sr-only string on the pocket ("… — Matched"); with the pocket preview
    // gone the review row carries both as visible text, which is better —
    // the evidence is the thing a user acts on and it was invisible before.
    expect(screen.getByText("Ken Griffey Jr. #24")).not.toBeNull();
    expect(screen.getByText("Name and details match")).not.toBeNull();

    // Both sides are fetched through their own signed GET, minted when the
    // image renders rather than with the pair list.
    // ONE of each front. There were briefly two — a pocket preview above the
    // review grid, plus the grid itself — and the duplication is exactly what
    // made the page hard to scan. The printable grid at the bottom is the only
    // preview now; this section shows each pair beside its back so the pairing
    // can be judged.
    expect(
      (await screen.findAllByAltText("Front of Ken Griffey Jr. #24")).length,
    ).toBe(1);
    // The back appears exactly once: in the review grid. The pocket grid shows
    // fronts only — a binder pocket is a front — so a back here means the
    // review grid rendered, which is where a pair is actually judged.
    expect(screen.getAllByAltText(/^Back of/)).toHaveLength(1);
    expect(mocks.fns[REFS.downloadUrl]).toHaveBeenCalledWith({
      jobId: "job-1234abcd",
      entryIndex: 0,
    });

    // A done image nothing paired is surfaced rather than dropped — an
    // unmatched scan is the thing a user most needs to act on. It is now shown
    // as a thumbnail under "Not matched yet", named by its file.
    expect(await screen.findByAltText("stray.jpg")).not.toBeNull();
  });

  describe("cold-start (heavy warm-up) indicator", () => {
    // NEO-175: the notice is now driven by the backend-derived `heavyWarming`
    // flag on the job, NOT by client-side image-state guessing. It is scoped to
    // escalations — the fast path is never gated, so fast cards streaming in
    // never trigger it. `deriveHeavyWarming` (unit-tested in convex/) is what
    // decides the flag; here we assert the page renders off it.
    const baseJob = {
      jobId: "job-1234abcd",
      status: "processing",
      createdAt: Date.now(),
      totalImages: 2,
      processedImages: 1,
      failedImages: 0,
      rejectedEntries: 0,
      pairCount: 0,
    };

    function openWithJob(
      jobOverrides: Record<string, unknown>,
      images: Array<{ entryIndex: number; status: string; escalated?: boolean }> = [],
    ) {
      mocks.queries = {
        [REFS.job]: { ...baseJob, ...jobOverrides },
        [REFS.images]: images.map((i) => ({ originalName: `f${i.entryIndex}.jpg`, ...i })),
      };
      return renderPage("/print/placeholders?jobId=job-1234abcd");
    }

    const WARMING = /A few of these need a closer look/;

    it("shows while an escalation is waiting on the cold heavy service", () => {
      openWithJob({ heavyWarming: true });
      const note = screen.getByText(WARMING);
      expect(note).not.toBeNull();
      // Announced, and not error-toned — a heavy warm-up is expected, not a fault.
      const region = note.closest("[role='status'][aria-live='polite']");
      expect(region).not.toBeNull();
    });

    it("clears once the heavy service has produced a result (heavyWarming false)", () => {
      openWithJob({ heavyWarming: false });
      expect(screen.queryByText(WARMING)).toBeNull();
    });

    it("never shows for a batch with no escalations (flag absent)", () => {
      openWithJob({});
      expect(screen.queryByText(WARMING)).toBeNull();
    });

    it("is scoped to escalations — fast cards streaming in do not trigger it", () => {
      // Images actively moving through the fast path, but heavyWarming false: the
      // fast path is never gated, so no warm-up notice appears for them.
      openWithJob({ heavyWarming: false }, [
        { entryIndex: 0, status: "queued" },
        { entryIndex: 1, status: "processing" },
      ]);
      expect(screen.queryByText(WARMING)).toBeNull();
    });

    it("badges an escalated, still-processing image as deeper processing", () => {
      openWithJob({ heavyWarming: true }, [
        { entryIndex: 0, status: "done" },
        { entryIndex: 1, status: "processing", escalated: true },
      ]);
      expect(screen.getByText(/Escalating — deeper processing/)).not.toBeNull();
    });
  });

  it("closes the session only after the confirm dialog", async () => {
    mocks.queries = {
      [REFS.job]: {
        jobId: "job-1234abcd",
        status: "collecting",
        createdAt: Date.now(),
        totalImages: 1,
        processedImages: 0,
        failedImages: 0,
        rejectedEntries: 0,
        pairCount: 0,
      },
    };
    renderPage();
    selectFiles(["front.jpg"]);

    const closeButton = await screen.findByRole("button", { name: /Finish/ });
    fireEvent.click(closeButton);
    expect(mocks.fns[REFS.close]).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Finish it" }));
    await waitFor(() =>
      expect(mocks.fns[REFS.close]).toHaveBeenCalledWith({ jobId: "job-1234abcd" }),
    );
    // Race: `closeStream` is recorded on the mock the instant it's invoked,
    // before its resolved promise's continuation runs — so the waitFor above
    // can settle before the `setNotice` call that follows `await closeStream`
    // has actually committed this text.
    expect(
      await screen.findByText(
        "Session closed. Processing and pairing finish on their own.",
      ),
    ).not.toBeNull();
  });

  it("backs out of Abort on Escape without cancelling anything", async () => {
    mocks.queries = {
      [REFS.job]: {
        jobId: "job-1234abcd",
        status: "processing",
        createdAt: Date.now(),
        totalImages: 1,
        processedImages: 0,
        failedImages: 0,
        rejectedEntries: 0,
        pairCount: 0,
      },
    };
    renderPage();
    selectFiles(["front.jpg"]);

    fireEvent.click(await screen.findByRole("button", { name: "Discard this batch" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.fns[REFS.cancel]).not.toHaveBeenCalled();
  });

  it("opens an existing run straight from ?jobId=", async () => {
    // The resume path. Two assertions that used to live here checked
    // "resolver calls: N" — a diagnostics counter that NEO-152 removed from the
    // UI on purpose (it is a Map-lookup tally since NEO-170, meaningless to a
    // collector). What matters on this path is that a run opened from the URL
    // alone renders its state without the user having just created it.
    mocks.queries = {
      [REFS.job]: {
        jobId: "job-1234abcd",
        status: "succeeded",
        createdAt: Date.now(),
        totalImages: 2,
        processedImages: 2,
        failedImages: 0,
        rejectedEntries: 0,
        pairCount: 1,
        resolverCalls: 3,
        heavyWarming: false,
      },
      [REFS.images]: [],
      [REFS.pairs]: [],
    };
    renderPage("/print/placeholders?jobId=job-1234abcd");

    expect(screen.getByRole("heading", { name: /Your cards/ })).not.toBeNull();
    // Plain language, and no internal counter anywhere on the page.
    expect(screen.queryByText(/resolver calls/)).toBeNull();
  });

  it("is reachable — main.tsx mounts the intake page under /print, signed in", () => {
    // NEO-152 moved intake from the standalone /placeholders stopgap into the
    // Print Shop. This asserts the destination rather than the old route.
    expect(mainSource).toContain('from "@/app/print/placeholders/page"');
    expect(mainSource).toMatch(
      /path="placeholders"\s+element=\{<PrintPlaceholders \/>\}/,
    );

    // Inside ProtectedLayout's subtree, and NOT inside the AdminLayout block —
    // this is a page for every signed-in user, not an admin tool.
    const adminBlock = mainSource.slice(
      mainSource.indexOf("<Route element={<AdminLayout />}>"),
    );
    expect(adminBlock.slice(0, adminBlock.indexOf("</Route>"))).not.toContain(
      'path="placeholders"',
    );
    const protectedBlock = mainSource.slice(
      mainSource.indexOf("<Route element={<ProtectedLayout />}>"),
    );
    expect(protectedBlock).toContain('path="placeholders"');
  });

  it("keeps the old /placeholders URL working, query string and all", () => {
    // The stopgap was never in the nav, but it IS in browser histories and it
    // is where /testing/seed-placeholder-upload sends the E2E suite. Deleting
    // the route would 404 those; forwarding with a bare `to` would be worse —
    // it drops `?jobId=`, so the run silently vanishes and the page looks empty
    // rather than broken. The redirect must carry the search across.
    expect(mainSource).toMatch(/path="\/placeholders" element=\{<LegacyPlaceholders \/>\}/);
    expect(mainSource).toMatch(
      /function LegacyPlaceholders\(\)[\s\S]{0,300}?to=\{`\/print\/placeholders\$\{search\}`\}/,
    );
  });
});

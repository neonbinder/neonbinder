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
} as const;

const mocks = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  fns: {} as Record<string, ReturnType<typeof vi.fn>>,
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

import PlaceholderScansPage from "./page";

/**
 * The page reads its session id from the query string now, so every render needs
 * a router. `initialEntry` is how the "open an existing run" case arrives.
 */
function renderPage(initialEntry = "/placeholders") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/placeholders" element={<PlaceholderScansPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function selectFiles(names: string[]) {
  const input = screen.getByLabelText("Scan images (JPEG)") as HTMLInputElement;
  const files = names.map(
    (name) => new File(["bytes"], name, { type: "image/jpeg" }),
  );
  // happy-dom's `files` is read-only, so it is defined onto the node directly
  // rather than through fireEvent's target shorthand.
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input);
  return files;
}

describe("PlaceholderScansPage", () => {
  beforeEach(() => {
    mocks.queries = {};
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

  it("explains what the page is for and starts with nothing selected", () => {
    renderPage();
    expect(
      screen.getByRole("heading", { level: 1, name: "Placeholder Scans" }),
    ).not.toBeNull();
    expect(screen.getByText("No files selected.")).not.toBeNull();
    // Nothing to upload yet, and the label says so rather than the button
    // silently doing nothing.
    expect(
      screen.getByRole("button", { name: "Start Upload" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("counts the selected files", () => {
    renderPage();
    selectFiles(["front.jpg", "back.jpg"]);
    expect(screen.getByText("2 files selected.")).not.toBeNull();
  });

  it("opens one session and uploads every file into it", async () => {
    renderPage();
    selectFiles(["front.jpg", "back.jpg"]);
    fireEvent.click(screen.getByRole("button", { name: "Start Upload" }));

    await waitFor(() =>
      expect(screen.getByText("Uploaded 2 of 2 images.")).not.toBeNull(),
    );
    // One session for the whole selection — a session per file would give every
    // card its own job and pair nothing.
    expect(mocks.fns[REFS.start]).toHaveBeenCalledTimes(1);
    expect(mocks.fns[REFS.uploadUrl]).toHaveBeenCalledTimes(2);
    // Confirms are addressed to the session that was just opened.
    expect(mocks.fns[REFS.confirm]).toHaveBeenCalledWith({
      jobId: "job-1234abcd",
      entryIndex: 0,
    });
    expect(screen.getByRole("heading", { name: "Session job-1234" })).not.toBeNull();
  });

  it("says why a session could not be started", async () => {
    mocks.fns[REFS.start] = vi.fn().mockResolvedValue({
      started: false,
      reason: "you already have 2 active batches (limit 2) — wait for one to finish",
    });
    renderPage();
    selectFiles(["front.jpg"]);
    fireEvent.click(screen.getByRole("button", { name: "Start Upload" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Start Upload" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Session job-1234" })).not.toBeNull(),
    );

    // Status line, composed rather than scattered across cells.
    expect(
      screen.getByText(
        "Collecting — 2 of 2 images processed, 0 failed, 1 pairs",
      ),
    ).not.toBeNull();

    const pairsSection = within(
      screen.getByRole("heading", { name: "Matched pairs" })
        .parentElement as HTMLElement,
    );
    expect(
      pairsSection.getByText("Ken Griffey Jr. · #24 · exact match · by scan order"),
    ).not.toBeNull();

    // Both sides are fetched through their own signed GET, minted when the
    // image renders rather than with the pair list.
    expect(
      await screen.findByAltText("Front of Ken Griffey Jr."),
    ).not.toBeNull();
    expect(await screen.findByAltText("Back of Ken Griffey Jr.")).not.toBeNull();
    expect(mocks.fns[REFS.downloadUrl]).toHaveBeenCalledWith({
      jobId: "job-1234abcd",
      entryIndex: 1,
    });

    // A done image nothing paired is listed rather than dropped — an unmatched
    // scan is the thing a user most needs to see.
    expect(screen.getByText(/#2 stray\.jpg/)).not.toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "Start Upload" }));

    const closeButton = await screen.findByRole("button", { name: "Close Session" });
    fireEvent.click(closeButton);
    expect(mocks.fns[REFS.close]).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Yes, Close" }));
    await waitFor(() =>
      expect(mocks.fns[REFS.close]).toHaveBeenCalledWith({ jobId: "job-1234abcd" }),
    );
    expect(
      screen.getByText(
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
    fireEvent.click(screen.getByRole("button", { name: "Start Upload" }));

    fireEvent.click(await screen.findByRole("button", { name: "Abort Session" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.fns[REFS.cancel]).not.toHaveBeenCalled();
  });

  it("opens an existing run straight from ?jobId=, with its resolver spend", () => {
    // Addressability is the point of putting the id in the URL: the /testing
    // entry point redirects here, and a run is shareable and survives a reload.
    mocks.queries = {
      [REFS.job]: {
        jobId: "job-1234abcd",
        status: "succeeded",
        createdAt: Date.now(),
        totalImages: 4,
        processedImages: 4,
        failedImages: 0,
        rejectedEntries: 0,
        pairCount: 2,
        resolverCalls: 3,
      },
      [REFS.images]: [],
      [REFS.pairs]: [],
    };

    renderPage("/placeholders?jobId=job-1234abcd");

    expect(
      screen.getByRole("heading", { name: "Session job-1234" }),
    ).not.toBeNull();
    // Nothing was uploaded to get here.
    expect(mocks.fns[REFS.start]).not.toHaveBeenCalled();
    // The spend signal for a run: adjacency and the image pool are free, the
    // name resolver is not.
    expect(screen.getByText("resolver calls: 3")).not.toBeNull();
  });

  it("reads a run with no resolver counter as zero calls", () => {
    // Rows written before the counter existed have no field at all; the run
    // view must still render rather than printing "undefined".
    mocks.queries = {
      [REFS.job]: {
        jobId: "job-1234abcd",
        status: "succeeded",
        createdAt: Date.now(),
        totalImages: 0,
        processedImages: 0,
        failedImages: 0,
        rejectedEntries: 0,
        pairCount: 0,
      },
    };
    renderPage("/placeholders?jobId=job-1234abcd");
    expect(screen.getByText("resolver calls: 0")).not.toBeNull();
  });

  it("is reachable — main.tsx routes /placeholders inside the signed-in shell", () => {
    expect(mainSource).toContain('from "@/app/placeholders/page"');
    expect(mainSource).toMatch(
      /path="\/placeholders"\s+element=\{<PlaceholderScans \/>\}/,
    );
    // Inside ProtectedLayout's subtree, and NOT inside the AdminLayout block —
    // this is a page for every signed-in user.
    const adminBlock = mainSource.slice(
      mainSource.indexOf("<Route element={<AdminLayout />}>"),
    );
    expect(adminBlock.slice(0, adminBlock.indexOf("</Route>"))).not.toContain(
      '"/placeholders"',
    );
    const protectedBlock = mainSource.slice(
      mainSource.indexOf("<Route element={<ProtectedLayout />}>"),
    );
    expect(protectedBlock).toContain('path="/placeholders"');
  });
});

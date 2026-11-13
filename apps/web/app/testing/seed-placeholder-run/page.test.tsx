/**
 * NEO-170 — the abort flow's fixture entry point.
 *
 * This page's whole job is to leave the worker account with exactly one
 * abortable run. That output IS a held active-job slot, so — like its sibling
 * /testing/seed-placeholder-upload — it has to clear the caller's active jobs
 * first, or a second run (or an abort flow that failed before aborting) leaves
 * the account over the cap and the next flow can't seed. The case that matters
 * is the ORDER: reset must precede the seed, every run.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authed: true,
  calls: [] as string[],
  reset: vi.fn(),
  seed: vi.fn(),
  seedFailed: vi.fn(),
  seedSavedFailure: vi.fn(),
  seedLoose: vi.fn(),
  seedHopper: vi.fn(),
  clearHopper: vi.fn(),
}));

// Plain string tokens for the generated api so `useMutation` can tell the reset
// from the seed — a real FunctionReference does not stringify to its path.
vi.mock("@/convex/_generated/api", () => ({
  api: {
    placeholderPipeline: {
      seedCancelMyActivePlaceholderJobs:
        "placeholderPipeline:seedCancelMyActivePlaceholderJobs",
    },
    testing: {
      seedMyTestPlaceholderStream: "testing:seedMyTestPlaceholderStream",
      seedMyTestFailedPhotoRun: "testing:seedMyTestFailedPhotoRun",
      seedMyTestSavedPhotoFailureRun: "testing:seedMyTestSavedPhotoFailureRun",
      seedMyTestLoosePhotosRun: "testing:seedMyTestLoosePhotosRun",
      seedMyTestHopperRun: "testing:seedMyTestHopperRun",
      clearMyTestHopper: "testing:clearMyTestHopper",
    },
  },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: mocks.authed, isLoading: false }),
  useMutation: (ref: string) =>
    ref === "placeholderPipeline:seedCancelMyActivePlaceholderJobs"
      ? mocks.reset
      : ref === "testing:seedMyTestFailedPhotoRun"
        ? mocks.seedFailed
        : ref === "testing:seedMyTestSavedPhotoFailureRun"
          ? mocks.seedSavedFailure
          : ref === "testing:seedMyTestLoosePhotosRun"
            ? mocks.seedLoose
            : ref === "testing:seedMyTestHopperRun"
              ? mocks.seedHopper
              : ref === "testing:clearMyTestHopper"
                ? mocks.clearHopper
                : mocks.seed,
}));

import TestingSeedPlaceholderRunPage from "./page";

function ShowSearch() {
  return <div>placeholder intake {useLocation().search}</div>;
}

function renderPage(entry = "/testing/seed-placeholder-run") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/testing/seed-placeholder-run"
          element={<TestingSeedPlaceholderRunPage />}
        />
        <Route path="/pipeline-runs" element={<div>operator view</div>} />
        <Route path="/collection" element={<div>add cards screen</div>} />
        <Route path="/dashboard" element={<div>dashboard</div>} />
        <Route path="/print/placeholders" element={<ShowSearch />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("TestingSeedPlaceholderRunPage", () => {
  beforeEach(() => {
    mocks.authed = true;
    mocks.calls = [];
    mocks.reset = vi.fn(async () => {
      mocks.calls.push("reset");
      return { canceled: 1, canceledWorkItems: 0 };
    });
    mocks.seed = vi.fn(async () => {
      mocks.calls.push("seed");
      return { jobId: "3f2a1b8c-1111-2222-3333-444455556666" };
    });
    mocks.seedFailed = vi.fn(async () => {
      mocks.calls.push("seedFailed");
      return { runId: "run123", jobId: "job123", originalName: "never-read-3f2a1b8c.jpg" };
    });
    mocks.seedSavedFailure = vi.fn(async () => {
      mocks.calls.push("seedSavedFailure");
      return { runId: "run456", copyId: "copy456" };
    });
    mocks.seedLoose = vi.fn(async () => {
      mocks.calls.push("seedLoose");
      return { runId: "run789" };
    });
    mocks.seedHopper = vi.fn(async () => {
      mocks.calls.push("seedHopper");
      return { runId: "runHopper" };
    });
    mocks.clearHopper = vi.fn(async () => {
      mocks.calls.push("clearHopper");
      return { cleared: 1 };
    });
    vi.stubEnv("VITE_CLERK_TESTING_ENABLED", "true");
  });

  it("NEO-464: with clearHopper=1, resets, clears the open scans and lands on the redirect", async () => {
    renderPage("/testing/seed-placeholder-run?clearHopper=1&redirect=/dashboard");
    await waitFor(() => expect(screen.getByText("dashboard")).not.toBeNull());
    expect(mocks.calls).toEqual(["reset", "clearHopper"]);
    expect(mocks.seedHopper).not.toHaveBeenCalled();
  });

  it("NEO-464: with hopperScan=1, resets, seeds the open scan and opens its run", async () => {
    renderPage("/testing/seed-placeholder-run?hopperScan=1");
    await waitFor(() => expect(screen.getByText("add cards screen")).not.toBeNull());
    expect(mocks.calls).toEqual(["reset", "seedHopper"]);
    expect(mocks.seed).not.toHaveBeenCalled();
  });

  it("NEO-441: with loosePhotos=1, resets, seeds the unpaired photos and opens the run", async () => {
    renderPage("/testing/seed-placeholder-run?loosePhotos=1");
    await waitFor(() => expect(screen.getByText("add cards screen")).not.toBeNull());
    expect(mocks.calls).toEqual(["reset", "seedLoose"]);
    expect(mocks.seed).not.toHaveBeenCalled();
  });

  it.each(["scanGone", "unusable", "error"])(
    "NEO-427: with savedPhotoFailure=%s, resets, seeds that state and opens the run",
    async (photoFailure) => {
      renderPage(`/testing/seed-placeholder-run?savedPhotoFailure=${photoFailure}`);
      await waitFor(() => expect(screen.getByText("add cards screen")).not.toBeNull());
      expect(mocks.calls).toEqual(["reset", "seedSavedFailure"]);
      expect(mocks.seedSavedFailure).toHaveBeenCalledWith({ photoFailure });
    },
  );

  it("NEO-427: an unknown savedPhotoFailure stops at a status line, touching nothing", async () => {
    renderPage("/testing/seed-placeholder-run?savedPhotoFailure=nope");
    await waitFor(() => expect(screen.getByText(/Error: savedPhotoFailure must be one of/)).not.toBeNull());
    expect(mocks.calls).toEqual([]);
  });

  it("NEO-411: with failedPhoto=1, resets, seeds the failed-photo run and opens it", async () => {
    renderPage("/testing/seed-placeholder-run?failedPhoto=1");
    await waitFor(() => expect(screen.getByText("add cards screen")).not.toBeNull());
    expect(mocks.calls).toEqual(["reset", "seedFailed"]);
    expect(mocks.seed).not.toHaveBeenCalled();
  });

  it("NEO-440: with view=placeholders, opens the seeded batch on the placeholder intake page", async () => {
    renderPage("/testing/seed-placeholder-run?failedPhoto=1&view=placeholders");
    await waitFor(() => expect(screen.getByText("placeholder intake ?jobId=job123")).not.toBeNull());
    expect(mocks.calls).toEqual(["reset", "seedFailed"]);
  });

  it("resets the caller's active jobs before seeding the fixture run", async () => {
    renderPage();
    await waitFor(() => expect(mocks.seed).toHaveBeenCalledTimes(1));
    expect(mocks.calls).toEqual(["reset", "seed"]);
  });

  it("lands on the operator view once the run is seeded", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("operator view")).not.toBeNull(),
    );
  });

  it("stops at a status line if the reset throws, without seeding", async () => {
    mocks.reset = vi.fn(async () => {
      mocks.calls.push("reset");
      throw new Error("Test placeholder cancellation is not enabled on this deployment");
    });
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText(/Error: Test placeholder cancellation is not enabled/),
      ).not.toBeNull(),
    );
    expect(mocks.seed).not.toHaveBeenCalled();
  });

  it("does nothing outside testing mode", async () => {
    vi.stubEnv("VITE_CLERK_TESTING_ENABLED", "false");
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText(/Testing mode is not enabled in this environment\./),
      ).not.toBeNull(),
    );
    expect(mocks.reset).not.toHaveBeenCalled();
    expect(mocks.seed).not.toHaveBeenCalled();
  });
});

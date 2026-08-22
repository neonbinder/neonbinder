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
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authed: true,
  calls: [] as string[],
  reset: vi.fn(),
  seed: vi.fn(),
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
    },
  },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: mocks.authed, isLoading: false }),
  useMutation: (ref: string) =>
    ref === "placeholderPipeline:seedCancelMyActivePlaceholderJobs"
      ? mocks.reset
      : mocks.seed,
}));

import TestingSeedPlaceholderRunPage from "./page";

function renderPage(entry = "/testing/seed-placeholder-run") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/testing/seed-placeholder-run"
          element={<TestingSeedPlaceholderRunPage />}
        />
        <Route path="/pipeline-runs" element={<div>operator view</div>} />
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
    vi.stubEnv("VITE_CLERK_TESTING_ENABLED", "true");
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

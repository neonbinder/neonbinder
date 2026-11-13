/**
 * NEO-481 — the hop that fails one of the caller's real scans, so the
 * hand-crop rescue can be proven live. It must pass the file (and job) through
 * as given, never fail anything without a `file`, and forward where asked.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authed: true,
  fail: vi.fn(),
}));

vi.mock("@/convex/_generated/api", () => ({
  api: { testing: { failMyTestPlaceholderEntry: "testing:failMyTestPlaceholderEntry" } },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: mocks.authed, isLoading: false }),
  useMutation: () => mocks.fail,
}));

import TestingFailPlaceholderEntryPage from "./page";

function ShowWhere() {
  const location = useLocation();
  return <div>landed {location.pathname + location.search}</div>;
}

function renderPage(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/testing/fail-placeholder-entry" element={<TestingFailPlaceholderEntryPage />} />
        <Route path="*" element={<ShowWhere />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("TestingFailPlaceholderEntryPage", () => {
  beforeEach(() => {
    mocks.authed = true;
    mocks.fail = vi.fn(async () => ({ jobId: "job-1", entryIndex: 2, runId: "run-1" }));
    vi.stubEnv("VITE_CLERK_TESTING_ENABLED", "true");
  });

  it("fails the named photo and opens its run's Add cards screen", async () => {
    renderPage("/testing/fail-placeholder-entry?file=front-1.jpg");
    await waitFor(() => expect(screen.getByText("landed /collection?tab=add&run=run-1")).not.toBeNull());
    expect(mocks.fail).toHaveBeenCalledWith({ file: "front-1.jpg" });
  });

  it("passes a job through and fills the redirect's placeholders", async () => {
    renderPage("/testing/fail-placeholder-entry?file=a.jpg&jobId=job-1&redirect=/print/placeholders%3FjobId%3D%7BjobId%7D");
    await waitFor(() => expect(screen.getByText("landed /print/placeholders?jobId=job-1")).not.toBeNull());
    expect(mocks.fail).toHaveBeenCalledWith({ file: "a.jpg", jobId: "job-1" });
  });

  it("with no run, opens the batch's placeholder page", async () => {
    mocks.fail = vi.fn(async () => ({ jobId: "job-2", entryIndex: 0, runId: null }));
    renderPage("/testing/fail-placeholder-entry?file=a.jpg");
    await waitFor(() => expect(screen.getByText("landed /print/placeholders?jobId=job-2")).not.toBeNull());
  });

  it("without a file, fails nothing", async () => {
    renderPage("/testing/fail-placeholder-entry");
    await waitFor(() => expect(screen.getByText(/Missing \?file= parameter/)).not.toBeNull());
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it("outside testing mode, fails nothing", async () => {
    vi.stubEnv("VITE_CLERK_TESTING_ENABLED", "false");
    renderPage("/testing/fail-placeholder-entry?file=a.jpg");
    await waitFor(() => expect(screen.getByText(/Testing mode is not enabled/)).not.toBeNull());
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it("a refusal stays on the page as an error line", async () => {
    mocks.fail = vi.fn(async () => {
      throw new Error("Expected one photo named a.jpg in this batch, found 0");
    });
    renderPage("/testing/fail-placeholder-entry?file=a.jpg");
    await waitFor(() => expect(screen.getByText(/Error: Expected one photo named a.jpg/)).not.toBeNull());
  });
});

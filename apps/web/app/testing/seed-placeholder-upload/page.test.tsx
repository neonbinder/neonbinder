/**
 * NEO-170 — the release E2E's door into the upload path.
 *
 * This page exists because maestro-web cannot drive a file input (`addMedia` on
 * web is a silent no-op stub, so a flow that "attaches" a file passes and
 * uploads nothing). Its entire value is that it bypasses the PICKER and nothing
 * else — so the case that matters is the negative one: that it goes through the
 * same `usePlaceholderUpload` path the product page uses, rather than a
 * test-only shortcut that could stay green while /placeholders was broken.
 *
 * The fixtures themselves are supplied separately; what is asserted here is the
 * manifest contract (both accepted shapes, order preserved) and the redirect.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authed: true,
  // One ordered log across both the reset mutation and the upload, so the
  // reset-precedes-start guarantee can be read directly (the same shared-log
  // technique lib/placeholders/upload-run.test.ts uses for allocation order).
  calls: [] as string[],
  reset: vi.fn(),
  upload: vi.fn(),
  warm: vi.fn(),
}));

// The page reaches the reset through `useMutation`. It is the only mutation this
// page uses, so the mock can ignore the ref and hand back the reset spy.
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: mocks.authed, isLoading: false }),
  useMutation: () => mocks.reset,
}));

vi.mock("@/src/hooks/usePlaceholderUpload", () => ({
  usePlaceholderUpload: () => ({
    upload: mocks.upload,
    progress: [],
    uploading: false,
    reset: vi.fn(),
  }),
}));

// The mount warm-up (its own semantics are covered in
// src/hooks/useWarmPreprocess.test.tsx). Spied here so this page's use of it is
// asserted, and so its real `useAction` call is not needed in this test's Convex
// mock.
vi.mock("@/src/hooks/useWarmPreprocess", () => ({
  useWarmPreprocess: () => mocks.warm(),
}));

import TestingSeedPlaceholderUploadPage from "./page";

/** Serves a manifest plus one body per fixture name. */
function stubFixtures(manifest: unknown, names: string[]) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("manifest.json")) {
      return { ok: true, status: 200, json: async () => manifest } as never;
    }
    const name = url.split("/").pop() ?? "";
    if (!names.includes(name)) {
      return { ok: false, status: 404 } as never;
    }
    return {
      ok: true,
      status: 200,
      blob: async () => new Blob(["jpeg"], { type: "image/jpeg" }),
    } as never;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage(entry = "/testing/seed-placeholder-upload") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/testing/seed-placeholder-upload"
          element={<TestingSeedPlaceholderUploadPage />}
        />
        <Route path="/placeholders" element={<div>run view</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("TestingSeedPlaceholderUploadPage", () => {
  beforeEach(() => {
    mocks.authed = true;
    mocks.calls = [];
    mocks.reset = vi.fn(async () => {
      mocks.calls.push("reset");
      return { canceled: 1, canceledWorkItems: 4 };
    });
    mocks.upload = vi.fn(async () => {
      // Stands in for the whole hook — startPlaceholderStream and the per-file
      // loop — so "upload" in the log marks the moment a slot would be consumed.
      mocks.calls.push("upload");
      return { ok: true, jobId: "job-abcd1234", uploaded: 2, failed: 0, total: 2 };
    });
    mocks.warm = vi.fn();
    vi.stubEnv("VITE_CLERK_TESTING_ENABLED", "true");
    // NEO-188: the page fetches its fixture manifest on mount, so a test that
    // only asserts mount behaviour still issues a request. Default every test
    // to an empty manifest; stubFixtures() overrides it where the body matters.
    stubFixtures({ files: [] }, []);
  });

  it("warms the card processor on mount", () => {
    renderPage();
    // Same mount warm-up as the product page — this is the web upload path with
    // the picker bypassed.
    expect(mocks.warm).toHaveBeenCalled();
  });

  it("uploads the manifest's files, in the manifest's order", async () => {
    stubFixtures({ files: ["front-1.jpg", "back-1.jpg"] }, [
      "front-1.jpg",
      "back-1.jpg",
    ]);
    renderPage();

    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    const files = mocks.upload.mock.calls[0][0] as File[];
    // Order IS the fixture: pairing reads adjacency, so a manifest whose order
    // is not preserved silently pairs the wrong sides together.
    expect(files.map((file) => file.name)).toEqual([
      "front-1.jpg",
      "back-1.jpg",
    ]);
  });

  it("accepts a bare array manifest too", async () => {
    stubFixtures(["a.jpg", "b.jpg"], ["a.jpg", "b.jpg"]);
    renderPage();

    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    const files = mocks.upload.mock.calls[0][0] as File[];
    expect(files.map((file) => file.name)).toEqual(["a.jpg", "b.jpg"]);
  });

  it("redirects to the run view with the new job id", async () => {
    stubFixtures(["a.jpg"], ["a.jpg"]);
    renderPage(
      "/testing/seed-placeholder-upload?redirect=/placeholders%3FjobId%3D{jobId}",
    );

    await waitFor(() => expect(screen.getByText("run view")).not.toBeNull());
  });

  it("defaults to the inset fixture set (placeholder-fixtures)", async () => {
    const fetchMock = stubFixtures(["a.jpg"], ["a.jpg"]);
    renderPage();

    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    // The default set (inset cards → heavy escalation) is fetched from
    // /placeholder-fixtures/, so an entry with no ?fixtures= is unchanged.
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls).toContain("/placeholder-fixtures/manifest.json");
    expect(urls).toContain("/placeholder-fixtures/a.jpg");
  });

  it("uploads the full-bleed set when ?fixtures= selects it", async () => {
    const fetchMock = stubFixtures(["fb.jpg"], ["fb.jpg"]);
    renderPage(
      "/testing/seed-placeholder-upload?fixtures=placeholder-fixtures-fullbleed",
    );

    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    // The frame-filling set (fast path) is served from its own directory.
    expect(urls).toContain("/placeholder-fixtures-fullbleed/manifest.json");
    expect(urls).toContain("/placeholder-fixtures-fullbleed/fb.jpg");
  });

  it("falls back to the default set for an unknown ?fixtures= value", async () => {
    const fetchMock = stubFixtures(["a.jpg"], ["a.jpg"]);
    // A value not on the allowlist must never reach the fetch as a path — it
    // falls back to the default set instead.
    renderPage("/testing/seed-placeholder-upload?fixtures=../../etc/passwd");

    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls).toContain("/placeholder-fixtures/manifest.json");
    expect(urls.some((u) => u.includes("etc/passwd"))).toBe(false);
  });

  it("says which fixture is missing rather than hanging", async () => {
    stubFixtures({ files: ["present.jpg", "absent.jpg"] }, ["present.jpg"]);
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText(/Fixture absent\.jpg is missing \(HTTP 404\)/),
      ).not.toBeNull(),
    );
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("says so when the manifest is not deployed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 }) as never),
    );
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/No fixture manifest at/)).not.toBeNull(),
    );
  });

  it("does nothing at all outside testing mode", async () => {
    vi.stubEnv("VITE_CLERK_TESTING_ENABLED", "false");
    const fetchMock = stubFixtures(["a.jpg"], ["a.jpg"]);
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText(/Testing mode is not enabled in this environment\./),
      ).not.toBeNull(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    // The reset is destructive; it must not fire outside testing mode either.
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it("resets the caller's active jobs BEFORE starting a new one", async () => {
    stubFixtures(["a.jpg"], ["a.jpg"]);
    renderPage();

    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    // The whole point: a stream job holds a slot until it goes terminal, and
    // startPlaceholderStream (inside `upload`) refuses at two active. Cancel
    // first or the flow dies at its first assert after two runs.
    expect(mocks.calls).toEqual(["reset", "upload"]);
    expect(mocks.reset).toHaveBeenCalledTimes(1);
    // This IS the web upload path (picker bypassed), so it labels the run web.
    expect(mocks.upload.mock.calls[0][1]).toEqual({ source: "web" });
  });

  // NOTE: the "Reset N previous sessions." status is deliberately NOT asserted
  // here. It is a real painted state (its `setStatus` is held across the fixture
  // load — see the page), but with instant mocks the flow runs to the redirect
  // before `waitFor` can sample the intermediate string, so asserting it would
  // be racing the scheduler. The E2E flow, with real network latency, sees it;
  // the unit test pins the reset through the call log instead.

  it("still starts on a second consecutive run (idempotent)", async () => {
    // Two runs back to back against the same account is exactly the case that
    // was failing: the first leaves a collecting job, and without the reset the
    // second cannot start. With it, each run resets then starts.
    stubFixtures(["a.jpg"], ["a.jpg"]);

    const first = renderPage();
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    first.unmount();

    stubFixtures(["a.jpg"], ["a.jpg"]);
    renderPage();
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2));

    expect(mocks.reset).toHaveBeenCalledTimes(2);
    // Each run reset before it started — never start-without-reset.
    expect(mocks.calls).toEqual(["reset", "upload", "reset", "upload"]);
  });

  it("surfaces a reset failure as a status line instead of starting", async () => {
    mocks.reset = vi.fn(async () => {
      mocks.calls.push("reset");
      throw new Error("Test placeholder cancellation is not enabled on this deployment");
    });
    stubFixtures(["a.jpg"], ["a.jpg"]);
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText(
          /Error: Test placeholder cancellation is not enabled on this deployment/,
        ),
      ).not.toBeNull(),
    );
    // A reset that throws must stop the flow — starting anyway is the cap
    // failure this whole change exists to prevent.
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});

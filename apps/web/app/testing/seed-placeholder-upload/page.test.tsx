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
  upload: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: mocks.authed, isLoading: false }),
}));

vi.mock("@/src/hooks/usePlaceholderUpload", () => ({
  usePlaceholderUpload: () => ({
    upload: mocks.upload,
    progress: [],
    uploading: false,
    reset: vi.fn(),
  }),
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
    mocks.upload = vi.fn().mockResolvedValue({
      ok: true,
      jobId: "job-abcd1234",
      uploaded: 2,
      failed: 0,
      total: 2,
    });
    vi.stubEnv("VITE_CLERK_TESTING_ENABLED", "true");
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
  });
});

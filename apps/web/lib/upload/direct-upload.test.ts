/**
 * Unit tests for `uploadDirectToStorage` (NEO-148).
 *
 * There's no XMLHttpRequest in the vitest "node" environment this file runs
 * under, so we install a small controllable fake on `globalThis` for the
 * duration of each test and drive it manually — asserting the request was
 * opened as a POST with the policy fields appended (file field LAST, and no
 * manual Content-Type header — the browser must set its own multipart
 * boundary), that progress events flow through, and that non-2xx /
 * network-error / abort all reject with a `DirectUploadError` carrying the
 * right flags.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DirectUploadError, uploadDirectToStorage } from "./direct-upload";

type ProgressHandler = (event: { loaded: number; total: number; lengthComputable: boolean }) => void;

class FakeXHR {
  static instances: FakeXHR[] = [];

  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string> = {};
  status = 0;
  sentBody: unknown;
  aborted = false;

  upload: { onprogress: ProgressHandler | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXHR.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  send(body: unknown) {
    this.sentBody = body;
  }

  abort() {
    this.aborted = true;
    this.onabort?.();
  }

  // Test helpers to drive the fake from outside.
  respond(status: number) {
    this.status = status;
    this.onload?.();
  }

  fail() {
    this.onerror?.();
  }

  progress(loaded: number, total: number, lengthComputable = true) {
    this.upload.onprogress?.({ loaded, total, lengthComputable });
  }
}

beforeEach(() => {
  FakeXHR.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const fakeBody = new Blob(["fake zip bytes"], { type: "application/zip" });
const FAKE_FIELDS = {
  key: "placeholders/user_abc/job-1/input.zip",
  "x-goog-date": "20260813T000000Z",
  "x-goog-credential": "svc@example.iam/20260813/auto/storage/goog4_request",
  "x-goog-algorithm": "GOOG4-RSA-SHA256",
  "Content-Type": "application/zip",
  "x-goog-if-generation-match": "0",
  policy: "base64-policy-doc",
  "x-goog-signature": "deadbeef",
};

function sentFormEntries(xhr: FakeXHR): Array<[string, FormDataEntryValue]> {
  expect(xhr.sentBody).toBeInstanceOf(FormData);
  return Array.from((xhr.sentBody as FormData).entries());
}

describe("uploadDirectToStorage", () => {
  test("opens a POST to the policy URL with no manual Content-Type header", () => {
    void uploadDirectToStorage({
      uploadUrl: "https://storage.googleapis.com/bucket-name/",
      fields: FAKE_FIELDS,
      body: fakeBody,
      filename: "input.zip",
    });

    const xhr = FakeXHR.instances[0];
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("https://storage.googleapis.com/bucket-name/");
    // The browser must compute its own multipart boundary — setting
    // Content-Type by hand here would break that.
    expect(xhr.headers["Content-Type"]).toBeUndefined();
  });

  test("appends every policy field to the form, with the file field LAST", () => {
    void uploadDirectToStorage({
      uploadUrl: "https://storage.googleapis.com/bucket-name/",
      fields: FAKE_FIELDS,
      body: fakeBody,
      filename: "input.zip",
    });

    const entries = sentFormEntries(FakeXHR.instances[0]);
    const keys = entries.map(([key]) => key);

    expect(keys).toEqual([...Object.keys(FAKE_FIELDS), "file"]);
    for (const [key, value] of Object.entries(FAKE_FIELDS)) {
      expect(entries.find(([k]) => k === key)?.[1]).toBe(value);
    }
    const fileEntry = entries[entries.length - 1][1];
    expect(fileEntry).toBeInstanceOf(File);
    expect((fileEntry as File).name).toBe("input.zip");
  });

  test("resolves when GCS responds with a 2xx (POST-policy success is 204 by default)", async () => {
    const promise = uploadDirectToStorage({
      uploadUrl: "https://example.com/upload",
      fields: FAKE_FIELDS,
      body: fakeBody,
      filename: "input.zip",
    });

    FakeXHR.instances[0].respond(204);

    await expect(promise).resolves.toBeUndefined();
  });

  test("rejects with a DirectUploadError carrying the status on a non-2xx response (e.g. 412 generation-match failure)", async () => {
    const promise = uploadDirectToStorage({
      uploadUrl: "https://example.com/upload",
      fields: FAKE_FIELDS,
      body: fakeBody,
      filename: "input.zip",
    });

    FakeXHR.instances[0].respond(412);

    await expect(promise).rejects.toMatchObject({
      name: "DirectUploadError",
      status: 412,
      aborted: false,
    });
    await expect(promise).rejects.toBeInstanceOf(DirectUploadError);
  });

  test("rejects with a DirectUploadError on a network error", async () => {
    const promise = uploadDirectToStorage({
      uploadUrl: "https://example.com/upload",
      fields: FAKE_FIELDS,
      body: fakeBody,
      filename: "input.zip",
    });

    FakeXHR.instances[0].fail();

    await expect(promise).rejects.toMatchObject({ name: "DirectUploadError", aborted: false });
  });

  test("reports progress with a computed fraction when length is computable", () => {
    const onProgress = vi.fn();
    void uploadDirectToStorage({
      uploadUrl: "https://example.com/upload",
      fields: FAKE_FIELDS,
      body: fakeBody,
      filename: "input.zip",
      onProgress,
    });

    FakeXHR.instances[0].progress(50, 200, true);

    expect(onProgress).toHaveBeenCalledWith({ loaded: 50, total: 200, fraction: 0.25 });
  });

  test("reports progress with an undefined total/fraction when length is not computable", () => {
    const onProgress = vi.fn();
    void uploadDirectToStorage({
      uploadUrl: "https://example.com/upload",
      fields: FAKE_FIELDS,
      body: fakeBody,
      filename: "input.zip",
      onProgress,
    });

    FakeXHR.instances[0].progress(50, 0, false);

    expect(onProgress).toHaveBeenCalledWith({ loaded: 50, total: undefined, fraction: undefined });
  });

  test("rejects immediately, without opening a request, when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const promise = uploadDirectToStorage({
      uploadUrl: "https://example.com/upload",
      fields: FAKE_FIELDS,
      body: fakeBody,
      filename: "input.zip",
      signal: controller.signal,
    });

    await expect(promise).rejects.toMatchObject({ name: "DirectUploadError", aborted: true });
    expect(FakeXHR.instances).toHaveLength(0);
  });

  test("aborting the signal mid-flight aborts the XHR and rejects with aborted:true", async () => {
    const controller = new AbortController();
    const promise = uploadDirectToStorage({
      uploadUrl: "https://example.com/upload",
      fields: FAKE_FIELDS,
      body: fakeBody,
      filename: "input.zip",
      signal: controller.signal,
    });

    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "DirectUploadError", aborted: true });
    expect(FakeXHR.instances[0].aborted).toBe(true);
  });
});

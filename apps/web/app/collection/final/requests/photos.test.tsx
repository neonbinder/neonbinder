import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeXhr } from "@/lib/testing/fake-xhr";
import { MAX_PHOTO_BYTES, photoProblem, uploadPhoto } from "./photos";

const file = (type: string, size = 10) => new File([new Uint8Array(size)], "card", { type });

describe("request photos (NEO-361)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("takes the photo types a phone writes, and turns away the rest before upload", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp", "image/heic"]) expect(photoProblem(file(type))).toBeNull();
    expect(photoProblem(file("image/svg+xml"))).toMatch(/isn't a photo/);
    expect(photoProblem(file(""))).toMatch(/isn't a photo/);
    expect(photoProblem(file("image/png", MAX_PHOTO_BYTES + 1))).toMatch(/over 10 MB/);
  });

  it("posts the bytes to a fresh upload URL and hands back the storage id", async () => {
    const xhrs = installFakeXhr();
    const photo = file("image/png");
    const uploaded = uploadPhoto(async () => "https://upload.example/1", photo);
    await vi.waitFor(() => expect(xhrs.all).toHaveLength(1));
    expect(xhrs.last).toMatchObject({ method: "POST", url: "https://upload.example/1", sentBody: photo });
    expect(xhrs.last.headers).toEqual({ "Content-Type": "image/png" });
    xhrs.last.respond(200, JSON.stringify({ storageId: "st1" }));
    expect(await uploaded).toBe("st1");
  });

  it("says so at once when storage refuses the upload", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const xhrs = installFakeXhr();
    const uploaded = uploadPhoto(async () => "u", file("image/png"));
    await vi.waitFor(() => expect(xhrs.all).toHaveLength(1));
    xhrs.last.respond(400);
    await expect(uploaded).rejects.toThrow(/didn't upload/);
    expect(xhrs.all).toHaveLength(1);
    warn.mockRestore();
  });

  it("rides out a one-off storage error (NEO-431)", async () => {
    vi.useFakeTimers();
    try {
      const xhrs = installFakeXhr();
      const uploaded = uploadPhoto(async () => "u", file("image/png"));
      await vi.advanceTimersByTimeAsync(0);
      xhrs.last.respond(503);
      await vi.advanceTimersByTimeAsync(500);
      expect(xhrs.all).toHaveLength(2);
      xhrs.last.respond(200, JSON.stringify({ storageId: "st2" }));
      expect(await uploaded).toBe("st2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the answer a slow server the full timeout, not the short stall windows", async () => {
    vi.useFakeTimers();
    try {
      const xhrs = installFakeXhr();
      const uploaded = uploadPhoto(async () => "u", file("image/png"));
      await vi.advanceTimersByTimeAsync(0);
      // Past both short windows (2.5 s, 5 s) with nothing heard: still waiting.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(xhrs.all).toHaveLength(1);
      expect(xhrs.last.aborted).toBe(false);
      xhrs.last.respond(200, JSON.stringify({ storageId: "slow" }));
      expect(await uploaded).toBe("slow");
    } finally {
      vi.useRealTimers();
    }
  });
});

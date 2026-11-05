import { afterEach, describe, expect, it, vi } from "vitest";
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
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ storageId: "st1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const photo = file("image/png");
    expect(await uploadPhoto(async () => "https://upload.example/1", photo)).toBe("st1");
    expect(fetchMock).toHaveBeenCalledWith("https://upload.example/1", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: photo,
      signal: expect.any(AbortSignal),
    });
  });

  it("says so at once when storage refuses the upload", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response("", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadPhoto(async () => "u", file("image/png"))).rejects.toThrow(/didn't upload/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("rides out a one-off storage error (NEO-431)", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 503 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ storageId: "st2" }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const uploaded = uploadPhoto(async () => "u", file("image/png"));
      await vi.runAllTimersAsync();
      expect(await uploaded).toBe("st2");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

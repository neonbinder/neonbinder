import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnv } from "vite";
import { shouldUploadSentrySourcemaps } from "./sentry-upload-gate";

describe("shouldUploadSentrySourcemaps (NEO-439)", () => {
  it("is off when VERCEL is unset (a local build)", () => {
    expect(shouldUploadSentrySourcemaps({})).toBe(false);
    expect(shouldUploadSentrySourcemaps({ SENTRY_AUTH_TOKEN: "x" })).toBe(false);
  });

  it("is on when the real environment has VERCEL=1 (a hosted build)", () => {
    expect(shouldUploadSentrySourcemaps({ VERCEL: "1" })).toBe(true);
  });

  it("is off for an empty or other VERCEL value", () => {
    expect(shouldUploadSentrySourcemaps({ VERCEL: "" })).toBe(false);
    expect(shouldUploadSentrySourcemaps({ VERCEL: "0" })).toBe(false);
  });

  it("ignores VERCEL=1 that only a .env file carries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-sentry-gate-"));
    try {
      fs.writeFileSync(path.join(dir, ".env.local"), "VERCEL=1\nSENTRY_AUTH_TOKEN=dummy\n");
      // Mirrors vite.config.ts: snapshot first, then merge the .env files.
      const snapshot = { ...process.env, VERCEL: undefined };
      const merged = { ...snapshot, ...loadEnv("production", dir, "") };
      expect(merged.VERCEL).toBe("1");
      expect(shouldUploadSentrySourcemaps(snapshot)).toBe(false);
      expect(shouldUploadSentrySourcemaps(merged)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

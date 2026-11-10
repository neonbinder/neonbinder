import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { e2eDiagnostic } from "@/lib/observability/e2e-diagnostics";
import {
  COPY_PHOTO_TIMING_EVENT,
  flattenCopyPhotoTiming,
  reportCopyPhotoTiming,
  shouldReportCopyPhotoTiming,
  SLOW_SAVE_MS,
  startCopyPhotoTimer,
  type CopyPhotoSaveTiming,
} from "./copy-photo-timing";
import type { UploadAttempt } from "./upload-with-retry";

vi.mock("@/lib/observability/e2e-diagnostics", () => ({ e2eDiagnostic: vi.fn() }));

const attempt = (over: Partial<UploadAttempt> = {}): UploadAttempt => ({
  attempt: 1,
  outcome: "ok",
  status: 200,
  ms: 100,
  host: "primary",
  ...over,
});

const timing = (over: Partial<CopyPhotoSaveTiming> = {}): CopyPhotoSaveTiming => ({
  outcome: "saved",
  totalMs: 500,
  phases: { resize: 100, startUpload: 100, finishUpload: 100 },
  puts: [{ file: "image", ms: 200, bytes: 1000, tries: [attempt()] }],
  ...over,
});

describe("copy photo timing (NEO-466)", () => {
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(e2eDiagnostic).mockClear();
  });
  afterEach(() => warn.mockRestore());

  describe("when a save is reported", () => {
    it("stays silent for a quick save that went through first time", () => {
      reportCopyPhotoTiming(timing());
      expect(warn).not.toHaveBeenCalled();
      expect(e2eDiagnostic).not.toHaveBeenCalled();
    });

    it("stays silent at exactly the slow threshold", () => {
      expect(shouldReportCopyPhotoTiming(timing({ totalMs: SLOW_SAVE_MS }))).toBe(false);
    });

    it("reports a save one millisecond over the threshold", () => {
      expect(shouldReportCopyPhotoTiming(timing({ totalMs: SLOW_SAVE_MS + 1 }))).toBe(true);
    });

    it("reports a save whose file needed a second try", () => {
      const retried = timing({
        puts: [{ file: "thumb", ms: 300, bytes: 10, tries: [attempt({ outcome: "network", status: null }), attempt()] }],
      });
      expect(shouldReportCopyPhotoTiming(retried)).toBe(true);
    });

    it("reports a failed save however fast it failed", () => {
      expect(shouldReportCopyPhotoTiming(timing({ outcome: "failed", totalMs: 5 }))).toBe(true);
    });

    it("counts the add's write toward slow: a quick photo after a slow add is reported", () => {
      expect(shouldReportCopyPhotoTiming(timing({ totalMs: 1_000, addLineItemMs: SLOW_SAVE_MS - 1_000 }))).toBe(false);
      expect(shouldReportCopyPhotoTiming(timing({ totalMs: 1_000, addLineItemMs: SLOW_SAVE_MS - 999 }))).toBe(true);
    });

    it("writes one console line and one diagnostic when it reports", () => {
      reportCopyPhotoTiming(timing({ outcome: "failed", failedAt: "put", errorName: "PhotoUploadError", errorStatus: null }));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({ event: COPY_PHOTO_TIMING_EVENT, outcome: "failed" });
      expect(e2eDiagnostic).toHaveBeenCalledWith(COPY_PHOTO_TIMING_EVENT, expect.objectContaining({ outcome: "failed" }));
    });

    it("never throws when the diagnostic does", () => {
      vi.mocked(e2eDiagnostic).mockImplementationOnce(() => {
        throw new Error("posthog down");
      });
      expect(() => reportCopyPhotoTiming(timing({ outcome: "failed" }))).not.toThrow();
    });
  });

  describe("the report's shape", () => {
    const failed = timing({
      outcome: "failed",
      failedAt: "put",
      errorName: "PhotoUploadError",
      errorStatus: null,
      puts: [
        {
          file: "image",
          ms: 9000,
          bytes: 2048,
          tries: [
            attempt({ outcome: "stall", status: null, stall: "no_progress", ms: 2500 }),
            attempt({ attempt: 2, outcome: "status", status: 503, host: "retry", ms: 80 }),
          ],
        },
      ],
    });

    it("flattens to primitives with a token per try", () => {
      expect(flattenCopyPhotoTiming(failed)).toEqual({
        outcome: "failed",
        total_ms: 500,
        resize_ms: 100,
        start_upload_ms: 100,
        finish_upload_ms: 100,
        image_ms: 9000,
        image_bytes: 2048,
        image_tries: 2,
        image_try_outcomes: "stall:no_progress,status:503@retry",
        image_try_ms: "2500,80",
        failed_at: "put",
        error_name: "PhotoUploadError",
        error_status: null,
      });
    });

    it("carries the add's write as add_line_item_ms, and leaves it out of a save that had none", () => {
      expect(flattenCopyPhotoTiming(timing({ addLineItemMs: 2300 })).add_line_item_ms).toBe(2300);
      expect(flattenCopyPhotoTiming(timing())).not.toHaveProperty("add_line_item_ms");
    });

    it("leaves a phase that never ran as null", () => {
      expect(flattenCopyPhotoTiming(timing({ phases: { resize: 5 } })).start_upload_ms).toBeNull();
    });

    it("carries no URL, token or photo id in the console line or the diagnostic", () => {
      reportCopyPhotoTiming(failed);
      const everything = JSON.stringify([warn.mock.calls, vi.mocked(e2eDiagnostic).mock.calls]);
      expect(everything).not.toMatch(/https?:|X-Amz|token|photoId|Id"/i);
    });
  });

  describe("the timer", () => {
    const makeClock = () => {
      let t = 0;
      return { clock: () => t, tick: (ms: number) => void (t += ms) };
    };

    it("records each phase's duration, including one that throws", async () => {
      const { clock, tick } = makeClock();
      const reports: CopyPhotoSaveTiming[] = [];
      const timer = startCopyPhotoTimer(clock, (t) => reports.push(t));
      await timer.phase("resize", async () => tick(40));
      await expect(
        timer.phase("startUpload", async () => {
          tick(70);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      const done = timer.finish("failed", new Error("boom"));
      expect(done.phases).toEqual({ resize: 40, startUpload: 70 });
      expect(done).toMatchObject({ totalMs: 110, failedAt: "startUpload", errorName: "Error" });
      expect(reports).toEqual([done]);
    });

    it("hands each put an onAttempt that records its tries", async () => {
      const { clock, tick } = makeClock();
      const timer = startCopyPhotoTimer(clock, () => {});
      await timer.put("thumb", 77, async (onAttempt) => {
        onAttempt(attempt({ outcome: "network", status: null }));
        onAttempt(attempt({ attempt: 2 }));
        tick(300);
      });
      const done = timer.finish("saved");
      expect(done.puts).toEqual([
        { file: "thumb", ms: 300, bytes: 77, tries: [expect.objectContaining({ outcome: "network" }), expect.objectContaining({ attempt: 2 })] },
      ]);
    });

    it("blames the part that failed first, and keeps that blame when a later part fails too", async () => {
      const timer = startCopyPhotoTimer(() => 0, () => {});
      await timer.put("image", 1, async () => {}).catch(() => {});
      await expect(timer.put("image", 1, async () => Promise.reject(new Error("first")))).rejects.toThrow("first");
      await expect(timer.phase("finishUpload", async () => Promise.reject(new Error("later")))).rejects.toThrow("later");
      expect(timer.finish("failed", new Error("first")).failedAt).toBe("put");
    });

    it("takes the error's status, null included, and never its message", () => {
      const timer = startCopyPhotoTimer(() => 0, () => {});
      const error = Object.assign(new Error("secret https://x"), { name: "PhotoUploadError", status: null });
      const done = timer.finish("failed", error);
      expect(done).toMatchObject({ errorName: "PhotoUploadError", errorStatus: null });
      expect(JSON.stringify(done)).not.toContain("secret");
    });

    it("omits error fields on a saved outcome", () => {
      const done = startCopyPhotoTimer(() => 0, () => {}).finish("saved");
      expect(done).not.toHaveProperty("errorName");
      expect(done).not.toHaveProperty("failedAt");
    });

    it("records the add's write it was given, rounded, without counting it in totalMs", () => {
      const { clock, tick } = makeClock();
      const timer = startCopyPhotoTimer(clock, () => {}, 2300.4);
      tick(900);
      expect(timer.finish("saved")).toMatchObject({ totalMs: 900, addLineItemMs: 2300 });
      expect(startCopyPhotoTimer(() => 0, () => {}).finish("saved")).not.toHaveProperty("addLineItemMs");
    });

    it("still returns the record when the reporter throws", () => {
      const timer = startCopyPhotoTimer(
        () => 0,
        () => {
          throw new Error("x");
        },
      );
      expect(timer.finish("saved").outcome).toBe("saved");
    });
  });
});

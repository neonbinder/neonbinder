/**
 * NEO-409 — what the page was doing when a test went red.
 *
 * The E2E reds left are hangs: a save that never resolves, a query that never
 * delivers. The failure screenshot shows a spinner. This keeps the page's
 * console and uncaught errors in memory and, only when a test fails,
 * attaches three things to it:
 *
 *   console        every console line and page error, oldest first;
 *   convex open calls  `window.__NB_HANG.snapshot()`: each Convex call still
 *                  open at the moment of failure (function name, args hash,
 *                  how long), the socket and token state, and the Convex
 *                  client's own last log lines;
 *   (both redacted: Clerk testing tokens, bearer tokens and JWTs are cut).
 *
 * The snapshot exists only on E2E builds (VITE_CLERK_TESTING_ENABLED); see
 * lib/observability/convex-hang-detector.ts. Used by ./fixtures.ts only.
 */
import type { Page, TestInfo } from "@playwright/test";
import { redactLine } from "../../lib/observability/convex-hang-detector";

/** Lines kept per page; the oldest drop first. */
export const CONSOLE_LINE_LIMIT = 3_000;
const MAX_LINE_LENGTH = 2_000;
/** The console attachment keeps its newest lines up to this many bytes. */
export const CONSOLE_BODY_LIMIT = 512 * 1024;
const SNAPSHOT_TIMEOUT_MS = 5_000;

export type PageDiagnostics = {
  lines(): string[];
  attachOnFailure(testInfo: TestInfo): Promise<void>;
};

export function capturePageDiagnostics(page: Page): PageDiagnostics {
  const started = Date.now();
  const lines: string[] = [];
  const push = (kind: string, text: string) => {
    const at = ((Date.now() - started) / 1000).toFixed(3).padStart(8);
    lines.push(`${at}s ${kind.padEnd(7)} ${redactLine(text).slice(0, MAX_LINE_LENGTH)}`);
    if (lines.length > CONSOLE_LINE_LIMIT) lines.splice(0, lines.length - CONSOLE_LINE_LIMIT);
  };

  page.on("console", (msg) => push(msg.type(), msg.text()));
  page.on("pageerror", (error) => push("pageerr", `${error.name}: ${error.message}`));
  page.on("crash", () => push("crash", "page crashed"));

  return {
    lines: () => [...lines],
    async attachOnFailure(testInfo) {
      if (testInfo.status === testInfo.expectedStatus) return;

      const snapshot = await openCallsSnapshot(page);
      await testInfo.attach("convex open calls", {
        body: redactLine(JSON.stringify(snapshot, null, 2)),
        contentType: "application/json",
      });
      await testInfo.attach("console", {
        body: consoleBody(lines),
        contentType: "text/plain",
      });
    },
  };
}

/** The newest lines that fit the byte cap, saying how many were dropped. */
export function consoleBody(lines: string[]): string {
  if (lines.length === 0) return "(no console output)";
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(lines[i]) + 1;
    if (bytes + size > CONSOLE_BODY_LIMIT) break;
    kept.push(lines[i]);
    bytes += size;
  }
  kept.reverse();
  const dropped = lines.length - kept.length;
  return (dropped > 0 ? `(... ${dropped} earlier lines dropped)\n` : "") + kept.join("\n");
}

/**
 * Reads the detector's snapshot. The page's JS is not hung when a call is
 * (it is awaiting), so this normally answers at once; a closed or crashed
 * page, or a build without the detector, says so instead.
 */
export async function openCallsSnapshot(page: Page): Promise<unknown> {
  if (page.isClosed()) return { unavailable: "page closed" };
  const read = page
    .evaluate(() => {
      const hang = (window as unknown as { __NB_HANG?: { snapshot(): unknown } }).__NB_HANG;
      return hang ? hang.snapshot() : { unavailable: "no hang detector on this page" };
    })
    .catch((error: unknown) => ({
      unavailable: `snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ unavailable: `snapshot timed out after ${SNAPSHOT_TIMEOUT_MS} ms` }),
      SNAPSHOT_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * NEO-409 hang-detector exception (GUIDE rule 9).
 *
 * The one place in the suite that intercepts the Convex WebSocket. It exists
 * for `diagnostics/convex-hang-detector-names-a-stalled-save` ONLY: to prove,
 * on a real E2E build, that a Convex call which never returns is named by the
 * hang detector (lib/observability/convex-hang-detector.ts) with the socket
 * state around it. A hang has no role, label or text handle, so the check
 * reads the page console and `window.__NB_HANG` instead. Nothing else may
 * import this file (eslint.config.mjs fences it).
 *
 * How it stalls: every frame is forwarded both ways untouched, except client
 * `Mutation` frames whose function path contains `udfPathPart` (the first,
 * and any resend after a reconnect), which are swallowed. The server never sees that mutation, so nothing is
 * written, and the socket stays healthy (pings and transitions keep
 * flowing): exactly the shape of the E2E reds, an await that never resolves
 * on a live socket.
 */
import type { ConsoleMessage, Page } from "@playwright/test";
import { openCallsSnapshot } from "./hang-capture";

/** The Convex sync socket: wss://<deployment>/api/<version>/sync. */
const CONVEX_SYNC = /\/api\/[^/]+\/sync$/;

export type StalledMutation = {
  /** Resolves with the swallowed frame's function path. */
  swallowed: Promise<string>;
};

/** Call before the first navigation: the route only sees sockets opened after it. */
export async function stallFirstMutation(page: Page, udfPathPart: string): Promise<StalledMutation> {
  let resolveSwallowed: (path: string) => void = () => {};
  const swallowed = new Promise<string>((resolve) => {
    resolveSwallowed = resolve;
  });
  let done = false;

  await page.routeWebSocket(CONVEX_SYNC, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (typeof message === "string") {
        const frame = parse(message);
        if (frame?.type === "Mutation" && typeof frame.udfPath === "string" && frame.udfPath.includes(udfPathPart)) {
          if (!done) {
            done = true;
            resolveSwallowed(frame.udfPath);
          }
          // Never forwarded, including the resend a reconnect makes of every
          // in-flight mutation, so the write can never land (R7).
          return;
        }
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });

  return { swallowed };
}

/** The swallowed frame's path, or a clear failure if the save never sent one. */
export async function swallowedWithin(stall: StalledMutation, udfPathPart: string, timeout: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no ${udfPathPart} mutation was sent within ${timeout} ms (renamed?)`)),
      timeout,
    );
  });
  try {
    return await Promise.race([stall.swallowed, late]);
  } finally {
    clearTimeout(timer);
  }
}

function parse(message: string): { type?: unknown; udfPath?: unknown } | null {
  try {
    return JSON.parse(message) as { type?: unknown; udfPath?: unknown };
  } catch {
    return null;
  }
}

/** The hang record the detector prints for `udfPathPart`, parsed. */
export async function waitForHangRecord(
  page: Page,
  udfPathPart: string,
  timeout: number,
): Promise<Record<string, unknown>> {
  const message: ConsoleMessage = await page.waitForEvent("console", {
    predicate: (msg) => msg.text().startsWith("[nb-hang] ") && msg.text().includes(udfPathPart),
    timeout,
  });
  return JSON.parse(message.text().slice("[nb-hang] ".length)) as Record<string, unknown>;
}

export { openCallsSnapshot };

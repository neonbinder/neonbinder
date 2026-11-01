import type { ConvexReactClient } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";

/**
 * NEO-409 — the E2E hang detector.
 *
 * The E2E reds left after NEO-385/392/410/411 are hangs in the browser: a
 * save whose `useMutation` await never resolves, a `useQuery` that never
 * delivers. A screenshot shows the spinner and nothing else. This module
 * names the call that never returned, with the client's socket and token
 * state around it, so the next red carries its own evidence.
 *
 * Under E2E only (the provider decides), it:
 *
 * - wraps one Convex client's `mutation`, `action` and `watchQuery` so every
 *   call is registered when sent and cleared when it settles (a subscription
 *   settles at its first result or error, or when it is dropped);
 * - is the client's logger, so the Convex client's own lines (socket opens and
 *   closes, the pause for a Clerk token fetch, server messages) land in a
 *   bounded buffer and the page console;
 * - checks once a second, and prints one `[nb-hang]` line for any call open
 *   past the threshold, with the state at that moment;
 * - exposes {@link HangDetector.snapshot} as `window.__NB_HANG.snapshot()`, so
 *   the Playwright fixture can list the open calls at the moment a test fails.
 *
 * It measures nothing and changes nothing: calls pass straight through, and
 * a failure inside the detector is swallowed. Args are never recorded, only a
 * hash of them, because the report is public.
 */

export type CallKind = "mutation" | "action" | "query";

export type OpenCall = {
  id: number;
  kind: CallKind;
  name: string;
  argsHash: string;
  /** Which client built it: the provider rebuilds the client on a wedge (NEO-84). */
  generation: number;
  startedAtMs: number;
  reported: boolean;
};

export type ClientState = {
  /** `connectionState()` of the newest client, or null if it could not be read. */
  connection: Record<string, unknown> | null;
  /** True between "pausing WS for auth token fetch" and its resume. */
  authPaused: boolean;
  /** True between "attempting to reauthenticate" (server rejected the token) and its outcome. */
  reauthenticating: boolean;
  /** The last auth line the client logged, and how long ago. */
  lastAuthLine: string | null;
  msSinceLastAuthLine: number | null;
  msSinceLastServerMessage: number | null;
  msSinceLastTransition: number | null;
};

export type HangRecord = {
  kind: CallKind;
  name: string;
  argsHash: string;
  generation: number;
  openForMs: number;
  openCalls: number;
  state: ClientState;
};

export type HangSnapshot = {
  atMs: number;
  hangAfterMs: number;
  openCalls: Array<Omit<OpenCall, "reported" | "startedAtMs"> & { openForMs: number }>;
  state: ClientState;
  /** The client's last log lines, oldest first. */
  recentLines: string[];
};

/** The shape of the Convex client's `logger` option (convex/browser Logger). */
export type ConvexLogger = {
  logVerbose(...args: unknown[]): void;
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

export type HangDetector = {
  logger: ConvexLogger;
  attach(client: ConvexReactClient, generation: number): void;
  /** Runs the once-a-second check now. Exposed for tests. */
  check(): void;
  snapshot(): HangSnapshot;
  stop(): void;
};

export const DEFAULT_HANG_AFTER_MS = 5_000;
export const RECENT_LINE_LIMIT = 300;
const MAX_LINE_LENGTH = 500;

type Sink = Pick<Console, "debug" | "log" | "warn" | "error">;

export type HangDetectorOptions = {
  hangAfterMs?: number;
  now?: () => number;
  sink?: Sink;
  /** Called once per hang, after the console line. */
  onHang?: (record: HangRecord) => void;
  /** Start the once-a-second interval. Off in tests that drive `check()`. */
  autoCheck?: boolean;
};

/**
 * FNV-1a over the JSON of the args: tells calls apart without recording them.
 * Not a privacy boundary: 32 bits of short args can be brute-forced. Fine
 * for E2E test-account data, which is all this ever sees.
 */
export function hashArgs(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args ?? {}) ?? "";
  } catch {
    return "unhashable";
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Strips what must never reach a public report: Clerk testing, dev-browser
 * and session tokens in URLs (plain or %3D-encoded), bearer tokens, and
 * anything shaped like a JWT.
 */
export function redactLine(line: string): string {
  return line
    .replace(
      /(__clerk_testing_token|__clerk_db_jwt|__session|__client_uat|__client)(=|%3D)[^&\s"';]*/gi,
      "$1$2[redacted]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[jwt]");
}

function stringify(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

function nameOf(fn: unknown): string {
  try {
    return getFunctionName(fn as FunctionReference<"query" | "mutation" | "action">);
  } catch {
    return "unknown";
  }
}

export function createHangDetector(options: HangDetectorOptions = {}): HangDetector {
  const hangAfterMs = options.hangAfterMs ?? DEFAULT_HANG_AFTER_MS;
  const now = options.now ?? (() => performance.now());
  const sink: Sink = options.sink ?? console;

  const open = new Map<number, OpenCall>();
  let nextId = 1;
  const lines: string[] = [];
  /** The client that last carried a call (the first attached until then). */
  let client: ConvexReactClient | null = null;
  let authPaused = false;
  let reauthenticating = false;
  /** Generation of `client`: a swap (NEO-84) moves the snapshot to the new client. */
  let clientGeneration = -1;
  let lastAuthLine: string | null = null;
  let lastAuthAt: number | null = null;
  let lastServerMessageAt: number | null = null;
  let lastTransitionAt: number | null = null;

  const remember = (level: string, text: string) => {
    const line = `${Math.round(now())}ms ${level} ${redactLine(text).slice(0, MAX_LINE_LENGTH)}`;
    lines.push(line);
    if (lines.length > RECENT_LINE_LIMIT) lines.splice(0, lines.length - RECENT_LINE_LIMIT);
  };

  const track = (text: string) => {
    // A large update arrives as TransitionChunk frames and is then logged once
    // as an assembled Transition; both count.
    const message = text.match(/(?:received ws message|assembled full ws message) (?:with|of) type (\w+)/);
    if (message) {
      lastServerMessageAt = now();
      if (message[1] === "Transition") lastTransitionAt = lastServerMessageAt;
      return true;
    }
    if (/auth|token/i.test(text)) {
      lastAuthLine = redactLine(text).slice(0, MAX_LINE_LENGTH);
      lastAuthAt = now();
      if (text.includes("pausing WS for auth token fetch")) authPaused = true;
      if (
        text.includes("resuming WS after auth token fetch") ||
        text.includes("restarting WS after auth token fetch")
      ) {
        authPaused = false;
      }
      // A rejected token stops the socket and refetches without a "pausing" line.
      if (text.includes("attempting to reauthenticate")) reauthenticating = true;
      if (
        text.includes("server confirmed new auth token is valid") ||
        text.includes("reauthentication failed")
      ) {
        reauthenticating = false;
      }
    }
    return false;
  };

  const safely = (fn: () => void) => {
    try {
      fn();
    } catch {
      // The detector must never break the client it watches.
    }
  };

  const logger: ConvexLogger = {
    logVerbose: (...args) =>
      safely(() => {
        const text = stringify(args);
        remember("debug", text);
        // One line per server message would flood the console; those are kept
        // in the buffer and the timestamps only.
        if (!track(text)) sink.debug(`[convex] ${redactLine(text)}`);
      }),
    log: (...args) =>
      safely(() => {
        remember("info", stringify(args));
        sink.log(...args);
      }),
    warn: (...args) =>
      safely(() => {
        remember("warn", stringify(args));
        sink.warn(...args);
      }),
    error: (...args) =>
      safely(() => {
        remember("error", stringify(args));
        sink.error(...args);
      }),
  };

  const since = (at: number | null) => (at === null ? null : Math.round(now() - at));

  // The client a call was made on. In development React builds the provider's
  // client twice (StrictMode) and uses one, so "the newest client" can be one
  // that never opened a socket; the client that carries calls is the live one.
  const clientOf = new Map<number, ConvexReactClient>();

  const state = (of: ConvexReactClient | null = client): ClientState => {
    let connection: Record<string, unknown> | null = null;
    try {
      connection = of ? { ...of.connectionState() } : null;
      if (connection && connection.timeOfOldestInflightRequest instanceof Date) {
        connection.timeOfOldestInflightRequest = connection.timeOfOldestInflightRequest.toISOString();
      }
    } catch {
      connection = null;
    }
    return {
      connection,
      authPaused,
      reauthenticating,
      lastAuthLine,
      msSinceLastAuthLine: since(lastAuthAt),
      msSinceLastServerMessage: since(lastServerMessageAt),
      msSinceLastTransition: since(lastTransitionAt),
    };
  };

  const register = (
    target: ConvexReactClient,
    kind: CallKind,
    name: string,
    args: unknown,
    generation: number,
  ) => {
    const id = nextId++;
    client = target;
    clientGeneration = Math.max(clientGeneration, generation);
    clientOf.set(id, target);
    open.set(id, {
      id,
      kind,
      name,
      argsHash: hashArgs(args),
      generation,
      startedAtMs: now(),
      reported: false,
    });
    return () => {
      open.delete(id);
      clientOf.delete(id);
    };
  };

  // `finally` hands the caller a promise that still rejects, so a caller
  // that ignores it (`void ensureOptions(...)`) still raises an unhandled
  // rejection for PostHog and the page-error capture, exactly as before.
  const settleWith = <T>(promise: Promise<T>, clear: () => void): Promise<T> =>
    promise.finally(clear);

  const attach = (target: ConvexReactClient, generation: number) =>
    safely(() => attachTo(target, generation));

  const attachTo = (target: ConvexReactClient, generation: number) => {
    // The first client of a generation stands in until a call lands: React
    // StrictMode builds a spare of the same generation (ignored), and a swap
    // brings a higher one, which replaces the closed client. Note that
    // connectionState() on a client that never carried a call opens its socket.
    if (generation > clientGeneration) {
      client = target;
      clientGeneration = generation;
    }
    const mutation = target.mutation.bind(target);
    const action = target.action.bind(target);
    const watchQuery = target.watchQuery.bind(target);
    const patch = target as unknown as Record<string, unknown>;

    patch.mutation = (fn: unknown, ...rest: unknown[]) => {
      const promise = (mutation as (...a: unknown[]) => Promise<unknown>)(fn, ...rest);
      let clear = () => {};
      safely(() => {
        clear = register(target, "mutation", nameOf(fn), rest[0], generation);
      });
      return settleWith(promise, clear);
    };

    patch.action = (fn: unknown, ...rest: unknown[]) => {
      const promise = (action as (...a: unknown[]) => Promise<unknown>)(fn, ...rest);
      let clear = () => {};
      safely(() => {
        clear = register(target, "action", nameOf(fn), rest[0], generation);
      });
      return settleWith(promise, clear);
    };

    // useQuery, client.query and prewarmQuery all subscribe through here.
    // watchPaginatedQuery is not wrapped: only usePaginatedQuery_experimental
    // uses it, and the app does not. A
    // subscription is open from its first listener until it has a result or
    // an error, or until the listener is dropped (the screen moved on).
    patch.watchQuery = (fn: unknown, ...rest: unknown[]) => {
      const watch = (watchQuery as (...a: unknown[]) => ReturnType<ConvexReactClient["watchQuery"]>)(
        fn,
        ...rest,
      );
      const onUpdate = watch.onUpdate;
      const settled = () => {
        try {
          return watch.localQueryResult() !== undefined;
        } catch {
          return true; // an error result is a settled call
        }
      };
      watch.onUpdate = (callback) => {
        let clear: (() => void) | null = null;
        safely(() => {
          if (!settled()) clear = register(target, "query", nameOf(fn), rest[0], generation);
        });
        const unsubscribe = onUpdate((...cbArgs: unknown[]) => {
          if (clear) {
            const done = clear;
            safely(() => {
              if (settled()) {
                done();
                clear = null;
              }
            });
          }
          (callback as (...a: unknown[]) => void)(...cbArgs);
        });
        return () => {
          clear?.();
          clear = null;
          unsubscribe();
        };
      };
      return watch;
    };
  };

  const check = () =>
    safely(() => {
      const at = now();
      for (const call of open.values()) {
        const openForMs = Math.round(at - call.startedAtMs);
        if (call.reported || openForMs < hangAfterMs) continue;
        call.reported = true;
        const record: HangRecord = {
          kind: call.kind,
          name: call.name,
          argsHash: call.argsHash,
          generation: call.generation,
          openForMs,
          openCalls: open.size,
          state: state(clientOf.get(call.id) ?? client),
        };
        sink.warn(`[nb-hang] ${JSON.stringify(record)}`);
        options.onHang?.(record);
      }
    });

  const timer =
    options.autoCheck === false ? null : setInterval(check, Math.min(1_000, hangAfterMs));

  const snapshot = (): HangSnapshot => {
    const at = now();
    return {
      atMs: Math.round(at),
      hangAfterMs,
      openCalls: [...open.values()]
        .map(({ reported: _reported, startedAtMs, ...call }) => ({
          ...call,
          openForMs: Math.round(at - startedAtMs),
        }))
        .sort((a, b) => b.openForMs - a.openForMs),
      state: state(),
      recentLines: [...lines],
    };
  };

  return {
    logger,
    attach,
    check,
    snapshot,
    stop: () => {
      if (timer !== null) clearInterval(timer);
    },
  };
}

/**
 * The threshold the Playwright fixture may lower for one test (the
 * detector's own spec stalls a save on purpose). Clamped so a typo cannot
 * silence it or make every call a "hang".
 */
export function hangAfterMsFrom(source: unknown): number {
  if (!source || typeof source !== "object") return DEFAULT_HANG_AFTER_MS;
  const value = (source as Record<string, unknown>).hang_after_ms;
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_HANG_AFTER_MS;
  return Math.min(60_000, Math.max(1_000, Math.round(value)));
}

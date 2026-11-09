/**
 * NEO-475 — why a BuySportsCards call failed, and how long BSC calls take.
 *
 * A pure recorder the BSC adapters wrap around each `fetch`. No Convex imports
 * (types excepted), no I/O of its own beyond the log sink it is given, so it is
 * safe in both the Node actions (`adapters/buysportscards.ts`) and the
 * default-runtime seller client (`adapters/bscSeller.ts`).
 *
 * One recorder per action invocation (or seller session):
 *
 *   const rec = createBscRecorder("fetchBscCardTeamNames", { deployment: deploymentName() });
 *   const tok = rec.start({ pathTemplate: "marketplace/card/:id/card-listing", bscCardId });
 *   try {
 *     const resp = await fetch(url, { signal: AbortSignal.timeout(ms) });
 *     rec.respond(tok, resp);            // 2xx -> ok; anything else -> http failure
 *     ...
 *     const data = await resp.json();   // the body was never touched (see below)
 *   } catch (err) {
 *     rec.fail(tok, { error: err });     // timeout | network, classified for you
 *     throw err;                         // behaviour unchanged
 *   }
 *   ...
 *   const out = await rec.flush();       // once, when the invocation ends
 *   if (out) await ctx.scheduler.runAfter(0, internal.bscCallStats.record, out.row);
 *
 * Phases after the headers (a body that times out, a 2xx body that will not
 * parse) call `rec.fail(tok, { kind: "body_timeout" | "parse", error })` on the
 * SAME token: a call already counted ok is converted to a failure, its latency
 * (to headers) kept, so `calls` never double-counts.
 *
 * Emits, exactly:
 *  - `bsc_call_failed` (console.warn JSON), at most {@link MAX_DETAIL_LINES} per
 *    recorder; the rest are only counted in `suppressed`;
 *  - one `bsc_call_summary` (console.log JSON) on `flush`.
 *
 * Safety (the repo and the CI artifacts are public):
 *  - the response body is read ONLY from `response.clone()`, at most 4 KB, and
 *    the clone is cancelled; the caller's response stays fully readable;
 *  - bodies pass through {@link scrubBscBody}, headers through
 *    {@link pickBscHeaders} (allowlist). No request header, token, credential or
 *    seller id is ever logged;
 *  - nothing here throws into the caller: telemetry must not be able to change
 *    a result, a timeout, a retry or an error message.
 *
 * The in-flight counter ({@link bscInflight}) is module-level, so it sees only
 * the calls of the one isolate it runs in: a LOWER BOUND on deployment-wide
 * concurrency.
 */

/** Why a call failed. Mirrors `bscCallKindValidator` in schema.ts. */
export type BscCallKind = "http" | "timeout" | "body_timeout" | "network" | "parse";

/** Upper edges of the latency buckets (ms). Fixed forever: see bscCallStats.ts. */
export const BSC_LATENCY_BUCKET_EDGES_MS = [
  100, 250, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000,
] as const;
export const BSC_LATENCY_BUCKET_COUNT = BSC_LATENCY_BUCKET_EDGES_MS.length + 1;

/** Detail lines per recorder; more are counted in `suppressed`. */
export const MAX_DETAIL_LINES = 10;
/** Failure samples kept for the table row. */
export const MAX_SAMPLES = 5;
/** Bytes read from a non-2xx clone. */
export const MAX_BODY_READ_BYTES = 4096;
/** Bytes of scrubbed body logged. */
export const MAX_BODY_LOG_BYTES = 500;
/** Longest a header value may be. */
export const MAX_HEADER_VALUE_CHARS = 200;
/** How long the background clone read may take before it is abandoned. */
export const BODY_READ_DEADLINE_MS = 2000;

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

const JSON_KEPT_KEYS = new Set(["message", "error", "title", "code", "status"]);
const MAX_JSON_KEYS = 20;
const MAX_JSON_DEPTH = 3;

/** Order matters: the specific shapes go before the generic runs. */
const REDACTIONS: Array<[RegExp, string]> = [
  [/eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, "[jwt]"],
  [/\bBearer\s+\S+/gi, "Bearer [token]"],
  [
    /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|secret|password|passwd|authorization|cookie|session[_-]?id)(["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi,
    "$1$2[redacted]",
  ],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[uuid]"],
  [/[A-Za-z0-9_\-+/=]{32,}/g, "[opaque]"],
  [/\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/g, "[num]"],
  [/\d{7,}/g, "[num]"],
];

function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function collapse(text: string): string {
  return text.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

/** Cut to at most `maxBytes` of UTF-8, never splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  const cut = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, maxBytes));
  return cut.replace(/�+$/, "");
}

type Walked = { keys: string[]; kept: Array<[string, string]> };

function walkJson(value: unknown, depth: number, acc: Walked): void {
  if (depth > MAX_JSON_DEPTH || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 5)) walkJson(item, depth + 1, acc);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (acc.keys.length < MAX_JSON_KEYS && !acc.keys.includes(key)) acc.keys.push(key);
    const lower = key.toLowerCase();
    if (
      JSON_KEPT_KEYS.has(lower) &&
      (typeof child === "string" || typeof child === "number" || typeof child === "boolean")
    ) {
      acc.kept.push([lower, String(child)]);
    }
    walkJson(child, depth + 1, acc);
  }
}

/** Truncated JSON cannot be parsed; pull the same things out with patterns. */
function lenientJson(raw: string): Walked {
  const acc: Walked = { keys: [], kept: [] };
  for (const m of raw.matchAll(/"([A-Za-z_][\w-]{0,40})"\s*:/g)) {
    if (acc.keys.length < MAX_JSON_KEYS && !acc.keys.includes(m[1])) acc.keys.push(m[1]);
  }
  const kept = /"(message|error|title|code|status)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false)/gi;
  for (const m of raw.matchAll(kept)) {
    let value = m[2];
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    }
    acc.kept.push([m[1].toLowerCase(), value]);
  }
  return acc;
}

function renderJson(acc: Walked): string {
  const parts: string[] = [];
  if (acc.keys.length > 0) parts.push(`keys=[${acc.keys.map((k) => redact(k.slice(0, 40))).join(",")}]`);
  for (const [key, value] of acc.kept.slice(0, 8)) parts.push(`${key}=${JSON.stringify(collapse(value).slice(0, 200))}`);
  return parts.join(" ");
}

function renderMarkup(raw: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1];
  const body = raw
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>?/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
  const text = collapse(body);
  const head = title ? `title=${JSON.stringify(collapse(title).slice(0, 120))}` : "";
  return [head, text].filter(Boolean).join(" ");
}

/**
 * Turn a (possibly truncated) non-2xx response body into a short string that is
 * safe to publish.
 *
 *  - JSON: only the NAMES of keys, plus the values of `message`, `error`,
 *    `title`, `code` and `status`. Every other value is dropped, which covers
 *    seller bodies.
 *  - HTML/text: tags stripped, `<title>` kept.
 *  - Then JWTs, bearer tokens, `token=…`-style pairs, emails, UUIDs, opaque
 *    runs of 32+ characters and digit runs of 7+ are replaced.
 *  - Truncated to {@link MAX_BODY_LOG_BYTES} bytes AFTER scrubbing, so a cut
 *    can never split a secret in two and leave half of it.
 */
export function scrubBscBody(raw: string, contentType?: string | null): string {
  try {
    const text = raw.trim();
    if (!text) return "";
    const looksJson = /json/i.test(contentType ?? "") || /^[{[]/.test(text);
    let rendered: string;
    if (looksJson && /^[{[]/.test(text)) {
      let walked: Walked;
      try {
        walked = { keys: [], kept: [] };
        walkJson(JSON.parse(text), 0, walked);
      } catch {
        walked = lenientJson(text);
      }
      rendered = renderJson(walked);
    } else {
      rendered = renderMarkup(text);
    }
    return truncateUtf8(redact(rendered), MAX_BODY_LOG_BYTES);
  } catch {
    return "";
  }
}

const HEADER_ALLOWLIST = new Set([
  "server",
  "via",
  "x-cache",
  "retry-after",
  "cf-ray",
  "x-amz-cf-id",
  "x-amz-cf-pop",
  "x-request-id",
  "content-type",
  "content-length",
]);
const MAX_AMZN_HEADERS = 8;

type HeadersLike = { forEach(cb: (value: string, key: string) => void): void } | Record<string, string>;

/**
 * Response headers worth keeping, by allowlist only. Anything else (set-cookie,
 * authorization, x-user-*, …) is never copied. Each value is capped at
 * {@link MAX_HEADER_VALUE_CHARS}.
 */
export function pickBscHeaders(headers: HeadersLike | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  let amzn = 0;
  const take = (rawKey: string, rawValue: unknown): void => {
    if (typeof rawValue !== "string") return;
    const key = rawKey.toLowerCase();
    const isAmzn = key.startsWith("x-amzn-");
    if (!HEADER_ALLOWLIST.has(key) && !isAmzn) return;
    if (isAmzn) {
      if (amzn >= MAX_AMZN_HEADERS) return;
      amzn += 1;
    }
    out[key] = collapse(rawValue).slice(0, MAX_HEADER_VALUE_CHARS);
  };
  if (typeof (headers as { forEach?: unknown }).forEach === "function") {
    (headers as { forEach(cb: (value: string, key: string) => void): void }).forEach((value, key) => take(key, value));
  } else {
    for (const [key, value] of Object.entries(headers as Record<string, string>)) take(key, value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Histogram helpers (mirrored in scripts/bsc-health/histogram.mjs; both are
// covered by the same test vectors)
// ---------------------------------------------------------------------------

export type BscLatency = { min: number; max: number; sum: number; buckets: number[] };

export type BscSummaryLine = {
  op: string;
  deployment?: string;
  /** Epoch ms. */
  startedAt: number;
  endedAt: number;
  calls: number;
  ok: number;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  maxInflight: number;
  suppressed: number;
  lat: BscLatency;
};

export function emptyLatency(): BscLatency {
  return { min: 0, max: 0, sum: 0, buckets: new Array<number>(BSC_LATENCY_BUCKET_COUNT).fill(0) };
}

/** Bucket index for a duration: the first edge it does not exceed, else overflow. */
export function bucketIndex(ms: number): number {
  for (let i = 0; i < BSC_LATENCY_BUCKET_EDGES_MS.length; i++) {
    if (ms <= BSC_LATENCY_BUCKET_EDGES_MS[i]) return i;
  }
  return BSC_LATENCY_BUCKET_EDGES_MS.length;
}

function bucketTotal(buckets: number[]): number {
  return buckets.reduce((a, b) => a + b, 0);
}

/**
 * Estimated percentile (`p` in 0..1) from fixed buckets, interpolating inside
 * the bucket the rank falls in and clamping to the observed min/max. `null`
 * when there are no observations. An estimate, not an exact value.
 */
export function percentile(lat: BscLatency, p: number): number | null {
  const total = bucketTotal(lat.buckets);
  if (total <= 0) return null;
  const rank = Math.min(Math.max(p, 0), 1) * total;
  let before = 0;
  for (let i = 0; i < lat.buckets.length; i++) {
    const n = lat.buckets[i];
    if (n > 0 && before + n >= rank) {
      const lower = i === 0 ? 0 : BSC_LATENCY_BUCKET_EDGES_MS[i - 1];
      const upper = i < BSC_LATENCY_BUCKET_EDGES_MS.length ? BSC_LATENCY_BUCKET_EDGES_MS[i] : lat.max;
      const frac = (rank - before) / n;
      const estimate = lower + frac * (Math.max(upper, lower) - lower);
      return Math.round(Math.min(Math.max(estimate, lat.min), lat.max));
    }
    before += n;
  }
  return lat.max;
}

function addCounts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n;
  return out;
}

/**
 * Merge two summaries: counts add, `maxInflight`/`lat.max` take the max,
 * `lat.min` the min of the non-empty sides, buckets add element-wise, the
 * window widens. `op` and `deployment` are kept from `a` (the caller groups
 * before merging).
 */
export function mergeSummaries(a: BscSummaryLine, b: BscSummaryLine): BscSummaryLine {
  const aEmpty = bucketTotal(a.lat.buckets) === 0;
  const bEmpty = bucketTotal(b.lat.buckets) === 0;
  const buckets = new Array<number>(BSC_LATENCY_BUCKET_COUNT).fill(0);
  for (let i = 0; i < BSC_LATENCY_BUCKET_COUNT; i++) buckets[i] = (a.lat.buckets[i] ?? 0) + (b.lat.buckets[i] ?? 0);
  return {
    op: a.op,
    ...(a.deployment !== undefined ? { deployment: a.deployment } : {}),
    startedAt: Math.min(a.startedAt, b.startedAt),
    endedAt: Math.max(a.endedAt, b.endedAt),
    calls: a.calls + b.calls,
    ok: a.ok + b.ok,
    byKind: addCounts(a.byKind, b.byKind),
    byStatus: addCounts(a.byStatus, b.byStatus),
    maxInflight: Math.max(a.maxInflight, b.maxInflight),
    suppressed: a.suppressed + b.suppressed,
    lat: {
      min: aEmpty ? b.lat.min : bEmpty ? a.lat.min : Math.min(a.lat.min, b.lat.min),
      max: Math.max(a.lat.max, b.lat.max),
      sum: a.lat.sum + b.lat.sum,
      buckets,
    },
  };
}

// ---------------------------------------------------------------------------
// In-flight counter (module level; one isolate only: a lower bound)
// ---------------------------------------------------------------------------

let inflightNow = 0;

/** BSC calls currently between `start` and their headers/failure, in this isolate. */
export function bscInflight(): number {
  return inflightNow;
}

/** For tests only. */
export function resetBscInflightForTests(): void {
  inflightNow = 0;
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

export type BscLogSink = { log(line: string): void; warn(line: string): void };

export type BscRecorderOptions = {
  /** `deploymentName()` from convex/observability.ts. */
  deployment?: string;
  /** Defaults to `console`. */
  log?: BscLogSink;
  /** Epoch ms clock; defaults to `Date.now`. */
  now?: () => number;
  /** Test hook: how long a background body read may take. */
  bodyReadDeadlineMs?: number;
};

export type BscCallMeta = {
  /** The BSC path with ids replaced, e.g. `marketplace/card/:id/card-listing`. */
  pathTemplate: string;
  bscCardId?: string | number;
  timeoutMs?: number;
  /** 1-based attempt in a retry loop. */
  attempt?: number;
};

export type BscCallToken = { readonly id: number };

export type BscFailInfo = {
  /** Omit to classify from `error`: TimeoutError/AbortError is `timeout`, anything else `network`. */
  kind?: BscCallKind;
  error?: unknown;
  status?: number;
  /** Supplies status and headers when the failure follows a response. */
  response?: Pick<Response, "status" | "headers">;
};

/** One failed call, the `bsc_call_failed` line minus its `msg`. */
export type BscFailureSample = {
  op: string;
  pathTemplate: string;
  bscCardId?: string;
  kind: BscCallKind;
  status?: number;
  durationMs: number;
  timeoutMs?: number;
  attempt?: number;
  inflight: number;
  errCode?: string;
  headers?: Record<string, string>;
  body?: string;
  deployment?: string;
  at: number;
};

export type BscFlushResult = {
  /** The `bsc_call_summary` line's payload, without `msg` or samples. */
  summary: BscSummaryLine;
  /** At most {@link MAX_SAMPLES} failures. */
  samples: BscFailureSample[];
  /** `{...summary, samples}`: the exact argument for `internal.bscCallStats.record`. */
  row: BscSummaryLine & { samples: BscFailureSample[] };
};

export interface BscRecorder {
  start(meta: BscCallMeta): BscCallToken;
  /** Headers arrived with a 2xx status. Never touches the body. */
  ok(token: BscCallToken, response: Pick<Response, "status" | "headers">): void;
  /** Routes: 2xx is `ok`; anything else is an `http` failure whose body is read from a clone. */
  respond(token: BscCallToken, response: Response): void;
  /** Record a failure. On a token already counted ok it converts that call to a failure. */
  fail(token: BscCallToken, info?: BscFailInfo): void;
  /** Await pending body reads, emit the summary line, return it. `null` when no call was started or already flushed. */
  flush(): Promise<BscFlushResult | null>;
}

type CallState = {
  meta: BscCallMeta;
  startedMs: number;
  state: "open" | "ok" | "failed";
  durationMs?: number;
  status?: number;
  headers?: Record<string, string>;
};

function errorCode(error: unknown): string | undefined {
  const candidates: unknown[] = [];
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; cause?: unknown };
    candidates.push(e.code);
    if (e.cause && typeof e.cause === "object") candidates.push((e.cause as { code?: unknown }).code);
  }
  for (const c of candidates) {
    if (typeof c === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(c)) return c;
  }
  return undefined;
}

function classify(error: unknown): BscCallKind {
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
}

/** Read at most `MAX_BODY_READ_BYTES` of the clone, then cancel it. Never throws. */
async function readCloneBody(clone: Response, deadlineMs: number): Promise<string> {
  const stream = clone.body;
  if (!stream) return "";
  const reader = stream.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deadlineMs);
  });
  const read = (async (): Promise<Uint8Array> => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < MAX_BODY_READ_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
    }
    const all = new Uint8Array(Math.min(total, MAX_BODY_READ_BYTES));
    let offset = 0;
    for (const chunk of chunks) {
      const room = all.length - offset;
      if (room <= 0) break;
      all.set(chunk.subarray(0, room), offset);
      offset += Math.min(chunk.byteLength, room);
    }
    return all;
  })();
  try {
    const winner = await Promise.race([read, deadline]);
    if (winner === "deadline") return "";
    return new TextDecoder("utf-8", { fatal: false }).decode(winner);
  } catch {
    return "";
  } finally {
    if (timer) clearTimeout(timer);
    // Not awaited: a tee'd branch's cancel() settles only when BOTH branches
    // are cancelled, and the other branch is the caller's.
    reader.cancel().catch(() => {});
  }
}

export function createBscRecorder(op: string, opts: BscRecorderOptions = {}): BscRecorder {
  const log: BscLogSink = opts.log ?? console;
  const now = opts.now ?? Date.now;
  const deadlineMs = opts.bodyReadDeadlineMs ?? BODY_READ_DEADLINE_MS;
  const startedAt = now();
  const calls = new Map<number, CallState>();
  const lat = emptyLatency();
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const samples: BscFailureSample[] = [];
  const pending: Array<Promise<void>> = [];
  let nextId = 1;
  let started = 0;
  let settled = 0;
  let okCount = 0;
  let maxInflight = 0;
  let detailLines = 0;
  let suppressed = 0;
  let flushed = false;

  const settle = (call: CallState): number => {
    call.durationMs = Math.max(0, now() - call.startedMs);
    const inflightAtSettle = inflightNow;
    inflightNow = Math.max(0, inflightNow - 1);
    settled += 1;
    const d = call.durationMs;
    const i = bucketIndex(d);
    lat.buckets[i] += 1;
    lat.sum += d;
    lat.min = settled === 1 ? d : Math.min(lat.min, d);
    lat.max = Math.max(lat.max, d);
    return inflightAtSettle;
  };

  const countStatus = (status: number | undefined): void => {
    if (typeof status === "number" && Number.isFinite(status)) {
      const key = String(status);
      byStatus[key] = (byStatus[key] ?? 0) + 1;
    }
  };

  const emitFailure = (sample: BscFailureSample, bodyPromise?: Promise<string>): void => {
    if (detailLines >= MAX_DETAIL_LINES) {
      suppressed += 1;
      return;
    }
    detailLines += 1;
    if (samples.length < MAX_SAMPLES) samples.push(sample);
    const write = (body: string | undefined): void => {
      if (body) sample.body = body;
      try {
        log.warn(JSON.stringify({ msg: "bsc_call_failed", ...sample }));
      } catch {
        // telemetry never throws into a call
      }
    };
    if (!bodyPromise) {
      write(undefined);
      return;
    }
    pending.push(bodyPromise.then(write, () => write(undefined)));
  };

  const failure = (
    call: CallState,
    kind: BscCallKind,
    inflightAtSettle: number,
    extra: { status?: number; headers?: Record<string, string>; errCode?: string },
  ): BscFailureSample => {
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    const status = extra.status ?? call.status;
    const headers = extra.headers ?? call.headers;
    return {
      op,
      pathTemplate: call.meta.pathTemplate,
      ...(call.meta.bscCardId !== undefined ? { bscCardId: String(call.meta.bscCardId) } : {}),
      kind,
      ...(status !== undefined ? { status } : {}),
      durationMs: call.durationMs ?? 0,
      ...(call.meta.timeoutMs !== undefined ? { timeoutMs: call.meta.timeoutMs } : {}),
      ...(call.meta.attempt !== undefined ? { attempt: call.meta.attempt } : {}),
      inflight: inflightAtSettle,
      ...(extra.errCode ? { errCode: extra.errCode } : {}),
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      ...(opts.deployment ? { deployment: opts.deployment } : {}),
      at: now(),
    };
  };

  const recorder: BscRecorder = {
    start(meta) {
      const id = nextId++;
      if (!flushed) {
        calls.set(id, { meta, startedMs: now(), state: "open" });
        started += 1;
        inflightNow += 1;
        maxInflight = Math.max(maxInflight, inflightNow);
      }
      return { id };
    },

    ok(token, response) {
      try {
        const call = calls.get(token.id);
        if (!call || call.state !== "open") return;
        settle(call);
        call.state = "ok";
        call.status = response.status;
        call.headers = pickBscHeaders(response.headers);
        okCount += 1;
        countStatus(response.status);
      } catch {
        // telemetry never throws into a call
      }
    },

    respond(token, response) {
      try {
        if (response.ok) {
          recorder.ok(token, response);
          return;
        }
        const call = calls.get(token.id);
        if (!call || call.state !== "open") return;
        const inflightAtSettle = settle(call);
        call.state = "failed";
        countStatus(response.status);
        const sample = failure(call, "http", inflightAtSettle, {
          status: response.status,
          headers: pickBscHeaders(response.headers),
        });
        const contentType = response.headers.get("content-type");
        let body: Promise<string> | undefined;
        try {
          body = readCloneBody(response.clone(), deadlineMs).then((raw) => scrubBscBody(raw, contentType));
        } catch {
          body = undefined; // a body already used cannot be cloned
        }
        emitFailure(sample, body);
      } catch {
        // telemetry never throws into a call
      }
    },

    fail(token, info = {}) {
      try {
        const call = calls.get(token.id);
        if (!call || call.state === "failed") return;
        const kind = info.kind ?? classify(info.error);
        const status = info.status ?? info.response?.status;
        let inflightAtSettle = inflightNow;
        if (call.state === "ok") {
          okCount -= 1; // converted: latency to headers and calls are already counted
        } else {
          inflightAtSettle = settle(call);
          countStatus(status);
        }
        call.state = "failed";
        const sample = failure(call, kind, inflightAtSettle, {
          status,
          headers: info.response ? pickBscHeaders(info.response.headers) : undefined,
          errCode: errorCode(info.error),
        });
        emitFailure(sample);
      } catch {
        // telemetry never throws into a call
      }
    },

    async flush() {
      if (flushed) return null;
      flushed = true;
      try {
        await Promise.allSettled(pending);
        // A call that never settled (abandoned action) must not leak the counter.
        for (const call of calls.values()) {
          if (call.state === "open") inflightNow = Math.max(0, inflightNow - 1);
        }
        if (started === 0) return null;
        const summary: BscSummaryLine = {
          op,
          ...(opts.deployment ? { deployment: opts.deployment } : {}),
          startedAt,
          endedAt: now(),
          calls: settled,
          ok: okCount,
          byKind,
          byStatus,
          maxInflight,
          suppressed,
          lat,
        };
        log.log(JSON.stringify({ msg: "bsc_call_summary", ...summary }));
        return { summary, samples, row: { ...summary, samples } };
      } catch {
        return null;
      }
    },
  };
  return recorder;
}

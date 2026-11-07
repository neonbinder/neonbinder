import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { BACKEND_FUNCTIONS, RUN_CLOSED_ERROR } from "./backend-contract.js";

/**
 * The NeonBinder side: sign in with the collector's API key, join the intake
 * run by its scanner code, and stream images into that run's placeholder job.
 *
 * Function references are built from their paths (./backend-contract.ts)
 * because this package does not share apps/web's codegen; the key exchange is
 * apps/web/convex/machineAuth.ts (`POST /machine/token`).
 *
 * The API key and the session tokens minted from it are never logged, not even
 * in part.
 */

const joinRun = makeFunctionReference<"query">(BACKEND_FUNCTIONS.joinRun);
const createUploadUrl = makeFunctionReference<"action">(BACKEND_FUNCTIONS.createUploadUrl);
const confirmUpload = makeFunctionReference<"mutation">(BACKEND_FUNCTIONS.confirmUpload);
const closeRun = makeFunctionReference<"mutation">(BACKEND_FUNCTIONS.closeRun);

export interface JoinedRun {
  runId: string;
  jobId: string;
  homeName: string;
  homeKind: "binder" | "box";
  variantName?: string;
  collecting: boolean;
}

/** `closed: false` means the job had already closed, which is not an error. */
export interface CloseResult {
  closed: boolean;
  status?: string;
  reason?: string;
}

interface UploadTicket {
  uploadUrl: string;
  fields: Record<string, string>;
  entryIndex: number;
  maxUploadBytes: number;
}

/**
 * Functions are served on `.convex.cloud`, HTTP actions (the key exchange) on
 * `.convex.site`. NEONBINDER_CONVEX_SITE_URL overrides for a local backend.
 * The key travels in that request's body, so it must be https (or loopback).
 */
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

export function siteUrlFor(convexUrl: string, override?: string): string {
  // The session token rides the deployment connection, so it gets the same rule.
  if (!/^https:\/\//.test(convexUrl) && !LOOPBACK.test(convexUrl)) {
    throw new Error("NEONBINDER_CONVEX_URL must be https:// (or http://localhost for a local backend).");
  }
  if (override) {
    if (!/^https:\/\//.test(override) && !LOOPBACK.test(override)) {
      throw new Error("NEONBINDER_CONVEX_SITE_URL must be https:// (or http://localhost for a local backend).");
    }
    return override.replace(/\/$/, "");
  }
  const match = convexUrl.match(/^https:\/\/([a-z0-9-]+)\.convex\.cloud\/?$/);
  if (!match) {
    throw new Error("NEONBINDER_CONVEX_URL should look like https://<name>.convex.cloud.");
  }
  return `https://${match[1]}.convex.site`;
}

/** Statuses worth another try: a rate limit or an upstream blip. */
const TRANSIENT = new Set([429, 502, 503]);

/** How long one key exchange may take before it counts as a network failure. */
const EXCHANGE_TIMEOUT_MS = 15_000;

/** How soon to sign back in after the client gave up on its session, the first time. */
const REAUTH_RETRY_MS = 30_000;
/** However long sign-in stays broken, it's tried at least this often. */
const REAUTH_RETRY_MAX_MS = 5 * 60_000;

/** Doubles with each failed try, spread by a quarter either way so many apps don't retry together. */
function reauthDelayMs(failures: number): number {
  const doubled = REAUTH_RETRY_MS * 2 ** Math.min(failures, 8);
  return Math.min(REAUTH_RETRY_MAX_MS, doubled * (0.75 + Math.random() * 0.5));
}

/** Trades the API key for short-lived session tokens, reusing one session. */
class KeyExchange {
  private sessionId: string | null = null;
  private primed: string | null = null;
  /** The key itself was refused, so asking again can't help. */
  rejected = false;
  onRejected = () => {};

  constructor(
    private readonly siteUrl: string,
    private readonly key: string,
  ) {}

  private async exchange(): Promise<Response> {
    return await fetch(`${this.siteUrl}/machine/token`, {
      method: "POST",
      // The key is in the body; a redirect would resend it somewhere else.
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: this.key, ...(this.sessionId ? { sessionId: this.sessionId } : {}) }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  }

  private async read(res: Response): Promise<string | null> {
    const body = (await res.json()) as { token?: string; sessionId?: string };
    if (body.sessionId) this.sessionId = body.sessionId;
    return body.token ?? null;
  }

  /** One loud check at start, so a bad key fails now and not mid-stack. */
  async verify(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      let res: Response | null = null;
      let token: string | null = null;
      try {
        res = await this.exchange();
        // The time limit covers the body too, so it's read in here.
        if (res.ok) token = await this.read(res);
      } catch {
        // Network blip or time limit: retried below like a transient status.
        res = null;
      }
      if (res?.status === 401) {
        throw new KeyRejectedError();
      }
      if (res?.ok) {
        if (!token) throw new Error("NeonBinder sign-in returned no session.");
        this.primed = token;
        return;
      }
      if (res && !TRANSIENT.has(res.status)) throw new Error(`NeonBinder sign-in failed (HTTP ${res.status}).`);
      if (attempt >= 5) {
        throw new Error(
          res ? `NeonBinder sign-in is unavailable (HTTP ${res.status}). Try again in a minute.` : "Can't reach NeonBinder. Check your connection.",
        );
      }
      await new Promise((r) => setTimeout(r, Math.min(8000, 1500 * 2 ** (attempt - 1))));
    }
  }

  /** ConvexClient's token callback: quiet, and null on any failure. */
  async fetchToken(args: { forceRefreshToken: boolean }): Promise<string | null> {
    if (this.primed && !args.forceRefreshToken) {
      const token = this.primed;
      this.primed = null;
      return token;
    }
    this.primed = null;
    try {
      const res = await this.exchange();
      if (res.status === 401 && !this.rejected) {
        this.rejected = true;
        this.onRejected();
      }
      return res.ok ? await this.read(res) : null;
    } catch {
      return null;
    }
  }
}

/** The API key was refused: revoked, mistyped, or from another NeonBinder. */
export class KeyRejectedError extends Error {
  constructor() {
    super("NeonBinder didn't accept that API key. Make one under Profile → API Keys.");
    this.name = "KeyRejectedError";
  }
}

export class NeonBinder {
  private reauth: ReturnType<typeof setTimeout> | undefined;
  private reauthFailures = 0;
  private closed = false;
  private readonly rejectionListeners = new Set<() => void>();

  private constructor(
    private readonly convex: ConvexClient,
    private readonly keys: KeyExchange,
  ) {
    keys.onRejected = () => {
      for (const listener of [...this.rejectionListeners]) listener();
    };
  }

  static async signIn(convexUrl: string, apiKey: string, siteOverride?: string): Promise<NeonBinder> {
    const keys = new KeyExchange(siteUrlFor(convexUrl, siteOverride), apiKey);
    await keys.verify();
    const nb = new NeonBinder(new ConvexClient(convexUrl), keys);
    nb.stayAuthenticated(keys);
    return nb;
  }

  /**
   * One failed token refresh makes the Convex client drop its session for good,
   * and a refresh during a network blip or a sleeping laptop is such a failure.
   * This app stays open between runs, so sign back in until it works, unless
   * the key itself was refused.
   */
  private stayAuthenticated(keys: KeyExchange): void {
    this.convex.setAuth(
      (args) => keys.fetchToken(args),
      (authenticated) => {
        if (authenticated) {
          this.reauthFailures = 0;
          return;
        }
        if (keys.rejected || this.closed) return;
        clearTimeout(this.reauth);
        this.reauth = setTimeout(() => {
          this.reauthFailures++;
          this.stayAuthenticated(keys);
        }, reauthDelayMs(this.reauthFailures));
      },
    );
  }

  /**
   * Hears once that NeonBinder refused the key after sign-in (revoked, most
   * likely), straight away if it already has. Returns how to stop listening.
   */
  onKeyRejected(listener: () => void): () => void {
    if (this.keys.rejected) {
      listener();
      return () => {};
    }
    this.rejectionListeners.add(listener);
    return () => this.rejectionListeners.delete(listener);
  }

  async join(code: string): Promise<JoinedRun | null> {
    return (await this.convex.query(joinRun, { code })) as JoinedRun | null;
  }

  /**
   * Follow a joined run: `onChange` gets its latest state, null once the code
   * finds nothing. A query error reaches no one on purpose: an auth refresh or
   * a network blip says nothing about the run, and the subscription carries on
   * by itself after one. The handler has to be passed all the same, because
   * without it the client raises an unhandled rejection, which ends the process.
   */
  watchRun(code: string, onChange: (run: JoinedRun | null) => void): () => void {
    const unsubscribe = this.convex.onUpdate(
      joinRun,
      { code },
      (run: unknown) => {
        // Undefined is "no result right now", which is not an answer about the run.
        if (run !== undefined) onChange(run as JoinedRun | null);
      },
      () => {},
    );
    return () => unsubscribe();
  }

  /** The same as Done adding photos on the screen. Queues while offline, so callers bound the wait. */
  async closeRun(jobId: string): Promise<CloseResult> {
    return (await this.convex.mutation(closeRun, { jobId })) as CloseResult;
  }

  /**
   * One image into the run's job: sign an upload for the next entry, POST the
   * bytes straight to storage, then confirm so the pipeline starts on it.
   * Entries are allocated in call order, so a card's front and back sent one
   * after the other sit side by side, which is what pairing looks for first.
   */
  async sendImage(jobId: string, bytes: Buffer, name: string): Promise<number> {
    const ticket = (await this.convex.action(createUploadUrl, {
      jobId,
      contentType: "image/jpeg",
      originalName: name,
    })) as UploadTicket;
    if (bytes.byteLength > ticket.maxUploadBytes) {
      throw new Error(`${name} is over the ${Math.floor(ticket.maxUploadBytes / 1048576)} MB upload limit.`);
    }
    // Policy fields first, the file last: storage ignores anything after it.
    const form = new FormData();
    for (const [k, v] of Object.entries(ticket.fields)) form.append(k, v);
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), name);
    const res = await fetch(ticket.uploadUrl, { method: "POST", body: form });
    // Status only: a storage error body can quote the signed policy.
    if (!res.ok) throw new Error(`Upload failed (HTTP ${res.status}).`);
    await this.convex.mutation(confirmUpload, { jobId, entryIndex: ticket.entryIndex });
    return ticket.entryIndex;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.reauth);
    await this.convex.close();
  }
}

/**
 * The run stopped taking cards (done pressed, or it sat idle and closed). Only
 * a fast path: a deployment can hide an error's words, so no match proves
 * nothing, and the caller asks the run itself.
 */
export function isRunClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return RUN_CLOSED_ERROR.test(message);
}

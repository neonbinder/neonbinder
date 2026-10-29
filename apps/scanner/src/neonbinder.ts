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

export interface JoinedRun {
  runId: string;
  jobId: string;
  homeName: string;
  homeKind: "binder" | "box";
  variantName?: string;
  collecting: boolean;
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

/** Trades the API key for short-lived session tokens, reusing one session. */
class KeyExchange {
  private sessionId: string | null = null;
  private primed: string | null = null;

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
      try {
        res = await this.exchange();
      } catch {
        // Network blip: retried below like a transient status.
      }
      if (res?.status === 401) {
        throw new Error(
          "NeonBinder didn't accept your API key. Make one under Settings → API Keys and put it in NEONBINDER_API_KEY.",
        );
      }
      if (res?.ok) {
        this.primed = await this.read(res);
        if (!this.primed) throw new Error("NeonBinder sign-in returned no session.");
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
      return res.ok ? await this.read(res) : null;
    } catch {
      return null;
    }
  }
}

export class NeonBinder {
  private constructor(private readonly convex: ConvexClient) {}

  static async signIn(convexUrl: string, apiKey: string, siteOverride?: string): Promise<NeonBinder> {
    const keys = new KeyExchange(siteUrlFor(convexUrl, siteOverride), apiKey);
    await keys.verify();
    const convex = new ConvexClient(convexUrl);
    convex.setAuth((args) => keys.fetchToken(args));
    return new NeonBinder(convex);
  }

  async join(code: string): Promise<JoinedRun | null> {
    return (await this.convex.query(joinRun, { code })) as JoinedRun | null;
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
    await this.convex.close();
  }
}

/** The run stopped taking cards (done pressed, or it sat idle and closed). */
export function isRunClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return RUN_CLOSED_ERROR.test(message);
}

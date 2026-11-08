import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  replayIntegration: vi.fn((opts: unknown) => ({ name: "replay", opts })),
  browserTracingIntegration: vi.fn(() => ({ name: "tracing" })),
}));
vi.mock("@sentry/react", () => sentry);

const RETURN = "https://app.example/profile/ebay?code=v%5E1.1%23SECRET&state=NONCE123";
const dirty = () => ({ request: { url: RETURN }, breadcrumbs: [{ data: { to: RETURN } }] });

async function load(e2e: string) {
  vi.resetModules();
  sentry.init.mockClear();
  sentry.replayIntegration.mockClear();
  vi.stubEnv("VITE_CLERK_TESTING_ENABLED", e2e);
  await import("./sentry");
}

beforeEach(() => vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.ingest/1"));
afterEach(() => vi.unstubAllEnvs());

describe("Sentry init scrubs the eBay return's code and state (NEO-415)", () => {
  it.each(["beforeSend", "beforeSendTransaction", "beforeBreadcrumb"])("%s redacts them", async (hook) => {
    await load("");
    const options = sentry.init.mock.calls[0][0] as Record<string, (v: unknown) => unknown>;
    const out = JSON.stringify(options[hook](dirty()));
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("NONCE123");
    expect(out).toContain("code=<redacted>");
    expect(out).toContain("state=<redacted>");
  });

  it("the replay recording hook redacts them too", async () => {
    await load("");
    const opts = sentry.replayIntegration.mock.calls[0][0] as { beforeAddRecordingEvent: (e: unknown) => unknown };
    const out = JSON.stringify(opts.beforeAddRecordingEvent({ data: { href: RETURN } }));
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("NONCE123");
  });

  it("does not initialise Sentry under E2E", async () => {
    await load("true");
    expect(sentry.init).not.toHaveBeenCalled();
  });
});

describe("Sentry event hooks survive the SDK's live objects (NEO-434)", () => {
  const SIGNED = "https://storage.googleapis.com/bucket/obj.jpg?X-Goog-Signature=SIGSECRET";

  function circularMetadata() {
    const scope: Record<string, unknown> = {};
    scope.self = scope;
    return { capturedSpanScope: scope, spanCountBeforeProcessing: 1 };
  }

  it.each(["beforeSend", "beforeSendTransaction"])(
    "%s redacts the event and hands back the same sdkProcessingMetadata",
    async (hook) => {
      await load("");
      const options = sentry.init.mock.calls[0][0] as Record<string, (v: unknown) => Record<string, unknown>>;
      const sdkProcessingMetadata = circularMetadata();
      const event = {
        type: "transaction",
        request: { url: RETURN },
        spans: [{ data: { "http.url": SIGNED } }],
        sdkProcessingMetadata,
      };

      const out = options[hook](event);

      expect(out.sdkProcessingMetadata).toBe(sdkProcessingMetadata);
      const { sdkProcessingMetadata: _kept, ...rest } = out;
      const wire = JSON.stringify(rest);
      for (const secret of ["SECRET", "NONCE123", "SIGSECRET"]) expect(wire).not.toContain(secret);
      expect(wire).toContain("code=<redacted>");
      expect(wire).toContain("obj.jpg?<redacted>");
    },
  );

  it.each(["beforeSend", "beforeSendTransaction"])(
    "%s drops an event it cannot stringify instead of throwing or sending it unscrubbed",
    async (hook) => {
      await load("");
      const options = sentry.init.mock.calls[0][0] as Record<string, (v: unknown) => unknown>;
      const loop: Record<string, unknown> = { url: RETURN };
      loop.self = loop;

      expect(options[hook]({ request: { url: RETURN }, extra: loop })).toBeNull();
    },
  );
});

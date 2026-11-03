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

/**
 * NEO-434 — `src/sentry.ts` driven through the real SDK, Session Replay
 * included. `sentry.test.tsx` mocks `@sentry/react`, which is how a hook that
 * threw on every real transaction went unnoticed: only the real pipeline puts
 * live scopes on the event, and only the real pipeline swallows the throw.
 *
 * Nothing leaves the process: the client's transport `send` is replaced, and
 * that call is what these tests read.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/react";

const LANDING = "https://app.example/profile/ebay?code=OAUTHSECRET&state=NONCESECRET";
const SIGNED = "https://storage.googleapis.com/bucket/obj.jpg?X-Goog-Signature=SIGSECRET";

type EnvelopeItem = [{ type: string }, Record<string, unknown>];
const send = vi.fn(async (_envelope: [unknown, EnvelopeItem[]]) => ({}));

const sentItems = () => send.mock.calls.flatMap(([envelope]) => envelope[1]);
const sentOfType = (type: string) => sentItems().filter(([header]) => header.type === type);
/** The event sent to report that our own hook crashed. */
const selfReports = () =>
  sentOfType("event").filter(([, event]) => JSON.stringify(event).includes('"type":"internal"'));

// Replay only starts in a browser, and the SDK takes a real `process` to mean
// Node. Hide that from it while it initialises; happy-dom supplies the rest.
const processTag = Object.getOwnPropertyDescriptor(process, Symbol.toStringTag);

beforeAll(async () => {
  Object.assign(process, { [Symbol.toStringTag]: "Object" });
  // Above the 10% session rate, so Replay buffers rather than sends on a timer.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.ingest/1");
  vi.stubEnv("VITE_CLERK_TESTING_ENABLED", "");
  const { happyDOM } = window as unknown as {
    happyDOM: { setURL(url: string): void; settings: { enableIframePageLoading: boolean } };
  };
  happyDOM.setURL(LANDING);
  // The SDK probes a blank iframe for a native fetch; happy-dom logs a refusal otherwise.
  happyDOM.settings.enableIframePageLoading = true;

  await import("./sentry");

  vi.spyOn(Sentry.getClient()!.getTransport()!, "send").mockImplementation(send as never);
});

beforeEach(() => send.mockClear());

afterAll(async () => {
  await Sentry.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (processTag) Object.assign(process, { [Symbol.toStringTag]: processTag.value });
});

it("runs against the live objects that caused the crash", () => {
  expect(Sentry.getClient()!.getIntegrationByName("Replay")).toMatchObject({ _replay: expect.anything() });
  expect(() => JSON.stringify(Sentry.getCurrentScope())).toThrow(/circular/i);
});

it("a transaction reaches the transport, redacted and with no self-report", async () => {
  Sentry.startSpan({ name: "neo-434-transaction", forceTransaction: true }, () => {
    Sentry.startSpan({ name: "upload", attributes: { "http.url": SIGNED } }, () => {});
  });
  await Sentry.flush(2000);

  const [item] = sentOfType("transaction").filter(([, event]) => event.transaction === "neo-434-transaction");
  expect(item).toBeDefined();
  const wire = JSON.stringify(item[1]);
  for (const secret of ["OAUTHSECRET", "NONCESECRET", "SIGSECRET"]) expect(wire).not.toContain(secret);
  expect(wire).toContain("code=<redacted>");
  expect(wire).toContain("obj.jpg?<redacted>");
  expect(item[1]).not.toHaveProperty("sdkProcessingMetadata");
  expect(selfReports()).toEqual([]);
});

it("an error reaches the transport, redacted and with no self-report", async () => {
  Sentry.captureException(new Error("neo-434-error"));
  await Sentry.flush(2000);

  const items = sentOfType("event").filter(([, event]) => JSON.stringify(event).includes("neo-434-error"));
  expect(items).toHaveLength(1);
  const wire = JSON.stringify(items[0][1]);
  expect(wire).not.toContain("OAUTHSECRET");
  expect(wire).toContain("code=<redacted>");
  expect(selfReports()).toEqual([]);
});

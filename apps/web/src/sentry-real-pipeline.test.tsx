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
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

const LANDING = "https://app.example/profile/ebay?code=OAUTHSECRET&state=NONCESECRET";
const SIGNED = "https://storage.googleapis.com/bucket/obj.jpg?X-Goog-Signature=SIGSECRET";

const WRITE_TOKEN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const READ_TOKEN = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
/** NEO-434: the shapes the scrub must catch wherever they land, and what must not survive them. */
const CAPABILITIES = {
  r2Put: `https://r2accountsecret.r2.cloudflarestorage.com/photos/copy-photos/${WRITE_TOKEN}/image.jpg?X-Amz-Credential=AMZCREDSECRET&X-Amz-Signature=AMZSIGSECRET`,
  convexUpload: "https://x.convex.cloud/api/storage/upload?token=CONVEXTOKENSECRET",
  bareQuery: "?X-Goog-Credential=GOOGCREDSECRET&X-Goog-Signature=GOOGSIGSECRET",
  encoded:
    "https://a.test/?next=https%3A%2F%2Fbucket.storage.googleapis.com%2Fo%3FX-Goog-Signature%3DENCSIGSECRET%26X-Goog-Date%3DENCDATESECRET",
  photoRead: `https://x.convex.site/copy-photo/${READ_TOKEN}/thumb`,
  quoted: 'upload failed for "https://storage.googleapis.com/b/o?X-Goog-Signature=QUOTEDSECRET" twice',
};
const CAPABILITY_SECRETS = [
  "r2accountsecret",
  WRITE_TOKEN,
  "AMZCREDSECRET",
  "AMZSIGSECRET",
  "CONVEXTOKENSECRET",
  "GOOGCREDSECRET",
  "GOOGSIGSECRET",
  "ENCSIGSECRET",
  "ENCDATESECRET",
  READ_TOKEN,
  "QUOTEDSECRET",
];
const expectNoCapability = (wire: string) => {
  for (const secret of CAPABILITY_SECRETS) expect(wire).not.toContain(secret);
};

/** NEO-434: capabilities requested through the SDK's own fetch instrumentation. */
const FETCH_TOKEN = "cccccccccccccccccccccccccccccccc";
const FETCHED = {
  r2Put: `https://fetchacctsecret.r2.cloudflarestorage.com/photos/copy-photos/${FETCH_TOKEN}/image.jpg?X-Amz-Credential=FETCHCREDSECRET&X-Amz-Signature=FETCHSIGSECRET`,
  convexUpload: "https://fetch.convex.cloud/api/storage/upload?token=FETCHTOKENSECRET",
};
const FETCH_SECRETS = ["fetchacctsecret", FETCH_TOKEN, "FETCHCREDSECRET", "FETCHSIGSECRET", "FETCHTOKENSECRET"];

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

  // Before init: the SDK wraps whatever `fetch` it finds, so its own
  // instrumentation (breadcrumbs and http.client spans) sees these requests.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));

  await import("./sentry");

  vi.spyOn(Sentry.getClient()!.getTransport()!, "send").mockImplementation(send as never);
});

beforeEach(() => send.mockClear());

afterAll(async () => {
  await Sentry.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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

it("no upload capability survives on a transaction's spans", async () => {
  Sentry.startSpan({ name: "neo-434-capabilities", forceTransaction: true }, () => {
    Sentry.startSpan(
      {
        name: `PUT ${CAPABILITIES.r2Put}`,
        attributes: {
          url: CAPABILITIES.r2Put,
          "http.url": CAPABILITIES.convexUpload,
          "url.full": CAPABILITIES.photoRead,
          "http.query": CAPABILITIES.bareQuery,
          encoded: CAPABILITIES.encoded,
          note: CAPABILITIES.quoted,
        },
      },
      () => {},
    );
  });
  await Sentry.flush(2000);

  const [item] = sentOfType("transaction").filter(([, event]) => event.transaction === "neo-434-capabilities");
  expect(item).toBeDefined();
  expectNoCapability(JSON.stringify(item[1]));
  expect(selfReports()).toEqual([]);
});

it("no upload capability survives on an error or its breadcrumbs, and the quoted message still sends", async () => {
  for (const url of Object.values(CAPABILITIES)) {
    Sentry.addBreadcrumb({ category: "fetch", type: "http", data: { method: "PUT", url } });
  }
  Sentry.captureException(new Error(CAPABILITIES.quoted), { extra: CAPABILITIES });
  await Sentry.flush(2000);

  const items = sentOfType("event").filter(([, event]) => JSON.stringify(event).includes("upload failed for"));
  expect(items).toHaveLength(1);
  const wire = JSON.stringify(items[0][1]);
  expectNoCapability(wire);
  expect(wire).toContain('"category":"fetch"');
  expect(wire).toContain("r2.cloudflarestorage.com");
  expect(selfReports()).toEqual([]);
});

it("no upload capability survives a real fetch, on the transaction or on the error's breadcrumbs", async () => {
  await Sentry.startSpan({ name: "neo-434-real-fetch", forceTransaction: true }, async () => {
    for (const url of Object.values(FETCHED)) await fetch(url, { method: "PUT" });
  });
  Sentry.captureException(new Error("neo-434-real-fetch-error"));
  await Sentry.flush(2000);

  const [transaction] = sentOfType("transaction").filter(([, event]) => event.transaction === "neo-434-real-fetch");
  expect(transaction).toBeDefined();
  const txWire = JSON.stringify(transaction[1]);
  // The instrumentation recorded the requests (so the assertions below are not vacuous)...
  expect(txWire).toContain("r2.cloudflarestorage.com");
  expect(txWire).toContain("fetch.convex.cloud");
  for (const secret of FETCH_SECRETS) expect(txWire).not.toContain(secret);

  const errors = sentOfType("event").filter(([, event]) => JSON.stringify(event).includes("neo-434-real-fetch-error"));
  expect(errors).toHaveLength(1);
  const errWire = JSON.stringify(errors[0][1]);
  expect(errWire).toContain('"category":"fetch"');
  expect(errWire).toContain("r2.cloudflarestorage.com");
  for (const secret of FETCH_SECRETS) expect(errWire).not.toContain(secret);
  expect(selfReports()).toEqual([]);
});

// Session Replay's real recorder (rrweb) emits no snapshots or mutations under
// happy-dom, so there is no rrweb-produced frame to follow. What does run for
// real is Replay's own event path: its fetch capture builds a performanceSpan
// frame, and `throttledAddEvent` is the entry every frame goes through before
// `beforeAddRecordingEvent`. These tests read what that path hands the event
// buffer, which is what would be compressed and uploaded.
const replayInternals = () =>
  (Sentry.getClient()!.getIntegrationByName("Replay") as unknown as {
    _replay: {
      eventBuffer: { addEvent(event: unknown): Promise<unknown> };
      throttledAddEvent(event: unknown): Promise<unknown>;
    };
  })._replay;

it("Replay's own fetch capture reaches the event buffer redacted (end to end; the breadcrumb scrub already covers it, the hook is the backstop)", async () => {
  const replay = replayInternals();
  const buffered = vi.spyOn(replay.eventBuffer, "addEvent");

  await fetch(FETCHED.convexUpload, { method: "PUT" });
  await fetch(FETCHED.r2Put, { method: "PUT" });
  await vi.waitFor(() => {
    const spans = buffered.mock.calls.filter(([e]) => JSON.stringify(e).includes('"tag":"performanceSpan"'));
    expect(spans.length).toBeGreaterThanOrEqual(2);
  });

  const wire = JSON.stringify(buffered.mock.calls.map(([e]) => e));
  expect(wire).toContain("fetch.convex.cloud/api/storage/upload?token=<redacted>");
  expect(wire).toContain("r2.cloudflarestorage.com");
  for (const secret of FETCH_SECRETS) expect(wire).not.toContain(secret);
  buffered.mockRestore();
});

it("a custom frame handed to Replay is redacted before it is buffered", async () => {
  const replay = replayInternals();
  const buffered = vi.spyOn(replay.eventBuffer, "addEvent");

  await replay.throttledAddEvent({
    type: 5, // rrweb Custom
    timestamp: Date.now(),
    data: { tag: "breadcrumb", payload: { category: "navigation", data: { to: LANDING, signed: SIGNED } } },
  });

  const wire = JSON.stringify(buffered.mock.calls.map(([e]) => e));
  expect(wire).toContain("navigation");
  for (const secret of ["OAUTHSECRET", "NONCESECRET", "SIGSECRET"]) expect(wire).not.toContain(secret);
  expect(wire).toContain("code=<redacted>");
  buffered.mockRestore();
});

it("the hook is not applied to a non-custom frame (pins the comment in src/sentry.ts)", async () => {
  const replay = replayInternals();
  const buffered = vi.spyOn(replay.eventBuffer, "addEvent");
  const meta = { type: 4, timestamp: Date.now(), data: { href: "https://app.example/page?token=NEO434METAMARKER", width: 1, height: 1 } };

  await replay.throttledAddEvent(meta);

  // Reaches the buffer as handed in: Replay never calls the hook for it.
  expect(buffered.mock.calls.map(([e]) => e)).toEqual([meta]);
  buffered.mockRestore();
});

it.each([
  ["a", "HTMLAnchorElement"],
  ["button", "HTMLButtonElement"],
])("after a click on <%s>, %s starts the circle and the next transaction still sends", async (tag, constructorName) => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  flushSync(() => root.render(tag === "a" ? <a href="#x">Go</a> : <button type="button">Go</button>));

  // Replay's detector ignores a click unless its breadcrumb has an rrweb node
  // id, and rrweb assigns none under happy-dom. So hand the detector the click
  // Replay would: the node it keeps, whose React fiber loops back to it.
  const { clickDetector } = (Sentry.getClient()!.getIntegrationByName("Replay") as unknown as {
    _replay: {
      clickDetector: {
        _clicks: unknown[];
        handleClick(breadcrumb: unknown, node: unknown): void;
      };
    };
  })._replay;
  clickDetector._clicks = [];
  clickDetector.handleClick(
    { category: "ui.click", timestamp: Date.now() / 1000, data: { nodeId: 1 } },
    host.querySelector(tag),
  );
  expect(() => JSON.stringify(Sentry.getCurrentScope())).toThrow(`starting at object with constructor '${constructorName}'`);

  const name = `neo-434-click-${tag}`;
  Sentry.startSpan({ name, forceTransaction: true }, () => {});
  await Sentry.flush(2000);

  expect(sentOfType("transaction").filter(([, event]) => event.transaction === name)).toHaveLength(1);
  expect(selfReports()).toEqual([]);
  clickDetector._clicks = [];
  root.unmount();
  host.remove();
});

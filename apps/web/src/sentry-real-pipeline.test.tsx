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

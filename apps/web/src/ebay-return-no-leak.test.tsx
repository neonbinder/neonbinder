/**
 * NEO-434 — the real SDK and Session Replay, started on eBay's return address.
 * The hooks cannot reach a `replay_event` or an rrweb Meta frame, so the only
 * proof is that the values never appear in what reaches the transport.
 * `sentry-real-pipeline.test.tsx` explains the Node and transport handling.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/react";

const SECRETS = ["EBAYCODESECRET", "EBAYNONCESECRET", "EBAYEXPIRESSECRET", "EBAYERRORSECRET", "EBAYDESCSECRET"];
const RETURN =
  "https://app.example/profile/ebay?code=EBAYCODESECRET&state=EBAYNONCESECRET&expires_in=EBAYEXPIRESSECRET&error=EBAYERRORSECRET&error_description=EBAYDESCSECRET";

const decoder = new TextDecoder();
/** An envelope item as text, with Replay's byte payload decoded. */
const asText = (item: unknown) =>
  JSON.stringify(item, (_key, value) => (value instanceof Uint8Array ? decoder.decode(value) : value));

type Item = [{ type: string }, unknown];
const send = vi.fn(async (_envelope: [unknown, Item[]]) => ({}));
const sentOfType = (type: string) => send.mock.calls.flatMap(([envelope]) => envelope[1]).filter(([h]) => h.type === type);
const processTag = Object.getOwnPropertyDescriptor(process, Symbol.toStringTag);

beforeAll(async () => {
  Object.assign(process, { [Symbol.toStringTag]: "Object" });
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.ingest/1");
  vi.stubEnv("VITE_CLERK_TESTING_ENABLED", "");
  const { happyDOM } = window as unknown as {
    happyDOM: { setURL(url: string): void; settings: { enableIframePageLoading: boolean } };
  };
  happyDOM.setURL(RETURN);
  happyDOM.settings.enableIframePageLoading = true;
  // rrweb's polyfill step reads these off window, and happy-dom leaves them
  // undefined there. Without them recording never starts and there is no Meta frame.
  const win = window as unknown as Record<string, unknown>;
  win.NodeList ??= class {};
  win.DOMTokenList ??= class {};

  await import("./sentry");

  vi.spyOn(Sentry.getClient()!.getTransport()!, "send").mockImplementation(send as never);
});

afterAll(async () => {
  await Sentry.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (processTag) Object.assign(process, { [Symbol.toStringTag]: processTag.value });
});

const expectClean = (items: Item[]) => {
  const wire = items.map(asText).join("\n");
  for (const secret of SECRETS) expect(wire).not.toContain(secret);
  return wire;
};

it("no transaction, error, replay_event or recording frame carries what eBay sent", async () => {
  Sentry.startSpan({ name: "neo-434-landing", forceTransaction: true }, () => {});
  Sentry.captureException(new Error("neo-434-landing-error"));
  await Sentry.flush(2000);
  // Replay holds back anything under five seconds long.
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
  await Sentry.getReplay()!.flush();
  await Sentry.flush(2000);

  const transactions = sentOfType("transaction");
  const errors = sentOfType("event");
  const replayEvents = sentOfType("replay_event");
  const recordings = sentOfType("replay_recording");
  expect(transactions.length).toBeGreaterThan(0);
  expect(errors.length).toBeGreaterThan(0);
  expect(replayEvents.length).toBeGreaterThan(0);
  expect(recordings.length).toBeGreaterThan(0);

  expectClean([...transactions, ...errors, ...replayEvents, ...recordings]);

  // Each surface did carry the address, so this is not passing on an empty field.
  expect(asText(errors[0])).toContain("https://app.example/profile/ebay");
  const replayEvent = replayEvents[0][1] as { urls: string[]; request?: { url?: string } };
  expect(replayEvent.urls[0]).toBe("https://app.example/profile/ebay");
  expect(replayEvent.request?.url).toBe("https://app.example/profile/ebay");
  expect(recordings.map(asText).join("\n")).toContain('\\"href\\":\\"https://app.example/profile/ebay\\"');
});

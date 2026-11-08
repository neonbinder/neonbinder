/**
 * NEO-434 — the real recorder, not a pinned option. rrweb's snapshots and
 * mutations pass through no hook, and it records an href even under masking, so
 * the only thing keeping these links out of a recording is the `block` list in
 * `src/sentry.ts`. `sentry-real-pipeline.test.tsx` explains the Node and transport
 * handling; the polyfills below are what start rrweb under happy-dom.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/react";

const COPY_TOKEN = "0123456789abcdef0123456789abcdef";
const COPY_PHOTO = `https://dep.example/copy-photo/${COPY_TOKEN}/full`;
const STORAGE = "https://dep.example/api/storage/STORAGEIDSECRET";
const LATE_COPY_TOKEN = "fedcba9876543210fedcba9876543210";
const LATE_STORAGE = "https://dep.example/api/storage/LATESTORAGESECRET";
const SECRETS = [COPY_TOKEN, "STORAGEIDSECRET", LATE_COPY_TOKEN, "LATESTORAGESECRET"];

const decoder = new TextDecoder();
const asText = (item: unknown) =>
  JSON.stringify(item, (_key, value) => (value instanceof Uint8Array ? decoder.decode(value) : value));

type Item = [{ type: string }, unknown];
const send = vi.fn(async (_envelope: [unknown, Item[]]) => ({}));
const processTag = Object.getOwnPropertyDescriptor(process, Symbol.toStringTag);

const link = (href: string) => {
  const a = document.createElement("a");
  a.href = href;
  a.textContent = "photo";
  document.body.append(a);
};

beforeAll(async () => {
  Object.assign(process, { [Symbol.toStringTag]: "Object" });
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.ingest/1");
  vi.stubEnv("VITE_CLERK_TESTING_ENABLED", "");
  const { happyDOM } = window as unknown as {
    happyDOM: { setURL(url: string): void; settings: { enableIframePageLoading: boolean } };
  };
  happyDOM.setURL("https://app.example/collection");
  happyDOM.settings.enableIframePageLoading = true;
  const win = window as unknown as Record<string, unknown>;
  win.NodeList ??= class {};
  win.DOMTokenList ??= class {};

  link(COPY_PHOTO);
  link(STORAGE);
  link("https://dep.example/control-link");
  const photo = document.createElement("img");
  photo.src = STORAGE;
  document.body.append(photo);

  await import("./sentry");

  vi.spyOn(Sentry.getClient()!.getTransport()!, "send").mockImplementation(send as never);
});

afterAll(async () => {
  await Sentry.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (processTag) Object.assign(process, { [Symbol.toStringTag]: processTag.value });
});

it("a recording carries an ordinary link but neither bearer link, at load or added later", async () => {
  link(`https://dep.example/copy-photo/${LATE_COPY_TOKEN}/thumb`);
  link(LATE_STORAGE);
  link("https://dep.example/control-late");
  await new Promise((resolve) => setTimeout(resolve, 50));

  Sentry.captureException(new Error("neo-434-blocked-links"));
  await Sentry.flush(2000);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
  await Sentry.getReplay()!.flush();
  await Sentry.flush(2000);

  const recording = send.mock.calls
    .flatMap(([envelope]) => envelope[1])
    .filter(([h]) => h.type === "replay_recording")
    .map(asText)
    .join("\n");

  // The recorder really did walk the page and watch it change.
  expect(recording).toContain("control-link");
  expect(recording).toContain("control-late");
  for (const secret of SECRETS) expect(recording).not.toContain(secret);
});

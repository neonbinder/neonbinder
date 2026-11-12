import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeXhr } from "@/lib/testing/fake-xhr";
import { xhrTransport } from "./xhr-transport";

const body = new Blob([new Uint8Array(8)], { type: "image/jpeg" });
const send = (over: Partial<Parameters<typeof xhrTransport>[0]> = {}, controller = new AbortController()) =>
  xhrTransport({
    url: "https://photos.example/a",
    method: "PUT",
    headers: { "content-type": "image/jpeg", "content-length": "8" },
    body,
    signal: controller.signal,
    ...over,
  });

describe("xhrTransport (NEO-466)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens the request, passes every header and sends the blob as given", () => {
    const xhrs = installFakeXhr();
    void send();
    expect(xhrs.last).toMatchObject({ method: "PUT", url: "https://photos.example/a", sentBody: body, sent: true });
    expect(xhrs.last.headers).toEqual({ "content-type": "image/jpeg", "content-length": "8" });
  });

  it("attaches the upload listeners before send, because a browser decides at send time", () => {
    const xhrs = installFakeXhr();
    void send({ onProgress: () => {} });
    expect(xhrs.last.uploadListenersAtSend).toEqual({ progress: 1, load: 1 });
  });

  it("reports progress with the total, or null when the length is not computable", () => {
    const xhrs = installFakeXhr();
    const seen: unknown[] = [];
    void send({ onProgress: (p) => seen.push(p) });
    xhrs.last.progress(3, 8);
    xhrs.last.progress(5, 0, false);
    xhrs.last.uploadDone(8);
    expect(seen).toEqual([
      { loaded: 3, total: 8 },
      { loaded: 5, total: null },
      { loaded: 8, total: 8 },
    ]);
  });

  it("resolves with the status and the text of a 2xx answer", async () => {
    const xhrs = installFakeXhr();
    const sending = send();
    xhrs.last.respond(200, '{"storageId":"s1"}');
    expect(await sending).toEqual({ status: 200, body: '{"storageId":"s1"}' });
  });

  it("gives an empty-bodied 204 an empty string body", async () => {
    const xhrs = installFakeXhr();
    const sending = send();
    xhrs.last.respond(204);
    expect(await sending).toEqual({ status: 204, body: "" });
  });

  it("resolves a non-2xx answer instead of rejecting, so the caller can judge it", async () => {
    const xhrs = installFakeXhr();
    const sending = send();
    xhrs.last.respond(503);
    expect(await sending).toMatchObject({ status: 503 });
  });

  it("rejects a network error with a TypeError", async () => {
    const xhrs = installFakeXhr();
    const sending = send();
    xhrs.last.fail();
    await expect(sending).rejects.toBeInstanceOf(TypeError);
  });

  it("rejects an XHR timeout with a TypeError", async () => {
    const xhrs = installFakeXhr();
    const sending = send();
    xhrs.last.timeout();
    await expect(sending).rejects.toBeInstanceOf(TypeError);
  });

  it("aborts the request and rejects with an AbortError when the signal aborts", async () => {
    const xhrs = installFakeXhr();
    const controller = new AbortController();
    const sending = send({}, controller);
    controller.abort();
    await expect(sending).rejects.toMatchObject({ name: "AbortError" });
    expect(xhrs.last.aborted).toBe(true);
  });

  it("rejects with an AbortError without opening a request when the signal is already aborted", async () => {
    const xhrs = installFakeXhr();
    const controller = new AbortController();
    controller.abort();
    await expect(send({}, controller)).rejects.toMatchObject({ name: "AbortError" });
    expect(xhrs.all).toHaveLength(0);
  });

  it("settles once: an answer after an abort changes nothing", async () => {
    const xhrs = installFakeXhr();
    const controller = new AbortController();
    const sending = send({}, controller);
    controller.abort();
    xhrs.last.respond(200);
    await expect(sending).rejects.toMatchObject({ name: "AbortError" });
  });
});

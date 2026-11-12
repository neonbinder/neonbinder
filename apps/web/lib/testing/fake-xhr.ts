/**
 * A controllable XMLHttpRequest for unit tests (NEO-466).
 *
 * The network guard (`vitest.setup.network-guard.ts`) installs a refusing XHR
 * on every project; a test that exercises an upload installs this instead and
 * drives it by hand. `vi.unstubAllGlobals()` puts the guard back.
 *
 *     const xhrs = installFakeXhr();
 *     ...start an upload...
 *     xhrs.last.respond(200);
 */
import { vi } from "vitest";

type Listener = (event: Record<string, unknown>) => void;

class Target {
  listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== listener));
  }
  emit(type: string, event: Record<string, unknown> = {}) {
    for (const l of this.listeners.get(type) ?? []) l({ type, ...event });
  }
  count(type: string) {
    return this.listeners.get(type)?.length ?? 0;
  }
}

export class FakeXhr extends Target {
  static instances: FakeXhr[] = [];
  /** Called as each request is sent; lets a test answer without driving every instance. */
  static onSend: ((xhr: FakeXhr) => void) | undefined;

  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string> = {};
  responseType = "";
  response: unknown = "";
  status = 0;
  sentBody: unknown;
  sent = false;
  aborted = false;
  /** Listener counts on the upload target at the moment send() ran. */
  uploadListenersAtSend: Record<string, number> = {};
  upload = new Target();

  constructor() {
    super();
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.sent = true;
    this.sentBody = body;
    for (const type of ["progress", "load"]) this.uploadListenersAtSend[type] = this.upload.count(type);
    FakeXhr.onSend?.(this);
  }
  abort() {
    this.aborted = true;
    this.emit("abort");
  }

  // Drivers.
  progress(loaded: number, total = 0, lengthComputable = total > 0) {
    this.upload.emit("progress", { loaded, total, lengthComputable });
  }
  uploadDone(total: number) {
    this.upload.emit("load", { loaded: total, total, lengthComputable: true });
  }
  respond(status: number, body = "") {
    this.status = status;
    this.response = body;
    this.emit("load");
  }
  fail() {
    this.emit("error");
  }
  timeout() {
    this.emit("timeout");
  }
}

/** Installs the fake as the global XMLHttpRequest; returns the handle on its instances. */
export function installFakeXhr(onSend?: (xhr: FakeXhr) => void) {
  FakeXhr.instances = [];
  FakeXhr.onSend = onSend;
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  return {
    get all() {
      return FakeXhr.instances;
    },
    get last() {
      const x = FakeXhr.instances[FakeXhr.instances.length - 1];
      if (!x) throw new Error("no XMLHttpRequest was opened");
      return x;
    },
  };
}

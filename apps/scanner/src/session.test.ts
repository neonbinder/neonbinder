import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { JoinedRun } from "./neonbinder.js";
import { QUIT, type Answer } from "./prompt.js";
import { DEFAULT_SETTINGS, fujitsuPlan, type Timing } from "./scanimage.js";
import { scanLoop, type RunClient, type SessionDeps } from "./session.js";

/**
 * The prompt loop and a scanning session, against a fake scanimage on PATH
 * (./testing/fake-scanimage.sh), a faked NeonBinder and keys through a pipe:
 * how a session ends, what order the last card and the close happen in, and
 * that nothing is left behind for the next session.
 */
const convex = vi.hoisted(() => ({
  setAuth: vi.fn(),
  query: vi.fn(),
  action: vi.fn(),
  mutation: vi.fn(),
  close: vi.fn(),
  onUpdate: vi.fn(),
}));
vi.mock("convex/browser", () => ({
  ConvexClient: vi.fn(function () {
    return convex;
  }),
}));

/**
 * A seam into the real feedCards: `beforeScanStart` runs just before the session
 * hears a scan has started, which is the moment a stop can land with no scan to
 * stop. Everything else is the real thing, and stopScan stays real too: it's
 * only recorded.
 */
const seam = vi.hoisted(() => ({
  beforeScanStart: undefined as undefined | (() => void),
  stopped: [] as ChildProcess[],
  onStopped: undefined as undefined | (() => void),
}));
vi.mock("./scanimage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scanimage.js")>();
  return {
    ...actual,
    stopScan: async (proc: ChildProcess, log: (line: string) => void) => {
      await actual.stopScan(proc, log);
      seam.stopped.push(proc);
      seam.onStopped?.();
    },
    feedCards: (opts: Parameters<typeof actual.feedCards>[0]) =>
      actual.feedCards({
        ...opts,
        onScanStart: (proc) => {
          const hook = seam.beforeScanStart;
          seam.beforeScanStart = undefined;
          hook?.();
          opts.onScanStart(proc);
        },
      }),
  };
});

import { KeyRejectedError, NeonBinder } from "./neonbinder.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "testing", "fake-scanimage.sh");
const FAST: Timing = { stallMs: 2000, firstPageMs: 2000, settleMs: 0, idleMs: 20, pollMs: 10 };
const RUN: JoinedRun = { runId: "run-1", jobId: "job-1", homeName: "Dimes", homeKind: "box", collecting: true };
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const REAL_TMPDIR = tmpdir();
let dir: string;
const signalListeners = () => SIGNALS.map((s) => process.listenerCount(s));

async function loadPaper(scenario: string) {
  process.env.FAKE_SCENARIO = scenario;
  await writeFile(path.join(dir, "paper"), "");
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(REAL_TMPDIR, "fake-sane-"));
  // feed-cards.test.ts checks the shared temp folder for leftovers, so stage scans elsewhere.
  process.env.TMPDIR = dir;
  await mkdir(path.join(dir, "bin"));
  await symlink(FAKE, path.join(dir, "bin", "scanimage"));
  process.env.PATH = `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`;
  process.env.FAKE_DIR = dir;
  await loadPaper("pairs:2");
});
afterEach(() => {
  vi.unstubAllGlobals();
  seam.beforeScanStart = undefined;
  seam.onStopped = undefined;
  seam.stopped.length = 0;
});

async function until(condition: () => boolean, what = "condition") {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited > 5000) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A held-back promise, to keep an upload in flight until the test lets it go. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

/** Everything a session needs, faked. `answers` are the prompt's replies; after them, QUIT. */
function rig(answers: Array<Answer | (() => Answer | Promise<Answer>)> = ["ABC123"], over: Partial<SessionDeps> = {}) {
  const order: string[] = [];
  const lines: string[] = [];
  const watchers: Array<(run: JoinedRun | null) => void> = [];
  let unwatched = 0;
  let keyRejected = false;
  const rejectionListeners = new Set<() => void>();
  const nb = {
    join: vi.fn<RunClient["join"]>(async () => RUN),
    watchRun: vi.fn<RunClient["watchRun"]>((_code, onChange) => {
      watchers.push(onChange);
      return () => void unwatched++;
    }),
    sendImage: vi.fn<RunClient["sendImage"]>(async (_job, _bytes, name) => {
      order.push(name);
      return 0;
    }),
    closeRun: vi.fn<RunClient["closeRun"]>(async () => {
      order.push("close");
      return { closed: true, status: "processing" };
    }),
    onKeyRejected: (listener: () => void) => {
      if (keyRejected) {
        listener();
        return () => {};
      }
      rejectionListeners.add(listener);
      return () => void rejectionListeners.delete(listener);
    },
  };
  const stdin = new PassThrough();
  const ask = vi.fn<SessionDeps["ask"]>(async () => {
    if (!answers.length) return QUIT;
    const next = answers.shift();
    return typeof next === "function" ? await next() : next;
  });
  const prepare = vi.fn<SessionDeps["prepare"]>(async () => ({
    scannerName: "FAKE scanner",
    plan: fujitsuPlan("fujitsu:fake", DEFAULT_SETTINGS),
    raw: false,
  }));
  const deps: SessionDeps = {
    nb,
    log: (line) => lines.push(line),
    ask,
    stdin,
    prepare,
    timing: FAST,
    ...over,
  };
  return {
    deps,
    nb,
    stdin,
    ask,
    prepare,
    order,
    lines,
    watchers,
    unwatched: () => unwatched,
    closeWebsite: (latest: JoinedRun | null = { ...RUN, collecting: false }) => watchers.at(-1)!(latest),
    rejectKey: () => {
      keyRejected = true;
      for (const listener of [...rejectionListeners]) listener();
    },
    rejectionListeners,
    logged: (text: string | RegExp) => lines.some((l) => (typeof text === "string" ? l.includes(text) : text.test(l))),
    start: (first?: string) => scanLoop(deps, first),
  };
}

describe("Done on the website", () => {
  test.each([
    ["stops collecting", { ...RUN, collecting: false }],
    ["disappears", null],
  ])("the run %s: the scanner stops, it reports, it asks again, and closes nothing", async (_name, latest) => {
    const r = rig();
    const exit = r.start();
    await until(() => r.logged("Card 1 sent."), "the first card");
    r.closeWebsite(latest);
    await expect(exit).resolves.toBe(0);
    expect(r.nb.closeRun).not.toHaveBeenCalled();
    expect(r.logged(/^This run closed on NeonBinder\. 1 card sent\.$/)).toBe(true);
    expect(r.ask).toHaveBeenCalledTimes(2);
    expect(r.logged("Waiting for the next run's code. Ctrl-C quits.")).toBe(true);
    expect(r.unwatched()).toBe(1);
  });

  test("a run still collecting changes nothing", async () => {
    const r = rig();
    const exit = r.start();
    await until(() => r.logged("Card 1 sent."), "the first card");
    r.closeWebsite({ ...RUN, collecting: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(r.logged("Stopping the scanner…")).toBe(false);
    r.closeWebsite();
    await exit;
  });

  test("a card scanned after the close is reported and counted, never dropped", async () => {
    await loadPaper("pairs:4");
    const hold = gate();
    const r = rig();
    r.nb.sendImage.mockImplementationOnce(async (_job, _bytes, name) => {
      r.order.push(name);
      await hold.opened;
      return 0;
    });
    const exit = r.start();
    await until(() => r.order.includes("scan-1-front.jpg"), "the first upload");
    // Give the fake time to write all four sides, so a second card is staged.
    await new Promise((resolve) => setTimeout(resolve, 400));
    r.closeWebsite();
    hold.open();
    await exit;
    expect(r.logged("Card 2 wasn't sent: the run stopped taking cards. Put it back in the stack.")).toBe(true);
    expect(r.logged(/^This run closed on NeonBinder\. 1 card sent, 1 to feed again\.$/)).toBe(true);
    expect(r.order).toEqual(["scan-1-front.jpg", "scan-1-back.jpg"]);
  });

  test("an upload refused because the run closed is the same: reported, counted, back to the prompt", async () => {
    const r = rig();
    r.nb.sendImage.mockRejectedValue(new Error("job is not collecting"));
    await expect(r.start()).resolves.toBe(0);
    expect(r.ask).toHaveBeenCalledTimes(2);
    expect(r.logged("Card 1 wasn't sent: the run stopped taking cards. Put it back in the stack.")).toBe(true);
    expect(r.logged(/^This run closed on NeonBinder\. 0 cards sent, 1 to feed again\.$/)).toBe(true);
    expect(r.nb.closeRun).not.toHaveBeenCalled();
  });
});

describe("a closed run when the error's words are hidden", () => {
  const REDACTED = new Error("[Request ID: abc123] Server Error");
  const CLOSED = { ...RUN, collecting: false };
  /** The prompt's own join finds the open run; the next ones are the check after a failure. */
  const joinThenCheck = (r: ReturnType<typeof rig>, check: () => Promise<JoinedRun | null>) =>
    r.nb.join.mockResolvedValueOnce(RUN).mockImplementation(check);

  test.each([
    ["stopped collecting", CLOSED],
    ["is gone", null],
  ])("a failed upload whose run %s is exactly a closed run", async (_name, latest) => {
    const r = rig();
    r.nb.sendImage.mockRejectedValue(REDACTED);
    joinThenCheck(r, async () => latest);
    await expect(r.start()).resolves.toBe(0);
    expect(r.logged("Card 1 wasn't sent: the run stopped taking cards. Put it back in the stack.")).toBe(true);
    expect(r.logged(/^This run closed on NeonBinder\. 0 cards sent, 1 to feed again\.$/)).toBe(true);
    expect(r.logged("didn't reach NeonBinder")).toBe(false);
    expect(r.ask).toHaveBeenCalledTimes(2);
    expect(r.nb.closeRun).not.toHaveBeenCalled();
  });

  test("a failed upload whose run is still open keeps the connection message and keeps scanning", async () => {
    await loadPaper("pairs:4");
    const r = rig();
    r.nb.sendImage.mockRejectedValueOnce(REDACTED);
    joinThenCheck(r, async () => RUN);
    const exit = r.start();
    await until(() => r.logged("Card 1 didn't reach NeonBinder. Check the internet connection and feed it again."), "the failed card");
    expect(r.logged("Stopping the scanner…")).toBe(false);
    await until(() => r.logged("Card 2 sent."), "the next card");
    r.closeWebsite();
    await exit;
    expect(r.logged("the run stopped taking cards")).toBe(false);
  });

  test.each([
    ["fails", () => Promise.reject(new Error("offline"))],
    ["never answers", () => new Promise<never>(() => {})],
  ])("a check that %s proves nothing: the connection message, within its limit", async (_name, check) => {
    await loadPaper("pairs:4");
    const r = rig(["ABC123"], { runCheckTimeoutMs: 30 });
    r.nb.sendImage.mockRejectedValueOnce(REDACTED);
    joinThenCheck(r, check);
    const exit = r.start();
    await until(() => r.logged("Card 1 didn't reach NeonBinder."), "the failed card");
    expect(r.logged("the run stopped taking cards")).toBe(false);
    await until(() => r.logged("Card 2 sent."), "the next card");
    r.closeWebsite();
    await exit;
  });

  test("the words still decide on their own, with no check", async () => {
    const r = rig();
    r.nb.sendImage.mockRejectedValue(new Error("job is not collecting"));
    await r.start();
    expect(r.nb.join).toHaveBeenCalledTimes(1);
  });

  test("the watcher already saw the close: a card failing in flight needs no check", async () => {
    const hold = gate();
    const r = rig();
    r.nb.sendImage.mockImplementationOnce(async () => {
      await hold.opened;
      throw REDACTED;
    });
    const exit = r.start();
    await until(() => r.nb.sendImage.mock.calls.length === 1, "the upload to start");
    r.closeWebsite();
    hold.open();
    await expect(exit).resolves.toBe(0);
    expect(r.nb.join).toHaveBeenCalledTimes(1);
    expect(r.logged("Card 1 wasn't sent: the run stopped taking cards. Put it back in the stack.")).toBe(true);
    expect(r.logged("didn't reach NeonBinder")).toBe(false);
  });

  test("a close that throws, on a run confirmed closed, needs no fallback", async () => {
    const r = rig();
    r.nb.closeRun.mockRejectedValue(REDACTED);
    joinThenCheck(r, async () => CLOSED);
    const exit = r.start();
    await until(() => r.logged("Card 1 sent."), "the first card");
    r.stdin.write("d");
    await expect(exit).resolves.toBe(0);
    expect(r.logged("Couldn't reach NeonBinder")).toBe(false);
  });

  test.each([
    ["still open", () => Promise.resolve(RUN)],
    ["unknown", () => Promise.reject(new Error("offline"))],
    ["not answering", () => new Promise<never>(() => {})],
  ])("a close that throws, on a run %s, shows the fallback", async (_name, check) => {
    const r = rig(["ABC123"], { runCheckTimeoutMs: 30 });
    r.nb.closeRun.mockRejectedValue(REDACTED);
    joinThenCheck(r, check);
    const exit = r.start();
    await until(() => r.logged("Card 1 sent."), "the first card");
    r.stdin.write("d");
    await expect(exit).resolves.toBe(0);
    expect(r.logged("Couldn't reach NeonBinder. Press Done adding photos on the screen.")).toBe(true);
  });
});

describe("a key refused partway through", () => {
  const CLOSED_LINE = "This run closed on NeonBinder";

  test("the scan stops, it reports, and the loop ends with the rejection; never a closed run, never a close", async () => {
    const r = rig();
    const exit = r.start();
    await until(() => r.logged("Card 1 sent."), "the first card");
    r.rejectKey();
    await expect(exit).rejects.toBeInstanceOf(KeyRejectedError);
    expect(r.logged("Stopping the scanner…")).toBe(true);
    expect(r.logged(/^1 card sent\.$/)).toBe(true);
    expect(r.logged(CLOSED_LINE)).toBe(false);
    expect(r.nb.closeRun).not.toHaveBeenCalled();
    expect(r.ask).toHaveBeenCalledTimes(1);
    expect(r.unwatched()).toBe(1);
    expect(r.rejectionListeners.size).toBe(0);
  });

  test.each([
    ["hidden words", new Error("Server Error")],
    ["a closed run's words", new Error("job is not collecting")],
  ])("a card failing in flight, with %s, is reported as signed out", async (_name, failure) => {
    const hold = gate();
    const r = rig();
    r.nb.sendImage.mockImplementationOnce(async () => {
      await hold.opened;
      throw failure;
    });
    const exit = r.start();
    await until(() => r.nb.sendImage.mock.calls.length === 1, "the upload to start");
    r.rejectKey();
    hold.open();
    await expect(exit).rejects.toBeInstanceOf(KeyRejectedError);
    expect(r.logged("Card 1 wasn't sent: NeonBinder signed this app out. Put it back in the stack.")).toBe(true);
    expect(r.logged(/^0 cards sent, 1 to feed again\.$/)).toBe(true);
    expect(r.logged("Check the internet connection")).toBe(false);
    expect(r.logged("the run stopped taking cards")).toBe(false);
    expect(r.logged(CLOSED_LINE)).toBe(false);
    expect(r.nb.join).toHaveBeenCalledTimes(1);
  });

  test("a card already staged isn't tried: it's put back", async () => {
    await loadPaper("pairs:4");
    const hold = gate();
    const r = rig();
    r.nb.sendImage.mockImplementationOnce(async () => {
      await hold.opened;
      return 0;
    });
    const exit = r.start();
    await until(() => r.nb.sendImage.mock.calls.length === 1, "the first upload");
    await new Promise((resolve) => setTimeout(resolve, 400));
    r.rejectKey();
    hold.open();
    await expect(exit).rejects.toBeInstanceOf(KeyRejectedError);
    expect(r.logged("Card 2 wasn't sent: NeonBinder signed this app out. Put it back in the stack.")).toBe(true);
    expect(r.nb.sendImage.mock.calls.map(([, , name]) => name)).toEqual(["scan-1-front.jpg", "scan-1-back.jpg"]);
  });

  test("after D, during the drain: no close goes out, and the screen is the way to finish", async () => {
    const hold = gate();
    const r = rig();
    r.nb.sendImage.mockImplementationOnce(async () => {
      await hold.opened;
      return 0;
    });
    const exit = r.start();
    await until(() => r.nb.sendImage.mock.calls.length === 1, "the upload to start");
    r.stdin.write("d");
    await until(() => r.logged("Stopping the scanner…"), "the stop");
    r.rejectKey();
    hold.open();
    await expect(exit).rejects.toBeInstanceOf(KeyRejectedError);
    expect(r.nb.closeRun).not.toHaveBeenCalled();
    expect(r.logged("Couldn't reach NeonBinder. Press Done adding photos on the screen.")).toBe(true);
  });

  test("at the code prompt, it ends the question and the loop", async () => {
    const r = rig();
    const before = signalListeners();
    r.ask.mockImplementation(
      (_question, quit) => new Promise((resolve) => quit?.addEventListener("abort", () => resolve(QUIT))),
    );
    const exit = r.start();
    await until(() => r.ask.mock.calls.length === 1, "the prompt");
    r.rejectKey();
    await expect(exit).rejects.toBeInstanceOf(KeyRejectedError);
    expect(signalListeners()).toEqual(before);
    expect(r.rejectionListeners.size).toBe(0);
  });

  test("refused while a code is being looked up: the failure is shown, then the loop ends", async () => {
    const r = rig(["ABC123", "DEF456"]);
    r.nb.join.mockImplementationOnce(async () => {
      r.rejectKey();
      throw new Error("Server Error");
    });
    await expect(r.start()).rejects.toBeInstanceOf(KeyRejectedError);
    expect(r.ask).toHaveBeenCalledTimes(1);
    expect(r.prepare).not.toHaveBeenCalled();
  });

  test("Ctrl-C during the stop still means quit", async () => {
    const hold = gate();
    const r = rig();
    r.nb.sendImage.mockImplementationOnce(async () => {
      await hold.opened;
      return 0;
    });
    const exit = r.start();
    await until(() => r.nb.sendImage.mock.calls.length === 1, "the upload to start");
    r.rejectKey();
    r.stdin.write("\u0003");
    await new Promise((resolve) => setTimeout(resolve, 20));
    hold.open();
    await expect(exit).resolves.toBe(0);
  });
});

describe("the D key", () => {
  test.each(["d", "D", "d\n"])("%j sends the card in flight before it closes the run", async (key) => {
    const hold = gate();
    const r = rig();
    r.nb.sendImage.mockImplementationOnce(async (_job, _bytes, name) => {
      r.order.push(name);
      await hold.opened;
      return 0;
    });
    const exit = r.start();
    await until(() => r.order.length === 1, "the upload to start");
    r.stdin.write(key);
    await until(() => r.logged("Stopping the scanner…"), "the stop");
    expect(r.nb.closeRun).not.toHaveBeenCalled();
    hold.open();
    await expect(exit).resolves.toBe(0);
    expect(r.order).toEqual(["scan-1-front.jpg", "scan-1-back.jpg", "close"]);
    expect(r.nb.closeRun).toHaveBeenCalledWith("job-1");
    expect(r.logged(/^Done\. 1 card sent\.$/)).toBe(true);
    expect(r.ask).toHaveBeenCalledTimes(2);
  });

  test("an arrow key or a pasted code is not D", async () => {
    const r = rig();
    const exit = r.start();
    await until(() => r.logged("Card 1 sent."), "the first card");
    r.stdin.write("\u001b[D");
    await new Promise((resolve) => setTimeout(resolve, 20));
    r.stdin.write("ABD123");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(r.logged("Stopping the scanner…")).toBe(false);
    r.closeWebsite();
    await exit;
    expect(r.nb.closeRun).not.toHaveBeenCalled();
  });

  test("pressed again while stopping, it's ignored", async () => {
    const hold = gate();
    const r = rig();
    r.nb.sendImage.mockImplementationOnce(async () => {
      await hold.opened;
      return 0;
    });
    const exit = r.start();
    await until(() => r.nb.sendImage.mock.calls.length === 1, "the upload to start");
    r.stdin.write("d");
    await until(() => r.logged("Stopping the scanner…"), "the stop");
    r.stdin.write("d");
    await new Promise((resolve) => setTimeout(resolve, 20));
    r.stdin.write("D");
    await new Promise((resolve) => setTimeout(resolve, 20));
    hold.open();
    await exit;
    expect(r.nb.closeRun).toHaveBeenCalledTimes(1);
    expect(r.lines.filter((l) => l === "Stopping the scanner…")).toHaveLength(1);
  });

  test("then Ctrl-C during the drain: the run still closes, then the app exits", async () => {
    const hold = gate();
    const r = rig();
    r.nb.sendImage.mockImplementationOnce(async (_job, _bytes, name) => {
      r.order.push(name);
      await hold.opened;
      return 0;
    });
    const exit = r.start();
    await until(() => r.order.length === 1, "the upload to start");
    r.stdin.write("d");
    await until(() => r.logged("Stopping the scanner…"), "the stop");
    r.stdin.write("\u0003");
    await new Promise((resolve) => setTimeout(resolve, 20));
    hold.open();
    await expect(exit).resolves.toBe(0);
    expect(r.order).toEqual(["scan-1-front.jpg", "scan-1-back.jpg", "close"]);
    expect(r.ask).toHaveBeenCalledTimes(1);
  });

  test("Done on the website during the drain: the close finds it closed, and that's no error", async () => {
    const hold = gate();
    const r = rig();
    r.nb.sendImage.mockImplementationOnce(async (_job, _bytes, name) => {
      r.order.push(name);
      await hold.opened;
      return 0;
    });
    r.nb.closeRun.mockResolvedValue({ closed: false, reason: "job is already processing" });
    const exit = r.start();
    await until(() => r.order.length === 1, "the upload to start");
    r.stdin.write("d");
    await until(() => r.logged("Stopping the scanner…"), "the stop");
    r.closeWebsite();
    hold.open();
    await expect(exit).resolves.toBe(0);
    expect(r.logged("Couldn't reach NeonBinder")).toBe(false);
    expect(r.logged(/^Done\. 1 card sent\.$/)).toBe(true);
    expect(r.ask).toHaveBeenCalledTimes(2);
  });

  test("an upload that never answers can't hold the session open: it's counted to feed again", async () => {
    const r = rig(["ABC123"], { drainCardTimeoutMs: 30 });
    r.nb.sendImage.mockImplementation(() => new Promise(() => {}));
    const exit = r.start();
    await until(() => r.nb.sendImage.mock.calls.length === 1, "the upload to start");
    r.stdin.write("d");
    await expect(exit).resolves.toBe(0);
    expect(r.logged("Card 1 didn't reach NeonBinder. Check the internet connection and feed it again.")).toBe(true);
    expect(r.logged(/^Done\. 0 cards sent, 1 to feed again\.$/)).toBe(true);
    expect(r.nb.closeRun).toHaveBeenCalledTimes(1);
  });

  test("an upload that begins after the stop already landed still hits the limit: counted to feed again", async () => {
    await loadPaper("pairs:4");
    const hold = gate();
    const r = rig(["ABC123"], { drainCardTimeoutMs: 100 });
    r.nb.sendImage
      .mockImplementationOnce(async () => {
        await hold.opened;
        return 0;
      })
      .mockImplementationOnce(async () => 0)
      .mockImplementation(() => new Promise(() => {}));
    const exit = r.start();
    await until(() => r.nb.sendImage.mock.calls.length === 1, "the first upload");
    // Let the fake write all four sides, so card 2 is staged behind card 1.
    await new Promise((resolve) => setTimeout(resolve, 400));
    r.stdin.write("d");
    await until(() => r.logged("Stopping the scanner…"), "the stop");
    hold.open();
    await expect(exit).resolves.toBe(0);
    expect(r.nb.sendImage.mock.calls.map(([, , name]) => name)).toEqual(["scan-1-front.jpg", "scan-1-back.jpg", "scan-2-front.jpg"]);
    expect(r.logged("Card 1 sent.")).toBe(true);
    expect(r.logged("Card 2 didn't reach NeonBinder. Check the internet connection and feed it again.")).toBe(true);
    expect(r.logged(/^Done\. 1 card sent, 1 to feed again\.$/)).toBe(true);
    expect(r.nb.closeRun).toHaveBeenCalledTimes(1);
  });

  test("an upload that finished before the stop arms no timer and rejects nothing later", async () => {
    const LIMIT = 12_345;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      const r = rig(["ABC123"], { drainCardTimeoutMs: LIMIT });
      const exit = r.start();
      await until(() => r.logged("Card 1 sent."), "the first card");
      r.stdin.write("d");
      await expect(exit).resolves.toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(timers.mock.calls.filter(([, ms]) => ms === LIMIT)).toEqual([]);
      expect(r.logged("didn't reach NeonBinder")).toBe(false);
      expect(r.logged(/^Done\. 1 card sent\.$/)).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      timers.mockRestore();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("the front goes up, the back never answers, D is pressed: the card counts as unsent", async () => {
    const r = rig(["ABC123"], { drainCardTimeoutMs: 30 });
    r.nb.sendImage.mockImplementation(async (_job, _bytes, name) => {
      if (name.endsWith("-back.jpg")) return await new Promise<number>(() => {});
      r.order.push(name);
      return 0;
    });
    const exit = r.start();
    await until(() => r.nb.sendImage.mock.calls.length === 2, "the back to start");
    r.stdin.write("d");
    await expect(exit).resolves.toBe(0);
    expect(r.order).toEqual(["scan-1-front.jpg", "close"]);
    expect(r.logged("Card 1 sent.")).toBe(false);
    expect(r.logged("Card 1 didn't reach NeonBinder. Check the internet connection and feed it again.")).toBe(true);
    expect(r.logged(/^Done\. 0 cards sent, 1 to feed again\.$/)).toBe(true);
    expect(r.nb.closeRun).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["fails", () => Promise.reject(new Error("Connection lost"))],
    ["never answers", () => new Promise<never>(() => {})],
  ])("a close that %s shows the fallback and still asks again", async (_name, closeRun) => {
    const r = rig(["ABC123"], { closeTimeoutMs: 30 });
    r.nb.closeRun.mockImplementation(closeRun);
    const exit = r.start();
    await until(() => r.logged("Card 1 sent."), "the first card");
    r.stdin.write("d");
    await expect(exit).resolves.toBe(0);
    expect(r.logged("Couldn't reach NeonBinder. Press Done adding photos on the screen.")).toBe(true);
    expect(r.ask).toHaveBeenCalledTimes(2);
  });

  test("a close refused because the job is gone needs no fallback", async () => {
    const r = rig();
    r.nb.closeRun.mockRejectedValue(new Error("Job not found"));
    const exit = r.start();
    await until(() => r.logged("Card 1 sent."), "the first card");
    r.stdin.write("D");
    await exit;
    expect(r.logged("Couldn't reach NeonBinder")).toBe(false);
  });
});

describe("a stop that lands just before a scan starts", () => {
  /** Ends the first session at the moment its scan is spawned, then runs a second to the end. */
  async function stoppedBeforeScan(stop: (r: ReturnType<typeof rig>) => void) {
    let secondStarted = 0;
    const r = rig([
      "ABC123",
      async () => {
        secondStarted = r.lines.length;
        await loadPaper("pairs:2");
        return "DEF456";
      },
    ]);
    seam.onStopped = () => r.order.push("stopped");
    seam.beforeScanStart = () => stop(r);
    const exit = r.start();
    await until(() => r.ask.mock.calls.length === 2, "the prompt after the stopped session");
    await until(() => r.watchers.length === 2, "the second session");
    await until(() => r.lines.slice(secondStarted).includes("Card 1 sent."), "the second session's card");
    r.closeWebsite();
    await expect(exit).resolves.toBe(0);
    return r;
  }

  test("D: the scan that starts is stopped, then the run closes, once", async () => {
    const r = await stoppedBeforeScan((rr) => rr.stdin.emit("data", Buffer.from("d")));
    expect(seam.stopped).toHaveLength(1);
    const proc = seam.stopped[0];
    expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
    expect(r.order.filter((x) => x === "stopped" || x === "close").slice(0, 2)).toEqual(["stopped", "close"]);
    expect(r.nb.closeRun).toHaveBeenCalledTimes(1);
    expect(r.nb.closeRun).toHaveBeenCalledWith("job-1");
    expect(r.logged("Stopping the scanner…")).toBe(true);
    expect(r.logged(/^Done\. \d+ cards? sent\.$/)).toBe(true);
  });

  test("Done on the website: the scan that starts is stopped, and the run is never closed from here", async () => {
    const r = await stoppedBeforeScan((rr) => rr.closeWebsite());
    expect(seam.stopped).toHaveLength(1);
    const proc = seam.stopped[0];
    expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
    expect(r.nb.closeRun).not.toHaveBeenCalled();
    expect(r.logged(/^This run closed on NeonBinder\. \d+ cards? sent\.$/)).toBe(true);
  });
});

describe("quitting", () => {
  test("Ctrl-C at the keyboard exits and leaves the run open", async () => {
    const r = rig();
    const exit = r.start();
    await until(() => r.logged("Card 1 sent."), "the first card");
    r.stdin.write("\u0003");
    await expect(exit).resolves.toBe(0);
    expect(r.nb.closeRun).not.toHaveBeenCalled();
    expect(r.ask).toHaveBeenCalledTimes(1);
    expect(r.logged(/^1 card sent\.$/)).toBe(true);
    expect(r.unwatched()).toBe(1);
  });

  test.each(SIGNALS)("%s while scanning exits and leaves the run open", async (signal) => {
    const r = rig();
    const before = signalListeners();
    const exit = r.start();
    await until(() => r.logged("Card 1 sent."), "the first card");
    process.emit(signal);
    await expect(exit).resolves.toBe(0);
    expect(r.nb.closeRun).not.toHaveBeenCalled();
    expect(signalListeners()).toEqual(before);
  });

  test.each(SIGNALS)("%s at the prompt answers it as a quit", async (signal) => {
    const r = rig();
    const before = signalListeners();
    r.ask.mockImplementation(
      (_question, quit) => new Promise((resolve) => quit?.addEventListener("abort", () => resolve(QUIT))),
    );
    const exit = r.start();
    await until(() => r.ask.mock.calls.length === 1, "the prompt");
    process.emit(signal);
    await expect(exit).resolves.toBe(0);
    expect(signalListeners()).toEqual(before);
  });

  test("a card left to feed again makes the exit a failure", async () => {
    const r = rig();
    r.nb.sendImage.mockRejectedValue(new Error("fetch failed"));
    const exit = r.start();
    await until(() => r.logged("Card 1 didn't reach NeonBinder"), "the failed card");
    r.stdin.write("\u0003");
    await expect(exit).resolves.toBe(1);
    expect(r.logged(/^0 cards sent, \d+ to feed again\.$/)).toBe(true);
  });

  test("stdin closing is neither done nor a crash", async () => {
    const r = rig();
    const exit = r.start();
    await until(() => r.logged("Card 1 sent."), "the first card");
    r.stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(r.logged("Stopping the scanner…")).toBe(false);
    expect(r.nb.closeRun).not.toHaveBeenCalled();
    r.closeWebsite();
    await expect(exit).resolves.toBe(0);
  });
});

describe("one session after another", () => {
  test("nothing leaks, and the second session's keys and scanner still work", async () => {
    const setRawMode = vi.fn();
    const before = signalListeners();
    const counts: Array<{ signals: number[]; data: number; error: number; paused: boolean; raw: unknown }> = [];
    const r = rig(
      [
        "ABC123",
        async () => {
          record();
          await loadPaper("pairs:2");
          return "DEF456";
        },
        () => {
          record();
          return QUIT;
        },
      ],
    );
    const stdin = Object.assign(r.stdin, { isTTY: true, setRawMode });
    function record() {
      counts.push({
        // One each is the prompt's own, removed once it's answered.
        signals: signalListeners().map((n, i) => n - before[i] - 1),
        data: stdin.listenerCount("data"),
        error: stdin.listenerCount("error"),
        paused: stdin.isPaused(),
        raw: setRawMode.mock.lastCall?.[0],
      });
    }
    const exit = r.start();
    await until(() => r.logged("Card 1 sent."), "the first card");
    stdin.write("d");
    await until(() => r.nb.closeRun.mock.calls.length === 1, "the first close");
    await until(() => r.nb.join.mock.calls.length === 2, "the second join");
    await until(() => r.watchers.length === 2, "the second watch");
    await until(() => r.lines.filter((l) => l === "Card 1 sent.").length === 2, "the second session's card");
    stdin.write("D");
    await expect(exit).resolves.toBe(0);

    const clean = { signals: [0, 0, 0], data: 0, error: 0, paused: true, raw: false };
    expect(counts).toEqual([clean, clean]);
    expect(signalListeners()).toEqual(before);
    expect(r.nb.closeRun).toHaveBeenCalledTimes(2);
    expect(r.unwatched()).toBe(2);
    expect(setRawMode.mock.calls.map(([raw]) => raw)).toEqual([true, false, true, false]);
    expect(r.nb.join.mock.calls.map(([code]) => code)).toEqual(["ABC123", "DEF456"]);
    expect(r.prepare).toHaveBeenCalledTimes(2);
  });
});

describe("the prompt loop", () => {
  test("wrong codes, closed runs and failures say so and ask again", async () => {
    const r = rig(["", "nope", "AAA111", "BBB222", "CCC333", "DDD444", "EEE555"]);
    r.nb.join.mockImplementation(async (code) => {
      if (code === "AAA111") return null;
      if (code === "BBB222") return { ...RUN, collecting: false };
      if (code === "CCC333") throw new Error("Not authenticated");
      return RUN;
    });
    r.prepare.mockRejectedValueOnce(new Error("No scanner found that this app can drive."));
    const exit = r.start();
    await until(() => r.logged("Card 1 sent."), "the card");
    r.closeWebsite();
    await expect(exit).resolves.toBe(0);

    expect(r.logged("A scanner code is six letters and numbers, like ABC 123.")).toBe(true);
    expect(r.logged("No run of yours has the code AAA111. Check the code on the Add cards screen.")).toBe(true);
    expect(r.logged("That run isn't taking cards any more. Start a new run on the screen and use its code.")).toBe(true);
    expect(r.logged("Not authenticated")).toBe(true);
    expect(r.logged("No scanner found that this app can drive.")).toBe(true);
    // Empty and malformed answers never reach the backend.
    expect(r.nb.join.mock.calls.map(([code]) => code)).toEqual(["AAA111", "BBB222", "CCC333", "DDD444", "EEE555"]);
    // Only once a code has found an open run.
    expect(r.prepare).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["with the key's prefix", "ak_2xQ9mZpLw"],
    ["long, with no prefix", "x7Hq2Lm9Vt4Rw8Kp3Ns6Yb1"],
  ])("an API key pasted at the prompt, %s, isn't repeated or sent, and asks for the code", async (_name, key) => {
    const r = rig([key, QUIT]);
    await expect(r.start()).resolves.toBe(0);
    expect(r.logged("That looks like your API key, not a scanner code, so it wasn't used. Go back to NeonBinder, copy the scanner code, and paste that here.")).toBe(true);
    expect(r.logged("six letters and numbers")).toBe(false);
    expect(r.lines.join("\n")).not.toContain(key);
    expect(r.nb.join).not.toHaveBeenCalled();
  });

  test("the code on the command line is for the first run only", async () => {
    const r = rig([QUIT]);
    const exit = r.start("ABC123");
    await until(() => r.logged("Card 1 sent."), "the card");
    expect(r.ask).not.toHaveBeenCalled();
    r.closeWebsite();
    await expect(exit).resolves.toBe(0);
    expect(r.nb.join).toHaveBeenCalledTimes(1);
    expect(r.ask).toHaveBeenCalledTimes(1);
  });

  test("the scanner isn't looked for before a code is entered", async () => {
    const r = rig([QUIT]);
    await expect(r.start()).resolves.toBe(0);
    expect(r.prepare).not.toHaveBeenCalled();
    expect(r.nb.join).not.toHaveBeenCalled();
  });

  test("with no keyboard and no code, it says so and exits", async () => {
    const r = rig();
    r.ask.mockResolvedValue(undefined);
    await expect(r.start()).resolves.toBe(2);
    expect(r.logged("No code, so nothing to do.")).toBe(true);
  });

  test("with no keyboard, a run that closed with a card unsent is a failed exit", async () => {
    const r = rig();
    r.ask.mockResolvedValue(undefined);
    r.nb.sendImage.mockRejectedValue(new Error("job is not collecting"));
    await expect(r.start("ABC123")).resolves.toBe(1);
  });

  test("with no keyboard, a code that finds no run is a failed exit", async () => {
    const r = rig();
    r.ask.mockResolvedValue(undefined);
    r.nb.join.mockResolvedValue(null);
    await expect(r.start("ABC123")).resolves.toBe(1);
  });
});

describe("with the real client", () => {
  const ticket = { uploadUrl: "https://storage.example/upload", fields: { key: "k" }, entryIndex: 0, maxUploadBytes: 1000 };

  beforeEach(() => {
    for (const f of Object.values(convex)) f.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) =>
        String(url).endsWith("/machine/token")
          ? new Response(JSON.stringify({ token: "t1", sessionId: "s1" }), { status: 200 })
          : new Response(null, { status: 204 }),
      ),
    );
    convex.query.mockResolvedValue(RUN);
    convex.action.mockResolvedValue(ticket);
    convex.onUpdate.mockReturnValue(vi.fn());
  });

  test("a subscription error doesn't stop the scan; the same subscription still ends it later", async () => {
    await loadPaper("pairs:4");
    const nb = await NeonBinder.signIn("https://happy-otter-123.convex.cloud", "ak_secret");
    const r = rig(["ABC123"], { nb });
    const exit = r.start();
    await until(() => r.logged("Card 1 sent."), "the first card");
    const [, , onResult, onError] = convex.onUpdate.mock.calls[0];
    onError(new Error("Not authenticated"));
    await until(() => r.logged("Card 2 sent."), "the card after the error");
    expect(r.logged("Stopping the scanner…")).toBe(false);
    onResult({ ...RUN, collecting: false });
    await expect(exit).resolves.toBe(0);
    expect(r.logged(/^This run closed on NeonBinder\. 2 cards sent\.$/)).toBe(true);
    const closes = convex.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === "placeholderStream:closePlaceholderStream");
    expect(closes).toEqual([]);
  });

  test("a 401 on a token refresh ends the scan as a refused key, with no close sent", async () => {
    const nb = await NeonBinder.signIn("https://happy-otter-123.convex.cloud", "ak_secret");
    const r = rig(["ABC123"], { nb });
    const exit = r.start();
    await until(() => r.logged("Card 1 sent."), "the first card");
    const fetchToken = convex.setAuth.mock.calls[0][0] as (a: { forceRefreshToken: boolean }) => Promise<string | null>;
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(fetchToken({ forceRefreshToken: true })).resolves.toBeNull();
    await expect(exit).rejects.toBeInstanceOf(KeyRejectedError);
    const closes = convex.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === "placeholderStream:closePlaceholderStream");
    expect(closes).toEqual([]);
    expect(r.logged("This run closed on NeonBinder")).toBe(false);
    await nb.close();
  });

  test("D's close goes out after the last confirm, as the real mutation", async () => {
    const nb = await NeonBinder.signIn("https://happy-otter-123.convex.cloud", "ak_secret");
    const r = rig(["ABC123"], { nb });
    const exit = r.start();
    await until(() => r.logged("Card 1 sent."), "the first card");
    r.stdin.write("d");
    await expect(exit).resolves.toBe(0);
    const names = convex.mutation.mock.calls.map(([ref]) => getFunctionName(ref));
    expect(names.at(-1)).toBe("placeholderStream:closePlaceholderStream");
    expect(names.slice(0, -1).every((n) => n === "placeholderStream:confirmPlaceholderImageUpload")).toBe(true);
    expect(names.length).toBeGreaterThan(1);
  });
});

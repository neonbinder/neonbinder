import type { ChildProcess } from "node:child_process";
import { looksLikeCode, looksLikeKey } from "./config.js";
import { isRunClosedError, KeyRejectedError, type CloseResult, type JoinedRun } from "./neonbinder.js";
import { QUIT, type Answer } from "./prompt.js";
import type { SaneRuntime } from "./sane.js";
import { DEFAULT_TIMING, feedCards, stopScan, TESTED_BACKENDS, type ScanEvent, type ScanPlan, type Timing } from "./scanimage.js";
import { toneScan } from "./tone.js";

/**
 * The scanner app's working life: ask for a run's code, scan into that run until
 * it is done, and ask again. Done comes from the screen (the run stops
 * collecting) or from the D key here. Ctrl-C and the signals that close a
 * Terminal quit the app and leave the run open.
 */

/** How long a close may wait for an answer: offline it would queue forever. */
const CLOSE_TIMEOUT_MS = 10_000;
/** Once stopping, how long one card's upload may hold up the end of the session. */
const DRAIN_CARD_TIMEOUT_MS = 30_000;
/** How long asking after a failure whether the run is still open may wait. */
const RUN_CHECK_TIMEOUT_MS = 10_000;

const QUIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** A key press arrives alone. A paste, or an arrow key (ESC [ D), is not this key. */
const DONE_KEY = /^[dD][\r\n]*$/;
const CTRL_C = "\u0003";

export interface RunClient {
  join(code: string): Promise<JoinedRun | null>;
  watchRun(code: string, onChange: (run: JoinedRun | null) => void): () => void;
  sendImage(jobId: string, bytes: Buffer, name: string): Promise<number>;
  closeRun(jobId: string): Promise<CloseResult>;
  /** Hears that NeonBinder refused the key, straight away if it already has. Returns how to stop listening. */
  onKeyRejected(listener: () => void): () => void;
}

/** The part of stdin the app uses, so a test can drive the keys through a pipe. */
export interface KeyStream {
  isTTY?: boolean;
  setRawMode?(raw: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

export interface PreparedScan {
  scannerName: string;
  plan: ScanPlan;
  sane?: SaneRuntime;
  raw: boolean;
}

export interface SessionDeps {
  nb: RunClient;
  log: (line: string) => void;
  ask: (question: string, quit?: AbortSignal) => Promise<Answer>;
  stdin: KeyStream;
  /** Find the scanner and work out how to drive it. Runs once per run, after its code. */
  prepare: () => Promise<PreparedScan>;
  timing?: Timing;
  closeTimeoutMs?: number;
  drainCardTimeoutMs?: number;
  runCheckTimeoutMs?: number;
}

export interface SessionResult {
  /** Leave the app, rather than going back to the code prompt. */
  quit: boolean;
  /** A card has to be fed again, or the run couldn't be closed. */
  failed: boolean;
}

type Ending = "website" | "key" | "quit" | "rejected";

const plural = (n: number) => `${n} card${n === 1 ? "" : "s"}`;

/** Rejects after `ms`, leaving `work` to finish or not; never holds the process open afterwards. */
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`No answer from NeonBinder in ${Math.round(ms / 1000)} s.`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Scan into one run until it is done or the app is quit. */
export async function runSession(deps: SessionDeps, run: JoinedRun, code: string, scan: PreparedScan): Promise<SessionResult> {
  const { nb, log, stdin } = deps;
  const { plan, sane } = scan;
  const drainCardMs = deps.drainCardTimeoutMs ?? DRAIN_CARD_TIMEOUT_MS;
  const jobId = run.jobId;

  let ending: Ending | undefined;
  let quit = false;
  let runClosed = false;
  let keyRejected = false;
  let activeScan: ChildProcess | undefined;
  let scanStopped: Promise<void> = Promise.resolve();
  let requestStop = () => {};
  const stopRequested = new Promise<void>((resolve) => (requestStop = resolve));
  let cards = 0;
  let toFeedAgain = 0;

  const stop = (why: Ending) => {
    if (why === "quit") quit = true;
    if (ending) return;
    ending = why;
    requestStop();
    log("Stopping the scanner…");
    // scanimage runs in its own process group, so no terminal signal reached
    // it: stopping it here, with SIGINT, is what releases the scanner.
    const proc = activeScan;
    if (proc && proc.exitCode === null) scanStopped = stopScan(proc, log);
  };

  const onQuitSignal = () => stop("quit");
  // Read Ctrl-C as a key instead of a signal, so npm and tsx don't tear the
  // process down mid-card before the scanner is released.
  const onKey = (chunk: Buffer | string) => {
    const keys = chunk.toString();
    if (keys.includes(CTRL_C)) stop("quit");
    else if (DONE_KEY.test(keys)) stop("key");
  };
  // Closing the window can fail the read before the SIGHUP is handled.
  const onReadError = () => {};

  for (const signal of QUIT_SIGNALS) process.on(signal, onQuitSignal);
  stdin.on("data", onKey);
  stdin.on("error", onReadError);
  if (stdin.isTTY) stdin.setRawMode?.(true);
  stdin.resume();

  const unwatch = nb.watchRun(code, (latest) => {
    if (latest && latest.collecting) return;
    runClosed = true;
    stop("website");
  });
  const stopListeningForRejection = nb.onKeyRejected(() => {
    keyRejected = true;
    stop("rejected");
  });

  /**
   * A failure's words may be hidden from us, so when they don't say the run
   * closed, ask the run. No answer proves nothing, so it stays a failure.
   */
  const runHasClosed = async (error: unknown): Promise<boolean> => {
    if (runClosed || isRunClosedError(error)) return true;
    try {
      const latest = await bounded(nb.join(code), deps.runCheckTimeoutMs ?? RUN_CHECK_TIMEOUT_MS);
      return !latest?.collecting;
    } catch {
      return false;
    }
  };

  const tone = { whiteClipPercent: 1, gamma: 2.2, jpegQuality: 95, dpi: plan.resolution };
  const send = async (raw: Buffer, name: string) => nb.sendImage(jobId, (await toneScan(raw, tone)) ?? raw, name);

  /** Uploads wait out a blip while scanning. Once stopping, one can't hold the session open forever. */
  const boundedOnceStopping = async (work: Promise<void>) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tooLong = stopRequested.then(
      () =>
        new Promise<never>((_, reject) => {
          if (!settled) timer = setTimeout(() => reject(new Error(`No answer in ${Math.round(drainCardMs / 1000)} s.`)), drainCardMs);
        }),
    );
    try {
      await Promise.race([work, tooLong]);
    } finally {
      settled = true;
      clearTimeout(timer);
    }
  };

  const notSent = (n: number) => {
    toFeedAgain++;
    log(`Card ${n} wasn't sent: the run stopped taking cards. Put it back in the stack.`);
  };
  const notSentSignedOut = (n: number) => {
    toFeedAgain++;
    log(`Card ${n} wasn't sent: NeonBinder signed this app out. Put it back in the stack.`);
  };

  const onEvent = async (event: ScanEvent) => {
    switch (event.kind) {
      case "card": {
        const n = cards + toFeedAgain + 1;
        if (keyRejected) {
          notSentSignedOut(n);
          return;
        }
        if (runClosed) {
          notSent(n);
          return;
        }
        try {
          // Front, then back, one after the other: the run sees them side by side.
          const upload = (async () => {
            await send(event.front, `scan-${n}-front.jpg`);
            await send(event.back, `scan-${n}-back.jpg`);
          })();
          await boundedOnceStopping(upload);
          cards++;
          log(`Card ${n} sent.`);
        } catch (error) {
          const closed = !keyRejected && (await runHasClosed(error));
          // Checked after the wait too: without a key nothing here is about the run.
          if (keyRejected) {
            notSentSignedOut(n);
            return;
          }
          if (closed) {
            runClosed = true;
            notSent(n);
            stop("website");
            return;
          }
          toFeedAgain++;
          log(`Card ${n} didn't reach NeonBinder. Check the internet connection and feed it again.`);
          log(`  (${error instanceof Error ? error.message : String(error)})`);
        }
        return;
      }
      case "one-side":
        log("A card scanned only one side and was dropped. Put it back in the stack.");
        return;
      case "stalled":
        log(`The scanner stalled after ${plural(event.kept)}. Leave the rest in the feeder; it retries.`);
        if (event.partial) log("The card it stopped on wasn't sent. Put it back in the stack.");
        return;
      case "jammed":
        log(`The feeder reported a jam ${event.times} times in a row. Check for a stuck card.`);
        return;
      case "error":
        log("The scanner reported a problem. Check it's on, the cover is shut, and the cards are loaded; it retries.");
        log(`  (${event.detail})`);
        return;
    }
  };

  let closeFailed = false;
  let feedFailed = false;
  try {
    try {
      await feedCards({
        plan,
        sane,
        timing: deps.timing ?? DEFAULT_TIMING,
        shouldStop: () => ending !== undefined,
        stopRequested,
        onEvent,
        onScanStart: (proc) => {
          activeScan = proc;
          // A stop that landed just before this scan started had nothing to stop.
          if (ending) scanStopped = stopScan(proc, log);
        },
        log,
      });
    } catch (error) {
      feedFailed = true;
      log(error instanceof Error ? error.message : String(error));
    }
    await scanStopped;

    // Only now: closing any earlier would refuse the last card's upload.
    if (ending === "key" && keyRejected) {
      closeFailed = true;
    } else if (ending === "key") {
      try {
        await bounded(nb.closeRun(jobId), deps.closeTimeoutMs ?? CLOSE_TIMEOUT_MS);
      } catch (error) {
        // Refused because it's already gone: there's nothing left to press.
        closeFailed = !(await runHasClosed(error));
      }
    }
    const summary = `${plural(cards)} sent${toFeedAgain ? `, ${toFeedAgain} to feed again` : ""}.`;
    log(ending === "website" ? `This run closed on NeonBinder. ${summary}` : ending === "key" ? `Done. ${summary}` : summary);
    if (closeFailed) log("Couldn't reach NeonBinder. Press Done adding photos on the screen.");
  } finally {
    stopListeningForRejection();
    unwatch();
    for (const signal of QUIT_SIGNALS) process.off(signal, onQuitSignal);
    stdin.off("data", onKey);
    stdin.off("error", onReadError);
    if (stdin.isTTY) stdin.setRawMode?.(false);
    stdin.pause();
  }
  return { quit, failed: toFeedAgain > 0 || closeFailed || feedFailed };
}

/** One prompt, with the quitting signals answering it instead of ending the process mid-line. */
async function askForCode(deps: SessionDeps): Promise<Answer> {
  const quit = new AbortController();
  const onSignal = () => quit.abort();
  for (const signal of QUIT_SIGNALS) process.on(signal, onSignal);
  // A refused key ends the prompt too: no code would work without one.
  const stopListeningForRejection = deps.nb.onKeyRejected(onSignal);
  try {
    return await deps.ask("Scanner code: ", quit.signal);
  } finally {
    stopListeningForRejection();
    for (const signal of QUIT_SIGNALS) process.off(signal, onSignal);
  }
}

/**
 * Ask for a code, scan that run, and ask again. `firstCode` (from the command
 * line) stands in for the first answer only. Returns the exit code, or throws
 * KeyRejectedError once NeonBinder refuses the key.
 */
export async function scanLoop(deps: SessionDeps, firstCode?: string): Promise<number> {
  let rejected = false;
  const stopListeningForRejection = deps.nb.onKeyRejected(() => (rejected = true));
  try {
    return await promptLoop(deps, firstCode, () => rejected);
  } finally {
    stopListeningForRejection();
  }
}

async function promptLoop(deps: SessionDeps, firstCode: string | undefined, keyRejected: () => boolean): Promise<number> {
  const { nb, log } = deps;
  let given = firstCode;
  /** Decides the exit once there's no keyboard to ask; undefined when nothing was tried. */
  let exitCode: number | undefined;
  let hint = 'On NeonBinder, open Add cards, pick the binder or box, and press "Use a scanner". Ctrl-C quits.';

  for (;;) {
    if (keyRejected()) throw new KeyRejectedError();
    let code: Answer = given;
    given = undefined;
    if (code === undefined) {
      if (hint) log(hint);
      hint = "";
      code = await askForCode(deps);
      if (keyRejected()) throw new KeyRejectedError();
    }
    if (code === QUIT) return 0;
    if (code === undefined) {
      if (exitCode !== undefined) return exitCode;
      log('No code, so nothing to do. On NeonBinder, press "Use a scanner" on Add cards, then open this app again.');
      return 2;
    }
    if (code === "") continue;
    exitCode = 1;
    if (!looksLikeCode(code)) {
      log(
        looksLikeKey(code)
          ? "That looks like your API key, not a scanner code, so it wasn't used. Go back to NeonBinder, copy the scanner code, and paste that here."
          : "A scanner code is six letters and numbers, like ABC 123.",
      );
      continue;
    }

    let run: JoinedRun;
    let scan: PreparedScan;
    try {
      const joined = await nb.join(code);
      if (!joined) {
        log(`No run of yours has the code ${code}. Check the code on the Add cards screen.`);
        continue;
      }
      if (!joined.collecting) {
        log("That run isn't taking cards any more. Start a new run on the screen and use its code.");
        continue;
      }
      run = joined;
      scan = await deps.prepare();
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
      continue;
    }

    log(`Joined: cards go into ${run.homeName}${run.variantName ? `, matched in ${run.variantName}` : ""}.`);
    log(`Scanner: ${scan.scannerName}.`);
    if (!scan.plan.backend || !TESTED_BACKENDS.includes(scan.plan.backend)) {
      log("This scanner hasn't been tested with NeonBinder Scanner yet. Watch the first few cards on the screen:");
      log("if they jam, come out crooked or miss a side, stop here (Ctrl-C).");
    }
    if (scan.raw) log(`${scan.plan.resolution} dpi, raw frame (no crop).`);
    log("Ready. Load cards in the feeder; each shows up on NeonBinder as it feeds.");
    log("Press D when you're done (same as Done adding photos on the screen). Ctrl-C quits.");

    const session = await runSession(deps, run, code, scan);
    exitCode = session.failed ? 1 : 0;
    if (session.quit) return exitCode;
    hint = "Waiting for the next run's code. Ctrl-C quits.";
  }
}

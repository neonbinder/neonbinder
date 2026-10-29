import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, readFile, rm, stat, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Driving a Fujitsu fi-series ADF over SANE `scanimage`, in duplex.
 *
 * Everything here was learned the hard way on an fi-7160 by the scanner CLI
 * this replaces; the comments say why each setting is what it is.
 */

export interface ScanSettings {
  device?: string;
  source: string;
  mode: string;
  resolution: number;
  /**
   * Scan area in mm, much larger than a 63.5 x 88.9 mm card: a card skewed 10
   * degrees needs ~78 x 99 mm, and too tight clips silently, which is worse
   * than failing because the images still look plausible.
   */
  pageWidthMm: number;
  pageHeightMm: number;
  /**
   * Hardware deskew + crop straightens the card, orients it and crops to its
   * edges. Raw mode turns it off and turns overscan on instead (full frame
   * with margin); the two are exclusive since the crop removes the margin.
   */
  raw: boolean;
  /**
   * MUST stay Off. On, the scanner races ahead pulling cards into memory, so a
   * stall strands them: fed, never captured, and afterwards
   * indistinguishable from cards that scanned fine.
   */
  bufferMode: string;
  prepick: string;
}

export const DEFAULT_SETTINGS: ScanSettings = {
  source: "ADF Duplex",
  mode: "Color",
  resolution: 400,
  pageWidthMm: 110,
  pageHeightMm: 130,
  raw: false,
  bufferMode: "Off",
  prepick: "Default",
};

/** The first Fujitsu device `scanimage -f` lists, or the configured one. */
export async function findDevice(settings: ScanSettings): Promise<string> {
  if (settings.device) return settings.device;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("scanimage", ["-f", "%d%n"]));
  } catch {
    throw new Error("Couldn't run scanimage. Install SANE (brew install sane-backends) and try again.");
  }
  const device = pickFujitsuDevice(stdout);
  if (!device) throw new Error("No Fujitsu scanner found. Check it's on and plugged in.");
  return device;
}

export function pickFujitsuDevice(listing: string): string | undefined {
  return listing
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("fujitsu:"));
}

/** Does `scanimage -A` say the hopper sensor sees paper? */
export function paperLoadedIn(options: string): boolean {
  const line = options.split("\n").find((l) => l.includes("--page-loaded"));
  return !!line && /\[yes\]/.test(line);
}

export async function paperPresent(device: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("scanimage", ["-d", device, "-A"]);
    return paperLoadedIn(stdout);
  } catch {
    return false;
  }
}

export function scanArgs(device: string, settings: ScanSettings, batchPattern: string): string[] {
  const w = String(settings.pageWidthMm);
  const h = String(settings.pageHeightMm);
  return [
    "-d", device,
    "--source", settings.source,
    "--mode", settings.mode,
    "--resolution", String(settings.resolution),
    "--page-width", w,
    "--page-height", h,
    "-x", w,
    "-y", h,
    "--overscan", settings.raw ? "On" : "Off",
    `--hwdeskewcrop=${settings.raw ? "no" : "yes"}`,
    // Card stock is thicker than paper, so the jam-prediction and ultrasonic
    // double-feed sensors false-trigger on every card and the scanner aborts
    // with "Document feeder jammed" before sending anything. Page geometry
    // alone does not fix it; these four flags do.
    "--paper-protect", "Off",
    "--adv-paper-protect", "Off",
    "--df-action", "Continue",
    "--df-recovery", "Off",
    "--buffermode", settings.bufferMode,
    "--prepick", settings.prepick,
    "--format=jpeg",
    `--batch=${batchPattern}`,
    "--batch-start=1",
  ];
}

/**
 * Which staged files make whole cards. scanimage writes a duplex card as two
 * consecutive files, front then back, and writes sequentially, so a file is
 * known complete once the next one exists. While a scan runs the newest file
 * is held back; `final` means scanimage has exited and all are complete. A
 * leftover single at the end is a card that gave up only one side.
 */
export function wholeCards(
  staged: readonly string[],
  final: boolean,
): { pairs: Array<[string, string]>; orphan?: string } {
  const complete = final ? staged.length : Math.max(0, staged.length - 1);
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i + 1 < complete; i += 2) pairs.push([staged[i], staged[i + 1]]);
  const orphan = final && complete % 2 === 1 ? staged[complete - 1] : undefined;
  return { pairs, orphan };
}

export interface Timing {
  /** Longest healthy gap is 2-3 s between cards; 0 s between a card's sides. */
  stallMs: number;
  /** The first page also covers feeding and lamp start. */
  firstPageMs: number;
  /**
   * A stack still moving reads as a double feed to the ultrasonic sensor
   * ("Document feeder jammed", error 49), so a freshly loaded stack settles
   * first. That was why the first card of every batch used to fail.
   */
  settleMs: number;
  idleMs: number;
  pollMs: number;
}

export const DEFAULT_TIMING: Timing = {
  stallMs: 5000,
  firstPageMs: 25000,
  settleMs: 2000,
  idleMs: 3000,
  pollMs: 250,
};

export type ScanEvent =
  | { kind: "card"; front: Buffer; back: Buffer }
  | { kind: "one-side"; image: Buffer }
  | { kind: "stalled"; kept: number; partial?: Buffer }
  | { kind: "jammed"; times: number }
  | { kind: "error"; detail: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const running = (proc: ChildProcess) => proc.exitCode === null && !proc.signalCode;

async function waitForExit(proc: ChildProcess, ms: number, pollMs: number): Promise<boolean> {
  for (let waited = 0; running(proc) && waited < ms; waited += pollMs) await sleep(pollMs);
  return !running(proc);
}

/**
 * Stop scanimage. It traps SIGINT and calls sane_cancel/sane_close, which
 * releases the USB device; SIGTERM/SIGKILL skip that and leave the scanner
 * wedged until a power cycle. So always SIGINT first, and escalate only if it
 * will not exit.
 */
export async function stopScan(proc: ChildProcess, log: (line: string) => void): Promise<void> {
  proc.kill("SIGINT");
  if (await waitForExit(proc, 10000, 250)) return;
  log("The scan didn't stop on its own; forcing it. The scanner may need a power cycle.");
  proc.kill("SIGTERM");
  await sleep(2000);
  if (proc.exitCode === null) proc.kill("SIGKILL");
}

/**
 * Feed cards for as long as `shouldStop` says no: wait for paper, let it
 * settle, scan the stack, hand each whole card to `onEvent` as it lands, and
 * watchdog the transfer (the scanner sometimes stops mid-card and scanimage
 * then waits forever).
 *
 * `onEvent` is awaited, so a slow upload holds back the next card's event but
 * never the scanner itself.
 */
export async function feedCards(opts: {
  device: string;
  settings: ScanSettings;
  timing: Timing;
  shouldStop: () => boolean;
  /** Resolves when a stop is asked for, to cut idle waits short. */
  stopRequested: Promise<void>;
  onEvent: (event: ScanEvent) => Promise<void>;
  onScanStart: (proc: ChildProcess) => void;
  log: (line: string) => void;
}): Promise<void> {
  const { device, settings, timing, shouldStop, onEvent, log } = opts;
  const pause = (ms: number) => Promise.race([sleep(ms), opts.stopRequested]);
  const stage = await mkdtemp(path.join(tmpdir(), "nb-scan-"));
  let jams = 0;
  try {
    while (!shouldStop()) {
      while (!shouldStop() && !(await paperPresent(device))) await pause(timing.idleMs);
      if (shouldStop()) break;
      await pause(timing.settleMs);
      if (shouldStop()) break;

      for (const f of await readdir(stage)) await rm(path.join(stage, f), { force: true });
      const proc = spawn("scanimage", scanArgs(device, settings, path.join(stage, "raw-%04d.jpg")), {
        stdio: ["ignore", "ignore", "pipe"],
      });
      opts.onScanStart(proc);
      let stderr = "";
      proc.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const exited = new Promise<void>((resolve) => proc.on("close", () => resolve()));

      const staged = async () => (await readdir(stage).catch(() => [] as string[])).filter((f) => f.startsWith("raw-") && f.endsWith(".jpg")).sort();
      let released = 0;
      let kept = 0;
      const release = async (final: boolean) => {
        const files = await staged();
        const { pairs, orphan } = wholeCards(files, final);
        for (const [front, back] of pairs.slice(released)) {
          released++;
          kept++;
          await onEvent({
            kind: "card",
            front: await readFile(path.join(stage, front)),
            back: await readFile(path.join(stage, back)),
          });
        }
        return orphan;
      };

      let seen = 0;
      let sawPage = false;
      let lastProgress = Date.now();
      let stalled = false;
      let partial: Buffer | undefined;
      while (running(proc)) {
        const files = await staged();
        if (files.length > seen) {
          seen = files.length;
          sawPage = true;
          lastProgress = Date.now();
          await release(false);
        } else if (!shouldStop() && Date.now() - lastProgress > (sawPage ? timing.stallMs : timing.firstPageMs)) {
          stalled = true;
          partial = await snapshotPartial(stage);
          await stopScan(proc, log);
          break;
        }
        await sleep(timing.pollMs);
      }
      await exited;

      const orphan = await release(true);
      if (orphan) await onEvent({ kind: "one-side", image: await readFile(path.join(stage, orphan)) });
      if (!/jammed/i.test(stderr)) jams = 0;

      if (stalled) {
        await onEvent({ kind: "stalled", kept, partial: orphan ? undefined : partial });
        await pause(timing.idleMs);
      } else if (kept > 0 || /out of documents/i.test(stderr)) {
        // Cards scanned, or the feeder emptied between the sensor and the scan.
      } else if (/jammed/i.test(stderr)) {
        // The first start of a batch can report a jam that the retry clears.
        // Only a run of them means a card is really stuck.
        jams++;
        if (jams >= 4) await onEvent({ kind: "jammed", times: jams });
      } else if (stderr.trim() && !shouldStop()) {
        const detail = stderr
          .split("\n")
          .filter((l) => l.trim() && !/rounded value/.test(l))
          .slice(0, 3)
          .join("; ");
        await onEvent({ kind: "error", detail });
        await pause(timing.idleMs);
      }
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/**
 * Copy what scanimage has of the page it stalled on: on cancel it deletes its
 * `.part` file, so this is the only image of that card. Undefined when the
 * page had not started (a header-only file).
 */
async function snapshotPartial(stage: string): Promise<Buffer | undefined> {
  const part = (await readdir(stage).catch(() => [] as string[])).find((f) => f.endsWith(".part"));
  if (!part) return undefined;
  const copy = path.join(stage, "stalled.jpg");
  try {
    await copyFile(path.join(stage, part), copy);
    if ((await stat(copy)).size < 4096) return undefined;
    return await readFile(copy);
  } catch {
    return undefined;
  }
}

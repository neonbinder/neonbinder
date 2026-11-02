import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, readFile, rm, stat, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SYSTEM_SANE, type SaneRuntime } from "./sane.js";

const execFileAsync = promisify(execFile);

/**
 * Driving a sheet-fed scanner over SANE `scanimage`, in duplex.
 *
 * Fujitsu fi-series is the tested path: everything in `fujitsuArgs` was
 * learned the hard way on an fi-7160 by the scanner CLI this replaces, and the
 * comments say why each setting is what it is. Canon imageFORMULA (canon_dr)
 * and Epson (epsonds, epson2) follow what their SANE backends document and
 * are untested on real hardware, so their settings are only ever the options
 * the scanner itself reports: scanimage refuses an unknown or inactive option
 * outright, and every model of a brand reports a different set.
 */

/** The SANE backends the app carries (scripts/bundle-sane.sh) and drives. */
export const SUPPORTED_BACKENDS = ["fujitsu", "canon_dr", "epsonds", "epson2"] as const;
export type Backend = (typeof SUPPORTED_BACKENDS)[number];
/** Proven on a real scanner. */
export const TESTED_BACKENDS: readonly Backend[] = ["fujitsu"];
export const BRAND: Record<Backend, string> = { fujitsu: "Fujitsu", canon_dr: "Canon", epsonds: "Epson", epson2: "Epson" };

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

export interface Scanner {
  device: string;
  backend?: Backend;
  /** "Canon DR-C225", as SANE names it. */
  name: string;
}

function unavailable(sane: SaneRuntime): Error {
  return new Error(
    sane === SYSTEM_SANE
      ? "Couldn't run scanimage. Install SANE (brew install sane-backends) and try again."
      : "Couldn't start the scanner driver. Download the scanner app again and retry.",
  );
}

export function backendOf(device: string): Backend | undefined {
  const prefix = device.slice(0, device.indexOf(":"));
  return (SUPPORTED_BACKENDS as readonly string[]).includes(prefix) ? (prefix as Backend) : undefined;
}

/** `scanimage -f "%d|%v %m%n"` as scanners. */
export function parseScanners(listing: string): Scanner[] {
  return listing
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [device, name = ""] = line.split("|");
      return { device, backend: backendOf(device), name: name.trim() || device };
    });
}

/** Every scanner SANE sees. Throws when the driver won't run. */
export async function listScanners(sane: SaneRuntime = SYSTEM_SANE): Promise<Scanner[]> {
  const { stdout } = await execFileAsync(sane.scanimage, ["-f", "%d|%v %m%n"], { env: sane.env });
  return parseScanners(stdout);
}

/** The first scanner the app can drive, or the configured one. */
export async function findScanner(settings: ScanSettings, sane: SaneRuntime = SYSTEM_SANE): Promise<Scanner> {
  if (settings.device) return { device: settings.device, backend: backendOf(settings.device), name: settings.device };
  let scanners: Scanner[];
  try {
    scanners = await listScanners(sane);
  } catch {
    throw unavailable(sane);
  }
  const scanner = scanners.find((s) => s.backend);
  if (!scanner) {
    throw new Error(
      "No scanner found that this app can drive. Check it's on and plugged in. It works with Fujitsu, Canon and Epson scanners that have a feeder.",
    );
  }
  return scanner;
}

/** One option as `scanimage -A` lists it. `values` is null for a range or free value. */
export interface DeviceOption {
  values: string[] | null;
  active: boolean;
}
export type DeviceOptions = Map<string, DeviceOption>;

/**
 * `scanimage -A`, as a map from flag ("--source", "-x") to what it accepts:
 *
 *     --source Flatbed|ADF Front|ADF Duplex [ADF Front]
 *     --swcrop[=(yes|no)] [inactive]
 *     --resolution 75|150|300|600dpi [300]
 *     -x 0..215.9mm [215.9]
 */
export function parseOptions(listing: string): DeviceOptions {
  const options: DeviceOptions = new Map();
  for (const line of listing.split("\n")) {
    const match = /^\s+(--?[a-z0-9][a-z0-9-]*)(.*)$/i.exec(line);
    if (!match) continue;
    const [, flag] = match;
    let rest = match[2];
    const current: string[] = [];
    // The trailing "[current]" brackets; "[=(yes|no)]" is the value list, not one.
    const TAIL = /\s+\[([^\]=][^\]]*)\]\s*$/;
    for (let tail = TAIL.exec(rest); tail; tail = TAIL.exec(rest)) {
      current.unshift(tail[1]);
      rest = rest.slice(0, tail.index);
    }
    if (!current.length) continue;
    rest = rest.trim();
    let values: string[] | null;
    const bool = /^\[=\(([^)]*)\)\]$/.exec(rest);
    if (bool) values = bool[1].split("|");
    else if (!rest || rest.includes("..") || rest.startsWith("<")) values = null;
    else values = rest.split("|").map((v) => v.trim().replace(/^(\d+(?:\.\d+)?)[a-z%]+$/i, "$1"));
    options.set(flag, { values, active: !current.includes("inactive") });
  }
  return options;
}

async function readOptions(device: string, set: string[], sane: SaneRuntime): Promise<DeviceOptions> {
  try {
    const { stdout } = await execFileAsync(sane.scanimage, ["-d", device, ...set, "-A"], { env: sane.env });
    return parseOptions(stdout);
  } catch {
    throw new Error("The scanner didn't answer. Turn it off and on again, then reopen this app.");
  }
}

/** How to scan with one scanner: everything scanimage needs before its output flags. */
export interface ScanPlan {
  device: string;
  backend?: Backend;
  args: string[];
  /** The resolution scanned at, which the scanner may have rounded. */
  resolution: number;
  /** The hopper sensor flag. Without one, an empty feeder is found by trying. */
  sensor?: string;
}

/** The feeder source that scans both sides, plus any flag that makes it duplex. */
export function duplexSource(options: DeviceOptions): string[] | undefined {
  const sources = options.get("--source")?.values ?? [];
  const duplex = sources.find((s) => /^(ADF|Card) Duplex$/i.test(s)) ?? sources.find((s) => /duplex/i.test(s));
  if (duplex) return [`--source=${duplex}`];
  // epson2: one feeder source, with duplex as a mode of it.
  const feeder = sources.find((s) => /ADF|feeder/i.test(s));
  if (feeder && options.get("--adf-mode")?.values?.includes("Duplex")) return [`--source=${feeder}`, "--adf-mode=Duplex"];
  return undefined;
}

/** The listed resolution nearest the one asked for, a step up on a tie. */
export function nearestResolution(option: DeviceOption | undefined, wanted: number): number {
  const listed = option?.values?.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!listed?.length) return wanted;
  return listed.reduce((best, n) => {
    const d = Math.abs(n - wanted) - Math.abs(best - wanted);
    return d < 0 || (d === 0 && n > best) ? n : best;
  });
}

/**
 * The args for a scanner other than a Fujitsu, from the options it reports
 * with its duplex source set. A setting the scanner doesn't list is left out
 * rather than guessed.
 */
export function reportedArgs(
  device: string,
  backend: Backend | undefined,
  settings: ScanSettings,
  source: string[],
  options: DeviceOptions,
): Omit<ScanPlan, "device" | "backend"> {
  const args = ["-d", device, ...source];
  const set = (flag: string, value: string) => {
    const option = options.get(flag);
    if (!option?.active) return false;
    if (option.values && !option.values.includes(value)) return false;
    // A long option takes "=value"; -x and -y take theirs as the next word.
    if (flag.startsWith("--")) args.push(`${flag}=${value}`);
    else args.push(flag, value);
    return true;
  };
  const resolution = nearestResolution(options.get("--resolution"), settings.resolution);
  set("--mode", settings.mode);
  set("--resolution", String(resolution));
  // Page size first: on Canon it bounds the scan area.
  set("--page-width", String(settings.pageWidthMm));
  set("--page-height", String(settings.pageHeightMm));
  set("-x", String(settings.pageWidthMm));
  set("-y", String(settings.pageHeightMm));
  if (backend === "canon_dr") {
    // Card stock trips double-feed detection by thickness and by length, the
    // same way it trips the Fujitsu's sensors.
    set("--df-thickness", "no");
    set("--df-length", "no");
    set("--stapledetect", "no");
    // The same stranded-cards risk as the Fujitsu's buffer mode.
    set("--buffermode", "no");
    if (!settings.raw && !set("--hwcrop", "yes")) {
      set("--swcrop", "yes");
      set("--swdeskew", "yes");
    }
  }
  // epsonds never turns on double-feed detection; it only offers crop and skew.
  if (backend === "epsonds" && !settings.raw) {
    set("--adf-skew", "yes");
    set("--adf-crp", "yes");
  }
  const sensor = ["--page-loaded", "--adf-loaded"].find((flag) => options.get(flag)?.active);
  return { args, resolution, sensor };
}

/** Work out how to scan with this scanner, asking it what it supports unless it is a Fujitsu. */
export async function planScan(scanner: Scanner, settings: ScanSettings, sane: SaneRuntime = SYSTEM_SANE): Promise<ScanPlan> {
  const { device, backend } = scanner;
  if (backend === "fujitsu") return fujitsuPlan(device, settings);
  const source = duplexSource(await readOptions(device, [], sane));
  if (!source) throw new Error(`${scanner.name} can't scan both sides from its feeder, which cards need.`);
  return { device, backend, ...reportedArgs(device, backend, settings, source, await readOptions(device, source, sane)) };
}

export function fujitsuPlan(device: string, settings: ScanSettings): ScanPlan {
  return { device, backend: "fujitsu", args: fujitsuArgs(device, settings), resolution: settings.resolution, sensor: "--page-loaded" };
}

/** Does `scanimage -A` say the hopper sensor sees paper? */
export function paperLoadedIn(options: string, sensor = "--page-loaded"): boolean {
  const line = options.split("\n").find((l) => l.includes(`${sensor}[`));
  return !!line && /\[yes\]/.test(line);
}

export async function paperPresent(device: string, sane: SaneRuntime = SYSTEM_SANE, sensor = "--page-loaded"): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(sane.scanimage, ["-d", device, "-A"], { env: sane.env });
    return paperLoadedIn(stdout, sensor);
  } catch {
    return false;
  }
}

export function fujitsuArgs(device: string, settings: ScanSettings): string[] {
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
  ];
}

export function scanArgs(plan: ScanPlan, batchPattern: string): string[] {
  return [...plan.args, "--format=jpeg", `--batch=${batchPattern}`, "--batch-start=1"];
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
 * settle, scan the stack (with no hopper sensor, just try, and wait a while
 * when the feeder turns out empty), hand each whole card to `onEvent` as it lands, and
 * watchdog the transfer (the scanner sometimes stops mid-card and scanimage
 * then waits forever).
 *
 * `onEvent` is awaited, so a slow upload holds back the next card's event but
 * never the scanner itself.
 */
export async function feedCards(opts: {
  plan: ScanPlan;
  /** Which scanimage, and the environment it needs. The one on PATH if unset. */
  sane?: SaneRuntime;
  timing: Timing;
  shouldStop: () => boolean;
  /** Resolves when a stop is asked for, to cut idle waits short. */
  stopRequested: Promise<void>;
  onEvent: (event: ScanEvent) => Promise<void>;
  onScanStart: (proc: ChildProcess) => void;
  log: (line: string) => void;
}): Promise<void> {
  const { plan, timing, shouldStop, onEvent, log } = opts;
  const { device, sensor } = plan;
  const sane = opts.sane ?? SYSTEM_SANE;
  const pause = (ms: number) => Promise.race([sleep(ms), opts.stopRequested]);
  const stage = await mkdtemp(path.join(tmpdir(), "nb-scan-"));
  let jams = 0;
  try {
    while (!shouldStop()) {
      if (sensor) {
        while (!shouldStop() && !(await paperPresent(device, sane, sensor))) await pause(timing.idleMs);
        if (shouldStop()) break;
        await pause(timing.settleMs);
        if (shouldStop()) break;
      }

      for (const f of await readdir(stage)) await rm(path.join(stage, f), { force: true });
      const proc = spawn(sane.scanimage, scanArgs(plan, path.join(stage, "raw-%04d.jpg")), {
        stdio: ["ignore", "ignore", "pipe"],
        env: sane.env,
        // Its own process group, so a Ctrl-C or a closed Terminal window
        // reaches only us, and we stop it the one safe way (stopScan).
        detached: true,
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
      } else if (kept > 0) {
        // Cards scanned.
      } else if (/out of documents/i.test(stderr)) {
        // The feeder emptied between the sensor and the scan, or (no sensor)
        // it was empty all along: try again after a wait, not straight away.
        if (!sensor) await pause(timing.idleMs);
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

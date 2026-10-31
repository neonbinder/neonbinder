import type { ChildProcess } from "node:child_process";
import { parseArgs } from "node:util";
import { configPath, looksLikeCode, resolveConvexUrl, savedKey, saveKey } from "./config.js";
import { isRunClosedError, KeyRejectedError, NeonBinder } from "./neonbinder.js";
import { ask, askSecret } from "./prompt.js";
import { saneRuntime, SYSTEM_SANE, type SaneRuntime } from "./sane.js";
import { DEFAULT_SETTINGS, DEFAULT_TIMING, feedCards, findDevice, listScanners, stopScan, type ScanEvent } from "./scanimage.js";
import { toneScan } from "./tone.js";

/**
 * NEO-386 — the NeonBinder scanner app: feed cards from a sheet-fed scanner
 * into the intake run open on the NeonBinder screen. The screen's "Use a
 * scanner" shows the code. Each card scans in duplex and goes up front then
 * back; the screen pairs, reads and matches them like dropped photos.
 *
 * Packaged (`npm run build`), it is one file carrying its own scanner driver:
 * double-click it, type the code, and (once) paste an API key. From source it
 * is `npm run scan <code>` against the scanimage on PATH.
 *
 * Environment, all optional (a `.env` beside package.json works from source):
 *   NEONBINDER_API_KEY     a key to use instead of the saved one
 *   NEONBINDER_CONVEX_URL  https://<deployment>.convex.cloud, for a preview;
 *                          otherwise the app asks neonbinder.io
 *   NEONBINDER_CONVEX_SITE_URL  only for a local backend
 *   SCANNER_DEVICE  a SANE device name, when the first Fujitsu isn't the one
 */

const HELP = `Usage: neonbinder-scanner [code] [--raw] [--forget-key]

  code          the scanner code on the Add cards screen ("Use a scanner");
                asked for when left out
  --raw         no hardware deskew/crop: full frame with margin (odd sizes)
  --forget-key  forget the saved API key and ask for one again
  --check       set up the scanner driver, list the scanners it sees, and stop

Ctrl-C stops the scanner. A card it was partway through is reported to feed again.`;

const log = (line: string) => process.stdout.write(`${line}\n`);

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** Sign in with the env key, the saved key, or one asked for (then saved). */
async function signIn(convexUrl: string, keyFile: string): Promise<NeonBinder | undefined> {
  const fromEnv = env("NEONBINDER_API_KEY") ?? env("NEONBINDER_MACHINE_KEY");
  if (fromEnv) return NeonBinder.signIn(convexUrl, fromEnv, env("NEONBINDER_CONVEX_SITE_URL"));
  let key = await savedKey(keyFile, convexUrl);
  let asked = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!key) {
      log("Paste your NeonBinder API key (NeonBinder → Profile → API Keys). It's saved on this computer.");
      key = await askSecret("API key: ");
      if (!key) return undefined;
      asked = true;
    }
    try {
      const nb = await NeonBinder.signIn(convexUrl, key, env("NEONBINDER_CONVEX_SITE_URL"));
      if (asked) await saveKey(keyFile, convexUrl, key);
      return nb;
    } catch (error) {
      if (!(error instanceof KeyRejectedError)) throw error;
      log(error.message);
      await saveKey(keyFile, convexUrl, undefined);
      key = undefined;
    }
  }
  return undefined;
}

async function askCode(given: string | undefined): Promise<string | undefined> {
  if (given) return given;
  log('On NeonBinder, open Add cards, pick the binder or box, and press "Use a scanner".');
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = await ask("Scanner code: ");
    if (code === undefined || code === "") return undefined;
    if (looksLikeCode(code)) return code;
    log("A scanner code is six letters and numbers, like ABC 123.");
  }
  return undefined;
}

/** `--check`: is the driver working, and does it see a scanner? Signs in to nothing. */
async function check(): Promise<number> {
  const sane = await saneRuntime();
  const scanners = await listScanners(sane);
  log(`Scanner driver ready (${sane === SYSTEM_SANE ? "SANE on this computer" : "built in"}).`);
  log(scanners.length ? scanners.map((s) => `Found ${s}`).join("\n") : "No scanner found. Check it's on and plugged in.");
  return 0;
}

async function main(): Promise<number> {
  // Only from source. The packaged app reads no .env at all (it's built with
  // --no-compile-autoload-dotenv too): a file dropped beside a download must
  // never be able to point the collector's key at another backend.
  if (!import.meta.url.includes("$bunfs")) {
    try {
      process.loadEnvFile(new URL("../.env", import.meta.url));
    } catch {
      // No .env: the environment alone has to do.
    }
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      raw: { type: "boolean", default: false },
      "forget-key": { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length > 1) {
    log(HELP);
    return values.help ? 0 : 2;
  }
  log("NeonBinder Scanner");
  if (values.check) return await check();

  const convexUrl = await resolveConvexUrl({ convexUrl: env("NEONBINDER_CONVEX_URL"), site: env("NEONBINDER_SITE") });
  const keyFile = configPath();
  if (values["forget-key"]) await saveKey(keyFile, convexUrl, undefined);

  const nb = await signIn(convexUrl, keyFile);
  if (!nb) {
    log("No API key, so nothing to do. Make one under Profile → API Keys and run this again.");
    return 1;
  }
  try {
    const code = await askCode(positionals[0]);
    if (!code) {
      log('No code, so nothing to do. On NeonBinder, press "Use a scanner" on Add cards, then open this app again.');
      return 2;
    }
    const run = await nb.join(code);
    if (!run) {
      log(`No run of yours has the code ${code}. Check the code on the Add cards screen.`);
      return 1;
    }
    if (!run.collecting) {
      log("That run isn't taking cards any more. Start a new run on the screen and use its code.");
      return 1;
    }
    const settings = { ...DEFAULT_SETTINGS, raw: values.raw, device: env("SCANNER_DEVICE") };
    const sane = await saneRuntime();
    const device = await findDevice(settings, sane);
    log(`Joined: cards go into ${run.homeName}${run.variantName ? `, matched in ${run.variantName}` : ""}.`);
    if (settings.raw) log(`${settings.source}, ${settings.resolution} dpi, raw frame (no crop).`);
    log("Ready. Load cards in the feeder; each shows up on NeonBinder as it feeds.");
    log("To stop, press Ctrl-C or close this window.");
    return await scanInto(nb, run.jobId, device, settings, sane);
  } finally {
    await nb.close();
  }
}

async function scanInto(
  nb: NeonBinder,
  jobId: string,
  device: string,
  settings: typeof DEFAULT_SETTINGS,
  sane: SaneRuntime,
): Promise<number> {
  let stopping = false;
  let runClosed = false;
  let activeScan: ChildProcess | undefined;
  let requestStop = () => {};
  const stopRequested = new Promise<void>((resolve) => (requestStop = resolve));
  let cards = 0;
  let failed = 0;

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    requestStop();
    log("Stopping the scanner…");
    // scanimage runs in its own process group, so no terminal signal reached
    // it: stopping it here, with SIGINT, is what releases the scanner.
    const proc = activeScan;
    if (proc && proc.exitCode === null) await stopScan(proc, log);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  // Closing the Terminal window.
  process.on("SIGHUP", () => void stop());
  // Read Ctrl-C as a key instead of a signal, so npm and tsx don't tear the
  // process down mid-card before the scanner is released.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (buf: Buffer) => {
      if (buf.includes(0x03)) void stop();
    });
  }

  const tone = { whiteClipPercent: 1, gamma: 2.2, jpegQuality: 95, dpi: settings.resolution };
  const send = async (raw: Buffer, name: string) => nb.sendImage(jobId, (await toneScan(raw, tone)) ?? raw, name);

  const onEvent = async (event: ScanEvent) => {
    switch (event.kind) {
      case "card": {
        if (runClosed) return;
        const n = cards + failed + 1;
        try {
          // Front, then back, one after the other: the run sees them side by side.
          await send(event.front, `scan-${n}-front.jpg`);
          await send(event.back, `scan-${n}-back.jpg`);
          cards++;
          log(`Card ${n} sent.`);
        } catch (error) {
          if (isRunClosedError(error)) {
            runClosed = true;
            log("The run stopped taking cards. Start a new run on the screen and use its code.");
            await stop();
            return;
          }
          failed++;
          log(`Card ${n} didn't reach NeonBinder. Check the internet connection and feed it again.`);
          log(`  (${error instanceof Error ? error.message : String(error)})`);
        }
        return;
      }
      case "one-side":
        log("A card scanned only one side and was dropped. Put it back in the stack.");
        return;
      case "stalled":
        log(`The scanner stalled after ${event.kept} card${event.kept === 1 ? "" : "s"}. Leave the rest in the feeder; it retries.`);
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

  await feedCards({
    device,
    settings,
    sane,
    timing: DEFAULT_TIMING,
    shouldStop: () => stopping,
    stopRequested,
    onEvent,
    onScanStart: (proc) => (activeScan = proc),
    log,
  });
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  log(`${cards} card${cards === 1 ? "" : "s"} sent${failed ? `, ${failed} to feed again` : ""}.`);
  return runClosed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    log(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);

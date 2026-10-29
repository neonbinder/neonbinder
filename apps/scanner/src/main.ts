import type { ChildProcess } from "node:child_process";
import { parseArgs } from "node:util";
import { isRunClosedError, NeonBinder } from "./neonbinder.js";
import { DEFAULT_SETTINGS, DEFAULT_TIMING, feedCards, findDevice, stopScan, type ScanEvent } from "./scanimage.js";
import { toneScan } from "./tone.js";

/**
 * NEO-386 — `npm run scan <code>`: feed cards from a sheet-fed scanner into
 * the intake run open on the NeonBinder screen. The screen's "Use a scanner"
 * shows the code. Each card scans in duplex and goes up front then back; the
 * screen pairs, reads and matches them like dropped photos.
 *
 * Environment (a `.env` beside package.json works):
 *   NEONBINDER_API_KEY   your key from Settings → API Keys (required)
 *   NEONBINDER_CONVEX_URL  https://<deployment>.convex.cloud (required)
 *   NEONBINDER_CONVEX_SITE_URL  only for a local backend
 *   SCANNER_DEVICE  a SANE device name, when the first Fujitsu isn't the one
 */

const HELP = `Usage: npm run scan <code> [-- --raw]

  <code>   the scanner code on the Add cards screen ("Use a scanner")
  --raw    no hardware deskew/crop: full frame with margin (for odd sizes)

Ctrl-C stops after the card in progress.`;

const log = (line: string) => process.stdout.write(`${line}\n`);

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

async function main(): Promise<number> {
  try {
    process.loadEnvFile(new URL("../.env", import.meta.url));
  } catch {
    // No .env: the environment alone has to do.
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { raw: { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false } },
  });
  if (values.help || positionals.length !== 1) {
    log(HELP);
    return values.help ? 0 : 2;
  }
  // NEONBINDER_MACHINE_KEY is the name the older scanner CLI used for the same key.
  const apiKey = env("NEONBINDER_API_KEY") ?? env("NEONBINDER_MACHINE_KEY");
  const convexUrl = env("NEONBINDER_CONVEX_URL");
  if (!apiKey || !convexUrl) {
    log("Set NEONBINDER_API_KEY and NEONBINDER_CONVEX_URL (see .env.example).");
    return 2;
  }

  const nb = await NeonBinder.signIn(convexUrl, apiKey, env("NEONBINDER_CONVEX_SITE_URL"));
  try {
    const run = await nb.join(positionals[0]);
    if (!run) {
      log(`No run of yours has the code ${positionals[0]}. Check the code on the Add cards screen.`);
      return 1;
    }
    if (!run.collecting) {
      log("That run isn't taking cards any more. Start a new run on the screen and use its code.");
      return 1;
    }
    const settings = { ...DEFAULT_SETTINGS, raw: values.raw, device: env("SCANNER_DEVICE") };
    const device = await findDevice(settings);
    log(`Joined: cards go into ${run.homeName}${run.variantName ? `, matched in ${run.variantName}` : ""}.`);
    log(`${settings.source}, ${settings.resolution} dpi, ${settings.raw ? "raw frame" : "cropped to the card"}. Waiting for cards…`);
    return await scanInto(nb, run.jobId, device, settings);
  } finally {
    await nb.close();
  }
}

async function scanInto(
  nb: NeonBinder,
  jobId: string,
  device: string,
  settings: typeof DEFAULT_SETTINGS,
): Promise<number> {
  let stopping = false;
  let runClosed = false;
  let activeScan: ChildProcess | undefined;
  let requestStop = () => {};
  const stopRequested = new Promise<void>((resolve) => (requestStop = resolve));
  let cards = 0;
  let failed = 0;
  let fromKeyboard = false;

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    requestStop();
    log("Stopping after this card…");
    // A terminal Ctrl-C also reached scanimage, which cancels and releases the
    // device on its own; a second SIGINT would make it abort without
    // releasing. So give it a moment, and only a keyboard Ctrl-C we read
    // ourselves (it never reached scanimage) is passed on at once.
    const proc = activeScan;
    if (proc && proc.exitCode === null) {
      if (fromKeyboard) await stopScan(proc, log);
      else {
        await new Promise((r) => setTimeout(r, 3000));
        if (proc.exitCode === null) await stopScan(proc, log);
      }
    }
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  // Read Ctrl-C as a key instead of a signal, so npm and tsx don't tear the
  // process down mid-card before the scanner is released.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (buf: Buffer) => {
      if (buf.includes(0x03)) {
        fromKeyboard = true;
        void stop();
      }
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
          log(`Card ${n} didn't send (${error instanceof Error ? error.message : String(error)}). Feed it again.`);
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
        log(`Scanner error: ${event.detail}`);
        return;
    }
  };

  await feedCards({
    device,
    settings,
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

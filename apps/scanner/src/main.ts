import { parseArgs } from "node:util";
import { configPath, resolveConvexUrl, savedKey, saveKey } from "./config.js";
import { KeyRejectedError, NeonBinder } from "./neonbinder.js";
import { ask, askSecret } from "./prompt.js";
import { saneRuntime, SYSTEM_SANE } from "./sane.js";
import { BRAND, DEFAULT_SETTINGS, findScanner, listScanners, planScan, TESTED_BACKENDS } from "./scanimage.js";
import { scanLoop } from "./session.js";

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
 *   SCANNER_DEVICE  a SANE device name, when the first scanner found isn't the one
 */

/** Shown every time: only Fujitsu has been through real cards so far. */
const TESTED =
  "Tested on Fujitsu fi-series scanners. Canon imageFORMULA and Epson scanners with a feeder should work too, but haven't been tested yet.";

const HELP = `Usage: neonbinder-scanner [code] [--raw] [--forget-key]

  code          the scanner code on the Add cards screen ("Use a scanner");
                asked for when left out
  --raw         no hardware deskew/crop: full frame with margin (odd sizes)
  --forget-key  forget the saved API key and ask for one again
  --check       set up the scanner driver, list the scanners it sees, and stop

While it scans, D finishes the run, the same as Done adding photos on the
screen, and the app waits for the next run's code. Ctrl-C quits and leaves the
run open. A card the scanner was partway through is reported to feed again.

${TESTED}`;

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

/** `--check`: is the driver working, and does it see a scanner? Signs in to nothing. */
async function check(): Promise<number> {
  const sane = await saneRuntime();
  const scanners = await listScanners(sane);
  log(`Scanner driver ready (${sane === SYSTEM_SANE ? "SANE on this computer" : "built in"}).`);
  for (const s of scanners) {
    const support = !s.backend
      ? "this app can't drive it"
      : TESTED_BACKENDS.includes(s.backend)
        ? "tested"
        : `${BRAND[s.backend]}, not tested yet`;
    log(`Found ${s.name} (${s.device}): ${support}.`);
  }
  if (!scanners.length) log("No scanner found. Check it's on and plugged in.");
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
  log(TESTED);
  if (values.check) return await check();

  const convexUrl = await resolveConvexUrl({ convexUrl: env("NEONBINDER_CONVEX_URL"), site: env("NEONBINDER_SITE") });
  const keyFile = configPath();
  if (values["forget-key"]) await saveKey(keyFile, convexUrl, undefined);

  const nb = await signIn(convexUrl, keyFile);
  if (!nb) {
    log("No API key, so nothing to do. Make one under Profile → API Keys and run this again.");
    return 1;
  }
  const settings = { ...DEFAULT_SETTINGS, raw: values.raw, device: env("SCANNER_DEVICE") };
  try {
    return await scanLoop(
      {
        nb,
        log,
        ask,
        stdin: process.stdin,
        prepare: async () => {
          const sane = await saneRuntime();
          const scanner = await findScanner(settings, sane);
          return { scannerName: scanner.name, plan: await planScan(scanner, settings, sane), sane, raw: settings.raw };
        },
      },
      positionals[0],
    );
  } finally {
    await nb.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    log(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);

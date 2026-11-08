/**
 * NEO-459: drive the real NeonBinder Scanner app (apps/scanner) from a spec.
 *
 * The app is a Node program for a collector's Mac. Here it runs as a child
 * process, exactly as `npm run scan <code>` would, with three stand-ins and
 * nothing else changed:
 *
 *   - the scanner: `apps/scanner/src/testing/fake-scanimage.sh` is put first on
 *     the child's PATH as `scanimage` (the app's own unit tests use the same
 *     file). With `cards: 0` the hopper sensor reads empty, so the app waits
 *     for paper; with `cards: n` it finds paper once and scans n pages;
 *   - the key: a Clerk API key the spec made through Profile -> API Keys,
 *     handed over in `NEONBINDER_API_KEY` (the child's own environment, never
 *     its arguments or output);
 *   - the backend: `NEONBINDER_CONVEX_URL`, the deployment under test.
 *
 * The app's source is bundled with esbuild into a temp file because CI's E2E
 * shard installs apps/web only: `apps/scanner/node_modules` is not there, but
 * the app's one runtime dependency that matters, `convex`, is (apps/web uses
 * it), so esbuild is told to look in apps/web's node_modules. `jpeg-js` (tone
 * mapping of a real JPEG) is not in apps/web and is replaced by a decoder that
 * always refuses: the app's own rule for a scan it cannot decode is to send the
 * untouched bytes, which is all the fake scanner ever produces.
 *
 * Everything the child says is kept; `said` and `exited` wait for an event
 * (no polling) and give up at the suite's 7 s budget, quoting what was said.
 * The key is never in that output (the app logs neither the key nor a token).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

const BUDGET = 7_000;
const APPS = fileURLToPath(new URL("../../../", import.meta.url));
const WEB_MODULES = fileURLToPath(new URL("../../node_modules", import.meta.url));
const FAKE_SCANIMAGE = path.join(APPS, "scanner", "src", "testing", "fake-scanimage.sh");
const SCANNER_MAIN = path.join(APPS, "scanner", "src", "main.ts");

/** The deployment this page talks to, as the page itself names it (the app does the same). */
export async function convexUrlOf(page: Page): Promise<string> {
  const res = await page.request.get("/");
  const html = await res.text();
  const url = html.match(/<meta\s+name="x-convex-url"\s+content="([^"]+)"/i)?.[1]?.trim().replace(/\/+$/, "");
  expect(url, "the site names the Convex deployment it talks to").toMatch(/^https:\/\/[a-z0-9-]+\.convex\.cloud$/);
  return url!;
}

export interface ScannerApp {
  /** Everything the app has printed so far. */
  output(): string;
  /** Resolves once the app has printed `text`; rejects at 7 s, quoting the output. */
  said(text: string): Promise<void>;
  /** Type into the app's stdin (a pipe: the app reads keys from it all the same). */
  press(keys: string): void;
  /** Resolves with the exit code once the app has exited; rejects at 7 s. */
  exited(): Promise<number | null>;
  /** Stop the app if it is still running and remove its scratch folder. */
  stop(): Promise<void>;
}

/** `jpeg-js` stand-in: the fake scanner's pages are not JPEGs, so decoding always refuses. */
const refusingJpeg = {
  name: "refusing-jpeg",
  setup(b: import("esbuild").PluginBuild) {
    b.onResolve({ filter: /^jpeg-js$/ }, () => ({ path: "jpeg-js", namespace: "refusing-jpeg" }));
    b.onLoad({ filter: /.*/, namespace: "refusing-jpeg" }, () => ({
      contents: `export default { decode() { throw new Error("not a JPEG"); }, encode() { throw new Error("not a JPEG"); } };`,
      loader: "js",
    }));
  },
};

/**
 * Start the app on `code`. `cards` is how many pages the fake scanner hands
 * over in one pass (2 per card); 0 leaves the feeder empty.
 */
export async function startScannerApp(opts: {
  code: string;
  apiKey: string;
  convexUrl: string;
  cards?: number;
}): Promise<ScannerApp> {
  const dir = await mkdtemp(path.join(tmpdir(), "nb-scanner-e2e-"));
  let proc: ChildProcess | undefined;
  try {
    const bundle = path.join(dir, "scanner.mjs");
    await build({
      entryPoints: [SCANNER_MAIN],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      nodePaths: [WEB_MODULES],
      plugins: [refusingJpeg],
      logLevel: "silent",
      // Bundled CommonJS reaches for require(); give it one.
      banner: { js: `import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);` },
    });

    const bin = path.join(dir, "bin");
    const fakeState = path.join(dir, "fake");
    const home = path.join(dir, "home");
    await mkdir(bin);
    await mkdir(fakeState);
    await mkdir(home);
    await symlink(FAKE_SCANIMAGE, path.join(bin, "scanimage"));
    const pages = (opts.cards ?? 0) * 2;
    if (pages > 0) await writeFile(path.join(fakeState, "paper"), "");

    proc = spawn(process.execPath, [bundle, opts.code], {
      // Only what the app needs: nothing of the test runner's secrets rides along.
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        HOME: home,
        TMPDIR: dir,
        FAKE_DIR: fakeState,
        FAKE_SCENARIO: pages > 0 ? `pairs:${pages}` : "pairs:0",
        NEONBINDER_API_KEY: opts.apiKey,
        NEONBINDER_CONVEX_URL: opts.convexUrl,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }

  const child = proc;
  let out = "";
  const listeners = new Set<() => void>();
  const take = (chunk: Buffer) => {
    out += chunk.toString();
    for (const l of [...listeners]) l();
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  child.stdin?.on("error", () => {});
  const done = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  let closed = false;
  void done.then(() => {
    closed = true;
    for (const l of [...listeners]) l();
  });

  const within = <T>(ready: () => T | undefined, what: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const check = () => {
        const got = ready();
        if (got !== undefined) {
          clearTimeout(timer);
          listeners.delete(check);
          resolve(got);
        } else if (closed) {
          clearTimeout(timer);
          listeners.delete(check);
          reject(new Error(`The scanner app exited before ${what}. It said:\n${out}`));
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`The scanner app did not ${what} within ${BUDGET / 1000} s. It said:\n${out}`));
      }, BUDGET);
      listeners.add(check);
      check();
    });

  return {
    output: () => out,
    said: (text) => within(() => (out.includes(text) ? true : undefined), `say "${text}"`).then(() => undefined),
    press: (keys) => void child.stdin?.write(keys),
    exited: () =>
      new Promise<number | null>((resolve, reject) => {
        if (closed) return void done.then(resolve);
        const timer = setTimeout(
          () => reject(new Error(`The scanner app did not exit within ${BUDGET / 1000} s. It said:\n${out}`)),
          BUDGET,
        );
        void done.then((code) => {
          clearTimeout(timer);
          resolve(code);
        });
      }),
    stop: async () => {
      if (!closed) {
        child.kill("SIGKILL");
        await done;
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

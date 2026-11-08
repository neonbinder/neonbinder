#!/usr/bin/env node
/**
 * NEO-434 — eBay's return must leave the address before Sentry is set up.
 *
 * `src/ebay-return-address.ts` being the first import of `src/sentry.ts` is a
 * claim about source. What runs is the built entry chunk, so this builds the app
 * through the real `vite.config.ts` and reads that chunk. E2E cannot hold this:
 * its builds set the Clerk testing flag, which compiles Sentry out. That is also
 * why this is not a `postbuild`: a preview build has no Sentry init to compare.
 *
 * The build needs no token and cannot upload. `vite.config.ts` loads `.env*` from
 * the working directory and the Sentry plugin reads its token from the
 * environment, so this runs from an empty temp directory with the token and any
 * `VITE_*` value removed. The temp directory is deleted afterwards.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The `LANDING_PATH` literal, which only the address step has. */
export const ADDRESS_MARKER = "\\/profile\\/ebay\\/*$/i";
/** A key of the object passed to `Sentry.init`. The SDK only ever reads it. */
export const SENTRY_INIT_MARKER = "replaysSessionSampleRate:";

/** Returns what is wrong with a built `dist`, or an empty list when it holds. */
export function findOrderProblems(distDir) {
  const html = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
  const src = html.match(/<script[^>]*type="module"[^>]*src="\/?([^"]+)"/)?.[1];
  if (!src) return ["index.html names no module entry script"];

  const assets = path.join(distDir, "assets");
  const entry = path.join(distDir, src);
  const text = fs.readFileSync(entry, "utf8");
  const others = fs
    .readdirSync(assets)
    .filter((name) => name.endsWith(".js") && path.join(assets, name) !== entry)
    .map((name) => [name, fs.readFileSync(path.join(assets, name), "utf8")]);

  const problems = [];
  const locate = (label, marker) => {
    const at = text.indexOf(marker);
    if (at < 0) problems.push(`${label} marker ${JSON.stringify(marker)} is not in the entry chunk ${src}`);
    for (const [name, other] of others) {
      if (other.includes(marker)) problems.push(`${label} marker ${JSON.stringify(marker)} is in the shared chunk ${name}`);
    }
    return at;
  };
  const address = locate("Address step", ADDRESS_MARKER);
  const init = locate("Sentry init", SENTRY_INIT_MARKER);
  if (address >= 0 && init >= 0 && address > init) {
    problems.push(`The address step (offset ${address}) comes after Sentry init (offset ${init}) in ${src}`);
  }
  return problems;
}

async function buildAndCheck() {
  const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "neo-entry-order-"));
  const emptyEnvDir = path.join(scratch, "env");
  const outDir = path.join(scratch, "dist");
  fs.mkdirSync(emptyEnvDir);

  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VITE_") || key.startsWith("SENTRY_")) delete process.env[key];
  }
  process.env.VITE_DEV_DISABLE_HTTPS = "1"; // keeps the dev-only mkcert plugin out
  process.chdir(scratch);

  try {
    const viteEntry = path.join(appDir, "node_modules/vite/dist/node/index.js");
    const { build } = await import(pathToFileURL(viteEntry).href);
    await build({
      root: appDir,
      configFile: path.join(appDir, "vite.config.ts"),
      mode: "production",
      envDir: emptyEnvDir,
      cacheDir: path.join(scratch, "cache"),
      logLevel: "error",
      build: { outDir, emptyOutDir: true },
    });
    const problems = findOrderProblems(outDir);
    for (const problem of problems) console.error(`check-entry-order: ${problem}`);
    if (problems.length > 0) {
      console.error("check-entry-order: Sentry could see eBay's code on the address. See src/ebay-return-address.ts.");
      process.exitCode = 1;
    } else {
      console.log("check-entry-order: the address step comes before Sentry init in the entry chunk");
    }
  } finally {
    process.chdir(appDir);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  await buildAndCheck();
}

#!/usr/bin/env node
// NEO-339 — recover the two values `setbuild --auth testing` needs from a PR
// PREVIEW's own served JavaScript, for when `vercel pull` returns them blank.
//
//   TESTING_ENDPOINT_SECRET     the x-testing-auth shared secret. The SPA bakes
//                               it in as VITE_TESTING_ENDPOINT_SECRET and sends
//                               it from /testing/sign-in (this is exactly how
//                               the old Maestro seed authenticated).
//   VITE_CLERK_PUBLISHABLE_KEY  public by design (pk_test_/pk_live_).
//
// PREVIEWS ONLY. Production never serves the testing endpoint, and the e2e
// workflow only ever calls this with a preview URL.
//
// Usage: preview-testing-creds.mjs <preview-url> <out-dir>
//   env: VERCEL_AUTOMATION_BYPASS_SECRET (sent as x-vercel-protection-bypass)
// Writes <out-dir>/testing-secret and <out-dir>/publishable-key (mode 0600),
// prints ONLY presence and length. Exit 0 if both found, 1 otherwise. The
// values are never written to stdout/stderr.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HEADER = "x-testing-auth";

/** Pull the baked secret out of one minified chunk, or null. */
export function extractTestingSecret(js) {
  let from = 0;
  for (;;) {
    const at = js.indexOf(HEADER, from);
    if (at < 0) return null;
    from = at + HEADER.length;
    // `"x-testing-auth":"<literal>"`  (Vite inlines the define)
    const after = js.slice(from, from + 200);
    const direct = after.match(/^["'`]?\s*:\s*"([^"\\]{8,})"/);
    if (direct) return direct[1];
    // `"x-testing-auth":<ident>` with `<ident>="<literal>"` declared earlier.
    const ident = after.match(/^["'`]?\s*:\s*([A-Za-z_$][\w$]*)\s*[},]/);
    if (ident) {
      const name = ident[1].replace(/\$/g, "\\$");
      const before = js.slice(Math.max(0, at - 1500), at);
      const decl = [...before.matchAll(new RegExp(`(?:^|[^\\w$.])${name}\\s*=\\s*"([^"\\\\]{8,})"`, "g"))];
      if (decl.length) return decl[decl.length - 1][1];
    }
  }
}

/** The publishable key baked into any chunk, or null. */
export function extractPublishableKey(js) {
  const m = js.match(/pk_(?:test|live)_[A-Za-z0-9+/=_-]{16,}/);
  return m ? m[0] : null;
}

function assetPaths(text) {
  const out = new Set();
  for (const m of text.matchAll(/(?:["'(=]|\bfrom\s*)(\.?\/?(?:assets\/)?[\w.-]+-[\w-]{6,}\.js)\b/g)) {
    let p = m[1].replace(/^\.\//, "");
    if (!p.startsWith("assets/") && !p.startsWith("/")) p = `assets/${p}`;
    out.add(p.startsWith("/") ? p : `/${p}`);
  }
  return out;
}

async function main() {
  const [previewUrl, outDir] = process.argv.slice(2);
  if (!previewUrl || !outDir) {
    console.error("usage: preview-testing-creds.mjs <preview-url> <out-dir>");
    return 2;
  }
  const base = previewUrl.replace(/\/+$/, "");
  const headers = { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? "" };
  const get = async (path) => {
    const res = await fetch(base + path, { headers });
    if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
    return res.text();
  };

  const html = await get("/");
  const seen = new Set();
  let queue = [...assetPaths(html)];
  let secret = null;
  let pk = null;
  // Breadth-first over the chunk graph, bounded: the entry chunk names its
  // lazy chunks, and the /testing/sign-in page may live in one of them.
  for (let round = 0; round < 3 && queue.length && !(secret && pk); round++) {
    const batch = queue.filter((p) => !seen.has(p)).slice(0, 400);
    queue = [];
    for (let i = 0; i < batch.length && !(secret && pk); i += 8) {
      const slice = batch.slice(i, i + 8);
      const texts = await Promise.all(
        slice.map(async (p) => {
          seen.add(p);
          try {
            return await get(p);
          } catch {
            return "";
          }
        }),
      );
      for (const js of texts) {
        secret ??= extractTestingSecret(js);
        pk ??= extractPublishableKey(js);
        for (const p of assetPaths(js)) if (!seen.has(p)) queue.push(p);
      }
    }
  }

  mkdirSync(outDir, { recursive: true });
  if (secret) writeFileSync(join(outDir, "testing-secret"), secret, { mode: 0o600 });
  if (pk) writeFileSync(join(outDir, "publishable-key"), pk, { mode: 0o600 });
  console.log(`preview bundle: scanned ${seen.size} chunk(s)`);
  console.log(`  TESTING_ENDPOINT_SECRET     ${secret ? `found (length ${secret.length})` : "NOT FOUND"}`);
  console.log(`  VITE_CLERK_PUBLISHABLE_KEY  ${pk ? `found (length ${pk.length})` : "NOT FOUND"}`);
  return secret && pk ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`preview-testing-creds: ${err instanceof Error ? err.message : "failed"}`);
      process.exitCode = 1;
    },
  );
}

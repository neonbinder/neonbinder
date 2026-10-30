import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Where the scanner app finds NeonBinder and keeps the collector's API key,
 * so someone who has never opened a terminal only ever types a code and,
 * once, a key.
 */

/** The site the app asks for its backend. Its pages name the Convex deployment they talk to. */
export const DEFAULT_SITE = "https://neonbinder.io";

const CONVEX_URL = /^https:\/\/[a-z0-9-]+\.convex\.cloud$/;

/** The `x-convex-url` a NeonBinder page carries, or undefined. */
export function convexUrlIn(html: string): string | undefined {
  const tag = html.match(/<meta\s+name="x-convex-url"\s+content="([^"]+)"/i);
  const url = tag?.[1].trim().replace(/\/+$/, "");
  return url && CONVEX_URL.test(url) ? url : undefined;
}

/**
 * The backend to use: an explicit NEONBINDER_CONVEX_URL (a preview, a local
 * backend), or whatever the live site says, so the app never needs a rebuild
 * when the deployment changes and the repo never names it.
 */
export async function resolveConvexUrl(
  env: { convexUrl?: string; site?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (env.convexUrl) return env.convexUrl;
  const site = env.site ?? DEFAULT_SITE;
  if (!site.startsWith("https://")) throw new Error("NEONBINDER_SITE must be https://.");
  let html: string;
  try {
    const res = await fetchImpl(site, { redirect: "follow", signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(String(res.status));
    html = await res.text();
  } catch {
    throw new Error("Can't reach NeonBinder. Check your connection and try again.");
  }
  const url = convexUrlIn(html);
  if (!url) throw new Error("NeonBinder didn't say where to send scans. Try again in a minute.");
  return url;
}

/** Where the saved key lives: the usual per-user settings folder. */
export function configPath(platform: NodeJS.Platform = process.platform, home = homedir()): string {
  return platform === "darwin"
    ? path.join(home, "Library", "Application Support", "NeonBinder", "scanner.json")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "neonbinder", "scanner.json");
}

interface Saved {
  /** One key per backend, so a preview key never gets sent to production. */
  keys: Record<string, string>;
}

async function load(file: string): Promise<Saved> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<Saved>;
    return { keys: parsed.keys && typeof parsed.keys === "object" ? parsed.keys : {} };
  } catch {
    return { keys: {} };
  }
}

export async function savedKey(file: string, convexUrl: string): Promise<string | undefined> {
  return (await load(file)).keys[convexUrl] || undefined;
}

/** Saved readable by this user only: it signs in as them. */
export async function saveKey(file: string, convexUrl: string, key: string | undefined): Promise<void> {
  const saved = await load(file);
  if (key) saved.keys[convexUrl] = key;
  else delete saved.keys[convexUrl];
  if (Object.keys(saved.keys).length === 0) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

/** Codes are shown as "ABC 123"; people type them however. */
export function looksLikeCode(raw: string): boolean {
  return /^[A-Za-z0-9]{6}$/.test(raw.replace(/[\s-]/g, ""));
}

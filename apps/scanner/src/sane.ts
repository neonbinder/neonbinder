import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * How to run scanimage. The packaged app carries its own SANE (the
 * `sane-bundle.tar.gz` that scripts/bundle-sane.sh builds, embedded by
 * `bun build --compile`) and unpacks it once into the user's cache, so the
 * collector installs nothing. Run from source, it uses the scanimage on PATH.
 */
export interface SaneRuntime {
  scanimage: string;
  env: NodeJS.ProcessEnv;
}

/** The environment without the collector's key: scanimage has no use for it. */
function withoutKeys(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.NEONBINDER_API_KEY;
  delete env.NEONBINDER_MACHINE_KEY;
  return env;
}

export const SYSTEM_SANE: SaneRuntime = {
  scanimage: "scanimage",
  // A getter, so a PATH set after start-up (the tests' fake scanimage) still counts.
  get env() {
    return withoutKeys(process.env);
  },
};

const BUNDLE_NAME = "sane-bundle.tar.gz";

/** The environment that makes the bundled scanimage load only the bundle. */
export function bundledRuntime(root: string, base: NodeJS.ProcessEnv = process.env): SaneRuntime {
  const lib = path.join(root, "lib");
  const backends = path.join(lib, "sane");
  return {
    scanimage: path.join(root, "bin", "scanimage"),
    env: {
      ...withoutKeys(base),
      // dyld finds the bundled libraries by leaf name before their Homebrew paths.
      DYLD_LIBRARY_PATH: `${lib}:${backends}`,
      // SANE's dll backend searches LD_LIBRARY_PATH for backends, on macOS too.
      LD_LIBRARY_PATH: backends,
      // dll.conf (fujitsu only) and fujitsu.conf.
      SANE_CONFIG_DIR: path.join(root, "etc"),
    },
  };
}

function cacheRoot(): string {
  return process.platform === "darwin"
    ? path.join(homedir(), "Library", "Caches", "NeonBinder")
    : path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "neonbinder");
}

interface EmbeddedFile extends Blob {
  name: string;
}

function embeddedBundle(): EmbeddedFile | undefined {
  const files = (globalThis as { Bun?: { embeddedFiles?: EmbeddedFile[] } }).Bun?.embeddedFiles ?? [];
  return files.find((f) => f.name === BUNDLE_NAME);
}

/**
 * The SANE to drive. Unpacks the embedded bundle the first time a given
 * build runs (keyed by its hash, so an update never mixes old and new files).
 */
export async function saneRuntime(): Promise<SaneRuntime> {
  const blob = embeddedBundle();
  if (!blob) return SYSTEM_SANE;
  const bytes = Buffer.from(await blob.arrayBuffer());
  const root = path.join(cacheRoot(), `sane-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`);
  const runtime = bundledRuntime(root);
  try {
    await access(runtime.scanimage);
    return runtime;
  } catch {
    // Not unpacked yet.
  }
  const staging = `${root}.tmp-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    const archive = path.join(staging, BUNDLE_NAME);
    await writeFile(archive, bytes);
    await execFileAsync("/usr/bin/tar", ["-xzf", archive, "-C", staging]);
    await rm(archive);
    await rename(staging, root);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    // Another copy of the app unpacked it first: theirs is as good as ours.
    try {
      await access(runtime.scanimage);
    } catch {
      throw new Error(`Couldn't set up the scanner driver (${error instanceof Error ? error.message : String(error)}).`);
    }
  }
  return runtime;
}

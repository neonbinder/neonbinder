/** Path guard shared by backfill.mjs and report.mjs (NEO-475). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../../../..");

/** realpath of the nearest existing ancestor, with the non-existing tail re-appended. */
function realpathOfNearest(target) {
  let existing = path.resolve(target);
  const tail = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...tail);
}

/**
 * Throws when `target` is the repository or inside it. Symlinks are resolved on
 * the nearest existing parent, so a link out of a scratch dir into the checkout
 * (or `..` tricks) cannot get past the check. Exported for report.mjs.
 */
export function assertOutsideRepo(target, repoRoot = REPO_ROOT) {
  const resolved = realpathOfNearest(target);
  const root = fs.realpathSync(repoRoot);
  const rel = path.relative(root, resolved);
  const outside = rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
  if (!outside) {
    throw new Error(`${resolved} is inside the repository; give a directory outside it`);
  }
  return resolved;
}

/**
 * NEO-356 — the theme lint's view of the codebase, without ESLint: which files
 * carry palette classes (theme/no-raw-palette's rule, applied to the same
 * string literals through the TypeScript parser), and which NEO-350 prototype
 * modules the shipped collection demo imports.
 *
 * Used by theme-allowlist.test.mjs to keep the allowlists honest, and runnable
 * to regenerate the pending list:
 *
 *   node scripts/eslint/scan-theme.mjs           # files the rule would flag
 *   node scripts/eslint/scan-theme.mjs --shared  # prototype files the demo ships
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { findPaletteViolations, WEB_ROOT } from "./no-raw-palette.mjs";

/** The directories the rule lints. */
export const LINTED_DIRS = ["app", "components", "src", "lib"];

const SOURCE = /\.(ts|tsx)$/;
const SKIP = /(\.test\.tsx?|\.d\.ts)$/;

/** Every file the rule lints, apps/web-relative and sorted. */
export function lintedFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(WEB_ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (SOURCE.test(entry.name) && !SKIP.test(entry.name)) out.push(rel);
    }
  };
  for (const dir of LINTED_DIRS) walk(dir);
  return out.sort();
}

/** The banned tokens in one file's string literals and template chunks. */
export function scanFile(rel) {
  const text = fs.readFileSync(path.join(WEB_ROOT, rel), "utf8");
  const kind = rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, false, kind);
  const found = [];
  const visit = (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      found.push(...findPaletteViolations(node.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const PROTOTYPES = "app/collection/prototypes/";

function resolveImport(fromRel, spec) {
  let base;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  else return null;
  for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts", ""]) {
    const candidate = base + ext;
    const abs = path.join(WEB_ROOT, candidate);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return candidate;
  }
  return null;
}

function importsOf(rel) {
  const text = fs.readFileSync(path.join(WEB_ROOT, rel), "utf8");
  const out = [];
  for (const m of text.matchAll(/(?:import|export)[^"']*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
    const resolved = resolveImport(rel, m[1] || m[2]);
    if (resolved) out.push(resolved);
  }
  return out;
}

/**
 * Prototype modules reachable from code outside app/collection/prototypes:
 * the shipped demo (/collection, /binder-tracking) renders them in both modes.
 * The p1-p5 route entries in src/main.tsx are not a seed: those pages are
 * forced dark.
 */
export function sharedPrototypeFiles() {
  const files = lintedFiles();
  const seeds = files.filter((f) => !f.startsWith(PROTOTYPES) && f !== "src/main.tsx");
  const reached = new Set();
  const queue = seeds.flatMap(importsOf).filter((f) => f.startsWith(PROTOTYPES));
  while (queue.length) {
    const f = queue.pop();
    if (reached.has(f) || SKIP.test(f) || !SOURCE.test(f)) continue;
    reached.add(f);
    for (const next of importsOf(f)) if (next.startsWith(PROTOTYPES)) queue.push(next);
  }
  return [...reached].sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--shared")) {
    for (const f of sharedPrototypeFiles()) console.log(f);
  } else {
    const { isPermanent } = await import("./theme-allowlist.mjs");
    for (const f of lintedFiles()) {
      if (!isPermanent(f) && scanFile(f).length > 0) console.log(f);
    }
  }
}

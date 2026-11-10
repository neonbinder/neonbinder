/** NEO-434 — the analysis half of `check-entry-order.mjs`, mostly proving it fails. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { ADDRESS_MARKER, SENTRY_INIT_MARKER, findOrderProblems } from "./check-entry-order.mjs";

const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const dist = (entry, shared = "shared();") => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neo-entry-order-test-"));
  made.push(dir);
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "index.html"), '<script type="module" crossorigin src="/assets/index-abc.js"></script>');
  fs.writeFileSync(path.join(dir, "assets/index-abc.js"), entry);
  fs.writeFileSync(path.join(dir, "assets/shared-def.js"), shared);
  return dir;
};

test("the address step before Sentry init, both in the entry, holds", () => {
  expect(findOrderProblems(dist(`${ADDRESS_MARKER};init({${SENTRY_INIT_MARKER}.1})`))).toEqual([]);
});

test("Sentry init first fails", () => {
  expect(findOrderProblems(dist(`init({${SENTRY_INIT_MARKER}.1});${ADDRESS_MARKER}`))).toEqual([
    expect.stringContaining("comes after Sentry init"),
  ]);
});

test.each([
  ["address step", SENTRY_INIT_MARKER, "Address step marker"],
  ["Sentry init", ADDRESS_MARKER, "Sentry init marker"],
])("a missing %s marker fails rather than passing on nothing", (_name, entry, message) => {
  expect(findOrderProblems(dist(entry))).toEqual([expect.stringContaining(message)]);
});

test.each([
  ["address step", SENTRY_INIT_MARKER, ADDRESS_MARKER],
  ["Sentry init", ADDRESS_MARKER, SENTRY_INIT_MARKER],
])("the %s in a shared chunk fails", (_name, entry, shared) => {
  const problems = findOrderProblems(dist(entry, shared));
  expect(problems).toContainEqual(expect.stringContaining("shared-def.js"));
});

test("an index.html with no module script fails", () => {
  const dir = dist("");
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  expect(findOrderProblems(dir)).toEqual(["index.html names no module entry script"]);
});

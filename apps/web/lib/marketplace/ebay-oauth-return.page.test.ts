/**
 * @vitest-environment happy-dom
 *
 * The docblock is load-bearing: `lib/**\/*.test.ts` runs in `node` unless a
 * file asks for a DOM.
 *
 * NEO-422 — the two static eBay return pages and the script that drives them.
 * The pages' real markup is read from public/oauth/ebay/ into an inert
 * `<template>` (so happy-dom neither fetches the stylesheet nor runs the
 * script), then `runEbayReturnPage` is driven against it with a stub location. Pinned: each page names its own mode, forwards
 * with `replace` only when its own allowlist vouches, otherwise swaps the
 * status for the lost-trip message; and neither page reaches off-origin or
 * leaks its URL as a referrer.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { encodeEbayReturnState, runEbayReturnPage } from "./ebay-oauth-return";

const PAGES_DIR = path.resolve(__dirname, "../../public/oauth/ebay");
const PAGES = {
  production: readFileSync(path.join(PAGES_DIR, "return.html"), "utf8"),
  sandbox: readFileSync(path.join(PAGES_DIR, "sandbox-return.html"), "utf8"),
} as const;

const PREVIEW = "https://neonbinder-a1b2c3d4e-neon-binder.vercel.app";

/** The page's markup, inert, behind the slice of `Document` the script uses. */
type PageDoc = { title: string; querySelector: Document["querySelector"]; querySelectorAll: Document["querySelectorAll"] };
let page: PageDoc;

function load(which: keyof typeof PAGES) {
  const template = document.createElement("template");
  template.innerHTML = PAGES[which];
  const root = template.content;
  page = {
    title: root.querySelector("title")?.textContent ?? "",
    querySelector: root.querySelector.bind(root) as Document["querySelector"],
    querySelectorAll: root.querySelectorAll.bind(root) as Document["querySelectorAll"],
  };
}

function run(location: ReturnType<typeof stubLocation>) {
  return runEbayReturnPage({ document: page as unknown as Document, location });
}

function stubLocation(search: string, origin = "https://www.neonbinder.io") {
  return { search, origin, replace: vi.fn<(url: string) => void>() };
}

const status = () => page.querySelector('[data-ebay-return="status"]') as HTMLElement;
const lost = () => page.querySelector('[data-ebay-return="lost"]') as HTMLElement;

describe("the static pages", () => {
  for (const [mode, html] of Object.entries(PAGES)) {
    describe(mode, () => {
      it("loads the shared script as an external module tagged with its own mode", () => {
        load(mode as keyof typeof PAGES);
        const scripts = [...page.querySelectorAll("script")];
        expect(scripts).toHaveLength(1);
        expect(scripts[0].getAttribute("type")).toBe("module");
        expect(scripts[0].getAttribute("src")).toBe("/oauth/ebay/ebay-return.js");
        expect(scripts[0].getAttribute("data-ebay-return-mode")).toBe(mode);
        expect(scripts[0].textContent).toBe("");
      });

      it("sends no referrer and has no inline style", () => {
        load(mode as keyof typeof PAGES);
        expect(page.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe("no-referrer");
        expect(html).not.toMatch(/<style|\sstyle=/i);
      });

      it("references nothing off its own origin", () => {
        load(mode as keyof typeof PAGES);
        const urls = [...page.querySelectorAll("[src], [href]")].map(
          (el) => el.getAttribute("src") ?? el.getAttribute("href") ?? "",
        );
        expect(urls.length).toBeGreaterThan(0);
        for (const url of urls) expect(url).toMatch(/^\/[^/]/);
        expect(html).not.toMatch(/https?:\/\//);
      });

      it("starts on the status line with the lost message hidden", () => {
        load(mode as keyof typeof PAGES);
        expect(status().hidden).toBe(false);
        expect(status().getAttribute("role")).toBe("status");
        expect(status().textContent).toBe("Taking you back to NeonBinder…");
        expect(lost().hidden).toBe(true);
      });
    });
  }
});

describe("runEbayReturnPage", () => {
  it("production page: forwards a production origin with replace, query untouched", () => {
    load("production");
    const search = `?code=ab12+cd34%2Fef56%3D%3D&state=${encodeEbayReturnState("n1", "https://neonbinder.io")}&expires_in=299`;
    const location = stubLocation(search);
    run(location);
    expect(location.replace).toHaveBeenCalledTimes(1);
    expect(location.replace).toHaveBeenCalledWith(`https://neonbinder.io/profile/ebay${search}`);
    expect(lost().hidden).toBe(true);
  });

  it("production page: refuses a preview origin and shows the lost message", () => {
    load("production");
    const location = stubLocation(`?code=secret&state=${encodeEbayReturnState("n1", PREVIEW)}`);
    run(location);
    expect(location.replace).not.toHaveBeenCalled();
    expect(status().hidden).toBe(true);
    expect(lost().hidden).toBe(false);
    expect(lost().querySelector("h1")?.textContent).toBe("That eBay trip got lost");
    const link = lost().querySelector("a");
    expect(link?.textContent).toBe("Back to eBay settings");
    expect(link?.getAttribute("href")).toBe("/profile/ebay");
    expect(page.title).toBe("eBay trip got lost · NeonBinder");
  });

  it("production page: refuses localhost", () => {
    load("production");
    const location = stubLocation(`?code=secret&state=${encodeEbayReturnState("n1", "http://localhost:3000")}`);
    run(location);
    expect(location.replace).not.toHaveBeenCalled();
    expect(lost().hidden).toBe(false);
  });

  it("sandbox page: forwards to a preview and to localhost", () => {
    for (const origin of [PREVIEW, "http://localhost:3000"]) {
      load("sandbox");
      const search = `?code=abc&state=${encodeEbayReturnState("n1", origin)}`;
      const location = stubLocation(search);
      run(location);
      expect(location.replace).toHaveBeenCalledWith(`${origin}/profile/ebay${search}`);
    }
  });

  it("sandbox page: still refuses a stranger", () => {
    load("sandbox");
    const location = stubLocation(`?code=secret&state=${encodeEbayReturnState("n1", "https://evil.example")}`);
    run(location);
    expect(location.replace).not.toHaveBeenCalled();
    expect(lost().hidden).toBe(false);
  });

  it("refuses when there is no state", () => {
    load("production");
    const location = stubLocation("?code=secret");
    run(location);
    expect(location.replace).not.toHaveBeenCalled();
    expect(lost().hidden).toBe(false);
  });

  it("never forwards from a page whose script tag names no valid mode", () => {
    load("sandbox");
    page.querySelector("script")?.setAttribute("data-ebay-return-mode", "staging");
    const location = stubLocation("?code=abc&state=n1");
    run(location);
    expect(location.replace).not.toHaveBeenCalled();
    expect(lost().hidden).toBe(false);
  });
});

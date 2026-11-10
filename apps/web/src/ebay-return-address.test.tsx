/**
 * NEO-434 — eBay's return comes off the address as the app starts, and still
 * reaches the eBay panel, through the real browser router.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import EbayReturnLanding from "@/app/profile/ebay/page";
import { takeEbayReturnOffAddress } from "./ebay-return-address";

const setURL = (url: string) =>
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(`https://app.example${url}`);

function Where() {
  const { pathname, search, state } = useLocation();
  return <output aria-label="where">{JSON.stringify({ pathname, search, state })}</output>;
}

/** The app's route shape, with what a signed-out collector gets as an option. */
function renderApp({ signedIn = true } = {}) {
  render(
    <BrowserRouter>
      <Routes>
        <Route path="/profile/ebay" element={signedIn ? <EbayReturnLanding /> : <Navigate to="/signin" replace />} />
        <Route path="/profile/credentials" element={<Where />} />
        <Route path="/signin" element={<Where />} />
      </Routes>
    </BrowserRouter>,
  );
  return JSON.parse(screen.getByRole("status", { name: "where" }).textContent ?? "null");
}

beforeEach(() => window.history.replaceState(null, "", "/"));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("taking eBay's return off the address", () => {
  it("a consent: the address is clean, nothing is added to history, and the panel gets the code", () => {
    setURL("/profile/ebay?code=v%5E1.1%23i&state=n1.b3JpZw&expires_in=299");
    const entries = window.history.length;

    takeEbayReturnOffAddress();
    expect(window.location.href).toBe("https://app.example/profile/ebay");
    expect(window.history.length).toBe(entries);

    expect(renderApp()).toEqual({
      pathname: "/profile/credentials",
      search: "?platform=ebay",
      state: { ebayReturn: { kind: "code", code: "v^1.1#i", state: "n1.b3JpZw" } },
    });
    expect(window.history.length).toBe(entries);
    expect(JSON.stringify(window.location.href)).not.toContain("n1.b3JpZw");
  });

  it("a decline: error and error_description come off and the panel is told no", () => {
    setURL("/profile/ebay?error=access_denied&error_description=User+said+no&state=n1");
    takeEbayReturnOffAddress();
    expect(window.location.search).toBe("");
    expect(renderApp().state).toEqual({ ebayReturn: { kind: "declined" } });
  });

  it("a plain visit changes nothing and the panel gets nothing", () => {
    setURL("/profile/ebay");
    const replace = vi.spyOn(window.history, "replaceState");
    takeEbayReturnOffAddress();
    expect(replace).not.toHaveBeenCalled();
    expect(renderApp()).toMatchObject({ pathname: "/profile/credentials", state: null });
  });

  it("half a return comes off the address but hands over nothing", () => {
    setURL("/profile/ebay?code=orphan");
    takeEbayReturnOffAddress();
    expect(window.location.search).toBe("");
    expect(renderApp().state).toBeNull();
  });

  it("a reload before the landing renders still finishes the trip", () => {
    setURL("/profile/ebay?code=c1&state=n1");
    takeEbayReturnOffAddress();
    // A reload re-runs the module on the clean address, with the entry's state kept.
    takeEbayReturnOffAddress();
    expect(renderApp().state).toEqual({ ebayReturn: { kind: "code", code: "c1", state: "n1" } });
  });

  it("signed out: the redirect to sign in replaces the entry, so the code does not stay in history", () => {
    setURL("/profile/ebay?code=c1&state=n1");
    takeEbayReturnOffAddress();
    expect(renderApp({ signedIn: false })).toMatchObject({ pathname: "/signin", state: null });
    // The quoted token: the router's random 8-character `key` can hold "c1" inside it, never as a whole value.
    expect(JSON.stringify(window.history.state)).not.toContain('"c1"');
  });

  it("anything else on the address stays, and existing history state is kept", () => {
    setURL("/profile/ebay?code=c1&state=n1&note=a%20b#top");
    window.history.replaceState({ mine: 1 }, "");
    takeEbayReturnOffAddress();
    expect(window.location.search).toBe("?note=a+b");
    expect(window.location.hash).toBe("#top");
    expect(window.history.state).toMatchObject({ mine: 1 });
  });

  it.each(["/Profile/eBay?code=c1&state=n1", "/profile/ebay/?code=c1&state=n1"])(
    "catches the spellings the router also matches: %s",
    (url) => {
      setURL(url);
      takeEbayReturnOffAddress();
      expect(window.location.search).toBe("");
    },
  );

  it.each([
    "/profile/credentials?code=c1&state=n1",
    "/profile/ebay-other?code=c1",
    "/oauth/ebay/return?code=c1&state=n1",
    "/search?error=x&state=y",
  ])("leaves every other route's query alone: %s", (url) => {
    setURL(url);
    takeEbayReturnOffAddress();
    expect(`${window.location.pathname}${window.location.search}`).toBe(url);
  });
});

describe("it runs before anything can record the address", () => {
  const source = (file: string) => readFileSync(path.resolve(__dirname, file), "utf8");
  const firstImport = (file: string) => /^import\s+(?:[^"']*from\s+)?["']([^"']+)["']/m.exec(source(file))?.[1];

  it("is the first import of src/sentry.ts", () => {
    expect(firstImport("sentry.ts")).toBe("./ebay-return-address");
  });

  it("src/sentry.ts is the first import of src/main.tsx", () => {
    expect(firstImport("main.tsx")).toBe("./sentry");
  });

  it("pulls in no SDK of its own", () => {
    const imports = [...source("ebay-return-address.ts").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["@/app/profile/credentials/ebay/oauth-return"]);
    expect(source("../app/profile/credentials/ebay/oauth-return.ts")).not.toMatch(/^import /m);
  });

  it.each(["return.html", "sandbox-return.html"])("%s forwards with no referrer, or the code arrives as document.referrer", (page) => {
    expect(source(`../public/oauth/ebay/${page}`)).toContain('<meta name="referrer" content="no-referrer" />');
  });
});

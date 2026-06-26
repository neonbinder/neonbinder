/**
 * Unit tests for BaseAdapter.loginWithBrowser
 *
 * Strategy: import the compiled CJS dist via createRequire (package.json "type":"commonjs"),
 * then monkey-patch SecretsManagerService at the module level to avoid real GCP calls.
 * Puppeteer is also stubbed so no real browser is launched.
 *
 * The most important test here is the no-recursion check: the old buggy dist called
 * this.login() inside loginWithBrowser(), causing infinite recursion. The fixed version
 * returns { cached, page } without touching login().
 */

import { describe, it, before, mock } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Minimal mock page and browser — avoids launching a real Chromium process
// ---------------------------------------------------------------------------
const mockPage = {
  goto: async () => {},
  setViewport: async () => {},
  waitForSelector: async () => {},
};

const mockBrowser = {
  newPage: async () => mockPage,
  close: async () => {},
};

// ---------------------------------------------------------------------------
// Patch SecretsManagerService before any test module loads it
// ---------------------------------------------------------------------------
// We override the require cache entry that base-adapter.js resolves to.
// Because Node caches modules, patching once covers every require() call
// made by code under test in this process.

function patchSecretsManager(credentialsToReturn) {
  const smPath = require.resolve(
    "../dist/services/secrets-manager"
  );
  const mod = require(smPath);
  mod.SecretsManagerService = class MockSecretsManagerService {
    async getCredentials(_key) {
      return credentialsToReturn;
    }
    async updateCredentials(_key, _creds) {}
    async deleteCredentials(_key) {}
    async credentialsExist(_key) { return true; }
  };
  // Invalidate the adapter cache so it picks up the new SecretsManagerService
  delete require.cache[require.resolve("../dist/adapters/base-adapter")];
}

// ---------------------------------------------------------------------------
// Minimal concrete subclass for testing the abstract BaseAdapter
// ---------------------------------------------------------------------------
function makeConcreteAdapter(credentials) {
  patchSecretsManager(credentials);

  const { BaseAdapter } = require("../dist/adapters/base-adapter");

  class TestAdapter extends BaseAdapter {
    constructor() {
      super(undefined, "TestSite");
      this.loginCallCount = 0;
    }

    getHomeUrl() {
      return "https://example.com";
    }

    async login(_key) {
      this.loginCallCount++;
      return { success: true, message: "logged in" };
    }
  }

  return TestAdapter;
}

// ---------------------------------------------------------------------------
// Puppeteer mock — patch before base-adapter is loaded in any test
// ---------------------------------------------------------------------------
function patchPuppeteer() {
  const puppeteerPath = require.resolve("puppeteer");
  require.cache[puppeteerPath] = {
    id: puppeteerPath,
    filename: puppeteerPath,
    loaded: true,
    exports: {
      default: { launch: async () => mockBrowser },
      launch: async () => mockBrowser,
    },
    children: [],
    parent: null,
    paths: [],
  };
}

// Patch puppeteer once for the whole test file
patchPuppeteer();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BaseAdapter.loginWithBrowser", () => {
  it("should return { cached: true } and set this.token when a valid non-expired token exists", async () => {
    const futureExpiry = Date.now() + 60 * 60 * 1000; // 1 hour from now
    const TestAdapter = makeConcreteAdapter({
      username: "user@example.com",
      password: "hunter2",
      token: "Bearer valid-token-abc",
      expiresAt: futureExpiry,
    });

    const adapter = new TestAdapter();
    const result = await adapter.loginWithBrowser("bsc-credentials-user1");

    assert.equal(result.cached, true, "should report cached=true");
    assert.equal(result.page, undefined, "should not return a page when cached");
    assert.equal(adapter.token, "Bearer valid-token-abc", "should set this.token to the cached token");
  });

  it("should return { cached: false, page } when credentials have no token", async () => {
    const TestAdapter = makeConcreteAdapter({
      username: "user@example.com",
      password: "hunter2",
      token: undefined,
      expiresAt: undefined,
    });

    const adapter = new TestAdapter();
    const result = await adapter.loginWithBrowser("bsc-credentials-user1");

    assert.equal(result.cached, false, "should report cached=false");
    assert.ok(result.page, "should return a page object");
    assert.equal(adapter.page, mockPage, "should assign the page to this.page");
  });

  it("should return { cached: false, page } when token is expired", async () => {
    const pastExpiry = Date.now() - 1000; // 1 second ago
    const TestAdapter = makeConcreteAdapter({
      username: "user@example.com",
      password: "hunter2",
      token: "Bearer expired-token",
      expiresAt: pastExpiry,
    });

    const adapter = new TestAdapter();
    const result = await adapter.loginWithBrowser("bsc-credentials-user1");

    assert.equal(result.cached, false, "expired token should not be treated as cached");
    assert.ok(result.page, "should return a page when token is expired");
  });

  it("should NOT call this.login() — no infinite recursion regression", async () => {
    // This is the core regression test for the bug that was fixed.
    // The old base-adapter called this.login(key) inside loginWithBrowser(),
    // and BSCAdapter.login() called loginWithBrowser(), causing infinite recursion.
    // The fixed version returns { cached, page } without ever calling this.login().

    const TestAdapter = makeConcreteAdapter({
      username: "user@example.com",
      password: "hunter2",
      token: undefined,
      expiresAt: undefined,
    });

    const adapter = new TestAdapter();
    await adapter.loginWithBrowser("bsc-credentials-user1");

    assert.equal(
      adapter.loginCallCount,
      0,
      "loginWithBrowser must not call this.login() — would cause infinite recursion in BSCAdapter"
    );
  });

  it("should NOT call this.login() even when a valid cached token exists", async () => {
    const TestAdapter = makeConcreteAdapter({
      username: "user@example.com",
      password: "hunter2",
      token: "Bearer cached-token",
      expiresAt: Date.now() + 60_000,
    });

    const adapter = new TestAdapter();
    await adapter.loginWithBrowser("bsc-credentials-user1");

    assert.equal(
      adapter.loginCallCount,
      0,
      "loginWithBrowser must not call this.login() in the cached-token path either"
    );
  });

  it("should use the provided page argument instead of launching a new browser", async () => {
    const TestAdapter = makeConcreteAdapter({
      username: "user@example.com",
      password: "hunter2",
      token: undefined,
      expiresAt: undefined,
    });

    const suppliedPage = {
      goto: async () => {},
      setViewport: async () => {},
      waitForSelector: async () => {},
      _isSuppliedPage: true,
    };

    const adapter = new TestAdapter();
    const result = await adapter.loginWithBrowser("bsc-credentials-user1", suppliedPage);

    assert.equal(result.cached, false);
    assert.equal(
      result.page._isSuppliedPage,
      true,
      "should use the caller-provided page, not a new browser page"
    );
  });
});

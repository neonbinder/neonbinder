import { afterEach, describe, expect, test, vi } from "vitest";
import { EBAY_SCOPES, ebayAuthorizeUrl, ebayConfig, ebayConfigured, ebaySellerConflictsEnforced } from "./ebayEnv";

function setEnv(env: Partial<Record<string, string>>) {
  vi.stubEnv("EBAY_CLIENT_ID", env.EBAY_CLIENT_ID ?? "");
  vi.stubEnv("EBAY_RU_NAME", env.EBAY_RU_NAME ?? "");
  vi.stubEnv("EBAY_ENVIRONMENT", env.EBAY_ENVIRONMENT ?? "");
  vi.stubEnv("TESTING_RESET_SECRET", env.TESTING_RESET_SECRET ?? "");
}

afterEach(() => vi.unstubAllEnvs());

describe("ebayConfig (NEO-415)", () => {
  test("is null when nothing is set", () => {
    setEnv({});
    expect(ebayConfig()).toBeNull();
    expect(ebayConfigured()).toBe(false);
  });

  test("sandbox env picks the sandbox hosts", () => {
    setEnv({ EBAY_CLIENT_ID: "cid", EBAY_RU_NAME: "ru", EBAY_ENVIRONMENT: "sandbox" });
    expect(ebayConfig()).toEqual({
      clientId: "cid",
      ruName: "ru",
      environment: "sandbox",
      apiBase: "https://api.sandbox.ebay.com",
      mediaBase: "https://apim.sandbox.ebay.com",
      authBase: "https://auth.sandbox.ebay.com",
      webBase: "https://www.sandbox.ebay.com",
    });
    expect(ebayConfigured()).toBe(true);
  });

  test("production env picks the production hosts", () => {
    setEnv({ EBAY_CLIENT_ID: "cid", EBAY_RU_NAME: "ru", EBAY_ENVIRONMENT: "production" });
    expect(ebayConfig()?.apiBase).toBe("https://api.ebay.com");
    expect(ebayConfig()?.authBase).toBe("https://auth.ebay.com");
  });

  test("an unknown environment is not configured", () => {
    setEnv({ EBAY_CLIENT_ID: "cid", EBAY_RU_NAME: "ru", EBAY_ENVIRONMENT: "staging" });
    expect(ebayConfig()).toBeNull();
  });

  test("a missing id or RuName is not configured, and whitespace counts as unset", () => {
    setEnv({ EBAY_CLIENT_ID: "  ", EBAY_RU_NAME: "ru", EBAY_ENVIRONMENT: "sandbox" });
    expect(ebayConfig()).toBeNull();
    setEnv({ EBAY_CLIENT_ID: "cid", EBAY_ENVIRONMENT: "sandbox" });
    expect(ebayConfig()).toBeNull();
  });
});

describe("ebayAuthorizeUrl (NEO-415)", () => {
  test("carries client id, RuName, code response, every scope and the state", () => {
    setEnv({ EBAY_CLIENT_ID: "cid", EBAY_RU_NAME: "ru", EBAY_ENVIRONMENT: "sandbox" });
    const url = new URL(ebayAuthorizeUrl(ebayConfig()!, "nonce-1"));
    expect(url.origin + url.pathname).toBe("https://auth.sandbox.ebay.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("ru");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("nonce-1");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...EBAY_SCOPES]);
  });
});

describe("ebaySellerConflictsEnforced (NEO-415)", () => {
  test("enforced in production even with a testing secret", () => {
    setEnv({ EBAY_CLIENT_ID: "c", EBAY_RU_NAME: "r", EBAY_ENVIRONMENT: "production", TESTING_RESET_SECRET: "s" });
    expect(ebaySellerConflictsEnforced()).toBe(true);
  });

  test("enforced on a sandbox without a testing secret", () => {
    setEnv({ EBAY_CLIENT_ID: "c", EBAY_RU_NAME: "r", EBAY_ENVIRONMENT: "sandbox" });
    expect(ebaySellerConflictsEnforced()).toBe(true);
  });

  test("relaxed only on a testing deployment on the sandbox", () => {
    setEnv({ EBAY_CLIENT_ID: "c", EBAY_RU_NAME: "r", EBAY_ENVIRONMENT: "sandbox", TESTING_RESET_SECRET: "s" });
    expect(ebaySellerConflictsEnforced()).toBe(false);
  });
});

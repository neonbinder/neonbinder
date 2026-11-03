import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ph = vi.hoisted(() => ({ init: vi.fn(), register: vi.fn(), capture: vi.fn() }));
vi.mock("posthog-js", () => ({ default: ph }));
vi.mock("posthog-js/react", () => ({ PostHogProvider: ({ children }: { children: unknown }) => children }));

import { PostHogProvider } from "./PostHogProvider";

const RETURN = "https://app.example/profile/ebay?code=v%5E1.1%23SECRET&state=NONCE123";
const pageview = () => ({ event: "$pageview", properties: { $current_url: RETURN } });

type Hook = (e: unknown) => unknown;
function hooks(options: { before_send?: Hook | Hook[] }): Hook[] {
  const b = options.before_send;
  return Array.isArray(b) ? b : b ? [b] : [];
}
const runAll = (list: Hook[], event: unknown) => list.reduce<unknown>((e, fn) => (e === null ? null : fn(e)), event);

beforeEach(() => {
  ph.init.mockClear();
  vi.stubEnv("VITE_POSTHOG_KEY", "phc_test");
});
afterEach(() => vi.unstubAllEnvs());

describe("PostHog init scrubs the eBay return's code and state (NEO-415)", () => {
  it("the normal init's before_send redacts them", () => {
    vi.stubEnv("VITE_CLERK_TESTING_ENABLED", "");
    render(<PostHogProvider>x</PostHogProvider>);
    const options = ph.init.mock.calls[0][1];
    const out = JSON.stringify(runAll(hooks(options), pageview()));
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("NONCE123");
    expect(out).toContain("code=<redacted>");
  });

  it("under E2E, the diagnostic filter is kept AND the scrub runs on events it lets through", () => {
    vi.stubEnv("VITE_CLERK_TESTING_ENABLED", "true");
    render(<PostHogProvider>x</PostHogProvider>);
    const list = hooks(ph.init.mock.calls[0][1]);
    expect(list.length).toBeGreaterThanOrEqual(2);
    // The filter still drops everything that is not a named diagnostic event.
    expect(runAll(list, pageview())).toBeNull();
    // A diagnostic event passes and has the OAuth values redacted.
    const out = JSON.stringify(runAll(list, { event: "e2e_page_start", properties: { path: RETURN } }));
    expect(out).toContain("e2e_page_start");
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("NONCE123");
  });

  it("does nothing without a key", () => {
    vi.stubEnv("VITE_POSTHOG_KEY", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<PostHogProvider>x</PostHogProvider>);
    expect(ph.init).not.toHaveBeenCalled();
  });
});

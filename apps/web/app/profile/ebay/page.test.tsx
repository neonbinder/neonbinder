/**
 * NEO-415 — Profile → eBay. The page's own logic against a mocked Convex:
 * each connection state, the consent round trip (Connect leaves for eBay;
 * the return spends its code once and cleans the URL), Disconnect's
 * confirm, and the setup (the $20-and-up picker leaving Standard
 * Envelope-only policies out, a refused save rolling back with an alert,
 * Set me up, and the checklist).
 */

import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { Theme } from "@radix-ui/themes";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EbayConnectionState, EbayPolicies } from "@/lib/marketplace/ebay-setup";
import { expectAccessibleInBothModes } from "@/lib/testing/axe";

let connection: EbayConnectionState | undefined;
const fns: Record<string, ReturnType<typeof vi.fn>> = {};
const fn = (name: string) => (fns[name] ??= vi.fn());

vi.mock("convex/react", () => {
  // Stable per function, as Convex's own hooks are: the page's effects depend on them.
  const bound = new Map<string, unknown>();
  const bind = (ref: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(ref);
    if (!bound.has(name)) {
      const call = (...args: unknown[]) => fn(name)(...args);
      bound.set(name, Object.assign(call, { withOptimisticUpdate: () => call }));
    }
    return bound.get(name);
  };
  return {
    useQuery: () => connection,
    useMutation: bind,
    useAction: bind,
  };
});

import EbayPanel from "./page";

const SETTINGS_EMPTY: EbayConnectionState["settings"] = {
  fulfillmentPolicyUnder20Id: null,
  fulfillmentPolicy20PlusId: null,
  paymentPolicyId: null,
  returnPolicyId: null,
  location: null,
  bestOffer: true,
};

function state(over: Partial<EbayConnectionState> = {}): EbayConnectionState {
  return {
    configured: true,
    environment: "production",
    status: "notConnected",
    ebayUsername: null,
    since: null,
    settings: SETTINGS_EMPTY,
    setupComplete: false,
    missing: ["shippingUnder20", "shipping20Plus", "payment", "returns", "location"],
    ...over,
  };
}

const POLICIES: EbayPolicies = {
  fulfillment: [
    { id: "f-ese", name: "PWE only", eseFit: true, eseOnly: true, freeShipping: false, summary: "Standard Envelope, $1.32" },
    { id: "f-both", name: "PWE or BMWT", eseFit: true, eseOnly: false, freeShipping: false, summary: "Envelope or Ground Advantage" },
    { id: "f-ga", name: "Tracked", eseFit: false, eseOnly: false, freeShipping: false, summary: "USPS Ground Advantage, $4.50" },
  ],
  payment: [{ id: "p1", name: "eBay managed payments" }],
  returns: [{ id: "r1", name: "No returns", summary: "Returns not accepted" }],
};

let where = "";
function Where() {
  const loc = useLocation();
  useEffect(() => {
    where = `${loc.pathname}${loc.search}`;
  }, [loc]);
  return null;
}

function renderAt(url = "/profile/ebay") {
  const tree = () => (
    <Theme>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/profile/ebay"
            element={
              <>
                <EbayPanel />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </Theme>
  );
  const view = render(tree());
  return { ...view, rerenderFresh: () => view.rerender(tree()) };
}

beforeEach(() => {
  for (const key of Object.keys(fns)) delete fns[key];
  connection = state();
  fn("ebayConnect:readPolicies").mockResolvedValue({ ok: true, ...POLICIES });
  fn("ebayConnect:savePolicies").mockResolvedValue({ ok: true });
});

afterEach(cleanup);

describe("Profile → eBay, connection", () => {
  it("not hooked up on this NeonBinder: Connect is inert and says why", () => {
    connection = state({ configured: false, environment: null });
    renderAt();
    const connect = screen.getByRole("button", { name: "Connect eBay" });
    expect(connect.getAttribute("aria-disabled")).toBe("true");
    expect(connect.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(connect.getAttribute("aria-describedby")!)?.textContent).toBe(
      "eBay isn't hooked up on this NeonBinder yet.",
    );
    fireEvent.click(connect);
    expect(fns["ebayConnect:beginConnect"]).toBeUndefined();
  });

  it("not connected: the consent sits beside Connect, and Connect leaves for eBay", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    fn("ebayConnect:beginConnect").mockResolvedValue({ authorizeUrl: "https://auth.ebay.test/consent?x=1" });
    renderAt();
    expect(screen.getByText("Heads up: connecting starts listing")).toBeTruthy();
    const connect = screen.getByRole("button", { name: "Connect eBay" });
    fireEvent.click(connect);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://auth.ebay.test/consent?x=1"));
    vi.unstubAllGlobals();
  });

  it("eBay's return spends the code once, cleans the URL, and lands focus on the heading", async () => {
    let finish: (v: unknown) => void = () => {};
    fn("ebayConnect:completeConnect").mockReturnValue(new Promise((r) => (finish = r)));
    renderAt("/profile/ebay?code=abc&state=nonce1&expires_in=299");
    expect(screen.getByText("Hooking up your eBay account…")).toBeTruthy();
    await waitFor(() => expect(where).toBe("/profile/ebay"));
    expect(fns["ebayConnect:completeConnect"]).toHaveBeenCalledTimes(1);
    expect(fns["ebayConnect:completeConnect"]).toHaveBeenCalledWith({ code: "abc", state: "nonce1" });
    connection = state({ status: "connected", ebayUsername: "cardshark88", since: Date.UTC(2026, 10, 2, 12) });
    await act(async () => finish({ ok: true, ebayUsername: "cardshark88" }));
    expect(screen.getByText(/Connected to eBay as cardshark88/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "eBay" })));
  });

  it("a refused return says why in an alert", async () => {
    fn("ebayConnect:completeConnect").mockResolvedValue({ ok: false, error: "eBay said no to that one. Connect again." });
    renderAt("/profile/ebay?code=def&state=nonce2");
    expect((await screen.findByRole("alert")).textContent).toBe("eBay said no to that one. Connect again.");
  });

  it("connected: who, since when, and a Disconnect that asks first", async () => {
    connection = state({ status: "connected", ebayUsername: "cardshark88", since: Date.UTC(2026, 10, 2, 12) });
    fn("ebayConnect:disconnect").mockResolvedValue({ ok: true });
    renderAt();
    expect(screen.getByText("cardshark88")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect eBay" }));
    const dialog = screen.getByRole("dialog", { name: "Disconnect eBay?" });
    // Disconnecting ends NB's own eBay listings; the seller's own stay.
    expect(dialog.textContent).toContain("We take down every eBay listing NeonBinder put up");
    expect(dialog.textContent).toContain("Listings you made on eBay yourself stay untouched.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, disconnect" }));
    await waitFor(() => expect(fns["ebayConnect:disconnect"]).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it.each([
    ["needsReauth", "Connect eBay again", /pass ran out/],
    ["paused", "Disconnect eBay", /eBay is on a break/],
    ["sellerConflict", "Disconnect eBay", /already lists from another NeonBinder account/],
  ] as const)("%s says so and offers %s", (status, button, line) => {
    connection = state({ status, ebayUsername: "cardshark88" });
    renderAt();
    expect(screen.getByRole("button", { name: button })).toBeTruthy();
    expect(screen.getByText(line)).toBeTruthy();
    // No setup while it can't reach eBay.
    expect(screen.queryByRole("region", { name: "Shipping" })).toBeNull();
  });
});

describe("Profile → eBay, setup", () => {
  beforeEach(() => {
    connection = state({ status: "connected", ebayUsername: "cardshark88", since: Date.UTC(2026, 10, 2, 12) });
  });

  it("$20 and up leaves the Standard Envelope-only policy out", async () => {
    renderAt();
    const over = await screen.findByRole("radiogroup", { name: "$20 and up" });
    expect(within(over).queryByRole("radio", { name: "PWE only" })).toBeNull();
    expect(within(over).getByRole("radio", { name: "Tracked" })).toBeTruthy();
    const under = screen.getByRole("radiogroup", { name: "Cards under $20" });
    expect(within(under).getByRole("radio", { name: "PWE only" })).toBeTruthy();
  });

  it("a refused pick goes back and says why", async () => {
    connection = state({
      status: "connected",
      ebayUsername: "cardshark88",
      settings: { ...SETTINGS_EMPTY, fulfillmentPolicy20PlusId: "f-both" },
    });
    fn("ebayConnect:savePolicies").mockResolvedValue({ ok: false, error: "That policy can't ship a $20 card." });
    renderAt();
    const over = await screen.findByRole("radiogroup", { name: "$20 and up" });
    fireEvent.click(within(over).getByRole("radio", { name: "Tracked" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That policy can't ship a $20 card. Your old pick is back.",
    );
    expect(within(over).getByRole("radio", { name: "PWE or BMWT" }).getAttribute("aria-checked")).toBe("true");
    expect(fns["ebayConnect:savePolicies"]).toHaveBeenCalledWith({ fulfillmentPolicy20PlusId: "f-ga" });
  });

  it("Set me up shows when nothing fits, makes the policies and picks the empty slots", async () => {
    fn("ebayConnect:readPolicies").mockResolvedValueOnce({ ok: true, fulfillment: [], payment: [], returns: [] });
    fn("ebayConnect:createStandardPolicies").mockResolvedValue({
      ok: true,
      created: ["NB Standard Envelope (under $20)", "NB Tracked (USPS Ground Advantage)", "NB Free Shipping"],
    });
    fn("ebayConnect:readPolicies").mockResolvedValue({
      ok: true,
      fulfillment: [
        { id: "n1", name: "NB Standard Envelope (under $20)", eseFit: true, eseOnly: true, freeShipping: false, summary: "" },
        { id: "n2", name: "NB Tracked (USPS Ground Advantage)", eseFit: false, eseOnly: false, freeShipping: false, summary: "" },
        { id: "n3", name: "NB Free Shipping", eseFit: false, eseOnly: false, freeShipping: true, summary: "" },
      ],
      payment: [{ id: "p1", name: "Payment" }],
      returns: [{ id: "r1", name: "Returns", summary: "" }],
    });
    renderAt();
    fireEvent.click(await screen.findByRole("button", { name: "Set me up" }));
    await waitFor(() =>
      expect(fns["ebayConnect:savePolicies"]).toHaveBeenCalledWith({
        fulfillmentPolicyUnder20Id: "n1",
        fulfillmentPolicy20PlusId: "n2",
        paymentPolicyId: "p1",
        returnPolicyId: "r1",
      }),
    );
    expect((await screen.findByText(/^Made 3 on your eBay account/)).getAttribute("role")).toBe("status");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Shipping" })));
  });

  it("the checklist says what's left, then folds to one line", async () => {
    connection = state({ status: "connected", ebayUsername: "cardshark88", missing: ["location"] });
    const view = renderAt();
    const list = await screen.findByRole("region", { name: "Finish these and your boxes go up" });
    expect(within(list).getByText("1 to go. Nothing lists on eBay until they're done.")).toBeTruthy();
    connection = state({ status: "connected", ebayUsername: "cardshark88", missing: [], setupComplete: true });
    view.rerenderFresh();
    expect(screen.getByRole("region", { name: "You're all set" })).toBeTruthy();
  });

  it("passes axe in light and dark, not connected and connected with setup", async () => {
    connection = state();
    const first = renderAt();
    await expectAccessibleInBothModes(first.container, { label: "eBay, not connected", rerender: first.rerenderFresh });
    cleanup();
    connection = state({ status: "connected", ebayUsername: "cardshark88", environment: "sandbox" });
    const second = renderAt();
    await screen.findByRole("radiogroup", { name: "$20 and up" });
    await expectAccessibleInBothModes(second.container, { label: "eBay, connected", rerender: second.rerenderFresh });
  });
});

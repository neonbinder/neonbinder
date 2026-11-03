/**
 * NEO-415 — Profile → Credentials → eBay. The panel's own logic against a
 * mocked Convex: each connection state, the consent round trip (Connect
 * leaves for eBay; the return lands on /profile/ebay, which forwards to the
 * eBay tab with the code in location state, and the panel spends it once and
 * clears it), Disconnect's
 * confirm, and the setup (the $20-and-up picker leaving Standard
 * Envelope-only policies out, a refused save rolling back with an alert,
 * the seller's own shipping picks and the way out to eBay when they have
 * none, Set me up for payment and returns, the weight of a single card, and
 * the checklist).
 */

import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { Theme } from "@radix-ui/themes";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EbayConnectionState, EbayPolicies } from "@/lib/marketplace/ebay-setup";
import { expectAccessibleInBothModes } from "@/lib/testing/axe";

let connection: EbayConnection | undefined;
const fns: Record<string, ReturnType<typeof vi.fn>> = {};
const fn = (name: string) => (fns[name] ??= vi.fn());

/**
 * The alerts saying something. The Set me up line keeps an alert mounted empty
 * (filled when a refusal comes, so it is announced), so "the alert" is the one
 * with words in it.
 */
const spokenAlerts = () => screen.queryAllByRole("alert").filter((a) => (a.textContent ?? "") !== "");
const saidAlert = () =>
  waitFor(() => {
    const said = spokenAlerts();
    expect(said).toHaveLength(1);
    return said[0];
  });

vi.mock("convex/react", () => {
  // Stable per function, as Convex's own hooks are: the page's effects depend on them.
  const bound = new Map<string, unknown>();
  const bind = (ref: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(ref);
    if (!bound.has(name)) {
      const call = (...args: unknown[]) => (fn(name) as (...a: unknown[]) => unknown)(...args);
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

import EbayPanel from "./EbayPanel";
import type { EbayConnection } from "./SetupSections";
import EbayReturnLanding from "@/app/profile/ebay/page";

const SETTINGS_EMPTY: EbayConnectionState["settings"] = {
  fulfillmentPolicyUnder20Id: null,
  fulfillmentPolicy20PlusId: null,
  paymentPolicyId: null,
  returnPolicyId: null,
  location: null,
  bestOffer: true,
};

function state(over: Partial<EbayConnection> = {}): EbayConnection {
  return {
    configured: true,
    environment: "production",
    status: "notConnected",
    ebayUsername: null,
    since: null,
    settings: SETTINGS_EMPTY,
    setupComplete: false,
    cardWeightOz: 1,
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

const TAB = "/profile/credentials?platform=ebay";

let where = "";
let whereState: unknown = undefined;
function Where() {
  const loc = useLocation();
  useEffect(() => {
    where = `${loc.pathname}${loc.search}`;
    whereState = loc.state;
  }, [loc]);
  return null;
}

/** The eBay tab, behind the landing eBay's consent screen returns to. */
function renderAt(url = TAB) {
  const tree = () => (
    <Theme>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/profile/ebay" element={<EbayReturnLanding />} />
          <Route
            path="/profile/credentials"
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
  where = "";
  whereState = undefined;
  for (const key of Object.keys(fns)) delete fns[key];
  connection = state();
  fn("ebayConnect:readPolicies").mockResolvedValue({ ok: true, ...POLICIES });
  fn("ebayConnect:savePolicies").mockResolvedValue({ ok: true });
});

afterEach(cleanup);

describe("Profile → Credentials → eBay, connection", () => {
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
    // NEO-422: the origin Connect was pressed on goes to the server, which folds it into the OAuth state.
    const origin = "https://neonbinder-abc123def-neon-binder.vercel.app";
    vi.stubGlobal("location", { ...window.location, origin, assign });
    fn("ebayConnect:beginConnect").mockResolvedValue({ authorizeUrl: "https://auth.ebay.test/consent?x=1" });
    renderAt();
    expect(screen.getByText("Heads up: connecting starts listing")).toBeTruthy();
    const connect = screen.getByRole("button", { name: "Connect eBay" });
    fireEvent.click(connect);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://auth.ebay.test/consent?x=1"));
    expect(fns["ebayConnect:beginConnect"]).toHaveBeenCalledWith({ returnOrigin: origin });
    vi.unstubAllGlobals();
  });

  it("eBay's return lands on the eBay tab, spends the code once, keeps it out of the URL and clears it, and lands focus on the heading", async () => {
    let finish: (v: unknown) => void = () => {};
    fn("ebayConnect:completeConnect").mockReturnValue(new Promise((r) => (finish = r)));
    renderAt("/profile/ebay?code=abc&state=nonce1&expires_in=299");
    expect(screen.getByText("Hooking up your eBay account…")).toBeTruthy();
    await waitFor(() => expect(where).toBe(TAB));
    // Handed over in location state, then cleared: nothing for a refresh or Back to replay.
    await waitFor(() => expect(whereState).toBeNull());
    expect(fns["ebayConnect:completeConnect"]).toHaveBeenCalledTimes(1);
    expect(fns["ebayConnect:completeConnect"]).toHaveBeenCalledWith({ code: "abc", state: "nonce1" });
    connection = state({ status: "connected", ebayUsername: "cardshark88", since: Date.UTC(2026, 10, 2, 12) });
    await act(async () => finish({ ok: true, ebayUsername: "cardshark88" }));
    expect(screen.getByText(/Connected to eBay as cardshark88/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "eBay" })));
  });

  it("a return carrying NEO-422's composite state hands it to the server untouched", async () => {
    fn("ebayConnect:completeConnect").mockResolvedValue({ ok: true, ebayUsername: "cardshark88" });
    const composite = `${"a".repeat(48)}.aHR0cDovL2xvY2FsaG9zdDozMDAw`;
    renderAt(`/profile/ebay?code=v%5E1.1%23i%5E1&state=${composite}&expires_in=299`);
    await waitFor(() => expect(where).toBe(TAB));
    expect(fns["ebayConnect:completeConnect"]).toHaveBeenCalledWith({ code: "v^1.1#i^1", state: composite });
  });

  it("eBay's decline, forwarded with the composite state, is said in NB words and cleaned up without spending anything", async () => {
    const composite = `${"b".repeat(48)}.aHR0cDovL2xvY2FsaG9zdDozMDAw`;
    renderAt(`/profile/ebay?error=access_denied&error_description=User+declined%2C+sorry&state=${composite}`);
    expect(await screen.findByText(/No worries, eBay isn't connected/)).toBeTruthy();
    await waitFor(() => expect(where).toBe(TAB));
    await waitFor(() => expect(whereState).toBeNull());
    expect(fns["ebayConnect:completeConnect"]).toBeUndefined();
    expect(document.body.textContent).not.toContain("User declined");
  });

  it("a refused return says why in an alert", async () => {
    fn("ebayConnect:completeConnect").mockResolvedValue({ ok: false, error: "eBay said no to that one. Connect again." });
    renderAt("/profile/ebay?code=def&state=nonce2");
    expect((await saidAlert()).textContent).toBe("eBay said no to that one. Connect again.");
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
    ["needsReauth", "Connect eBay again", /^Your eBay connection ran out\.$/],
    ["paused", "Disconnect eBay", /eBay is on a break/],
    ["sellerConflict", "Disconnect eBay", /^That eBay seller account \(cardshark88\) already lists from another NeonBinder account/],
  ] as const)("%s says so and offers %s", (status, button, line) => {
    connection = state({ status, ebayUsername: "cardshark88" });
    renderAt();
    expect(screen.getByRole("button", { name: button })).toBeTruthy();
    expect(screen.getByText(line)).toBeTruthy();
    // No setup while it can't reach eBay.
    expect(screen.queryByRole("region", { name: "Shipping" })).toBeNull();
  });
});

describe("Profile → Credentials → eBay, setup", () => {
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
    expect((await saidAlert()).textContent).toBe(
      "That policy can't ship a $20 card. Your old pick is back.",
    );
    expect(within(over).getByRole("radio", { name: "PWE or BMWT" }).getAttribute("aria-checked")).toBe("true");
    expect(fns["ebayConnect:savePolicies"]).toHaveBeenCalledWith({ fulfillmentPolicy20PlusId: "f-ga" });
  });

  it("a pick in each shipping slot saves the seller's own policy, and each slot says what fits it", async () => {
    renderAt();
    const under = await screen.findByRole("radiogroup", { name: "Cards under $20" });
    const over = screen.getByRole("radiogroup", { name: "$20 and up" });
    const said = (group: HTMLElement) =>
      (group.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .join(" ");
    expect(said(under)).toBe("A policy with Standard Envelope or tracked shipping fits here.");
    expect(said(over)).toBe("Ship these tracked: pick a policy with a tracked service.");
    fireEvent.click(within(under).getByRole("radio", { name: "PWE or BMWT" }));
    await waitFor(() => expect(fns["ebayConnect:savePolicies"]).toHaveBeenCalledWith({ fulfillmentPolicyUnder20Id: "f-both" }));
    fireEvent.click(within(over).getByRole("radio", { name: "Tracked" }));
    await waitFor(() => expect(fns["ebayConnect:savePolicies"]).toHaveBeenCalledWith({ fulfillmentPolicy20PlusId: "f-ga" }));
    expect(within(under).getByRole("radio", { name: "PWE or BMWT" }).getAttribute("aria-checked")).toBe("true");
    expect(within(over).getByRole("radio", { name: "Tracked" }).getAttribute("aria-checked")).toBe("true");
    // Shipping is never made for the seller: no Set me up while payment and returns are there.
    expect(screen.queryByRole("button", { name: "Set me up" })).toBeNull();
    expect(fns["ebayConnect:createStandardPolicies"]).toBeUndefined();
  });

  it("no shipping policies at all: says so, links out to make one on eBay, and Check eBay again reads afresh", async () => {
    fn("ebayConnect:readPolicies").mockResolvedValueOnce({ ok: true, ...POLICIES, fulfillment: [] });
    renderAt();
    const shipping = screen.getByRole("region", { name: "Shipping" });
    expect(await within(shipping).findByText("No shipping policies on your eBay account yet.")).toBeTruthy();
    expect(within(shipping).queryByRole("radiogroup")).toBeNull();
    const make = within(shipping).getByRole("link", { name: "Make a shipping policy on eBay (opens in a new tab)" });
    // A production connection goes to eBay itself.
    expect(make.getAttribute("href")).toBe("https://www.ebay.com/bp/manage");
    expect(make.getAttribute("target")).toBe("_blank");
    expect(make.getAttribute("rel")).toBe("noopener noreferrer");
    // Payment and returns are there, so nothing is offered to make shipping.
    expect(screen.queryByRole("button", { name: "Set me up" })).toBeNull();

    // Made one on eBay: the next read finds it and the pickers come up.
    fireEvent.click(within(shipping).getByRole("button", { name: "Check eBay again" }));
    expect(await screen.findByRole("radiogroup", { name: "Cards under $20" })).toBeTruthy();
    expect(fns["ebayConnect:readPolicies"]).toHaveBeenCalledTimes(2);
    expect(within(shipping).queryByText("No shipping policies on your eBay account yet.")).toBeNull();
  });

  it("on a sandbox connection the eBay link goes to the sandbox", async () => {
    connection = state({ status: "connected", ebayUsername: "cardshark88", environment: "sandbox" });
    fn("ebayConnect:readPolicies").mockResolvedValueOnce({ ok: true, ...POLICIES, fulfillment: [] });
    renderAt();
    const make = await screen.findByRole("link", { name: "Make a shipping policy on eBay (opens in a new tab)" });
    expect(make.getAttribute("href")).toBe("https://www.sandbox.ebay.com/bp/manage");
  });

  it("only Standard Envelope policies: $20 and up says so and links out to make a tracked one", async () => {
    fn("ebayConnect:readPolicies").mockResolvedValueOnce({ ok: true, ...POLICIES, fulfillment: [POLICIES.fulfillment[0]] });
    renderAt();
    expect(await screen.findByText("Nothing here can ship a $20 card yet. Standard Envelope only covers cards under $20.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Make a tracked policy on eBay (opens in a new tab)" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Cards under $20" })).toBeTruthy();
  });

  it("Set me up shows when payment or returns are missing, makes only those, and leaves the picking to the server", async () => {
    // No ship-from saved: Set me up waits for nothing.
    connection = state({
      status: "connected",
      ebayUsername: "cardshark88",
      missing: ["shippingUnder20", "shipping20Plus", "payment", "returns", "location"],
    });
    fn("ebayConnect:readPolicies").mockResolvedValueOnce({ ok: true, fulfillment: POLICIES.fulfillment, payment: [], returns: [] });
    fn("ebayConnect:createStandardPolicies").mockResolvedValue({
      ok: true,
      created: ["NB Payment", "NB Returns (30 days)"],
      // The account's policies once the run is done: the page picks from these, not from a second read.
      policies: {
        fulfillment: POLICIES.fulfillment,
        payment: [{ id: "p1", name: "NB Payment" }],
        returns: [{ id: "r1", name: "NB Returns (30 days)", summary: "" }],
      },
    });
    renderAt();
    const money = screen.getByRole("region", { name: "Payment and returns" });
    fireEvent.click(await within(money).findByRole("button", { name: "Set me up" }));
    expect((await screen.findByText(/^Made 2 on your eBay account/)).getAttribute("role")).toBe("status");
    // The run fills the empty payment and returns slots on the server; the page sends no pick, and never one for shipping.
    expect(fns["ebayConnect:savePolicies"]).not.toHaveBeenCalled();
    expect(within(money).getByRole("radio", { name: "NB Payment" })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 3, name: "Payment and returns" })),
    );
    // Only the read the page opened with: after a run, eBay is not asked again.
    expect(fns["ebayConnect:readPolicies"]).toHaveBeenCalledTimes(1);
  });

  it("the weight of a single card reads 1 oz by default, and says what it's for", async () => {
    renderAt();
    const weight = screen.getByRole("radiogroup", { name: "Weight of a single card" });
    expect(within(weight).getAllByRole("radio").map((r) => r.textContent)).toEqual(["1 oz", "2 oz", "3 oz"]);
    expect(within(weight).getByRole("radio", { name: "1 oz" }).getAttribute("aria-checked")).toBe("true");
    expect(within(weight).getAllByRole("radio", { checked: true })).toHaveLength(1);
    const hint = document.getElementById(weight.getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toBe(
      "Weigh one card packed to mail: sleeve, toploader, envelope and all. eBay charges buyers shipping by it, and Standard Envelope tops out at 3 oz.",
    );
  });

  it("the saved weight is the one shown", () => {
    connection = state({ status: "connected", ebayUsername: "cardshark88", cardWeightOz: 3 });
    renderAt();
    const weight = screen.getByRole("radiogroup", { name: "Weight of a single card" });
    expect(within(weight).getByRole("radio", { name: "3 oz" }).getAttribute("aria-checked")).toBe("true");
  });

  it("Enter on a weight saves it and says so", async () => {
    fn("ebayConnect:setCardWeight").mockResolvedValue(null);
    renderAt();
    const three = within(screen.getByRole("radiogroup", { name: "Weight of a single card" })).getByRole("radio", { name: "3 oz" });
    three.focus();
    await act(async () => {
      fireEvent.keyDown(three, { key: "Enter" });
    });
    expect(fns["ebayConnect:setCardWeight"]).toHaveBeenCalledTimes(1);
    expect(fns["ebayConnect:setCardWeight"]).toHaveBeenCalledWith({ ounces: 3 });
    expect((await screen.findByText("Saved. Each card weighs in at 3 oz.")).getAttribute("role")).toBe("status");
    expect(spokenAlerts()).toHaveLength(0);
  });

  it("picking the weight already saved sends nothing", async () => {
    renderAt();
    const one = within(screen.getByRole("radiogroup", { name: "Weight of a single card" })).getByRole("radio", { name: "1 oz" });
    one.focus();
    await act(async () => {
      fireEvent.keyDown(one, { key: "Enter" });
    });
    expect(fns["ebayConnect:setCardWeight"]).toBeUndefined();
  });

  it("the checklist says what's left, then folds to one line", async () => {
    connection = state({ status: "connected", ebayUsername: "cardshark88", missing: ["location"] });
    const view = renderAt();
    const list = await screen.findByRole("region", { name: "Finish these and your boxes go up" });
    expect(within(list).getByText("1 to go. Nothing lists on eBay until they're done.")).toBeTruthy();
    connection = state({ status: "connected", ebayUsername: "cardshark88", missing: [], setupComplete: true });
    view.rerenderFresh();
    const done = screen.getByRole("region", { name: "You're all set" });
    // Finished in this visit: the folded line mounts empty and fills, so it is announced.
    await waitFor(() =>
      expect(within(done).getByRole("status").textContent).toBe("Everything in a listed box lists on eBay at your count."),
    );
    expect(screen.queryByRole("region", { name: "Finish these and your boxes go up" })).toBeNull();
  });

  it("until it's done the checklist leads, and each step lands on its section's heading", async () => {
    connection = state({ status: "connected", ebayUsername: "cardshark88", missing: ["payment", "location"] });
    renderAt();
    const list = await screen.findByRole("region", { name: "Finish these and your boxes go up" });
    const regions = screen.getAllByRole("region").map((r) => r.getAttribute("aria-labelledby"));
    // Right under the connection, ahead of every setup section; Ships from leads them.
    expect(regions.indexOf(list.getAttribute("aria-labelledby"))).toBe(1);
    // The panel's heading is an h2 (it sits under the Credentials tab); its setup cards are h3s beneath it.
    expect(screen.getAllByRole("region").map((r) => r.querySelector("h2, h3")?.textContent)).toEqual([
      "eBay",
      "Finish these and your boxes go up",
      "Ships from",
      "Shipping",
      "Payment and returns",
      "Packing",
      "Offers",
    ]);
    expect(within(list).getAllByRole("link")[0].textContent).toMatch(/^Where your cards ship from/);
    for (const [step, heading] of [
      ["Where your cards ship from, still to do", "Ships from"],
      ["Shipping for cards under $20, done", "Shipping"],
      ["Shipping for cards $20 and up, done", "Shipping"],
      ["Payment, still to do", "Payment and returns"],
      ["Returns, done", "Payment and returns"],
    ] as const) {
      // happy-dom has no layout, so it pads the sr-only span with a space a browser leaves out.
      fireEvent.click(within(list).getByRole("link", { name: (name) => name.replace(" ,", ",") === step }));
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 3, name: heading }));
    }
  });

  it("a plain visit to /profile/ebay (an old link) just opens the eBay tab and spends nothing", async () => {
    connection = state();
    renderAt("/profile/ebay");
    await waitFor(() => expect(where).toBe(TAB));
    expect(whereState).toBeNull();
    expect(screen.getByRole("button", { name: "Connect eBay" })).toBeTruthy();
    expect(fns["ebayConnect:completeConnect"]).toBeUndefined();
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
    cleanup();
    // No shipping policies on the account: the way out to eBay, and Set me up for payment and returns.
    fn("ebayConnect:readPolicies").mockResolvedValue({ ok: true, fulfillment: [], payment: [], returns: [] });
    const third = renderAt();
    await screen.findByRole("link", { name: "Make a shipping policy on eBay (opens in a new tab)" });
    await expectAccessibleInBothModes(third.container, { label: "eBay, no shipping policies", rerender: third.rerenderFresh });
  });
});

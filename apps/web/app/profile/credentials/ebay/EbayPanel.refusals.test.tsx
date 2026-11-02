/**
 * NEO-415 — Profile → Credentials → eBay, what the server refuses and what a disconnect
 * leaves behind: Connect's start refusing ("Disconnect eBay first…"), as an
 * answer or a thrown ConvexError; a return from a different seller account;
 * and a disconnect that couldn't take every NB listing down. Each is said in
 * an alert in the server's own words or NB's.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Theme } from "@radix-ui/themes";
import { ConvexError } from "convex/values";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EbayConnectionState } from "@/lib/marketplace/ebay-setup";

let connection: EbayConnectionState | undefined;
const fns: Record<string, ReturnType<typeof vi.fn>> = {};
const fn = (name: string) => (fns[name] ??= vi.fn());

vi.mock("convex/react", () => {
  const bound = new Map<string, unknown>();
  const bind = (ref: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(ref);
    if (!bound.has(name)) {
      const call = (...args: unknown[]) => (fn(name) as (...a: unknown[]) => unknown)(...args);
      bound.set(name, Object.assign(call, { withOptimisticUpdate: () => call }));
    }
    return bound.get(name);
  };
  return { useQuery: () => connection, useMutation: bind, useAction: bind };
});

import EbayPanel from "./EbayPanel";
import EbayReturnLanding from "@/app/profile/ebay/page";

function state(over: Partial<EbayConnectionState> = {}): EbayConnectionState {
  return {
    configured: true,
    environment: "production",
    status: "notConnected",
    ebayUsername: null,
    since: null,
    settings: {
      fulfillmentPolicyUnder20Id: null,
      fulfillmentPolicy20PlusId: null,
      paymentPolicyId: null,
      returnPolicyId: null,
      location: null,
      bestOffer: true,
    },
    setupComplete: false,
    missing: [],
    ...over,
  };
}

function tree(url: string) {
  return (
    <Theme>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/profile/ebay" element={<EbayReturnLanding />} />
          <Route path="/profile/credentials" element={<EbayPanel />} />
        </Routes>
      </MemoryRouter>
    </Theme>
  );
}

function renderAt(url = "/profile/credentials?platform=ebay") {
  const view = render(tree(url));
  return { ...view, again: () => view.rerender(tree(url)) };
}

const assign = vi.fn();

beforeEach(() => {
  for (const key of Object.keys(fns)) delete fns[key];
  connection = state();
  fn("ebayConnect:readPolicies").mockResolvedValue({ ok: true, fulfillment: [], payment: [], returns: [] });
  assign.mockReset();
  vi.stubGlobal("location", { ...window.location, assign });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Connect refusals", () => {
  it("Connect's start refusing with a sentence says it in an alert and stays put", async () => {
    fn("ebayConnect:beginConnect").mockResolvedValue({ ok: false, error: "Disconnect eBay first, then connect again." });
    renderAt();
    fireEvent.click(screen.getByRole("button", { name: "Connect eBay" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Disconnect eBay first, then connect again.");
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Connect eBay" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("a refusal thrown as a ConvexError is said in the server's words", async () => {
    fn("ebayConnect:beginConnect").mockRejectedValue(new ConvexError("Disconnect eBay first, then connect again."));
    renderAt();
    fireEvent.click(screen.getByRole("button", { name: "Connect eBay" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Disconnect eBay first, then connect again.");
  });

  it("anything else thrown reads as NB's own line, never a stack", async () => {
    fn("ebayConnect:beginConnect").mockRejectedValue(new Error("[CONVEX M(ebayConnect:beginConnect)] Server Error"));
    renderAt();
    fireEvent.click(screen.getByRole("button", { name: "Connect eBay" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't reach eBay to connect. Give it another try.");
  });

  it("a return from a different seller account is an alert, and focus goes to Connect", async () => {
    connection = state({ status: "needsReauth", ebayUsername: "cardshark88" });
    const mismatch = "That's a different eBay account from the one you had connected. Connect cardshark88 again.";
    fn("ebayConnect:completeConnect").mockResolvedValue({ ok: false, error: mismatch });
    renderAt("/profile/ebay?code=c1&state=n1");
    expect((await screen.findByRole("alert")).textContent).toBe(mismatch);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Connect eBay again" })),
    );
  });
});

describe("Focus waits only for what can still happen", () => {
  it.each(["paused", "sellerConflict"] as const)(
    "a refused return while %s doesn't leave focus armed for a later status change",
    async (status) => {
      connection = state({ status, ebayUsername: "cardshark88" });
      fn("ebayConnect:completeConnect").mockResolvedValue({ ok: false, error: "eBay said no to that one." });
      // A fresh code per case: a spent one is never sent twice.
      const view = renderAt(`/profile/ebay?code=c9-${status}&state=n9`);
      expect((await screen.findByRole("alert")).textContent).toBe("eBay said no to that one.");
      const elsewhere = document.createElement("button");
      document.body.appendChild(elsewhere);
      elsewhere.focus();
      // Much later, the status moves on its own (the pause lifts, the seller frees up).
      connection = state({ status: "notConnected" });
      view.again();
      await act(async () => {});
      expect(screen.getByRole("button", { name: "Connect eBay" })).toBeTruthy();
      expect(document.activeElement).toBe(elsewhere);
      elsewhere.remove();
    },
  );
});

describe("Disconnect leftovers", () => {
  async function disconnectWith(answer: unknown) {
    connection = state({ status: "connected", ebayUsername: "cardshark88" });
    fn("ebayConnect:disconnect").mockResolvedValue(answer);
    const view = renderAt();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect eBay" }));
    const dialog = screen.getByRole("dialog", { name: "Disconnect eBay?" });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Yes, disconnect" }));
    });
    connection = state();
    view.again();
  }

  it("listings still up after a disconnect are counted in an alert that says to end them on eBay", async () => {
    await disconnectWith({ ok: true, notEnded: 3 });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Disconnected, but 3 NeonBinder listings are still up on eBay and we couldn't take them down. End them on eBay so nothing sells that you no longer have.",
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Connect eBay" })));
  });

  it("one listing left reads in the singular", async () => {
    await disconnectWith({ ok: true, notEnded: 1 });
    expect((await screen.findByRole("alert")).textContent).toContain("1 NeonBinder listing is still up on eBay");
  });

  it("nothing left up is a polite status, not an alert", async () => {
    await disconnectWith({ ok: true, notEnded: 0 });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Disconnected from eBay. Every listing NeonBinder put up there is down.").getAttribute("role")).toBe(
      "status",
    );
  });
});

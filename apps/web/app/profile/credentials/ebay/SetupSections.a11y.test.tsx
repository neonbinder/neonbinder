/**
 * NEO-415 — Profile → Credentials → eBay, the accessibility audit's fixes: the ships-from
 * form keeps focus and its "Saved." line through a save, marks and focuses
 * what a refused submit needs; Set me up (payment and returns only, under
 * their card, waiting for nothing) says it's working and offers the policies
 * its run hands back (no second read, no pick of its own); status lines
 * carry no aria-busy; eBay's "no" return focuses the
 * heading; the page is inert behind the Disconnect confirm and Cancel hands
 * focus back; a picker's refusal or gone pick describes its radiogroup.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Theme } from "@radix-ui/themes";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EbayConnectionState, EbayPolicies } from "@/lib/marketplace/ebay-setup";

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
  return { useQuery: () => connection, useMutation: bind, useAction: bind };
});

import EbayPanel from "./EbayPanel";
import type { EbayConnection } from "./SetupSections";
import EbayReturnLanding from "@/app/profile/ebay/page";

const SETTINGS: EbayConnectionState["settings"] = {
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
    status: "connected",
    ebayUsername: "cardshark88",
    since: Date.UTC(2026, 10, 2, 12),
    settings: SETTINGS,
    setupComplete: false,
    cardWeightOz: 1,
    missing: ["location"],
    ...over,
  };
}

const POLICIES: EbayPolicies = {
  fulfillment: [
    { id: "f-ese", name: "PWE only", eseFit: true, eseOnly: true, freeShipping: false, summary: "" },
    { id: "f-ga", name: "Tracked", eseFit: false, eseOnly: false, freeShipping: false, summary: "" },
  ],
  payment: [{ id: "p1", name: "Payment" }],
  returns: [{ id: "r1", name: "No returns", summary: "" }],
};

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

beforeEach(() => {
  for (const key of Object.keys(fns)) delete fns[key];
  connection = state();
  fn("ebayConnect:readPolicies").mockResolvedValue({ ok: true, ...POLICIES });
  fn("ebayConnect:savePolicies").mockResolvedValue({ ok: true });
});

afterEach(cleanup);

describe("Ships from", () => {
  it("a save keeps the form, its focus and the Saved line while the query catches up", async () => {
    fn("ebayConnect:saveLocation").mockResolvedValue({ ok: true });
    const view = renderAt();
    fireEvent.change(screen.getByLabelText("ZIP code"), { target: { value: "53703" } });
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Madison" } });
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "wi" } });
    const save = screen.getByRole("button", { name: "Save location" });
    save.focus();
    fireEvent.click(save);
    await screen.findByText("Saved. Your cards ship from here.");
    expect(fns["ebayConnect:saveLocation"]).toHaveBeenCalledWith({
      postalCode: "53703",
      city: "Madison",
      stateOrProvince: "WI",
    });

    connection = state({
      settings: { ...SETTINGS, location: { postalCode: "53703", city: "Madison", stateOrProvince: "WI" } },
      missing: [],
    });
    view.again();
    expect(screen.getByText("Saved. Your cards ship from here.")).toBeTruthy();
    expect(document.activeElement).toBe(save);
    expect(save.isConnected).toBe(true);
  });

  it("a refused submit marks every field it needs and focuses the first", async () => {
    renderAt();
    const zip = screen.getByLabelText("ZIP code");
    const city = screen.getByLabelText("City");
    const st = screen.getByLabelText("State");
    for (const field of [zip, city, st]) expect(field.getAttribute("aria-required")).toBe("true");
    fireEvent.change(zip, { target: { value: "5370" } });
    fireEvent.click(screen.getByRole("button", { name: "Save location" }));
    await waitFor(() => expect(document.activeElement).toBe(zip));
    for (const field of [zip, city, st]) expect(field.getAttribute("aria-invalid")).toBe("true");
    const said = (el: HTMLElement) =>
      (el.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .join(" ");
    expect(said(zip)).toContain("A ZIP code, like 53703 or 53703-1234.");
    expect(said(city)).toContain("Add the city your cards ship from.");
    expect(said(st)).toContain("Add the state, like WI.");
    expect(fns["ebayConnect:saveLocation"]).toBeUndefined();

    // A valid ZIP alone moves focus on to the next field that still needs filling.
    fireEvent.change(zip, { target: { value: "53703-1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Save location" }));
    await waitFor(() => expect(document.activeElement).toBe(city));
    expect(zip.getAttribute("aria-invalid")).toBeNull();
  });

  it("State is hinted under the field, never with a placeholder that reads as a saved value", () => {
    renderAt();
    const st = screen.getByLabelText("State");
    expect(st.getAttribute("placeholder")).toBeNull();
    const hint = document.getElementById(st.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toBe("Two letters, like WI.");
  });

  it("a save from elsewhere refills untouched fields, never ones being typed in", () => {
    const view = renderAt();
    connection = state({ settings: { ...SETTINGS, location: { postalCode: "10001", city: "New York", stateOrProvince: "NY" } } });
    view.again();
    expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe("New York");

    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Brooklyn" } });
    connection = state({ settings: { ...SETTINGS, location: { postalCode: "60601", city: "Chicago", stateOrProvince: "IL" } } });
    view.again();
    expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe("Brooklyn");
  });
});

describe("Set me up", () => {
  // Payment and returns only: shipping is the seller's own pick, never made for them (NEO-423).
  const NOTHING = { ok: true, fulfillment: [], payment: [], returns: [] };
  const MADE = ["NB Payment", "NB Returns (30 days)"];
  const MADE_POLICIES = {
    ok: true,
    fulfillment: [{ id: "f-ga", name: "Tracked", eseFit: false, eseOnly: false, freeShipping: false, summary: "" }],
    payment: [{ id: "p9", name: MADE[0] }],
    returns: [{ id: "r9", name: MADE[1], summary: "" }],
  };
  /** The policy lists a run hands back (`createStandardPolicies`'s `policies`): a read's answer without its `ok`. */
  const listsOf = ({ fulfillment, payment, returns }: typeof MADE_POLICIES) => ({ fulfillment, payment, returns });
  /** The read the page makes when it opens; a run that hands back its policies makes no other. */
  const reads = () => fns["ebayConnect:readPolicies"].mock.calls.length;
  const moneyHeading = () => screen.getByRole("heading", { level: 3, name: "Payment and returns" });

  const SHIPS_FROM = { postalCode: "53703", city: "Madison", stateOrProvince: "WI" };
  beforeEach(() => {
    connection = state({ settings: { ...SETTINGS, location: SHIPS_FROM }, missing: ["payment", "returns"] });
  });

  it("waits for nothing: with no ship-from saved it is enabled and runs", async () => {
    connection = state();
    fn("ebayConnect:readPolicies").mockResolvedValueOnce(NOTHING);
    fn("ebayConnect:createStandardPolicies").mockResolvedValue({ ok: true, created: MADE, policies: listsOf(MADE_POLICIES) });
    renderAt();
    const button = await screen.findByRole("button", { name: "Set me up" });
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByText(/^Save where you ship from first/)).toBeNull();
    fireEvent.click(button);
    expect((await screen.findByText(/^Made 2 on your eBay account/)).getAttribute("role")).toBe("status");
    expect(fns["ebayConnect:createStandardPolicies"]).toHaveBeenCalledTimes(1);
  });

  it("sits under Payment and returns and says it never makes shipping", async () => {
    fn("ebayConnect:readPolicies").mockResolvedValueOnce(NOTHING);
    renderAt();
    const money = screen.getByRole("region", { name: "Payment and returns" });
    const button = await within(money).findByRole("button", { name: "Set me up" });
    const said = document.getElementById(button.getAttribute("aria-describedby")!)!.textContent;
    expect(said).toBe(
      "Missing one? Set me up makes NeonBinder's standard payment and returns policies on your eBay account, only the ones you don't have, then picks them for you. Shipping stays your pick.",
    );
    expect(within(screen.getByRole("region", { name: "Shipping" })).queryByRole("button", { name: "Set me up" })).toBeNull();
  });

  it("is not offered once payment and returns are there, even with no shipping policy", async () => {
    fn("ebayConnect:readPolicies").mockResolvedValueOnce({ ...NOTHING, payment: POLICIES.payment, returns: POLICIES.returns });
    renderAt();
    await screen.findByRole("radiogroup", { name: "Payment" });
    expect(screen.getByText("No shipping policies on your eBay account yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set me up" })).toBeNull();
  });

  it("says it's working in a polite status while it runs", async () => {
    fn("ebayConnect:readPolicies").mockResolvedValueOnce(NOTHING);
    fn("ebayConnect:createStandardPolicies").mockReturnValue(new Promise(() => {}));
    renderAt();
    fireEvent.click(await screen.findByRole("button", { name: "Set me up" }));
    const working = await screen.findByText("Setting you up…", { selector: "p" });
    expect(working.getAttribute("role")).toBe("status");
    expect(working.getAttribute("aria-busy")).toBeNull();
  });

  it("offers what the run made without reading eBay again, and saves nothing itself (the server picks)", async () => {
    fn("ebayConnect:readPolicies").mockResolvedValueOnce(NOTHING);
    fn("ebayConnect:createStandardPolicies").mockResolvedValue({ ok: true, created: MADE, policies: listsOf(MADE_POLICIES) });
    const view = renderAt();
    fireEvent.click(await screen.findByRole("button", { name: "Set me up" }));
    expect((await screen.findByText(/^Made 2 on your eBay account/)).textContent).toBe(
      "Made 2 on your eBay account: NB Payment, NB Returns (30 days). Picked where you had nothing yet.",
    );
    // The made policies are on the pickers straight away; the page sends no pick of its own.
    expect(screen.getByRole("radio", { name: MADE[0] })).toBeTruthy();
    expect(fns["ebayConnect:savePolicies"]).not.toHaveBeenCalled();
    expect(reads()).toBe(1);
    await waitFor(() => expect(document.activeElement).toBe(moneyHeading()));

    // The server's own fill lands through the connection state: the picks show, shipping stays unpicked.
    connection = state({
      settings: { ...SETTINGS, location: SHIPS_FROM, paymentPolicyId: "p9", returnPolicyId: "r9" },
      missing: ["shippingUnder20", "shipping20Plus"],
    });
    view.again();
    expect(screen.getByRole("radio", { name: MADE[0] }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: MADE[1] }).getAttribute("aria-checked")).toBe("true");
    const under = screen.getByRole("radiogroup", { name: "Cards under $20" });
    expect(within(under).getByRole("radio", { name: "Tracked" }).getAttribute("aria-checked")).toBe("false");
    // Nothing missing now: the box is gone.
    expect(screen.queryByRole("button", { name: "Set me up" })).toBeNull();
  });

  it("nothing new to make says so", async () => {
    fn("ebayConnect:readPolicies").mockResolvedValueOnce(NOTHING);
    fn("ebayConnect:createStandardPolicies").mockResolvedValue({ ok: true, created: [], policies: listsOf(MADE_POLICIES) });
    renderAt();
    fireEvent.click(await screen.findByRole("button", { name: "Set me up" }));
    const line = await screen.findByText("You already had everything. Pick away.");
    expect(line.getAttribute("role")).toBe("status");
    expect(spokenAlerts()).toEqual([]);
  });
});

describe("Set me up's step ledger", () => {
  const SHIPS_FROM = { postalCode: "53703", city: "Madison", stateOrProvince: "WI" };
  const NOTHING = { ok: true, fulfillment: [], payment: [], returns: [] };
  const LEDGER = "Set me up, step by step";
  const NAMES = {
    check: "Check your eBay account",
    payment: "NB Payment",
    returns: "NB Returns (30 days)",
  } as const;
  type Key = keyof typeof NAMES;
  type Status = "waiting" | "working" | "done" | "failed" | "had" | "stopped";
  const run = (startedAt: number, statuses: Partial<Record<Key, Status>>) => ({
    startedAt,
    steps: (Object.keys(statuses) as Key[]).map((step) => ({ step, label: NAMES[step], status: statuses[step]! })),
  });
  const withRun = (progress: ReturnType<typeof run> | null) =>
    state({ settings: { ...SETTINGS, location: SHIPS_FROM }, missing: ["payment", "returns"], setupProgress: progress });
  const STARTED = Date.UTC(2026, 10, 2, 13);
  /**
   * The polite line Set me up speaks through: the Payment and returns card's
   * last status (the pickers' own lines sit above the ledger, the alert after it).
   */
  const runLine = () => {
    const line = within(screen.getByRole("region", { name: "Payment and returns" })).getAllByRole("status").at(-1)!;
    expect(line.getAttribute("aria-live")).toBe("polite");
    return [line];
  };

  let finish: (answer: unknown) => void;
  beforeEach(() => {
    connection = withRun(null);
    fn("ebayConnect:readPolicies").mockResolvedValueOnce(NOTHING);
    fn("ebayConnect:createStandardPolicies").mockReturnValue(new Promise((resolve) => (finish = resolve)));
  });

  it("shows the press's own run as a list of named steps, never an earlier run's finished ledger", async () => {
    // A run from an earlier visit is on the row: nothing shows for it, before or right after the press.
    connection = withRun(run(STARTED - 60_000, { check: "done", payment: "done", returns: "done" }));
    const view = renderAt();
    expect(screen.queryByRole("list", { name: LEDGER })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Set me up" }));
    view.again();
    expect(screen.queryByRole("list", { name: LEDGER })).toBeNull();

    connection = withRun(run(STARTED, { check: "done", payment: "working", returns: "waiting" }));
    view.again();
    const ledger = screen.getByRole("list", { name: LEDGER });
    expect(ledger.tagName).toBe("OL");
    // In the card whose policies it makes.
    expect(ledger.closest("section")).toBe(screen.getByRole("region", { name: "Payment and returns" }));
    const items = within(ledger).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("aria-label"))).toEqual([
      "Check your eBay account, done",
      "NB Payment, working",
      "NB Returns (30 days), waiting",
    ]);
    // Each item's own words say what its name says (the state in a hidden tail where the glyph shows it).
    for (const li of items) expect(li.textContent).toBe(li.getAttribute("aria-label"));
    // The glyph is decoration: the words carry the state.
    for (const svg of ledger.querySelectorAll("svg")) expect(svg.getAttribute("aria-hidden")).toBe("true");
  });

  it("says each step once as it lands, through one polite line, and keeps it until the next one lands", async () => {
    const view = renderAt();
    const button = await screen.findByRole("button", { name: "Set me up" });
    button.focus();
    fireEvent.click(button);
    // While it runs, the keyboard stays where it pressed (the box stays, its button busy).
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    connection = withRun(run(STARTED, { check: "working" }));
    view.again();
    let line = runLine();
    expect(line).toHaveLength(1);
    expect(line[0].getAttribute("aria-live")).toBe("polite");
    expect(line[0].textContent).toBe("Setting you up…");

    connection = withRun(run(STARTED, { check: "done", payment: "working", returns: "waiting" }));
    view.again();
    expect(runLine()[0].textContent).toBe("Checked your eBay account. 2 to make.");

    connection = withRun(run(STARTED, { check: "done", payment: "done", returns: "working" }));
    view.again();
    expect(runLine()[0].textContent).toBe("Made NB Payment. 1 of 2 made.");
    // The same ledger read again (a fresh array) is no news: the line holds, and stays one region.
    connection = withRun(run(STARTED, { check: "done", payment: "done", returns: "working" }));
    view.again();
    line = runLine();
    expect(line).toHaveLength(1);
    expect(line[0].textContent).toBe("Made NB Payment. 1 of 2 made.");
    expect(document.activeElement).toBe(button);
  });

  it("a run the page first hears of mid-way still says the step that already landed", async () => {
    const view = renderAt();
    fireEvent.click(await screen.findByRole("button", { name: "Set me up" }));
    expect(runLine()[0].textContent).toBe("Setting you up…");
    // The first read the page gets is already past the account check, which found payment already there.
    connection = withRun(run(STARTED, { check: "done", payment: "had", returns: "working" }));
    view.again();
    expect(runLine()[0].textContent).toBe("Checked your eBay account. 1 to make.");
    expect(screen.getByRole("listitem", { name: "NB Payment, already on eBay" }).textContent).toBe(
      "NB Payment, already on eBay",
    );
  });

  it("Set me up again after a refusal speaks through the same status node, and the refusal leaves the alert", async () => {
    fn("ebayConnect:createStandardPolicies").mockResolvedValueOnce({ ok: false, error: "eBay's not answering right now." });
    renderAt();
    const button = await screen.findByRole("button", { name: "Set me up" });
    const status = runLine()[0];
    const alert = screen.getAllByRole("alert").at(-1)!;
    fireEvent.click(button);
    await waitFor(() => expect(alert.textContent).toBe("eBay's not answering right now."));
    expect(status.textContent).toBe("");
    // The second press (the mock's pending promise now): the same nodes, only their words change.
    fireEvent.click(button);
    await waitFor(() => expect(status.textContent).toBe("Setting you up…"));
    expect(runLine()[0]).toBe(status);
    expect(status.isConnected).toBe(true);
    expect(screen.getAllByRole("alert").at(-1)).toBe(alert);
    expect(alert.textContent).toBe("");
  });

  it("the answer lands with every step ticked, no read of eBay after the run, and the ledger outlives the box", async () => {
    const view = renderAt();
    fireEvent.click(await screen.findByRole("button", { name: "Set me up" }));
    connection = withRun(run(STARTED, { check: "done", payment: "done", returns: "done" }));
    view.again();
    const policies = {
      fulfillment: [],
      payment: [{ id: "p9", name: NAMES.payment }],
      returns: [{ id: "r9", name: NAMES.returns, summary: "" }],
    };
    await act(async () => finish({ ok: true, created: [NAMES.payment, NAMES.returns], policies }));
    const answer = await screen.findByText(/^Made 2 on your eBay account/);
    expect(answer.getAttribute("role")).toBe("status");
    expect(fns["ebayConnect:readPolicies"]).toHaveBeenCalledTimes(1);
    expect(spokenAlerts()).toEqual([]);
    // Nothing missing now, so the box is gone; the ledger stays beside the answer.
    expect(screen.queryByRole("button", { name: "Set me up" })).toBeNull();
    expect(screen.getByRole("listitem", { name: "NB Returns (30 days), done" })).toBeTruthy();
  });

  it("a refusal: the step reads eBay said no, the rest not made, and the answer is the alert", async () => {
    const view = renderAt();
    fireEvent.click(await screen.findByRole("button", { name: "Set me up" }));
    connection = withRun(run(STARTED, { check: "done", payment: "failed", returns: "stopped" }));
    view.again();
    await act(async () => finish({ ok: false, error: "eBay turned down the payment policy, so Set me up stopped there." }));
    expect((await saidAlert()).textContent).toBe("eBay turned down the payment policy, so Set me up stopped there.");
    // Said on screen, not by colour and glyph alone.
    expect(screen.getByRole("listitem", { name: "NB Payment, eBay said no" }).textContent).toBe("NB Payment, eBay said no");
    expect(screen.getByRole("listitem", { name: "NB Returns (30 days), not made" }).textContent).toBe(
      "NB Returns (30 days), not made",
    );
  });

  it("a run that died under a step never leaves it spinning once the press is over", async () => {
    const view = renderAt();
    fireEvent.click(await screen.findByRole("button", { name: "Set me up" }));
    connection = withRun(run(STARTED, { check: "done", payment: "working", returns: "waiting" }));
    view.again();
    expect(screen.getByRole("listitem", { name: "NB Payment, working" })).toBeTruthy();
    await act(async () => finish(Promise.reject(new Error("boom"))));
    await saidAlert();
    expect(screen.getByRole("listitem", { name: "NB Payment, eBay said no" })).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "NB Returns (30 days), not made" })).toBeTruthy();
  });
});

describe("Live lines and focus", () => {
  it("no status line carries aria-busy while loading", () => {
    connection = undefined;
    renderAt();
    for (const s of screen.getAllByRole("status")) expect(s.getAttribute("aria-busy")).toBeNull();
    connection = state();
    fn("ebayConnect:readPolicies").mockReturnValue(new Promise(() => {}));
    cleanup();
    renderAt();
    expect(screen.getByText(/Pulling your policies/).getAttribute("aria-busy")).toBeNull();
  });

  it("an empty live line leaves the flow (no phantom gap) but stays in the tree to speak", async () => {
    renderAt();
    await screen.findByRole("radiogroup", { name: "$20 and up" });
    // happy-dom loads no CSS: pin the class and that the line really is :empty.
    const empty = screen.getAllByRole("status").filter((s) => s.childNodes.length === 0);
    expect(empty.length).toBeGreaterThan(0);
    for (const line of empty) {
      expect(line.className.includes("empty:absolute") || line.className.includes("min-h-5")).toBe(true);
    }
    // A picker's line holds its room, so "Saving…" never shoves the next picker down.
    const under = screen.getByRole("radiogroup", { name: "Cards under $20" });
    let picker = under.parentElement;
    while (picker && !picker.querySelector(':scope > [role="status"]')) picker = picker.parentElement;
    expect(picker!.querySelector(':scope > [role="status"]')!.className).toContain("min-h-5");
  });

  it("the policies area has its final two cards while eBay is still answering", () => {
    fn("ebayConnect:readPolicies").mockReturnValue(new Promise(() => {}));
    renderAt();
    expect(screen.getByRole("region", { name: "Shipping" }).textContent).toContain("Pulling your policies from eBay…");
    expect(screen.getByRole("region", { name: "Payment and returns" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Shipping, payment and returns" })).toBeNull();
  });

  it("coming back from eBay having said no lands focus on the heading", async () => {
    connection = state({ status: "notConnected", ebayUsername: null, since: null });
    renderAt("/profile/ebay?error=access_denied");
    expect(screen.getByText(/No worries, eBay isn't connected/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "eBay" })));
  });

  it("the page is inert behind the Disconnect confirm, and Cancel hands focus back", async () => {
    renderAt();
    const disconnect = screen.getByRole("button", { name: "Disconnect eBay" });
    disconnect.focus();
    fireEvent.click(disconnect);
    const dialog = screen.getByRole("dialog", { name: "Disconnect eBay?" });
    expect(dialog.closest("[inert]")).toBeNull();
    expect(disconnect.closest("[inert]")).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(disconnect.closest("[inert]")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(disconnect));
  });
});

describe("Policy pickers", () => {
  it("a refusal describes its radiogroup", async () => {
    connection = state({ settings: { ...SETTINGS, fulfillmentPolicy20PlusId: "f-ga" } });
    fn("ebayConnect:savePolicies").mockResolvedValue({ ok: false, error: "That one didn't save." });
    renderAt();
    const under = await screen.findByRole("radiogroup", { name: "Cards under $20" });
    // At rest the slot's hint describes it.
    const hintId = under.getAttribute("aria-describedby");
    expect(document.getElementById(hintId!)?.textContent).toBe("A policy with Standard Envelope or tracked shipping fits here.");
    await act(async () => {
      fireEvent.click(within(under).getByRole("radio", { name: "Tracked" }));
    });
    const alert = await saidAlert();
    // The refusal first, then the hint.
    expect(under.getAttribute("aria-describedby")).toBe(`${alert.id} ${hintId}`);
  });

  it("a saved policy gone from the account is said in the live line, which describes the group", async () => {
    connection = state({ settings: { ...SETTINGS, paymentPolicyId: "p-gone" } });
    renderAt();
    const payment = await screen.findByRole("radiogroup", { name: "Payment" });
    const id = payment.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    const line = document.getElementById(id!)!;
    expect(line.getAttribute("role")).toBe("status");
    expect(line.textContent).toBe("The policy you picked here isn't on your eBay account anymore. Pick another.");
  });
});

describe("Weight of a single card", () => {
  it("a refusal is said inline in an alert that describes the group, the old weight comes back, and focus lands on it", async () => {
    // The server's refusal arrives as a ConvexError carrying its sentence.
    fn("ebayConnect:setCardWeight").mockRejectedValue(
      Object.assign(new Error("ConvexError"), { data: "Pick a whole number of ounces from 1 to 3." }),
    );
    renderAt();
    const weight = screen.getByRole("radiogroup", { name: "Weight of a single card" });
    const hintId = weight.getAttribute("aria-describedby");
    expect(hintId).toBeTruthy();
    const two = within(weight).getByRole("radio", { name: "2 oz" });
    two.focus();
    await act(async () => {
      fireEvent.keyDown(two, { key: "Enter" });
    });
    expect(fns["ebayConnect:setCardWeight"]).toHaveBeenCalledWith({ ounces: 2 });
    const alert = await saidAlert();
    expect(alert.textContent).toBe("Pick a whole number of ounces from 1 to 3. Your old weight is back.");
    // Inline: the alert sits in the weight's own section, and describes the group ahead of the hint.
    expect(alert.closest("section")).toBe(weight.closest("section"));
    expect(weight.getAttribute("aria-describedby")).toBe(`${alert.id} ${hintId}`);
    const one = within(weight).getByRole("radio", { name: "1 oz" });
    expect(one.getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(one));
  });

  it("a failure with no sentence of the server's still says what happened", async () => {
    fn("ebayConnect:setCardWeight").mockRejectedValue(new Error("network"));
    renderAt();
    await act(async () => {
      fireEvent.click(within(screen.getByRole("radiogroup", { name: "Weight of a single card" })).getByRole("radio", { name: "3 oz" }));
    });
    expect((await saidAlert()).textContent).toBe("That didn't save. Your old weight is back.");
  });
});

/**
 * NEO-415 — Profile → Credentials → eBay, the accessibility audit's fixes: the ships-from
 * form keeps focus and its "Saved." line through a save, marks and focuses
 * what a refused submit needs; Set me up says it's working, and a failed
 * read-back keeps the box and focus with a Try again that makes nothing
 * twice; status lines carry no aria-busy; eBay's "no" return focuses the
 * heading; the page is inert behind the Disconnect confirm and Cancel hands
 * focus back; a picker's refusal or gone pick describes its radiogroup.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Theme } from "@radix-ui/themes";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EbayConnectionState, EbayPolicies } from "@/lib/marketplace/ebay-setup";

let connection: EbayConnectionState | undefined;
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
import EbayReturnLanding from "@/app/profile/ebay/page";

const SETTINGS: EbayConnectionState["settings"] = {
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
    status: "connected",
    ebayUsername: "cardshark88",
    since: Date.UTC(2026, 10, 2, 12),
    settings: SETTINGS,
    setupComplete: false,
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
  const NOTHING = { ok: true, fulfillment: [], payment: [], returns: [] };
  const MADE = ["NB Standard Envelope (under $20)", "NB Tracked (USPS Ground Advantage)", "NB Payment", "NB Returns"];
  const MADE_POLICIES = {
    ok: true,
    fulfillment: [
      { id: "n1", name: MADE[0], eseFit: true, eseOnly: true, freeShipping: false, summary: "" },
      { id: "n2", name: MADE[1], eseFit: false, eseOnly: false, freeShipping: false, summary: "" },
    ],
    payment: [{ id: "p9", name: MADE[2] }],
    returns: [{ id: "r9", name: MADE[3], summary: "" }],
  };

  const SHIPS_FROM = { postalCode: "53703", city: "Madison", stateOrProvince: "WI" };
  // Set me up waits for a saved ship-from (eBay prices shipping from its ZIP).
  beforeEach(() => {
    connection = state({ settings: { ...SETTINGS, location: SHIPS_FROM }, missing: ["shippingUnder20"] });
  });

  it("with no ship-from saved it stays reachable, says why beside it, and makes nothing", async () => {
    connection = state();
    fn("ebayConnect:readPolicies").mockResolvedValueOnce(NOTHING);
    renderAt();
    const button = await screen.findByRole("button", { name: "Set me up" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    const why = "Save where you ship from first, up in Ships from. eBay prices each buyer's shipping from your ZIP.";
    expect(screen.getByText(why)).toBeTruthy();
    expect(button.getAttribute("aria-describedby")?.split(" ")[0]).toBe(screen.getByText(why).id);
    fireEvent.click(button);
    expect(fns["ebayConnect:createStandardPolicies"]).toBeUndefined();

    // Saved: the button wakes up and the line goes.
    connection = state({ settings: { ...SETTINGS, location: SHIPS_FROM }, missing: ["shippingUnder20"] });
    cleanup();
    fn("ebayConnect:readPolicies").mockResolvedValueOnce(NOTHING);
    renderAt();
    const ready = await screen.findByRole("button", { name: "Set me up" });
    expect(ready.getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByText(why)).toBeNull();
  });

  it("says buyers pay eBay's own rate for the card's weight", async () => {
    fn("ebayConnect:readPolicies").mockResolvedValueOnce(NOTHING);
    renderAt();
    const button = await screen.findByRole("button", { name: "Set me up" });
    const said = document.getElementById(button.getAttribute("aria-describedby")!)!.textContent;
    expect(said).toContain("On the first two, buyers pay eBay's own rate for the card's weight.");
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

  it("made but not read back: the box stays with focus, and Try again picks without making twice", async () => {
    fn("ebayConnect:readPolicies").mockResolvedValueOnce(NOTHING);
    fn("ebayConnect:createStandardPolicies").mockResolvedValue({ ok: true, created: MADE });
    fn("ebayConnect:readPolicies").mockResolvedValueOnce({ ok: false, error: "eBay didn't answer." });
    renderAt();
    const button = await screen.findByRole("button", { name: "Set me up" });
    button.focus();
    fireEvent.click(button);
    const alert = await saidAlert();
    // One message, not eBay's sentence with ours stuck on: what's done, what isn't, and what Try again does.
    expect(alert.textContent).toBe(
      "Your new policies are made, but we couldn't read them back just now, so nothing's picked yet. Give it a bit, then press Try again to pick them. It won't make them twice.",
    );
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(document.activeElement).toBe(retry);
    expect(screen.getByRole("heading", { level: 3, name: "Shipping" })).toBeTruthy();

    fn("ebayConnect:readPolicies").mockResolvedValueOnce(MADE_POLICIES);
    fireEvent.click(retry);
    await waitFor(() =>
      expect(fns["ebayConnect:savePolicies"]).toHaveBeenCalledWith({
        fulfillmentPolicyUnder20Id: "n1",
        fulfillmentPolicy20PlusId: "n2",
        paymentPolicyId: "p9",
        returnPolicyId: "r9",
      }),
    );
    expect(fns["ebayConnect:createStandardPolicies"]).toHaveBeenCalledTimes(1);
    expect((await screen.findByText(/^Made 4 on your eBay account/)).getAttribute("role")).toBe("status");
    expect(spokenAlerts()).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 3, name: "Shipping" })));
  });

  // eBay turned the Standard Envelope policy down (the sandbox does): the rest is made and picked,
  // and cards under $20 stay the collector's pick. NB never puts a parcel policy there for them.
  const NO_ENVELOPE = ["NB Tracked (USPS Ground Advantage)", "NB Free Shipping", "NB Payment", "NB Returns"];
  const NO_ENVELOPE_POLICIES = {
    ok: true,
    fulfillment: [
      { id: "n2", name: NO_ENVELOPE[0], eseFit: false, eseOnly: false, freeShipping: false, summary: "" },
      { id: "n3", name: NO_ENVELOPE[1], eseFit: false, eseOnly: false, freeShipping: true, summary: "" },
    ],
    payment: [{ id: "p9", name: NO_ENVELOPE[2] }],
    returns: [{ id: "r9", name: NO_ENVELOPE[3], summary: "" }],
  };

  it("eBay turning down the envelope still reads as made: a status line, the rest picked, cards under $20 left to the collector", async () => {
    fn("ebayConnect:readPolicies").mockResolvedValueOnce(NOTHING);
    fn("ebayConnect:createStandardPolicies").mockResolvedValue({ ok: true, created: NO_ENVELOPE, envelopeRefused: true });
    fn("ebayConnect:readPolicies").mockResolvedValueOnce(NO_ENVELOPE_POLICIES);
    renderAt();
    fireEvent.click(await screen.findByRole("button", { name: "Set me up" }));
    await waitFor(() =>
      expect(fns["ebayConnect:savePolicies"]).toHaveBeenCalledWith({
        fulfillmentPolicy20PlusId: "n2",
        paymentPolicyId: "p9",
        returnPolicyId: "r9",
      }),
    );
    const line = await screen.findByText(/^Made 4 on your eBay account/);
    expect(line.getAttribute("role")).toBe("status");
    expect(line.textContent).toBe(
      "Made 4 on your eBay account: NB Tracked (USPS Ground Advantage), NB Free Shipping, NB Payment, NB Returns. Picked where you had nothing yet. eBay wouldn't make a Standard Envelope policy, so pick one of yours for cards under $20.",
    );
    expect(spokenAlerts()).toEqual([]);
  });

  it("nothing new to make and eBay turning down the envelope says so, as a status line", async () => {
    fn("ebayConnect:readPolicies").mockResolvedValueOnce(NOTHING);
    fn("ebayConnect:createStandardPolicies").mockResolvedValue({ ok: true, created: [], envelopeRefused: true });
    fn("ebayConnect:readPolicies").mockResolvedValueOnce(NO_ENVELOPE_POLICIES);
    renderAt();
    fireEvent.click(await screen.findByRole("button", { name: "Set me up" }));
    const line = await screen.findByText(/^You already had the rest\./);
    expect(line.getAttribute("role")).toBe("status");
    expect(line.textContent).toBe(
      "You already had the rest. eBay wouldn't make a Standard Envelope policy, so pick one of yours for cards under $20.",
    );
    expect(spokenAlerts()).toEqual([]);
  });

  it("the envelope note survives a Try again after the read back failed", async () => {
    fn("ebayConnect:readPolicies").mockResolvedValueOnce(NOTHING);
    fn("ebayConnect:createStandardPolicies").mockResolvedValue({ ok: true, created: NO_ENVELOPE, envelopeRefused: true });
    fn("ebayConnect:readPolicies").mockResolvedValueOnce({ ok: false, error: "eBay didn't answer." });
    renderAt();
    fireEvent.click(await screen.findByRole("button", { name: "Set me up" }));
    const retry = await screen.findByRole("button", { name: "Try again" });
    fn("ebayConnect:readPolicies").mockResolvedValueOnce(NO_ENVELOPE_POLICIES);
    fireEvent.click(retry);
    const line = await screen.findByText(/^Made 4 on your eBay account/);
    expect(line.textContent).toMatch(/so pick one of yours for cards under \$20\.$/);
    expect(fns["ebayConnect:createStandardPolicies"]).toHaveBeenCalledTimes(1);
  });
});

describe("Set me up's step ledger", () => {
  const SHIPS_FROM = { postalCode: "53703", city: "Madison", stateOrProvince: "WI" };
  const NOTHING = { ok: true, fulfillment: [], payment: [], returns: [] };
  const LEDGER = "Set me up, step by step";
  const NAMES = {
    check: "Check your eBay account",
    tracked: "NB Tracked (USPS Ground Advantage)",
    free: "NB Free Shipping",
    payment: "NB Payment",
    returns: "NB Returns (30 days)",
    ese: "NB Standard Envelope (under $20)",
  } as const;
  type Key = keyof typeof NAMES;
  type Status = "waiting" | "working" | "done" | "failed" | "had" | "stopped";
  const run = (startedAt: number, statuses: Partial<Record<Key, Status>>) => ({
    startedAt,
    steps: (Object.keys(statuses) as Key[]).map((step) => ({ step, label: NAMES[step], status: statuses[step]! })),
  });
  const withRun = (progress: ReturnType<typeof run> | null) =>
    state({ settings: { ...SETTINGS, location: SHIPS_FROM }, missing: ["shippingUnder20"], setupProgress: progress });
  const STARTED = Date.UTC(2026, 10, 2, 13);
  /**
   * The polite line Set me up speaks through: the Shipping card's last status
   * (the pickers' own lines sit above the ledger, the alert after it).
   */
  const runLine = () => {
    const line = within(screen.getByRole("region", { name: "Shipping" })).getAllByRole("status").at(-1)!;
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
    connection = withRun(run(STARTED - 60_000, { check: "done", tracked: "done", free: "done", ese: "done" }));
    const view = renderAt();
    expect(screen.queryByRole("list", { name: LEDGER })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Set me up" }));
    view.again();
    expect(screen.queryByRole("list", { name: LEDGER })).toBeNull();

    connection = withRun(run(STARTED, { check: "done", tracked: "working", free: "waiting", payment: "waiting", returns: "waiting", ese: "waiting" }));
    view.again();
    const ledger = screen.getByRole("list", { name: LEDGER });
    expect(ledger.tagName).toBe("OL");
    const items = within(ledger).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("aria-label"))).toEqual([
      "Check your eBay account, done",
      "NB Tracked (USPS Ground Advantage), working",
      "NB Free Shipping, waiting",
      "NB Payment, waiting",
      "NB Returns (30 days), waiting",
      "NB Standard Envelope (under $20), waiting",
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

    connection = withRun(run(STARTED, { check: "done", tracked: "working", free: "waiting", ese: "had" }));
    view.again();
    expect(runLine()[0].textContent).toBe("Checked your eBay account. 2 to make.");

    connection = withRun(run(STARTED, { check: "done", tracked: "done", free: "working", ese: "had" }));
    view.again();
    expect(runLine()[0].textContent).toBe("Made NB Tracked (USPS Ground Advantage). 1 of 2 made.");
    // The same ledger read again (a fresh array) is no news: the line holds, and stays one region.
    connection = withRun(run(STARTED, { check: "done", tracked: "done", free: "working", ese: "had" }));
    view.again();
    line = runLine();
    expect(line).toHaveLength(1);
    expect(line[0].textContent).toBe("Made NB Tracked (USPS Ground Advantage). 1 of 2 made.");
    expect(screen.getByRole("listitem", { name: "NB Standard Envelope (under $20), already on eBay" }).textContent).toBe(
      "NB Standard Envelope (under $20), already on eBay",
    );
    expect(document.activeElement).toBe(button);
  });

  it("a run the page first hears of mid-way still says the step that already landed", async () => {
    const view = renderAt();
    fireEvent.click(await screen.findByRole("button", { name: "Set me up" }));
    expect(runLine()[0].textContent).toBe("Setting you up…");
    // The first read the page gets is already past the account check.
    connection = withRun(run(STARTED, { check: "done", tracked: "working", free: "waiting", payment: "waiting", returns: "waiting", ese: "waiting" }));
    view.again();
    expect(runLine()[0].textContent).toBe("Checked your eBay account. 5 to make.");
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

  it("eBay turning the envelope down shows a warning on that step, and the answer is still the success line", async () => {
    const made = [NAMES.tracked, NAMES.free, NAMES.payment, NAMES.returns];
    const view = renderAt();
    fireEvent.click(await screen.findByRole("button", { name: "Set me up" }));
    connection = withRun(run(STARTED, { check: "done", tracked: "done", free: "done", payment: "done", returns: "done", ese: "working" }));
    view.again();
    connection = withRun(run(STARTED, { check: "done", tracked: "done", free: "done", payment: "done", returns: "done", ese: "failed" }));
    view.again();
    expect(runLine()[0].textContent).toBe("eBay said no to NB Standard Envelope (under $20).");
    const refused = screen.getByRole("listitem", { name: "NB Standard Envelope (under $20), eBay said no" });
    // Said on screen, not by colour and glyph alone.
    expect(refused.textContent).toBe("NB Standard Envelope (under $20), eBay said no");

    fn("ebayConnect:readPolicies").mockResolvedValueOnce({
      ok: true,
      fulfillment: [{ id: "n2", name: NAMES.tracked, eseFit: false, eseOnly: false, freeShipping: false, summary: "" }],
      payment: [{ id: "p9", name: NAMES.payment }],
      returns: [{ id: "r9", name: NAMES.returns, summary: "" }],
    });
    await act(async () => finish({ ok: true, created: made, envelopeRefused: true }));
    const answer = await screen.findByText(/^Made 4 on your eBay account/);
    expect(answer.getAttribute("role")).toBe("status");
    expect(spokenAlerts()).toEqual([]);
    // The ledger outlives the Set me up box, so the warning stays beside the answer.
    expect(screen.getByRole("listitem", { name: "NB Standard Envelope (under $20), eBay said no" })).toBeTruthy();
  });

  it("an earlier refusal: the step reads eBay said no, the rest not made, and the answer is the alert", async () => {
    const view = renderAt();
    fireEvent.click(await screen.findByRole("button", { name: "Set me up" }));
    connection = withRun(run(STARTED, { check: "done", tracked: "done", free: "failed", payment: "stopped", ese: "stopped" }));
    view.again();
    await act(async () => finish({ ok: false, error: "eBay turned down the free shipping policy, so Set me up stopped there." }));
    expect((await saidAlert()).textContent).toBe("eBay turned down the free shipping policy, so Set me up stopped there.");
    expect(screen.getByRole("listitem", { name: "NB Free Shipping, eBay said no" })).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "NB Payment, not made" }).textContent).toBe("NB Payment, not made");
  });

  it("a run that died under a step never leaves it spinning once the press is over", async () => {
    const view = renderAt();
    fireEvent.click(await screen.findByRole("button", { name: "Set me up" }));
    connection = withRun(run(STARTED, { check: "done", tracked: "working", ese: "waiting" }));
    view.again();
    expect(screen.getByRole("listitem", { name: "NB Tracked (USPS Ground Advantage), working" })).toBeTruthy();
    await act(async () => finish(Promise.reject(new Error("boom"))));
    await saidAlert();
    expect(screen.getByRole("listitem", { name: "NB Tracked (USPS Ground Advantage), eBay said no" })).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "NB Standard Envelope (under $20), not made" })).toBeTruthy();
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
    expect(under.getAttribute("aria-describedby")).toBeNull();
    await act(async () => {
      fireEvent.click(within(under).getByRole("radio", { name: "Tracked" }));
    });
    const alert = await saidAlert();
    expect(under.getAttribute("aria-describedby")).toBe(alert.id);
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

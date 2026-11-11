/**
 * PR 451 (NEO-487) — the five drill forms show "Waiting on BuySportsCards…"
 * while their sync is pending and held up by a BSC call.
 *
 * Each form mints a fresh run key per attempt, sends it to its action as
 * `waitKey`, and mounts one `WaitingOnMarketplaceRun` reading the same key
 * while the action is in flight. `marketplaceWaits.forRun` is mocked to
 * answer "waiting" for whatever key it is asked about, and records the keys,
 * so each test can tie the line to the key the action was given.
 *
 * Real timers: the line only shows after its 1.5 s announce threshold.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      fetchAggregatedOptions: "fetchAggregatedOptions",
      syncSetsAcrossManufacturers: "syncSetsAcrossManufacturers",
      getSelectorOptionById: "getSelectorOptionById",
      getAncestorChain: "getAncestorChain",
    },
    marketplaceWaits: { forRun: "marketplaceWaits.forRun" },
  },
}));

const st = vi.hoisted(() => ({
  /** Every call the form's action received. */
  calls: [] as Array<Record<string, unknown>>,
  /** Settles the pending action, newest last. */
  settle: [] as Array<(v: unknown) => void>,
  fail: [] as Array<(e: unknown) => void>,
  /** Every run key `forRun` was asked about. */
  asked: [] as string[],
}));

vi.mock("convex/react", () => ({
  useAction: () => (args: Record<string, unknown>) =>
    new Promise((resolve, reject) => {
      st.calls.push(args);
      st.settle.push(resolve);
      st.fail.push(reject);
    }),
  useQuery: (ref: string, args: unknown) => {
    if (ref === "getSelectorOptionById") return { _id: "sport-1", value: "Baseball", level: "sport" };
    if (ref === "getAncestorChain") {
      return [
        { _id: "sport-1", value: "Baseball", level: "sport" },
        { _id: "year-1", value: "2024", level: "year" },
        { _id: "brand-1", value: "Topps", level: "manufacturer" },
        { _id: "set-1", value: "Topps Chrome", level: "setName" },
      ];
    }
    if (ref === "marketplaceWaits.forRun" && args !== "skip") {
      st.asked.push((args as { runKey: string }).runKey);
      return { waitingSince: 1, accumulatedMs: 0 };
    }
    return undefined;
  },
}));

import { SportForm } from "./SportForm";
import YearForm from "./YearForm";
import ManufacturerForm from "./ManufacturerForm";
import SetVariantForm from "./SetVariantForm";
import SetForm from "./SetForm";

const WAIT = "Waiting on BuySportsCards…";
const KEY_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
const id = (s: string) => s as never;

beforeEach(() => {
  st.calls = [];
  st.settle = [];
  st.fail = [];
  st.asked = [];
});

const forms: Array<[string, () => React.ReactElement]> = [
  ["SportForm", () => <SportForm />],
  ["YearForm", () => <YearForm sportId={id("sport-1")} />],
  ["ManufacturerForm", () => <ManufacturerForm yearId={id("year-1")} />],
  ["SetVariantForm", () => <SetVariantForm setId={id("set-1")} />],
  ["SetForm", () => <SetForm manufacturerId={id("brand-1")} />],
];

describe.each(forms)("%s — waiting on BuySportsCards", (_name, ui) => {
  it("shows one wait line while the sync is pending, keyed by the key the action was given, and drops it once it settles", async () => {
    await act(async () => {
      render(ui());
    });
    await waitFor(() => expect(st.calls).toHaveLength(1));
    const sent = st.calls[0].waitKey as string;
    expect(sent).toMatch(KEY_SHAPE);

    const line = await screen.findByText(WAIT, {}, { timeout: 3000 });
    expect(line.closest('[role="status"]')).not.toBeNull();
    expect(screen.getAllByText(WAIT)).toHaveLength(1);
    expect(new Set(st.asked)).toEqual(new Set([sent]));

    await act(async () => {
      st.settle[0]({ success: true, message: "Synced", optionsCount: 1, totalSets: 1 });
    });
    await waitFor(() => expect(screen.queryByText(WAIT)).toBeNull());
  });
});

describe("a Retry is a new run", () => {
  it("YearForm sends a fresh key on Retry", async () => {
    await act(async () => {
      render(<YearForm sportId={id("sport-1")} />);
    });
    await waitFor(() => expect(st.calls).toHaveLength(1));
    await act(async () => {
      st.fail[0](new Error("boom"));
    });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(st.calls).toHaveLength(2));

    const [first, second] = st.calls.map((c) => c.waitKey as string);
    expect(second).toMatch(KEY_SHAPE);
    expect(second).not.toBe(first);
  });
});

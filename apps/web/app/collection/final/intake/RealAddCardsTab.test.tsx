/**
 * NEO-370 — the intake tab's leave-guard wiring. After "Done adding photos"
 * the tab arms `useLeaveGuard` until every column but Saved clears; the Done
 * memory (`doneRuns`) outlives a remount; a refused close disarms; a Back
 * answered "Stay" parks focus on Done, else the Pairing heading.
 *
 * The guard itself is the real hook (its own test pins the DOM mechanics);
 * the wrapper below only records the options the tab hands it.
 *
 * Also NEO-370's listing gate on the tab: a run into a box that lists, for a
 * collector set up for syncing, holds the drop zone until the cards carry a
 * price, with the reason beside it; and "See what's syncing" after Done.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageApiContext, type PageApi } from "../pageApi";
import { LEAVE_INTAKE_LINE } from "./realLanes";
import RealAddCardsTab from "./RealAddCardsTab";
import { intakeGateLine, SYNC_STATUS_LINK } from "../inventory/listing/ListingGate";
import type { ListingGateView } from "../data/types";
import { expectAccessibleInBothModes } from "@/lib/testing/axe";

const mocks = vi.hoisted(() => {
  const mutations = new Map<string, ReturnType<typeof vi.fn>>();
  return {
    mutations,
    mutation(name: string) {
      let fn = mutations.get(name);
      if (!fn) {
        fn = vi.fn(() => Promise.resolve(null));
        mutations.set(name, fn);
      }
      return fn;
    },
    data: {
      run: null as unknown,
      job: null as unknown,
      images: [] as unknown[],
      pairs: [] as unknown[],
      matches: [] as unknown[],
      /** The listing gate the store answers (NEO-370); undefined = loading. */
      gate: undefined as ListingGateView | undefined,
      side: "collection" as "collection" | "inventory",
      homes: [] as { id: string; name: string; kind: "binder" | "box" }[],
    },
    dropzone: [] as { heldBy?: string; heldLabel?: string }[],
    guardOptions: [] as { onStay?: () => boolean }[],
  };
});

// `api.<module>.<fn>` is the string "module.fn", so the mocks route by name.
vi.mock("@/convex/_generated/api", () => ({
  api: new Proxy({}, { get: (_t, mod: string) => new Proxy({}, { get: (_u, fn: string) => `${mod}.${fn}` }) }),
}));
vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (args === "skip") return undefined;
    switch (ref) {
      case "intakeRuns.getIntakeRun":
        return mocks.data.run;
      case "intakeRuns.listMyIntakeRuns":
        return [];
      case "placeholderPipeline.getPlaceholderJob":
        return mocks.data.job;
      case "placeholderPipeline.listPlaceholderImages":
        return mocks.data.images;
      case "placeholderPipeline.listPlaceholderPairs":
        return mocks.data.pairs;
      case "intakeRuns.listIntakeMatches":
        return mocks.data.matches;
      default:
        return undefined;
    }
  },
  useMutation: (ref: string) => mocks.mutation(ref),
}));
vi.mock("../data/store", () => ({
  useSide: () => mocks.data.side,
  useContainers: () => [],
  homesOnSide: () => mocks.data.homes,
  useDefaultCondition: () => "Near Mint",
  useListingGate: () => mocks.data.gate,
  writeErrorMessage: (e: unknown) => (e instanceof Error ? e.message : "Something went wrong."),
}));
vi.mock("@/src/hooks/useWarmPreprocess", () => ({ useWarmPreprocess: () => undefined }));
vi.mock("@/src/hooks/usePlaceholderUpload", () => ({
  usePlaceholderUpload: () => ({ uploading: false, upload: vi.fn() }),
}));
vi.mock("@/src/hooks/useLeaveGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/hooks/useLeaveGuard")>();
  return {
    ...actual,
    useLeaveGuard: (active: boolean, message: string, options: { onStay?: () => boolean } = {}) => {
      mocks.guardOptions.push(options);
      actual.useLeaveGuard(active, message, options);
    },
  };
});
// The real zone's held state has its own test (dropzone.test.tsx); this one
// records what the tab hands it and stands in a control that carries it.
vi.mock("@/app/print/placeholders/dropzone", () => ({
  Dropzone: (p: { heldBy?: string; heldLabel?: string }) => {
    mocks.dropzone.push(p);
    return (
      <button type="button" aria-disabled={p.heldBy ? "true" : undefined} aria-describedby={p.heldBy}>
        {p.heldBy ? p.heldLabel : "Drag your card photos here"}
      </button>
    );
  },
}));
// ParamLink needs the page's mode provider (and the real store); a plain link
// with the same href stands in.
vi.mock("../mode", () => ({
  ParamLink: ({ search, children, className }: { search: Record<string, string>; children: ReactNode; className?: string }) => (
    <a href={`?${new URLSearchParams(search).toString()}`} className={className}>
      {children}
    </a>
  ),
}));
vi.mock("@/app/print/placeholders/scan-image", () => ({ ScanImage: () => <span>scan</span> }));
vi.mock("../catalog/Cascade", () => ({ default: () => null }));
vi.mock("../catalog/useDrillState", () => ({ useDrillState: () => ({}) }));
vi.mock("../../prototypes/p1/Overlay", () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

let confirm: ReturnType<typeof vi.fn>;
const notify = vi.fn();
const pageApi = { notify, inform: vi.fn() } as unknown as PageApi;

let seq = 0;
/** A fresh run per test: `doneRuns` is module state and would leak between them. */
const freshRunId = () => `intakerun${String(++seq).padStart(8, "0")}`;

const photo = (entryIndex: number) => ({ entryIndex, originalName: `scan-${entryIndex}.jpg`, status: "done" });

function setRun(
  runId: string,
  {
    open = true,
    images = [photo(0)],
    homeKind = "binder",
  }: { open?: boolean; images?: unknown[]; homeKind?: "binder" | "box" } = {},
) {
  mocks.data.run = {
    _id: runId,
    jobId: `job-${runId}`,
    homeId: "home1",
    homeName: homeKind === "box" ? "For sale" : "Binder",
    homeKind,
    lastActivityAt: 0,
  };
  mocks.data.job = { status: open ? "collecting" : "closed" };
  // One read photo that is in no pair sits in the Pairing column: not clear.
  mocks.data.images = images;
  mocks.data.pairs = [];
  mocks.data.matches = [];
}

function Tab({ runId }: { runId: string }) {
  return (
    <MemoryRouter initialEntries={[`/collection/final/intake?run=${runId}`]}>
      <PageApiContext.Provider value={pageApi}>
        <a href="/inventory" onClick={preventNav}>
          Inventory
        </a>
        <RealAddCardsTab />
      </PageApiContext.Provider>
    </MemoryRouter>
  );
}

const pressDone = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Done adding photos" }));
  await act(async () => {});
};
const clickLink = () => fireEvent.click(screen.getByText("Inventory"));
const closeStream = () => mocks.mutation("placeholderStream.closePlaceholderStream");

beforeEach(() => {
  confirm = vi.fn(() => false);
  // happy-dom has no window.confirm: put one in place for each test.
  Object.defineProperty(window, "confirm", { value: confirm, configurable: true, writable: true });
  landed = vi.fn();
  mocks.mutations.clear();
  mocks.guardOptions.length = 0;
  mocks.dropzone.length = 0;
  mocks.data.gate = undefined;
  mocks.data.side = "collection";
  mocks.data.homes = [];
  notify.mockClear();
});
afterEach(() => {
  cleanup();
});
let landed: ReturnType<typeof vi.fn>;
/** On the link itself (after the document-level guard): records whether the guard cancelled the click, then stops the navigation. */
const preventNav = (e: { defaultPrevented: boolean; preventDefault: () => void }) => {
  landed(e.defaultPrevented);
  e.preventDefault();
};

describe("RealAddCardsTab leave guard", () => {
  it("does not ask before Done adding photos is pressed", async () => {
    const runId = freshRunId();
    setRun(runId);
    render(<Tab runId={runId} />);
    await screen.findByRole("button", { name: "Done adding photos" });
    clickLink();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("asks with the leave-intake line when an in-app link is clicked after Done, and Stay keeps the user", async () => {
    const runId = freshRunId();
    setRun(runId);
    render(<Tab runId={runId} />);
    await pressDone();
    expect(closeStream()).toHaveBeenCalledWith({ jobId: `job-${runId}` });
    clickLink();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(LEAVE_INTAKE_LINE);
    // The guard's capture-phase listener ran first and cancelled the click.
    expect(landed).not.toHaveBeenCalledWith(false);
  });

  it("lets the link through when the user answers Leave anyway", async () => {
    const runId = freshRunId();
    setRun(runId);
    confirm.mockReturnValue(true);
    render(<Tab runId={runId} />);
    await pressDone();
    clickLink();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(landed).toHaveBeenCalledWith(false);
  });

  it("disarms the guard when closing the stream is refused", async () => {
    const runId = freshRunId();
    setRun(runId);
    closeStream().mockRejectedValue(new Error("The run could not be closed."));
    render(<Tab runId={runId} />);
    await pressDone();
    await waitFor(() => expect(notify).toHaveBeenCalledWith("The run could not be closed."));
    clickLink();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("disarms the guard once every column but Saved is clear", async () => {
    const runId = freshRunId();
    setRun(runId);
    const { rerender } = render(<Tab runId={runId} />);
    await pressDone();
    clickLink();
    expect(confirm).toHaveBeenCalledTimes(1);

    setRun(runId, { images: [] }); // the photo was paired and saved: nothing left in the columns
    rerender(<Tab runId={runId} />);
    await act(async () => {});
    clickLink();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("still asks after a remount, because the Done memory outlives the component", async () => {
    const runId = freshRunId();
    setRun(runId);
    const first = render(<Tab runId={runId} />);
    await pressDone();
    first.unmount();

    render(<Tab runId={runId} />);
    await screen.findByRole("button", { name: "Done adding photos" });
    clickLink();
    expect(confirm).toHaveBeenCalledWith(LEAVE_INTAKE_LINE);
  });

  it("forgets a Done once the columns clear, so a remount does not ask", async () => {
    const runId = freshRunId();
    setRun(runId);
    const first = render(<Tab runId={runId} />);
    await pressDone();
    setRun(runId, { images: [] });
    first.rerender(<Tab runId={runId} />);
    await act(async () => {});
    first.unmount();

    setRun(runId); // a late photo lands in the same run
    render(<Tab runId={runId} />);
    await screen.findByRole("button", { name: "Done adding photos" });
    clickLink();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not leak one run's Done into another run", async () => {
    const first = freshRunId();
    setRun(first);
    const one = render(<Tab runId={first} />);
    await pressDone();
    one.unmount();

    const second = freshRunId();
    setRun(second);
    render(<Tab runId={second} />);
    await screen.findByRole("button", { name: "Done adding photos" });
    clickLink();
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("RealAddCardsTab parkAfterStay", () => {
  const onStay = () => mocks.guardOptions.at(-1)?.onStay;

  it("hands the guard a Stay handler that focuses Done adding photos when it is drawn", async () => {
    const runId = freshRunId();
    setRun(runId);
    render(<Tab runId={runId} />);
    const done = await screen.findByRole("button", { name: "Done adding photos" });
    expect(done.getAttribute("data-intake-done")).not.toBeNull();

    let parked: boolean | undefined;
    act(() => {
      parked = onStay()?.();
    });
    expect(parked).toBe(true);
    expect(document.activeElement).toBe(done);
  });

  it("falls back to the Pairing column heading when Done is no longer drawn", async () => {
    const runId = freshRunId();
    setRun(runId, { open: false });
    render(<Tab runId={runId} />);
    const heading = await screen.findByRole("heading", { name: "Pairing" });
    expect(screen.queryByRole("button", { name: "Done adding photos" })).toBeNull();

    let parked: boolean | undefined;
    act(() => {
      parked = onStay()?.();
    });
    expect(parked).toBe(true);
    expect(document.activeElement).toBe(heading);
  });
});

/* ------------------------------------------------------------------ */
/* NEO-370 — the listing gate                                          */
/* ------------------------------------------------------------------ */

/** A collector set up for syncing, picking a box that lists, with no common price for the set. */
const HELD: ListingGateView = { syncing: true, applies: true, commonPriceCents: null };

function NewRun() {
  return (
    <MemoryRouter initialEntries={["/inventory?tab=add"]}>
      <PageApiContext.Provider value={pageApi}>
        <RealAddCardsTab />
      </PageApiContext.Provider>
    </MemoryRouter>
  );
}

function newRunIntoBox(gate: ListingGateView | undefined) {
  mocks.data.run = null;
  mocks.data.job = null;
  mocks.data.side = "inventory";
  mocks.data.homes = [{ id: "box1", name: "For sale", kind: "box" }];
  mocks.data.gate = gate;
  return render(<NewRun />);
}

const zone = () => screen.getByRole("button", { name: /drop your photos|Drag your card photos here/ });
const gateLine = intakeGateLine("For sale", { needsPrice: true, needsCondition: false });

describe("RealAddCardsTab listing gate (NEO-370)", () => {
  it("holds the drop zone into a listed box with no price, the reason beside it", () => {
    newRunIntoBox(HELD);
    const note = screen.getByText(gateLine).closest("p");
    expect(gateLine).toBe(
      "Price tag first! For sale sells on your marketplaces, so give these cards a price in Defaults (or pick a set with a common price) before you send photos.",
    );
    const z = zone();
    expect(z.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(z.getAttribute("aria-describedby")!)).toBe(note);
    expect(z.textContent).toBe("Set a price, then drop your photos");
  });

  it("Set a Min price opens Defaults on the Min price field; a price there lifts the hold", async () => {
    newRunIntoBox(HELD);
    fireEvent.click(screen.getByRole("button", { name: "Set a Min price" }));
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    const field = screen.getByRole("textbox", { name: "Min price" });
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(field.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Leave it blank to sell at your common price.",
    );
    fireEvent.change(field, { target: { value: "0.50" } });
    fireEvent.blur(field);
    expect(screen.queryByText(gateLine)).toBeNull();
    expect(zone().getAttribute("aria-disabled")).toBeNull();
    expect(zone().textContent).toBe("Drag your card photos here");
  });

  it("a common price for the set, a box that does not list, or a collector who does not sync: no hold", () => {
    for (const gate of [
      { ...HELD, commonPriceCents: 25 },
      { syncing: true, applies: false, commonPriceCents: null },
      { syncing: false, applies: false, commonPriceCents: null },
    ]) {
      newRunIntoBox(gate);
      expect(screen.queryByText(gateLine)).toBeNull();
      expect(zone().getAttribute("aria-disabled")).toBeNull();
      cleanup();
    }
  });

  it("while the gate loads nothing is held (the server still refuses)", () => {
    newRunIntoBox(undefined);
    expect(zone().getAttribute("aria-disabled")).toBeNull();
  });

  it("a graded run needs no price", () => {
    newRunIntoBox(HELD);
    fireEvent.click(screen.getByRole("button", { name: /^Defaults:/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Graded by" }), { target: { value: "PSA" } });
    expect(zone().getAttribute("aria-disabled")).toBeNull();
  });

  it("a binder run shows no Min price field", () => {
    const runId = freshRunId();
    setRun(runId);
    render(<Tab runId={runId} />);
    fireEvent.click(screen.getByRole("button", { name: /^Defaults:/ }));
    expect(screen.queryByRole("textbox", { name: "Min price" })).toBeNull();
  });

  it("passes axe in light and dark while held, and with Defaults open", async () => {
    const { container, rerender } = newRunIntoBox(HELD);
    await expectAccessibleInBothModes(container, { label: "Intake, held by the listing gate", rerender: () => rerender(<NewRun />) });
    fireEvent.click(screen.getByRole("button", { name: "Set a Min price" }));
    await expectAccessibleInBothModes(container, { label: "Intake, Min price open", rerender: () => rerender(<NewRun />) });
  });
});

describe("RealAddCardsTab \"See what's syncing\" after Done (NEO-370)", () => {
  const link = () => screen.queryByRole("link", { name: SYNC_STATUS_LINK });

  it("appears after Done on a run into a box that syncs, in a live region, to Sync status", async () => {
    const runId = freshRunId();
    setRun(runId, { homeKind: "box" });
    mocks.data.gate = { syncing: true, applies: true, commonPriceCents: 25 };
    render(<Tab runId={runId} />);
    expect(link()).toBeNull();
    await pressDone();
    const a = link();
    expect(a).not.toBeNull();
    expect(a!.closest('[role="status"]')).not.toBeNull();
    expect(a!.getAttribute("href")).toBe("?tab=sync");
  });

  it("is not there after Done when the box does not sync (or for a binder run)", async () => {
    for (const [homeKind, gate] of [
      ["box", { syncing: false, applies: false, commonPriceCents: null }],
      ["box", { syncing: true, applies: false, commonPriceCents: null }],
      ["binder", undefined],
    ] as const) {
      const runId = freshRunId();
      setRun(runId, { homeKind });
      mocks.data.gate = gate;
      render(<Tab runId={runId} />);
      await pressDone();
      expect(link()).toBeNull();
      cleanup();
    }
  });

  it("passes axe in light and dark with the link showing", async () => {
    const runId = freshRunId();
    setRun(runId, { homeKind: "box" });
    mocks.data.gate = { syncing: true, applies: true, commonPriceCents: 25 };
    const { container, rerender } = render(<Tab runId={runId} />);
    await pressDone();
    expect(link()).not.toBeNull();
    await expectAccessibleInBothModes(container, { label: "Intake, after Done", rerender: () => rerender(<Tab runId={runId} />) });
  });
});

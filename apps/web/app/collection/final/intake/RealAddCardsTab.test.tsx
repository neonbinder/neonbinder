/**
 * NEO-370 — the intake tab's leave-guard wiring. After "Done adding photos"
 * the tab arms `useLeaveGuard` until every column but Saved clears; the Done
 * memory (`doneRuns`) outlives a remount; a refused close disarms; a Back
 * answered "Stay" parks focus on Done, else the Pairing heading.
 *
 * The guard itself is the real hook (its own test pins the DOM mechanics);
 * the wrapper below only records the options the tab hands it.
 *
 * Also NEO-370's listing gate on the tab, as NEO-452 reshaped it: photos can be
 * dropped at any time and wait in the browser (`heldIntake`) until the run has
 * a home, a set and, for a box that lists, a price; the warning shows only once
 * a set is picked; "Save as common price" turns the Min price into the
 * collector's own; and "See what's syncing" after Done.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode, type Ref } from "react";
import { MemoryRouter, useLocation, useNavigate, useSearchParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageApiContext, type PageApi } from "../pageApi";
import { DRAWER_PARAM } from "../drawerParams";
import { LEAVE_INTAKE_LINE, PHOTO_NEWS_QUIET_MS } from "./realLanes";
import RealAddCardsTab from "./RealAddCardsTab";
import { intakeGateLine, SYNC_STATUS_LINK } from "../inventory/listing/ListingGate";
import { clearAllHeld, heldIntakeKey, holdFiles, readHeld } from "./heldIntake";
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
      /** What `useContainers` answers; undefined = the shelf is still loading (NEO-416). */
      containers: [] as unknown[] | undefined,
      /** The signed-in user (`useAuth`); the held photos are keyed by it. */
      userId: "u1" as string | null,
      /** The caller's common prices in dollars by variant; undefined = loading. */
      common: {} as Record<string, number> | undefined,
      /** What the Cascade stand-in picks when "Pick it" is pressed. */
      pick: { variantId: "v1", title: "1988 Topps Base" },
      /** The collector's usual condition (Profile → Settings); undefined = none set. */
      usualCondition: "Near Mint" as string | undefined,
    },
    upload: vi.fn(),
    setCommon: vi.fn(),
    undoCommon: vi.fn(),
    /** The undo of the last `run`, to press. */
    undo: { current: null as null | (() => Promise<void>) },
    /** Draw the real drop zone instead of the stand-in (NEO-452 tests drop on it). */
    realZone: { current: false },
    dropzone: [] as {
      disabled: boolean;
      describedBy?: string;
      hint?: string;
      tray?: ReactNode;
      inputRef?: Ref<HTMLInputElement>;
      onFiles: (files: File[]) => void;
    }[],
    guardOptions: [] as { onStay?: () => boolean }[],
  };
});

vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ userId: mocks.data.userId }) }));
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
  useAction: (ref: string) => mocks.mutation(ref),
}));
vi.mock("../data/store", () => ({
  useSide: () => mocks.data.side,
  useContainers: () => mocks.data.containers,
  homesOnSide: () => mocks.data.homes,
  useDefaultCondition: () => mocks.data.usualCondition,
  useListingGate: () => mocks.data.gate,
  useCommonPrices: () => mocks.data.common,
  useCollectionActions: () => ({ setCommonPrice: mocks.setCommon }),
  writeErrorMessage: (e: unknown) => (e instanceof Error ? e.message : "Something went wrong."),
}));
vi.mock("@/src/hooks/useWarmPreprocess", () => ({ useWarmPreprocess: () => undefined }));
vi.mock("@/src/hooks/usePlaceholderUpload", () => ({
  usePlaceholderUpload: () => ({ uploading: false, upload: mocks.upload }),
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
// The real zone has its own test (dropzone.test.tsx). Most tests here record what
// the tab hands it and drop through a stand-in; the NEO-452 tests draw the real
// one (`realZone`), so a drop travels the way a collector's does.
vi.mock("@/app/print/placeholders/dropzone", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/print/placeholders/dropzone")>();
  return {
    Dropzone: (p: Parameters<typeof actual.Dropzone>[0]) => {
      mocks.dropzone.push(p);
      if (mocks.realZone.current) return <actual.Dropzone {...p} />;
      return (
        <div>
          <input
            ref={p.inputRef}
            type="file"
            aria-disabled={p.disabled || undefined}
            aria-describedby={p.describedBy}
            aria-label="Drag your card photos here, or browse your files"
          />
          <span>{p.hint}</span>
          {p.tray}
        </div>
      );
    },
  };
});
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
// The set pick: the real cascade has its own tests. This one reaches a checklist
// whenever "Pick it" is pressed, the way the real one does on its last click.
vi.mock("../catalog/Cascade", () => ({
  default: ({ onReachedChecklist }: { onReachedChecklist: () => boolean }) => (
    <button type="button" onClick={() => onReachedChecklist()}>
      Pick it
    </button>
  ),
}));
vi.mock("../catalog/useDrillState", () => ({
  useDrillState: () => ({
    checklist: { variantId: mocks.data.pick.variantId, name: "Base" },
    checklistTitle: mocks.data.pick.title,
  }),
}));
vi.mock("../../prototypes/p1/Overlay", () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

let confirm: ReturnType<typeof vi.fn>;
const notify = vi.fn();
const openCard = vi.fn();
const pageApi = {
  notify,
  openCard,
  inform: vi.fn(),
  // The real one shows the message and a toast with Undo; here the undo is kept for the test to press.
  run: async (write: () => Promise<{ undo: () => Promise<void> }>) => {
    try {
      const result = await write();
      mocks.undo.current = result.undo;
      return result;
    } catch (error) {
      notify(error instanceof Error ? error.message : "Something went wrong.");
      return null;
    }
  },
} as unknown as PageApi;

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
    variantId = "v1",
  }: { open?: boolean; images?: unknown[]; homeKind?: "binder" | "box"; variantId?: string | null } = {},
) {
  mocks.data.run = {
    _id: runId,
    jobId: `job-${runId}`,
    homeId: "home1",
    homeName: homeKind === "box" ? "For sale" : "Binder",
    homeKind,
    // A run from before NEO-452 may have no set (`variantId: null` here).
    ...(variantId ? { variantId, variantName: "1988 Topps Base" } : {}),
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
  clearAllHeld();
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
  mocks.data.containers = [];
  mocks.data.userId = "u1";
  mocks.data.usualCondition = "Near Mint";
  mocks.data.common = {};
  mocks.data.pick = { variantId: "v1", title: "1988 Topps Base" };
  mocks.realZone.current = false;
  mocks.undo.current = null;
  mocks.upload.mockReset();
  mocks.setCommon.mockReset().mockResolvedValue({ undo: mocks.undoCommon });
  mocks.undoCommon.mockReset().mockResolvedValue(undefined);
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
/* NEO-370, NEO-452 — the listing gate, and photos held until ready    */
/* ------------------------------------------------------------------ */

/** A collector set up for syncing, picking a box that lists, with no common price for the set. */
const HELD: ListingGateView = { syncing: true, applies: true, commonPriceCents: null, variantHasCards: true };
const PRICED: ListingGateView = { ...HELD, commonPriceCents: 25, variantHasCards: true };
const NO_LISTING: ListingGateView = { syncing: true, applies: false, commonPriceCents: null, variantHasCards: true };
const ZONE_NAME = "Drag your card photos here, or browse your files";
const RUN_ID = "intakerun0000000000001";
const TITLE = "1988 Topps Base";

/** The page's search, shown so a test can see whether `?run=` moved. */
function Address() {
  return <output aria-label="Page address">{useLocation().search}</output>;
}

function NewRun() {
  return (
    <MemoryRouter initialEntries={["/inventory?tab=add"]}>
      <PageApiContext.Provider value={pageApi}>
        <RealAddCardsTab />
        <Address />
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

/** The writes a send makes, answering as the server would. */
function armSend() {
  mocks.mutation("placeholderStream.startPlaceholderStream").mockResolvedValue({ started: true, jobId: "j1" });
  mocks.mutation("intakeRuns.createIntakeRun").mockResolvedValue(RUN_ID);
  mocks.upload.mockImplementation((files: File[], opts: { jobId?: string }) =>
    Promise.resolve({ ok: true, jobId: opts.jobId ?? "jz", uploaded: files.length, failed: 0, total: files.length }),
  );
}
const startStream = () => mocks.mutation("placeholderStream.startPlaceholderStream");
const createRun = () => mocks.mutation("intakeRuns.createIntakeRun");
const heldKey = heldIntakeKey("u1", "inventory");
const photoOf = (name: string) => new File(["x"], name, { type: "image/jpeg" });
const zipOf = (name = "pile.zip") => new File(["x"], name, { type: "application/zip" });

const zone = () => screen.getByLabelText(ZONE_NAME) as HTMLInputElement;
const frames = () =>
  act(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
  });
const dropOnZone = async (files: File[]) => {
  await act(async () => {
    fireEvent.drop(zone().closest("label")!, { dataTransfer: { files } });
  });
};
/** Open the Set panel and press the cascade's last click; leaves the frames for the caller. */
const pickNow = async () => {
  fireEvent.click(screen.getByRole("button", { name: /^Set: / }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Pick it" }));
  });
};
const pickSet = async () => {
  await pickNow();
  await frames();
};
const defaultsButton = () => screen.getByRole("button", { name: /^Defaults: / });
const minPrice = () => screen.getByRole("textbox", { name: "Min price" }) as HTMLInputElement;
const noMinPrice = () => screen.queryByRole("textbox", { name: "Min price" });
const commonButton = () => screen.getByRole("button", { name: /common price for / });
const statusTexts = () => screen.getAllByRole("status").map((el) => el.textContent ?? "");
const gateLine = intakeGateLine("For sale", TITLE, { needsPrice: true, needsCondition: false });
const describedByIds = (el: Element) => (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
const addressNow = () => screen.getByRole("status", { name: "Page address" }).textContent;

describe("RealAddCardsTab listing gate (NEO-370, NEO-452)", () => {
  beforeEach(() => {
    mocks.realZone.current = true;
    armSend();
  });

  it("with no set picked there is no price warning, even into a listed box with no price", async () => {
    newRunIntoBox(HELD);
    await frames();
    expect(screen.queryByText(/Price tag first/)).toBeNull();
    expect(noMinPrice()).toBeNull();
    // Defaults still opens by hand; with no set known there is no common price to save into.
    fireEvent.click(defaultsButton());
    expect(minPrice()).toBeTruthy();
    expect(screen.queryByRole("button", { name: /common price/ })).toBeNull();
  });

  it("the drop zone is never held, whatever the gate says", () => {
    for (const gate of [HELD, PRICED, NO_LISTING, undefined]) {
      newRunIntoBox(gate);
      expect(zone().disabled).toBe(false);
      expect(zone().getAttribute("aria-disabled")).toBeNull();
      expect(screen.getByText("Drag your card photos here")).toBeTruthy();
      cleanup();
    }
  });

  it("picking a set with no price shows the note once, in the set's name, and opens Defaults on the Min price", async () => {
    newRunIntoBox(HELD);
    await pickSet();
    expect(gateLine).toBe(
      "Price tag first! For sale sells on your marketplaces and 1988 Topps Base has no price yet. Set one in Defaults and your photos go up.",
    );
    const note = screen.getByText(gateLine).closest("p")!;
    const field = minPrice();
    expect(document.activeElement).toBe(field);
    expect(describedByIds(field)).toContain(note.id);
    expect(document.getElementById(describedByIds(field).at(-1)!)).toBeTruthy();
  });

  it("closing Defaults leaves it closed; a new pick opens it again, once", async () => {
    newRunIntoBox(HELD);
    await pickSet();
    fireEvent.click(defaultsButton());
    await frames();
    expect(noMinPrice()).toBeNull();
    // Nothing reopens it: not time, not the note still showing.
    await frames();
    expect(noMinPrice()).toBeNull();
    expect(screen.getByText(gateLine)).toBeTruthy();

    mocks.data.pick = { variantId: "v2", title: "1989 Topps Base" };
    await pickSet();
    expect(minPrice()).toBeTruthy();
    expect(screen.getByText(intakeGateLine("For sale", "1989 Topps Base", { needsPrice: true, needsCondition: false }))).toBeTruthy();
    fireEvent.click(defaultsButton());
    await frames();
    expect(noMinPrice()).toBeNull();
  });

  it("on an open run the answer comes from the server; focus goes to the Min price only if the collector hasn't moved on", async () => {
    setRun(RUN_ID, { homeKind: "box", variantId: null });
    mocks.data.side = "inventory";
    mocks.data.gate = HELD;
    const view = render(<Tab runId={RUN_ID} />);
    const elsewhere = document.createElement("button");
    elsewhere.textContent = "Elsewhere";
    document.body.append(elsewhere);
    await pickSet();
    // Nothing yet: the run hasn't got the set.
    expect(noMinPrice()).toBeNull();
    elsewhere.focus();
    Object.assign(mocks.data.run as object, { variantId: "v1", variantName: TITLE });
    mocks.data.run = { ...(mocks.data.run as object) };
    view.rerender(<Tab runId={RUN_ID} />);
    await frames();
    expect(minPrice()).toBeTruthy();
    expect(document.activeElement).toBe(elsewhere);
    expect(statusTexts().some((text) => text.includes(gateLine.replace("For sale", "For sale")))).toBe(true);
    elsewhere.remove();
  });

  it("focus does go to the Min price when it is still on the Set button", async () => {
    newRunIntoBox(HELD);
    await pickSet();
    expect(document.activeElement).toBe(minPrice());
    // The warning is read by the field's description, not a second time by the status line.
    expect(statusTexts().some((text) => text.includes(gateLine))).toBe(false);
  });

  it("a home change on a set with no price opens Defaults but never moves focus", async () => {
    mocks.data.homes = [];
    newRunIntoBox(HELD);
    cleanup();
    mocks.data.run = null;
    mocks.data.side = "inventory";
    mocks.data.homes = [
      { id: "box1", name: "For sale", kind: "box" },
      { id: "box2", name: "Show box", kind: "box" },
    ];
    mocks.data.gate = HELD;
    render(<NewRun />);
    await pickSet();
    fireEvent.click(defaultsButton());
    await frames();
    expect(noMinPrice()).toBeNull();
    const home = screen.getByRole("combobox", { name: "Put them in this box" });
    home.focus();
    fireEvent.change(home, { target: { value: "box2" } });
    await frames();
    expect(minPrice()).toBeTruthy();
    expect(document.activeElement).toBe(home);
    expect(statusTexts().some((text) => text.includes("Show box sells on your marketplaces and 1988 Topps Base"))).toBe(true);
  });

  it("Set a Min price in the note opens Defaults on the Min price field, after it was closed", async () => {
    newRunIntoBox(HELD);
    await pickSet();
    fireEvent.click(defaultsButton());
    await frames();
    fireEvent.click(screen.getByRole("button", { name: "Set a Min price" }));
    await frames();
    expect(document.activeElement).toBe(minPrice());
    expect(document.getElementById(describedByIds(minPrice()).at(-1)!)).toBeTruthy();
  });

  it("a Min price lifts the note and the Defaults button says it", async () => {
    newRunIntoBox(HELD);
    await pickSet();
    expect(document.getElementById(describedByIds(minPrice())[0])?.textContent).toBe("Leave it blank to sell at your common price.");
    fireEvent.change(minPrice(), { target: { value: "0.50" } });
    fireEvent.blur(minPrice());
    expect(screen.queryByText(gateLine)).toBeNull();
    expect(defaultsButton().textContent).toBe("Defaults: Near Mint, $0.50");
  });

  it("Min price reads $ and commas, commits on Enter, and shows the cents back", async () => {
    newRunIntoBox(HELD);
    await pickSet();
    const field = minPrice();
    expect(field.getAttribute("type")).toBe("text");
    expect(field.getAttribute("inputmode")).toBe("decimal");
    fireEvent.change(field, { target: { value: "$1,250.5" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field.value).toBe("1250.50");
    expect(screen.queryByText(gateLine)).toBeNull();
  });

  it("a Min price that is not a price keeps the note, marks the field and says how, tied to it", async () => {
    newRunIntoBox(HELD);
    await pickSet();
    const field = minPrice();
    fireEvent.change(field, { target: { value: "a buck" } });
    fireEvent.blur(field);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Type a price like 1.50");
    expect(describedByIds(field)).toContain(alert.id);
    // The typed text stays to fix; nothing was stored, so the note stays.
    expect(field.value).toBe("a buck");
    expect(screen.getByText(gateLine)).toBeTruthy();
    fireEvent.change(field, { target: { value: "2" } });
    fireEvent.blur(field);
    expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(field.value).toBe("2.00");
  });

  it("a common price for the set, a box that does not list, or a collector who does not sync: no note, no auto-open", async () => {
    for (const gate of [PRICED, NO_LISTING, { syncing: false, applies: false, commonPriceCents: null, variantHasCards: true }]) {
      newRunIntoBox(gate);
      await pickSet();
      expect(screen.queryByText(/Price tag first/)).toBeNull();
      expect(noMinPrice()).toBeNull();
      cleanup();
    }
  });

  it("a graded run needs no price", async () => {
    newRunIntoBox(HELD);
    await pickSet();
    fireEvent.change(screen.getByRole("combobox", { name: "Graded by" }), { target: { value: "PSA" } });
    expect(screen.queryByText(gateLine)).toBeNull();
  });

  it("a binder run shows no Min price field", () => {
    const runId = freshRunId();
    setRun(runId);
    render(<Tab runId={runId} />);
    fireEvent.click(screen.getByRole("button", { name: /^Defaults:/ }));
    expect(screen.queryByRole("textbox", { name: "Min price" })).toBeNull();
  });

  it("a binder shelf warns about nothing, opens nothing and offers no common price button", async () => {
    mocks.data.run = null;
    mocks.data.job = null;
    mocks.data.side = "collection";
    mocks.data.homes = [{ id: "bin1", name: "Rookies", kind: "binder" }];
    mocks.data.gate = NO_LISTING;
    render(<NewRun />);
    await pickSet();
    expect(screen.queryByText(/Price tag first/)).toBeNull();
    expect(noMinPrice()).toBeNull();
    fireEvent.click(defaultsButton());
    expect(screen.queryByRole("button", { name: /common price/ })).toBeNull();
  });

  it("passes axe in light and dark: nothing picked, the note with Defaults open, and a pile waiting", async () => {
    const { container, rerender } = newRunIntoBox(HELD);
    await expectAccessibleInBothModes(container, { label: "Intake, nothing picked", rerender: () => rerender(<NewRun />) });
    await pickSet();
    await expectAccessibleInBothModes(container, { label: "Intake, Min price open", rerender: () => rerender(<NewRun />) });
    await dropOnZone([photoOf("a.jpg"), photoOf("b.jpg")]);
    expect(screen.getByText("2 photos waiting on a price.")).toBeTruthy();
    await expectAccessibleInBothModes(container, { label: "Intake, photos waiting on a price", rerender: () => rerender(<NewRun />) });
  });
});

describe("RealAddCardsTab holds dropped photos until the run is ready (NEO-452)", () => {
  beforeEach(() => {
    mocks.realZone.current = true;
    armSend();
  });
  const sent = () => mocks.upload.mock.calls;
  const beforeUnload = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it("with no set, photos wait in the tray: the words, the hint, the description, the unload prompt, nothing sent", async () => {
    newRunIntoBox(HELD);
    await dropOnZone([photoOf("a.jpg"), photoOf("b.jpg")]);
    const line = screen.getByText("2 photos waiting. Pick a set and they're off.");
    expect(screen.getByText(/^JPEG, PNG or one zip\. Drop them whenever\. They wait here until the run is set up/)).toBeTruthy();
    expect(describedByIds(zone())).toContain(line.id);
    expect(screen.getByRole("button", { name: "Remove photos" })).toBeTruthy();
    expect(startStream()).not.toHaveBeenCalled();
    expect(createRun()).not.toHaveBeenCalled();
    expect(sent()).toEqual([]);
    expect(readHeld(heldKey).files).toHaveLength(2);
    expect(beforeUnload()).toBe(true);
  });

  it("picking a set with the price known sends the pile on its own: stream, then run, then upload into that job", async () => {
    newRunIntoBox(PRICED);
    const files = [photoOf("a.jpg"), photoOf("b.jpg")];
    await dropOnZone(files);
    await pickSet();
    await act(async () => {});
    expect(createRun()).toHaveBeenCalledTimes(1);
    expect(createRun()).toHaveBeenCalledWith({
      jobId: "j1",
      homeId: "box1",
      variantId: "v1",
      defaults: { acquiredOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
    });
    expect(sent()).toEqual([[files, { source: "web", jobId: "j1" }]]);
    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];
    expect(order(startStream())).toBeLessThan(order(createRun()));
    expect(order(createRun())).toBeLessThan(order(mocks.upload));
    expect(addressNow()).toBe(`?tab=add&run=${RUN_ID}`);
    expect(readHeld(heldKey).files).toEqual([]);
    expect(beforeUnload()).toBe(false);
    expect(statusTexts().join(" ")).toContain("Sent 2 photos.");
  });

  it("photos dropped after the set is picked and ready go straight up", async () => {
    newRunIntoBox(PRICED);
    await pickSet();
    await dropOnZone([photoOf("a.jpg")]);
    await act(async () => {});
    expect(createRun()).toHaveBeenCalledTimes(1);
    expect(sent()).toHaveLength(1);
  });

  it("a set pick never releases the pile while the gate loads: the price is not known yet", async () => {
    const view = newRunIntoBox(undefined);
    await dropOnZone([photoOf("a.jpg"), photoOf("b.jpg")]);
    await pickSet();
    await act(async () => {});
    expect(screen.getByText("2 photos waiting.")).toBeTruthy();
    expect(startStream()).not.toHaveBeenCalled();
    expect(createRun()).not.toHaveBeenCalled();
    expect(sent()).toEqual([]);
    // The gate answers: no price. Still held, and now it says so, once.
    mocks.data.gate = HELD;
    view.rerender(<NewRun />);
    await frames();
    expect(screen.getByText("2 photos waiting on a price.")).toBeTruthy();
    expect(screen.getByText(gateLine)).toBeTruthy();
    expect(document.activeElement).toBe(minPrice());
    expect(createRun()).not.toHaveBeenCalled();
    // The answer is a price: it goes.
    mocks.data.gate = PRICED;
    view.rerender(<NewRun />);
    await act(async () => {});
    expect(createRun()).toHaveBeenCalledTimes(1);
    expect(sent()).toHaveLength(1);
  });

  it("a Min price typed in Defaults lifts the hold and rides on the run", async () => {
    newRunIntoBox(HELD);
    await dropOnZone([photoOf("a.jpg")]);
    await pickSet();
    fireEvent.change(minPrice(), { target: { value: "1.50" } });
    await act(async () => {
      fireEvent.blur(minPrice());
    });
    await act(async () => {});
    expect(createRun()).toHaveBeenCalledTimes(1);
    expect(createRun().mock.calls[0][0]).toMatchObject({ defaults: { minPriceCents: 150 } });
    expect(sent()).toHaveLength(1);
  });

  it("a missing condition holds the pile, in words about the condition, until one is picked", async () => {
    mocks.data.usualCondition = undefined;
    newRunIntoBox(PRICED);
    await dropOnZone([photoOf("a.jpg")]);
    await pickSet();
    await act(async () => {});
    expect(screen.getByText("1 photo waiting on a condition.")).toBeTruthy();
    expect(screen.getByText(/^Condition first! For sale sells on your marketplaces\. Pick one in Defaults and your photos go up\.$/)).toBeTruthy();
    expect(createRun()).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Defaults:/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Condition" }), { target: { value: "Excellent" } });
    await act(async () => {});
    expect(createRun().mock.calls[0][0]).toMatchObject({ defaults: { condition: "Excellent" } });
    expect(sent()).toHaveLength(1);
  });

  it("a zip uploads first, because it starts its own job, and then starts the run over it", async () => {
    newRunIntoBox(PRICED);
    const zip = zipOf();
    await dropOnZone([zip]);
    await pickSet();
    await act(async () => {});
    expect(startStream()).not.toHaveBeenCalled();
    expect(sent()).toEqual([[[zip], { source: "web" }]]);
    expect(createRun()).toHaveBeenCalledWith(expect.objectContaining({ jobId: "jz", variantId: "v1" }));
    expect(mocks.upload.mock.invocationCallOrder[0]).toBeLessThan(createRun().mock.invocationCallOrder[0]);
    expect(addressNow()).toBe(`?tab=add&run=${RUN_ID}`);
    expect(readHeld(heldKey).files).toEqual([]);
  });

  it("a refused run for a zip cancels the batch it started (there is no stream to close), and the zip waits with the words", async () => {
    createRun().mockRejectedValue(new Error("Pick a set first: cards are matched in it."));
    newRunIntoBox(PRICED);
    await dropOnZone([zipOf()]);
    await pickSet();
    await act(async () => {});
    expect(mocks.mutation("placeholderStream.closePlaceholderStream")).not.toHaveBeenCalled();
    expect(mocks.mutation("placeholderPipeline.cancelPlaceholderBatch")).toHaveBeenCalledWith({ jobId: "jz" });
    expect(screen.getByText("1 zip waiting.")).toBeTruthy();
    expect(statusTexts().join(" ")).toContain("Pick a set first: cards are matched in it.");
  });

  it("a refused run closes the stream it opened, keeps the photos with Try again, and does not loop", async () => {
    createRun().mockRejectedValue(new Error("Nope"));
    newRunIntoBox(PRICED);
    await dropOnZone([photoOf("a.jpg")]);
    await pickSet();
    await act(async () => {});
    expect(mocks.mutation("placeholderStream.closePlaceholderStream")).toHaveBeenCalledWith({ jobId: "j1" });
    expect(sent()).toEqual([]);
    expect(createRun()).toHaveBeenCalledTimes(1);
    expect(statusTexts().join(" ")).toContain("Nope");
    expect(screen.getByText("1 photo waiting.")).toBeTruthy();
    // Time and renders don't retry it.
    await frames();
    await frames();
    expect(createRun()).toHaveBeenCalledTimes(1);
    createRun().mockResolvedValue(RUN_ID);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again: send the waiting photos" }));
    });
    await act(async () => {});
    expect(createRun()).toHaveBeenCalledTimes(2);
    expect(sent()).toHaveLength(1);
    expect(readHeld(heldKey).files).toEqual([]);
  });

  it("a changed setup tries a failed send again by itself; an unchanged one does not", async () => {
    createRun().mockRejectedValueOnce(new Error("Nope"));
    newRunIntoBox(PRICED);
    await dropOnZone([photoOf("a.jpg")]);
    await pickSet();
    await act(async () => {});
    expect(createRun()).toHaveBeenCalledTimes(1);
    fireEvent.click(defaultsButton());
    fireEvent.change(screen.getByRole("combobox", { name: "Condition" }), { target: { value: "Excellent" } });
    await act(async () => {});
    expect(createRun()).toHaveBeenCalledTimes(2);
    expect(createRun().mock.calls[1][0]).toMatchObject({ defaults: { condition: "Excellent" } });
    expect(sent()).toHaveLength(1);
  });

  it("a zip batch is not cancelled when its run starts", async () => {
    newRunIntoBox(PRICED);
    await dropOnZone([zipOf()]);
    await pickSet();
    await act(async () => {});
    expect(mocks.mutation("placeholderPipeline.cancelPlaceholderBatch")).not.toHaveBeenCalled();
  });

  it("editing Cost, Location, Notes or Acquired never fires a failed send again; a condition or a price does", async () => {
    createRun().mockRejectedValue(new Error("Nope"));
    newRunIntoBox(PRICED);
    await dropOnZone([photoOf("a.jpg")]);
    await pickSet();
    await act(async () => {});
    expect(createRun()).toHaveBeenCalledTimes(1);
    fireEvent.click(defaultsButton());
    const edit = async (label: RegExp | string, value: string) => {
      const field = screen.getByLabelText(label) as HTMLInputElement;
      fireEvent.change(field, { target: { value } });
      await act(async () => {
        fireEvent.blur(field);
      });
      await act(async () => {});
    };
    await edit("Cost each", "1.25");
    await edit("Location", "Row 2");
    await edit("Notes", "from a lot");
    await edit("Acquired", "2026-01-02");
    expect(createRun()).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("combobox", { name: "Condition" }), { target: { value: "Excellent" } });
    await act(async () => {});
    expect(createRun()).toHaveBeenCalledTimes(2);
    createRun().mockRejectedValue(new Error("Nope again"));
    await edit("Min price", "2");
    expect(createRun()).toHaveBeenCalledTimes(3);
    // And the edits made meanwhile ride along on the attempt.
    expect(createRun().mock.calls[2][0].defaults).toMatchObject({ costCents: 125, location: "Row 2", notes: "from a lot" });
  });

  it("Try again says it is trying rather than repeating the old failure", async () => {
    createRun().mockRejectedValueOnce(new Error("Nope"));
    newRunIntoBox(PRICED);
    await dropOnZone([photoOf("a.jpg")]);
    await pickSet();
    await act(async () => {});
    expect(statusTexts().join(" ")).toContain("Nope");
    let finish: (id: string) => void = () => {};
    createRun().mockImplementation(() => new Promise<string>((resolve) => (finish = resolve)));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again: send the waiting photos" }));
    });
    expect(statusTexts().join(" ")).not.toContain("Nope");
    expect(statusTexts().join(" ")).toContain("Sending your photos…");
    await act(async () => {
      finish(RUN_ID);
    });
  });

  it("Remove photos says so", async () => {
    newRunIntoBox(HELD);
    await dropOnZone([photoOf("a.jpg")]);
    fireEvent.click(screen.getByRole("button", { name: "Remove photos" }));
    expect(statusTexts().join(" ")).toContain("Photos removed.");
  });

  it("a drop that is ready to go up shows no waiting tray", async () => {
    let finish: (value: unknown) => void = () => {};
    startStream().mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    newRunIntoBox(PRICED);
    await pickSet();
    await dropOnZone([photoOf("a.jpg")]);
    expect(screen.queryByText(/waiting/)).toBeNull();
    await act(async () => {
      finish({ started: true, jobId: "j1" });
    });
  });

  it("files that arrive while photos are going up are not taken, and the collector is told", async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.upload.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    newRunIntoBox(PRICED);
    await dropOnZone([photoOf("a.jpg")]);
    await pickSet();
    await act(async () => {});
    await dropOnZone([photoOf("b.jpg")]);
    expect(statusTexts().join(" ")).toContain("Still sending. Drop the rest in a moment.");
    expect(readHeld(heldKey).files.map((f) => f.name)).toEqual(["a.jpg"]);
    await act(async () => {
      finish({ ok: true, jobId: "j1", uploaded: 1, failed: 0, total: 1 });
    });
  });

  it("a set with no cards holds the pile, says to pick another, offers no price warning, and sends nothing", async () => {
    newRunIntoBox({ ...PRICED, variantHasCards: false });
    await dropOnZone([photoOf("a.jpg")]);
    await pickSet();
    await act(async () => {});
    const words = "That set has no cards to match against yet. Pick another one.";
    expect(screen.getByText(words)).toBeTruthy();
    expect(screen.queryByText(/Price tag first/)).toBeNull();
    expect(noMinPrice()).toBeNull();
    expect(startStream()).not.toHaveBeenCalled();
    expect(readHeld(heldKey).files).toHaveLength(1);
    expect(screen.getByText(`${words.slice(0, -1)}, then get a code.`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use a scanner" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("picking another set after an empty one lets the pile go", async () => {
    const view = newRunIntoBox({ ...PRICED, variantHasCards: false });
    await dropOnZone([photoOf("a.jpg")]);
    await pickSet();
    mocks.data.gate = PRICED;
    view.rerender(<NewRun />);
    await act(async () => {});
    expect(createRun()).toHaveBeenCalledTimes(1);
  });

  it("a failed upload keeps the photos waiting too", async () => {
    mocks.upload.mockResolvedValueOnce({ ok: false, reason: "network down" });
    newRunIntoBox(PRICED);
    await dropOnZone([photoOf("a.jpg")]);
    await pickSet();
    await act(async () => {});
    expect(statusTexts().join(" ")).toContain("Couldn't send these photos: network down.");
    expect(screen.getByText("1 photo waiting.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again: send the waiting photos" })).toBeTruthy();
  });

  it("a second drop adds to the pile", async () => {
    newRunIntoBox(HELD);
    await dropOnZone([photoOf("a.jpg")]);
    await dropOnZone([photoOf("b.jpg")]);
    expect(screen.getByText("2 photos waiting. Pick a set and they're off.")).toBeTruthy();
    expect(readHeld(heldKey).files.map((f) => f.name)).toEqual(["a.jpg", "b.jpg"]);
  });

  it("a drop that makes the pile invalid is refused in words, and the first pile stays", async () => {
    newRunIntoBox(HELD);
    await dropOnZone([photoOf("a.jpg"), photoOf("b.jpg")]);
    await dropOnZone([zipOf()]);
    expect(screen.getByRole("alert").textContent).toMatch(/not both/);
    expect(readHeld(heldKey).files.map((f) => f.name)).toEqual(["a.jpg", "b.jpg"]);
    expect(screen.getByText("2 photos waiting. Pick a set and they're off.")).toBeTruthy();
    // Removing the pile takes the explanation with it.
    fireEvent.click(screen.getByRole("button", { name: "Remove photos" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Remove photos empties the pile, drops the unload prompt and puts focus back on the zone's input", async () => {
    newRunIntoBox(HELD);
    await dropOnZone([photoOf("a.jpg")]);
    fireEvent.click(screen.getByRole("button", { name: "Remove photos" }));
    expect(readHeld(heldKey).files).toEqual([]);
    expect(document.activeElement).toBe(zone());
    expect(screen.queryByText(/waiting/)).toBeNull();
    expect(beforeUnload()).toBe(false);
  });

  it("the same files can be chosen again after Remove (the input forgot them)", async () => {
    newRunIntoBox(HELD);
    const same = photoOf("same.jpg");
    await dropOnZone([same]);
    fireEvent.click(screen.getByRole("button", { name: "Remove photos" }));
    await act(async () => {
      fireEvent.change(zone(), { target: { files: [same] } });
    });
    expect(screen.getByText("1 photo waiting. Pick a set and they're off.")).toBeTruthy();
  });

  it("the pile survives the screen going away and coming back, with the setup it waited on", async () => {
    const first = newRunIntoBox(HELD);
    await dropOnZone([photoOf("a.jpg")]);
    await pickSet();
    fireEvent.change(minPrice(), { target: { value: "" } });
    first.unmount();
    expect(beforeUnload()).toBe(true);

    render(<NewRun />);
    await frames();
    expect(screen.getByText("1 photo waiting on a price.")).toBeTruthy();
    expect(screen.getByRole("button", { name: `Set: ${TITLE}` })).toBeTruthy();
    expect(startStream()).not.toHaveBeenCalled();
  });

  it("another signed-in user never sees it", async () => {
    const first = newRunIntoBox(HELD);
    await dropOnZone([photoOf("a.jpg")]);
    first.unmount();
    mocks.data.userId = "u2";
    render(<NewRun />);
    await frames();
    expect(screen.queryByText(/waiting/)).toBeNull();
    expect(readHeld(heldIntakeKey("u2", "inventory")).files).toEqual([]);
    // And it is still there for the first one.
    expect(readHeld(heldKey).files).toHaveLength(1);
  });

  it("a collection pile and an inventory pile are different piles", async () => {
    const first = newRunIntoBox(HELD);
    await dropOnZone([photoOf("a.jpg")]);
    first.unmount();
    mocks.data.side = "collection";
    mocks.data.homes = [{ id: "bin1", name: "Rookies", kind: "binder" }];
    render(<NewRun />);
    await frames();
    expect(screen.queryByText(/waiting/)).toBeNull();
  });

  it("a screen remounting mid-send doesn't send the same files twice, and the finish still clears the pile", async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.upload.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const first = newRunIntoBox(PRICED);
    await dropOnZone([photoOf("a.jpg")]);
    await pickSet();
    await act(async () => {});
    expect(sent()).toHaveLength(1);
    expect(readHeld(heldKey).sending).toBe(true);
    first.unmount();

    render(<NewRun />);
    await frames();
    await act(async () => {});
    expect(startStream()).toHaveBeenCalledTimes(1);
    expect(createRun()).toHaveBeenCalledTimes(1);
    expect(sent()).toHaveLength(1);
    // The new screen is told not to take more while it runs.
    expect(zone().getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      finish({ ok: true, jobId: "j1", uploaded: 1, failed: 0, total: 1 });
    });
    expect(readHeld(heldKey)).toMatchObject({ files: [], sending: false });
    expect(sent()).toHaveLength(1);
  });

  it("while photos go up, the zone is busy and Done adding photos won't close the stream", async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.upload.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const view = newRunIntoBox(PRICED);
    await dropOnZone([photoOf("a.jpg")]);
    await pickSet();
    await act(async () => {});
    setRun(RUN_ID, { homeKind: "box" });
    (mocks.data.run as { jobId: string; variantId: string }).jobId = "j1";
    (mocks.data.run as { variantId: string }).variantId = "v1";
    view.rerender(<NewRun />);
    await act(async () => {});
    expect(screen.getByText("Sending your photos…", { selector: "span" })).toBeTruthy();
    const done = screen.getByRole("button", { name: "Done adding photos" });
    expect(done.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(done);
    expect(mocks.mutation("placeholderStream.closePlaceholderStream")).not.toHaveBeenCalled();
    await act(async () => {
      finish({ ok: true, jobId: "j1", uploaded: 1, failed: 0, total: 1 });
    });
    expect(screen.getByRole("button", { name: "Done adding photos" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("an open run whose job has closed says to start a new run, with the photos still removable", async () => {
    setRun(RUN_ID, { open: false, homeKind: "box" });
    mocks.data.gate = PRICED;
    mocks.data.side = "inventory";
    holdFiles(heldKey, [photoOf("a.jpg")], { homeId: "home1", variant: { variantId: "v1" as never, title: TITLE }, defaults: {} });
    render(<Tab runId={RUN_ID} />);
    await act(async () => {});
    expect(screen.getByText("1 photo waiting. This run's all in, so start a new run.")).toBeTruthy();
    expect(sent()).toEqual([]);
    expect(screen.getByRole("button", { name: "Remove photos" })).toBeTruthy();
  });

  describe("an old run that has no set", () => {
    const openOldRun = () => {
      setRun(RUN_ID, { homeKind: "box", variantId: null });
      mocks.data.side = "inventory";
      mocks.data.gate = PRICED;
      return render(<Tab runId={RUN_ID} />);
    };

    it("a new drop waits for a set, then goes into the run's job once the run has it", async () => {
      const view = openOldRun();
      await dropOnZone([photoOf("a.jpg")]);
      expect(screen.getByText("1 photo waiting. Pick a set and they're off.")).toBeTruthy();
      expect(sent()).toEqual([]);
      await pickSet();
      const setVariant = mocks.mutation("intakeRuns.setIntakeRunVariant");
      expect(setVariant).toHaveBeenCalledWith({ runId: RUN_ID, variantId: "v1" });
      // The run hasn't got the set yet: still held.
      await act(async () => {});
      expect(sent()).toEqual([]);
      (mocks.data.run as { variantId?: string }).variantId = "v1";
      mocks.data.run = { ...(mocks.data.run as object) };
      view.rerender(<Tab runId={RUN_ID} />);
      await act(async () => {});
      expect(sent()).toEqual([[[expect.any(File)], { source: "web", jobId: `job-${RUN_ID}` }]]);
      expect(createRun()).not.toHaveBeenCalled();
    });

    it("a refused set pick clears the wait: no warning appears later, and the collector is told", async () => {
      mocks.mutation("intakeRuns.setIntakeRunVariant").mockRejectedValue(new Error("That set has no cards to match against yet. Pick another one."));
      mocks.data.gate = HELD;
      setRun(RUN_ID, { homeKind: "box", variantId: null });
      mocks.data.side = "inventory";
      render(<Tab runId={RUN_ID} />);
      await pickSet();
      await act(async () => {});
      expect(notify).toHaveBeenCalledWith("That set has no cards to match against yet. Pick another one.");
      expect(screen.queryByText(/Price tag first/)).toBeNull();
      expect(noMinPrice()).toBeNull();
    });

    it("can still mint its scanner code: an open run needs no set for that", () => {
      openOldRun();
      expect(screen.getByRole("button", { name: "Use a scanner" }).getAttribute("aria-disabled")).not.toBe("true");
      expect(screen.queryByText("Pick a set first, then get a code.")).toBeNull();
    });

    it("an open run that already has its Min price shows no warning on a pick", async () => {
      mocks.data.gate = HELD;
      setRun(RUN_ID, { homeKind: "box", variantId: null });
      (mocks.data.run as { defaults: unknown }).defaults = { minPriceCents: 100 };
      mocks.data.side = "inventory";
      const view = render(<Tab runId={RUN_ID} />);
      await pickSet();
      (mocks.data.run as { variantId?: string }).variantId = "v1";
      mocks.data.run = { ...(mocks.data.run as object) };
      view.rerender(<Tab runId={RUN_ID} />);
      await frames();
      expect(screen.queryByText(/Price tag first/)).toBeNull();
      expect(noMinPrice()).toBeNull();
    });
  });

  it("the scanner waits on the set as the photos do, and says so", async () => {
    newRunIntoBox(PRICED);
    const button = screen.getByRole("button", { name: "Use a scanner" });
    const reason = screen.getByText("Pick a set first, then get a code.");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(describedByIds(button)).toContain(reason.id);
    await pickSet();
    expect(screen.getByRole("button", { name: "Use a scanner" }).getAttribute("aria-disabled")).not.toBe("true");
    expect(screen.queryByText("Pick a set first, then get a code.")).toBeNull();
  });

  it("the scanner waits on a price too", async () => {
    newRunIntoBox(HELD);
    await pickSet();
    expect(screen.getByText("Set a price first, then get a code.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use a scanner" }).getAttribute("aria-disabled")).toBe("true");
  });
});

describe("leaving a run (NEO-452)", () => {
  beforeEach(() => {
    mocks.realZone.current = true;
    armSend();
  });
  const SECOND = "intakerun0000000000002";
  const nav: { go: (to: string) => void } = { go: () => {} };
  function Go() {
    const navigate = useNavigate();
    useEffect(() => {
      nav.go = (to) => navigate(to);
    }, [navigate]);
    return null;
  }
  function At({ initial }: { initial: string }) {
    return (
      <MemoryRouter initialEntries={[initial]}>
        <PageApiContext.Provider value={pageApi}>
          <Go />
          <RealAddCardsTab />
          <Address />
        </PageApiContext.Provider>
      </MemoryRouter>
    );
  }
  const runDoc = (id: string, defaults: object) => {
    setRun(id, { homeKind: "box" });
    Object.assign(mocks.data.run as object, { variantId: "v1", variantName: TITLE, defaults });
  };

  it("New run leaves the last run's Min price behind: Defaults reads blank and the next drop is held on the price again", async () => {
    mocks.data.run = null;
    mocks.data.job = null;
    mocks.data.side = "inventory";
    mocks.data.homes = [{ id: "box1", name: "For sale", kind: "box" }];
    mocks.data.gate = HELD;
    const view = render(<At initial="/inventory?tab=add" />);
    await pickSet();
    fireEvent.change(minPrice(), { target: { value: "1.50" } });
    await act(async () => {
      fireEvent.blur(minPrice());
    });
    await dropOnZone([photoOf("a.jpg")]);
    await act(async () => {});
    expect(createRun().mock.calls[0][0]).toMatchObject({ defaults: { minPriceCents: 150 } });
    // The run loads, carrying the Min it started with.
    runDoc(RUN_ID, { acquiredOn: "x", minPriceCents: 150 });
    mocks.data.job = { status: "collecting" };
    view.rerender(<At initial="/inventory?tab=add" />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "New run" }));
    mocks.data.run = null;
    mocks.data.job = null;
    view.rerender(<At initial="/inventory?tab=add" />);
    await act(async () => {});
    expect(addressNow()).toBe("?tab=add");
    expect(defaultsButton().textContent).toBe("Defaults: Near Mint");
    await dropOnZone([photoOf("b.jpg")]);
    expect(screen.getByText("1 photo waiting on a price.")).toBeTruthy();
    expect(createRun()).toHaveBeenCalledTimes(1);
  });

  it("a handover left over from a run the collector walked away from is not written onto it if it is reopened", async () => {
    mocks.data.run = null;
    mocks.data.job = null;
    mocks.data.side = "inventory";
    mocks.data.homes = [{ id: "box1", name: "For sale", kind: "box" }];
    mocks.data.gate = HELD;
    const view = render(<At initial="/inventory?tab=add" />);
    await pickSet();
    await dropOnZone([photoOf("a.jpg")]);
    fireEvent.change(minPrice(), { target: { value: "1.50" } });
    await act(async () => {
      fireEvent.blur(minPrice());
    });
    await act(async () => {});
    expect(addressNow()).toBe(`?tab=add&run=${RUN_ID}`);
    // The run hasn't loaded; the collector clears the Min in the setup, then leaves and comes back.
    mocks.data.run = undefined;
    view.rerender(<At initial="/inventory?tab=add" />);
    fireEvent.change(minPrice(), { target: { value: "" } });
    fireEvent.blur(minPrice());
    await act(async () => {
      nav.go("/inventory?tab=add");
    });
    expect(addressNow()).toBe("?tab=add");
    await act(async () => {
      nav.go(`/inventory?tab=add&run=${RUN_ID}`);
    });
    runDoc(RUN_ID, { minPriceCents: 150 });
    mocks.data.job = { status: "collecting" };
    view.rerender(<At initial="/inventory?tab=add" />);
    await act(async () => {});
    expect(mocks.mutation("intakeRuns.setIntakeRunDefaults")).not.toHaveBeenCalled();
  });

  it("Undo puts the Min price back on the run it was saved from, not on whichever run is open by then", async () => {
    runDoc(RUN_ID, { condition: "Near Mint", minPriceCents: 150 });
    mocks.data.side = "inventory";
    mocks.data.gate = PRICED;
    const view = render(<At initial={`/inventory?tab=add&run=${RUN_ID}`} />);
    fireEvent.click(defaultsButton());
    await act(async () => {
      fireEvent.click(commonButton());
    });
    const write = mocks.mutation("intakeRuns.setIntakeRunDefaults");
    expect(write.mock.calls.at(-1)![0]).toMatchObject({ runId: RUN_ID });
    // The collector opens a different run.
    runDoc(SECOND, { condition: "Near Mint" });
    nav.go(`/inventory?tab=add&run=${SECOND}`);
    view.rerender(<At initial={`/inventory?tab=add&run=${RUN_ID}`} />);
    await act(async () => {});
    write.mockClear();
    await act(async () => {
      await mocks.undo.current!();
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0].runId).toBe(RUN_ID);
    expect(write.mock.calls[0][0].defaults.minPriceCents).toBe(150);
  });

  it("Done adding photos says why it is held while photos go up", async () => {
    runDoc(RUN_ID, {});
    mocks.data.side = "inventory";
    mocks.data.gate = PRICED;
    mocks.data.job = { status: "collecting" };
    holdFiles(heldKey, [photoOf("a.jpg")], { homeId: "home1", variant: { variantId: "v1" as never, title: TITLE }, defaults: {} });
    mocks.upload.mockImplementation(() => new Promise(() => {}));
    render(<At initial={`/inventory?tab=add&run=${RUN_ID}`} />);
    await act(async () => {});
    const done = screen.getByRole("button", { name: "Done adding photos" });
    expect(done.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(done.getAttribute("aria-describedby")!)?.textContent).toBe("Photos are still going up.");
  });
});

describe("RealAddCardsTab Save as common price (NEO-452)", () => {
  beforeEach(() => {
    mocks.realZone.current = true;
    armSend();
  });
  const press = async () => {
    await act(async () => {
      fireEvent.click(commonButton());
    });
  };
  const open = async (gate: ListingGateView = HELD) => {
    const view = newRunIntoBox(gate);
    await pickSet();
    if (!noMinPrice()) fireEvent.click(defaultsButton());
    return view;
  };
  const type = (text: string) => fireEvent.change(minPrice(), { target: { value: text } });

  it("sits right after the Min price field, named for the set, blank is a Tab stop that does nothing", async () => {
    await open();
    const button = commonButton();
    expect(button.getAttribute("aria-label")).toBe(`Save as common price for ${TITLE}`);
    expect(button.textContent).toBe("Save as common price");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.compareDocumentPosition(minPrice()) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    fireEvent.click(button);
    await act(async () => {});
    expect(mocks.setCommon).not.toHaveBeenCalled();
    expect(button.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(describedByIds(button).at(-1)!)?.textContent).toBe(
      `Cards from ${TITLE} with no price of their own sell at it. That includes any you've already listed, so those change too.`,
    );
  });

  it("the help line drops the second clause when the collector doesn't sync", async () => {
    await open({ syncing: false, applies: false, commonPriceCents: null, variantHasCards: true });
    fireEvent.click(defaultsButton());
    fireEvent.click(defaultsButton());
    expect(document.getElementById(describedByIds(commonButton()).at(-1)!)?.textContent).toBe(
      `Cards from ${TITLE} with no price of their own sell at it.`,
    );
  });

  it("each disabled reason is there for a screen reader: nothing typed, not a price, still checking", async () => {
    await open();
    const reason = () => document.getElementById(describedByIds(commonButton())[0])?.textContent;
    expect(reason()).toBe("Type a Min price first.");
    type("a buck");
    expect(reason()).toBe("Fix the Min price first.");
    type("1.50");
    // Usable: the first description is the help line itself.
    expect(describedByIds(commonButton())).toHaveLength(1);
  });

  it("while the common prices load the reason says so", async () => {
    mocks.data.common = undefined;
    await open();
    type("1.50");
    expect(document.getElementById(describedByIds(commonButton())[0])?.textContent).toBe("Checking your common price…");
  });

  it("replace is named only with a price typed: blank, or just after a save, reads Save as common price", async () => {
    mocks.data.common = { v1: 0.25 };
    await open();
    expect(commonButton().textContent).toBe("Save as common price");
    type("1.50");
    expect(commonButton().textContent).toBe("Replace $0.25 common price");
    await press();
    expect(commonButton().textContent).toBe("Save as common price");
  });

  it("text that is not a price is a no-op too", async () => {
    await open();
    type("a buck");
    expect(commonButton().getAttribute("aria-disabled")).toBe("true");
    await press();
    expect(mocks.setCommon).not.toHaveBeenCalled();
  });

  it("while the caller's common prices load it does nothing", async () => {
    mocks.data.common = undefined;
    await open();
    type("1.50");
    expect(commonButton().getAttribute("aria-disabled")).toBe("true");
    await press();
    expect(mocks.setCommon).not.toHaveBeenCalled();
  });

  it("saves the typed price (not yet committed) as the common price, then clears the Min price", async () => {
    await open();
    type("1.50");
    expect(commonButton().getAttribute("aria-disabled")).not.toBe("true");
    await press();
    expect(mocks.setCommon).toHaveBeenCalledWith("v1", 1.5);
    expect(minPrice().value).toBe("");
    expect(defaultsButton().textContent).toBe("Defaults: Near Mint");
    expect(mocks.undo.current).toBeTruthy();
  });

  it("zero is a price", async () => {
    await open();
    type("0");
    expect(commonButton().getAttribute("aria-disabled")).not.toBe("true");
    await press();
    expect(mocks.setCommon).toHaveBeenCalledWith("v1", 0);
  });

  it("a different common price is replaced in the label, with no dialog; the same price is just saved", async () => {
    mocks.data.common = { v1: 0.25 };
    await open();
    type("1.50");
    expect(commonButton().textContent).toBe("Replace $0.25 common price");
    expect(commonButton().getAttribute("aria-label")).toBe(`Replace $0.25 common price for ${TITLE}`);
    type("0.25");
    expect(commonButton().textContent).toBe("Save as common price");
    type("1.50");
    await press();
    expect(mocks.setCommon).toHaveBeenCalledWith("v1", 1.5);
  });

  it("the Min price is cleared on the run once saved, never kept as each copy's own floor", async () => {
    setRun(RUN_ID, { homeKind: "box" });
    (mocks.data.run as { variantId: string; variantName: string; defaults: object }).variantId = "v1";
    (mocks.data.run as { variantName: string }).variantName = TITLE;
    (mocks.data.run as { defaults: object }).defaults = { condition: "Near Mint", minPriceCents: 150 };
    mocks.data.side = "inventory";
    mocks.data.gate = PRICED;
    render(<Tab runId={RUN_ID} />);
    fireEvent.click(defaultsButton());
    expect(minPrice().value).toBe("1.50");
    await press();
    const write = mocks.mutation("intakeRuns.setIntakeRunDefaults");
    expect(mocks.setCommon).toHaveBeenCalledWith("v1", 1.5);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0].runId).toBe(RUN_ID);
    expect(write.mock.calls[0][0].defaults.minPriceCents).toBeUndefined();
    // Common price first, then the clear: the hold never flashes back.
    expect(mocks.setCommon.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
  });

  it("Undo puts the Min price back, then the previous common price, then redraws the field", async () => {
    mocks.data.common = { v1: 0.25 };
    await open();
    type("1.50");
    await press();
    expect(minPrice().value).toBe("");
    await act(async () => {
      await mocks.undo.current!();
    });
    expect(mocks.undoCommon).toHaveBeenCalledTimes(1);
    expect(minPrice().value).toBe("1.50");
    expect(defaultsButton().textContent).toBe("Defaults: Near Mint, $1.50");
  });

  it("Undo on an open run writes the Min price back before it restores the common price", async () => {
    setRun(RUN_ID, { homeKind: "box" });
    Object.assign(mocks.data.run as object, { variantId: "v1", variantName: TITLE, defaults: { minPriceCents: 150 } });
    mocks.data.side = "inventory";
    mocks.data.gate = PRICED;
    render(<Tab runId={RUN_ID} />);
    fireEvent.click(defaultsButton());
    await press();
    const write = mocks.mutation("intakeRuns.setIntakeRunDefaults");
    await act(async () => {
      await mocks.undo.current!();
    });
    expect(write.mock.calls.at(-1)![0].defaults.minPriceCents).toBe(150);
    expect(write.mock.invocationCallOrder.at(-1)!).toBeLessThan(mocks.undoCommon.mock.invocationCallOrder[0]);
  });

  it("pressing it twice quickly saves once", async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.setCommon.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await open();
    type("1.50");
    fireEvent.click(commonButton());
    fireEvent.click(commonButton());
    expect(mocks.setCommon).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ undo: mocks.undoCommon });
    });
  });

  it("a refused save leaves the Min price where it was", async () => {
    mocks.setCommon.mockRejectedValue(new Error("Common price must be zero or more."));
    await open();
    type("1.50");
    await act(async () => {
      fireEvent.click(commonButton());
    });
    expect(minPrice().value).toBe("1.50");
    expect(notify).toHaveBeenCalledWith("Common price must be zero or more.");
  });

  it("a mouse press during the creation window ends with a run that has no Min price", async () => {
    // mousedown blurs the field: the price commits, the hold lifts and the send starts, before the click lands.
    const view = newRunIntoBox(HELD);
    await pickSet();
    await dropOnZone([photoOf("a.jpg")]);
    type("1.50");
    await act(async () => {
      fireEvent.blur(minPrice());
    });
    await act(async () => {});
    expect(createRun()).toHaveBeenCalledTimes(1);
    expect(createRun().mock.calls[0][0]).toMatchObject({ defaults: { minPriceCents: 150 } });
    expect(addressNow()).toBe(`?tab=add&run=${RUN_ID}`);
    // The run hasn't loaded yet: the click lands on the setup.
    mocks.data.run = undefined;
    view.rerender(<NewRun />);
    await press();
    expect(mocks.setCommon).toHaveBeenCalledWith("v1", 1.5);
    expect(minPrice().value).toBe("");
    const write = mocks.mutation("intakeRuns.setIntakeRunDefaults");
    expect(write).not.toHaveBeenCalled();
    // The run's first load: what moved since `createRun` is written across, once.
    setRun(RUN_ID, { homeKind: "box" });
    Object.assign(mocks.data.run as object, { jobId: "j1", variantId: "v1", variantName: TITLE, defaults: { minPriceCents: 150 } });
    mocks.data.common = { v1: 1.5 };
    mocks.data.gate = { ...HELD, commonPriceCents: 150, variantHasCards: true };
    view.rerender(<NewRun />);
    await act(async () => {});
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatchObject({ runId: RUN_ID });
    expect(write.mock.calls[0][0].defaults.minPriceCents).toBeUndefined();
    // And not again on the next render.
    view.rerender(<NewRun />);
    await act(async () => {});
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("a set or home that moved during the creation window is written across too", async () => {
    const view = newRunIntoBox(PRICED);
    await dropOnZone([photoOf("a.jpg")]);
    await pickSet();
    await act(async () => {});
    expect(createRun().mock.calls[0][0]).toMatchObject({ variantId: "v1" });
    mocks.data.run = undefined;
    view.rerender(<NewRun />);
    mocks.data.pick = { variantId: "v2", title: "1989 Topps Base" };
    await pickSet();
    setRun(RUN_ID, { homeKind: "box" });
    Object.assign(mocks.data.run as object, { jobId: "j1", variantId: "v1", variantName: TITLE });
    view.rerender(<NewRun />);
    await act(async () => {});
    expect(mocks.mutation("intakeRuns.setIntakeRunVariant")).toHaveBeenCalledWith({ runId: RUN_ID, variantId: "v2" });
  });

  it("with nothing moved the first load writes nothing across", async () => {
    const view = newRunIntoBox(PRICED);
    await dropOnZone([photoOf("a.jpg")]);
    await pickSet();
    await act(async () => {});
    setRun(RUN_ID, { homeKind: "box" });
    Object.assign(mocks.data.run as object, { jobId: "j1", variantId: "v1", variantName: TITLE });
    view.rerender(<NewRun />);
    await act(async () => {});
    for (const name of ["setIntakeRunDefaults", "setIntakeRunVariant", "setIntakeRunHome"]) {
      expect(mocks.mutation(`intakeRuns.${name}`)).not.toHaveBeenCalled();
    }
  });

  it("passes axe in light and dark with the button, and while it replaces a price", async () => {
    mocks.data.common = { v1: 0.25 };
    const { container, rerender } = await open();
    await expectAccessibleInBothModes(container, { label: "Intake, common price button blank", rerender: () => rerender(<NewRun />) });
    type("1.50");
    await expectAccessibleInBothModes(container, { label: "Intake, Replace common price", rerender: () => rerender(<NewRun />) });
  });
});

describe("RealAddCardsTab \"See what's syncing\" after Done (NEO-370)", () => {
  const link = () => screen.queryByRole("link", { name: SYNC_STATUS_LINK });

  it("appears after Done on a run into a box that syncs, in a live region, to Sync status", async () => {
    const runId = freshRunId();
    setRun(runId, { homeKind: "box" });
    mocks.data.gate = { syncing: true, applies: true, commonPriceCents: 25, variantHasCards: true };
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
      ["box", { syncing: false, applies: false, commonPriceCents: null, variantHasCards: true }],
      ["box", { syncing: true, applies: false, commonPriceCents: null, variantHasCards: true }],
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
    mocks.data.gate = { syncing: true, applies: true, commonPriceCents: 25, variantHasCards: true };
    const { container, rerender } = render(<Tab runId={runId} />);
    await pressDone();
    expect(link()).not.toBeNull();
    await expectAccessibleInBothModes(container, { label: "Intake, after Done", rerender: () => rerender(<Tab runId={runId} />) });
  });
});

describe("NEO-427: a Saved tile says where its photos are", () => {
  const CARD = "#47 Le'Veon Bell";
  const CAN_RETRY = { photos: "failed", photoFailure: "error", photoCanRetry: true };
  const saved = (extra: Record<string, unknown>) => ({
    _id: "match1",
    pairId: "pair1",
    frontIndex: 0,
    backIndex: 1,
    cardId: "card1",
    card: { _id: "card1", cardNumber: "47", cardName: "Le'Veon Bell" },
    candidates: [],
    variations: [],
    band: "matched",
    reason: "numberAndPlayer",
    confidence: 97,
    haveHere: 1,
    savedCopyId: "copy1",
    savedQuantity: 1,
    savedAt: 5,
    ...extra,
  });
  const show = (extra: Record<string, unknown>) => {
    const runId = freshRunId();
    setRun(runId, { images: [] });
    mocks.data.matches = [saved(extra)];
    return { runId, ...render(<Tab runId={runId} />) };
  };
  const retryPhotos = () => mocks.mutation("intakePhotos.retryIntakePhotos");
  beforeEach(() => {
    openCard.mockClear();
    retryPhotos().mockClear();
  });

  it("says nothing extra for a pair saved before photos came along", async () => {
    show({});
    await screen.findByText("Saved +1");
    expect(screen.queryByText("Photos are in!")).toBeNull();
    expect(screen.queryByRole("button", { name: /photos for|Add a photo/ })).toBeNull();
  });

  it("while they're on their way, then once they're in, with no control to press", async () => {
    show({ photos: "pending" });
    await screen.findByText("Slipping in the photos…");
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
    cleanup();
    show({ photos: "attached" });
    await screen.findByText("Photos are in!");
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
  });

  it("didn't stick: Try again sends the row back, once, and focus stays on the tile", async () => {
    const { rerender, runId } = show(CAN_RETRY);
    await screen.findByText("Photos didn't stick.");
    const again = screen.getByRole("button", { name: `Try again: photos for ${CARD}` });
    again.focus();
    fireEvent.click(again);
    fireEvent.click(again);
    expect(retryPhotos()).toHaveBeenCalledTimes(1);
    expect(retryPhotos()).toHaveBeenCalledWith({ matchId: "match1" });
    mocks.data.matches = [saved({ photos: "pending" })];
    rerender(<Tab runId={runId} />);
    const line = await screen.findByText("Slipping in the photos…");
    await waitFor(() => expect(document.activeElement).toBe(line));
  });

  it("didn't stick: a refused Try again says why, and can be pressed again", async () => {
    retryPhotos().mockImplementationOnce(() => Promise.reject(new Error("That card left your collection.")));
    show(CAN_RETRY);
    const again = await screen.findByRole("button", { name: `Try again: photos for ${CARD}` });
    fireEvent.click(again);
    await waitFor(() => expect(notify).toHaveBeenCalledWith("That card left your collection."));
    fireEvent.click(again);
    expect(retryPhotos()).toHaveBeenCalledTimes(2);
  });

  it("the scans aged out: no Try again, Add a photo opens that copy's form on the card", async () => {
    show({ photos: "failed", photoFailure: "scanGone" });
    await screen.findByText("The scans aged out.");
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: `Add a photo to ${CARD}` }));
    expect(openCard).toHaveBeenCalledWith("card1", { copyId: "copy1", edit: true });
  });

  it("unusable scans, or none of the tries left: no Try again, a photo instead", async () => {
    const { rerender, runId } = show({ photos: "failed", photoFailure: "unusable" });
    await screen.findByText("These scans won't cut it.");
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
    screen.getByRole("button", { name: `Add a photo to ${CARD}` });
    mocks.data.matches = [saved({ photos: "failed", photoFailure: "error", photoCanRetry: false })];
    rerender(<Tab runId={runId} />);
    await screen.findByText("Photos didn't stick.");
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
    screen.getByRole("button", { name: `Add a photo to ${CARD}` });
  });

  it("Try again reads as busy while it's in flight, without leaving the tab order", async () => {
    let answer = () => {};
    retryPhotos().mockImplementationOnce(() => new Promise<void>((resolve) => (answer = resolve)));
    show(CAN_RETRY);
    const again = await screen.findByRole("button", { name: `Try again: photos for ${CARD}` });
    expect(again.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(again);
    expect(again.getAttribute("aria-disabled")).toBe("true");
    expect((again as HTMLButtonElement).disabled).toBe(false);
    answer();
    await waitFor(() => expect(again.getAttribute("aria-disabled")).toBeNull());
  });

  it("Try again leaves focus alone once the collector has moved on", async () => {
    const { rerender, runId } = show(CAN_RETRY);
    const again = await screen.findByRole("button", { name: `Try again: photos for ${CARD}` });
    fireEvent.click(again);
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    mocks.data.matches = [saved({ photos: "pending" })];
    rerender(<Tab runId={runId} />);
    await screen.findByText("Slipping in the photos…");
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("Add a photo: when the drawer's photo took the button away, closing lands on the line", async () => {
    // A stand-in for the drawer: the URL carries it, as it does in the app.
    function Drawer() {
      const [, setParams] = useSearchParams();
      const set = (open: boolean) =>
        setParams((prev) => {
          const next = new URLSearchParams(prev);
          if (open) next.set(DRAWER_PARAM, "card1");
          else next.delete(DRAWER_PARAM);
          return next;
        });
      return (
        <>
          <button type="button" onClick={() => set(true)}>
            Open the drawer
          </button>
          <button type="button" onClick={() => set(false)}>
            Close the drawer
          </button>
        </>
      );
    }
    const runId = freshRunId();
    setRun(runId, { images: [] });
    mocks.data.matches = [saved({ photos: "failed", photoFailure: "scanGone" })];
    const tree = () => (
      <MemoryRouter initialEntries={[`/collection/final/intake?run=${runId}`]}>
        <PageApiContext.Provider value={pageApi}>
          <Drawer />
          <RealAddCardsTab />
        </PageApiContext.Provider>
      </MemoryRouter>
    );
    const { rerender } = render(tree());
    const add = await screen.findByRole("button", { name: `Add a photo to ${CARD}` });
    add.focus();
    fireEvent.click(add);
    fireEvent.click(screen.getByRole("button", { name: "Open the drawer" }));
    mocks.data.matches = [saved({ photos: "attached" })];
    rerender(tree());
    await screen.findByText("Photos are in!");
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(screen.getByRole("button", { name: "Close the drawer" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText("Photos are in!")));
  });

  describe("what the run's live line says", () => {
    const row = (i: number, extra: Record<string, unknown>) =>
      saved({
        _id: `match${i}`,
        pairId: `pair${i}`,
        card: { _id: `card${i}`, cardNumber: String(i), cardName: "Le'Veon Bell" },
        ...extra,
      });
    const news = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('[role="status"]'))
        .map((n) => n.textContent ?? "")
        .filter((text) => /Photos|scans/.test(text));
    afterEach(() => vi.useRealTimers());
    const flush = async () => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    };
    const opened = async (rows: unknown[]) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const shown = show({});
      mocks.data.matches = rows;
      shown.rerender(<Tab runId={shown.runId} />);
      await flush();
      const heard: string[] = [];
      return {
        ...shown,
        heard,
        to: async (next: unknown[], waitMs = 0) => {
          mocks.data.matches = next;
          shown.rerender(<Tab runId={shown.runId} />);
          await flush();
          await act(async () => {
            await vi.advanceTimersByTimeAsync(waitMs);
          });
          const said = news(shown.container)[0];
          if (said !== undefined && said !== heard[heard.length - 1]) heard.push(said);
        },
      };
    };

    it("ten cards landing one by one come out as one line", async () => {
      const rows = Array.from({ length: 10 }, (_, i) => row(i, { photos: "pending" }));
      const run = await opened(rows);
      for (let i = 0; i < 10; i++) {
        rows[i] = row(i, { photos: "attached" });
        await run.to([...rows], 100);
      }
      expect(run.heard.map((line) => line.trim())).toEqual(["Photos are in for 10 cards."]);
    });

    it("stragglers past a quiet spell get a second line, never one each", async () => {
      const rows = Array.from({ length: 10 }, (_, i) => row(i, { photos: "pending" }));
      const run = await opened(rows);
      for (let i = 0; i < 10; i++) {
        rows[i] = row(i, { photos: "attached" });
        await run.to([...rows], i === 4 ? PHOTO_NEWS_QUIET_MS : 100);
      }
      expect(run.heard.map((line) => line.trim())).toEqual(["Photos are in for 5 cards.", "Photos are in for 5 cards."]);
    });

    it("a steady stream of good news can't hold back a failure", async () => {
      const rows = Array.from({ length: 30 }, (_, i) => row(i, { photos: "pending" }));
      const run = await opened(rows);
      rows[0] = row(0, CAN_RETRY);
      await run.to([...rows], 100);
      for (let i = 1; i <= 20 && run.heard.length === 0; i++) {
        rows[i] = row(i, { photos: "attached" });
        await run.to([...rows], 100);
      }
      expect(run.heard).toHaveLength(1);
      expect(run.heard[0]).toContain("Photos didn't stick on #0 Le'Veon Bell.");
    });

    it("fail, Try again, fail again is said both times", async () => {
      const run = await opened([row(0, CAN_RETRY)]);
      expect(run.heard).toEqual([]);
      await run.to([row(0, { photos: "pending" })]);
      await run.to([row(0, CAN_RETRY)]);
      await run.to([row(0, { photos: "pending" })]);
      await run.to([row(0, CAN_RETRY)]);
      const line = "Photos didn't stick on #0 Le'Veon Bell. Try again from its tile in Saved.";
      expect(run.heard).toHaveLength(2);
      expect(run.heard.map((said) => said.trim())).toEqual([line, line]);
      expect(run.heard[0]).not.toBe(run.heard[1]);
    });

    it("two identical batches are each said", async () => {
      const pending = [row(0, { photos: "pending" }), row(1, { photos: "pending" })];
      const run = await opened(pending);
      const landed = [row(0, { photos: "attached" }), row(1, { photos: "attached" })];
      await run.to(landed);
      await run.to(pending);
      await run.to(landed);
      expect(run.heard.map((said) => said.trim())).toEqual(["Photos are in for 2 cards.", "Photos are in for 2 cards."]);
    });
  });

  it("speaks a change once, and not what was already so when the run opened", async () => {
    const { rerender, runId, container } = show({ photos: "attached" });
    await screen.findByText("Photos are in!");
    const said = () => Array.from(container.querySelectorAll('[role="status"]')).map((n) => n.textContent);
    expect(said().join(" ")).not.toContain("Photos are in for");
    mocks.data.matches = [saved(CAN_RETRY)];
    rerender(<Tab runId={runId} />);
    await waitFor(() =>
      expect(said()).toContain(`Photos didn't stick on ${CARD}. Try again from its tile in Saved.`),
    );
  });

  it("every state passes axe, light and dark", async () => {
    const states: Array<{ photos: string; photoFailure?: string; photoCanRetry?: boolean }> = [
      { photos: "pending" },
      { photos: "attached" },
      CAN_RETRY,
      { photos: "failed", photoFailure: "error", photoCanRetry: false },
      { photos: "failed", photoFailure: "scanGone" },
      { photos: "failed", photoFailure: "unusable" },
    ];
    for (const state of states) {
      const { container, rerender, runId } = show(state);
      await screen.findByText("Saved +1");
      await expectAccessibleInBothModes(container, {
        label: `Saved tile, ${state.photos} ${state.photoFailure ?? ""} ${state.photoCanRetry ?? ""}`,
        rerender: () => rerender(<Tab runId={runId} />),
      });
      cleanup();
    }
  });
});

/* ------------------------------------------------------------------ */
/* NEO-416 — loading is not "nothing there"                            */
/* ------------------------------------------------------------------ */

describe("RealAddCardsTab while the shelf or the open run loads (NEO-416)", () => {
  /** The page's search, shown so a test can see whether `?run=` moved. */
  function Url() {
    return <output aria-label="Page address">{useLocation().search}</output>;
  }
  function Loading({ initial }: { initial: string }) {
    return (
      <MemoryRouter initialEntries={[initial]}>
        <PageApiContext.Provider value={pageApi}>
          <RealAddCardsTab />
          <Url />
        </PageApiContext.Provider>
      </MemoryRouter>
    );
  }
  const scanner = () => screen.getByRole("button", { name: "Use a scanner" });
  const photoFile = (name = "front.jpg") => new File(["x"], name, { type: "image/jpeg" });
  const drop = async (files = [photoFile()]) => {
    await act(async () => mocks.dropzone.at(-1)!.onFiles(files));
  };
  /** The collector picks a set; with no shelf yet, the pick waits with the pile. */
  const pickSetNow = async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Set: / }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pick it" }));
    });
  };
  const start = () => mocks.mutation("placeholderStream.startPlaceholderStream");
  const create = () => mocks.mutation("intakeRuns.createIntakeRun");
  const MAKE_ONE = "Make a binder first: the cards need somewhere to go.";

  beforeEach(() => {
    // Loaded, and nothing to hold (a binder shelf): the loading under test is the shelf's and the run's.
    mocks.data.gate = NO_LISTING;
    // The writes a second run would make, answering as the server would.
    start().mockResolvedValue({ started: true, jobId: "job-second" });
    create().mockResolvedValue("intakerunsecond00001");
    mocks.upload.mockImplementation((files: File[], { jobId }: { jobId?: string }) =>
      Promise.resolve({ ok: true, jobId: jobId ?? "job-fresh", uploaded: files.length, failed: 0, total: files.length }),
    );
    mocks.data.homes = [{ id: "home1", name: "Binder", kind: "binder" }];
  });

  it("on ?run= with the run still loading, Use a scanner starts no second run and keeps the URL", async () => {
    const runId = freshRunId();
    mocks.data.run = undefined;
    mocks.data.job = undefined;
    const initial = `/collection/final/intake?run=${runId}`;
    const { container, rerender } = render(<Loading initial={initial} />);
    await expectAccessibleInBothModes(container, {
      label: "Intake, while the open run loads",
      rerender: () => rerender(<Loading initial={initial} />),
    });
    fireEvent.click(scanner());
    await act(async () => {});
    expect(start()).not.toHaveBeenCalled();
    expect(create()).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "Page address" }).textContent).toBe(`?run=${runId}`);
    expect(scanner().getAttribute("aria-disabled")).toBe("true");
  });

  it("on ?run= with the run still loading, a photo drop waits, then goes into the open run's job", async () => {
    const runId = freshRunId();
    mocks.data.run = undefined;
    mocks.data.job = undefined;
    const initial = `/collection/final/intake?run=${runId}`;
    const { rerender } = render(<Loading initial={initial} />);
    const files = [photoFile()];
    await drop(files);
    expect(mocks.upload).not.toHaveBeenCalled();
    // The run arrives.
    setRun(runId);
    rerender(<Loading initial={initial} />);
    await act(async () => {});
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.upload).toHaveBeenCalledWith(files, { source: "web", jobId: `job-${runId}` });
    expect(create()).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "Page address" }).textContent).toBe(`?run=${runId}`);
  });

  it("while the shelf loads, Use a scanner does nothing and says nothing", async () => {
    mocks.data.run = null;
    mocks.data.job = null;
    mocks.data.containers = undefined;
    mocks.data.homes = [];
    render(<Loading initial="/collection/final/intake" />);
    fireEvent.click(scanner());
    await act(async () => {});
    expect(screen.queryAllByText(MAKE_ONE)).toEqual([]);
    expect(start()).not.toHaveBeenCalled();
  });

  it("drops while the shelf loads pile up, and go together into the binder the shelf answers", async () => {
    mocks.data.run = null;
    mocks.data.job = null;
    mocks.data.containers = undefined;
    mocks.data.homes = [];
    const { rerender } = render(<Loading initial="/collection/final/intake" />);
    const first = [photoFile("first.jpg")];
    const second = [photoFile("second.jpg"), photoFile("second-back.jpg")];
    await drop(first);
    await drop(second);
    await pickSetNow();
    await act(async () => {});
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(screen.queryAllByText(MAKE_ONE)).toEqual([]);
    // The shelf arrives, with a binder on it.
    mocks.data.containers = [];
    mocks.data.homes = [{ id: "home1", name: "Binder", kind: "binder" }];
    rerender(<Loading initial="/collection/final/intake" />);
    await act(async () => {});
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.upload).toHaveBeenCalledWith([...first, ...second], { source: "web", jobId: "job-second" });
    expect(create()).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-second", homeId: "home1", variantId: "v1" }));
    expect(screen.queryAllByText(MAKE_ONE)).toEqual([]);
  });

  it("a drop while the shelf loads, onto a shelf that loads empty, then says to make a binder", async () => {
    mocks.data.run = null;
    mocks.data.job = null;
    mocks.data.containers = undefined;
    mocks.data.homes = [];
    const { rerender } = render(<Loading initial="/collection/final/intake" />);
    await drop();
    expect(screen.queryAllByText(MAKE_ONE)).toEqual([]);
    mocks.data.containers = [];
    rerender(<Loading initial="/collection/final/intake" />);
    await act(async () => {});
    expect(screen.getByText(MAKE_ONE, { selector: '[role="status"]' })).toBeTruthy();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("once the shelf is loaded and empty, both still say to make a binder", async () => {
    mocks.data.run = null;
    mocks.data.job = null;
    mocks.data.homes = [];
    render(<Loading initial="/collection/final/intake" />);
    expect(scanner().getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(scanner());
    expect((await screen.findByRole("alert")).textContent).toBe(MAKE_ONE);
    await drop();
    expect(screen.getByText(MAKE_ONE, { selector: '[role="status"]' })).toBeTruthy();
    expect(start()).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});

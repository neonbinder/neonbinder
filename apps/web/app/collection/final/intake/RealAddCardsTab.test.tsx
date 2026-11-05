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
import { MemoryRouter, useLocation, useNavigate, useSearchParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageApiContext, type PageApi } from "../pageApi";
import { DRAWER_PARAM } from "../drawerParams";
import { LEAVE_INTAKE_LINE, PHOTO_NEWS_QUIET_MS } from "./realLanes";
import RealAddCardsTab from "./RealAddCardsTab";
import { intakeGateLine, SYNC_STATUS_LINK } from "../inventory/listing/ListingGate";
import type { ListingGateView } from "../data/types";
import { expectAccessibleInBothModes } from "@/lib/testing/axe";

const mocks = vi.hoisted(() => {
  const mutations = new Map<string, ReturnType<typeof vi.fn>>();
  return {
    mutations,
    uploading: false,
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
    },
    upload: vi.fn(),
    dropzone: [] as { heldBy?: string; heldLabel?: string; onFiles: (files: File[]) => void }[],
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
  useAction: (ref: string) => mocks.mutation(ref),
}));
vi.mock("../data/store", () => ({
  useSide: () => mocks.data.side,
  useContainers: () => mocks.data.containers,
  homesOnSide: () => mocks.data.homes,
  useDefaultCondition: () => "Near Mint",
  useListingGate: () => mocks.data.gate,
  writeErrorMessage: (e: unknown) => (e instanceof Error ? e.message : "Something went wrong."),
}));
vi.mock("@/src/hooks/useWarmPreprocess", () => ({ useWarmPreprocess: () => undefined }));
vi.mock("@/src/hooks/usePlaceholderUpload", () => ({
  usePlaceholderUpload: () => ({ uploading: mocks.uploading, upload: mocks.upload }),
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
  Dropzone: (p: { disabled?: boolean; heldBy?: string; heldLabel?: string; onFiles: (files: File[]) => void }) => {
    mocks.dropzone.push(p);
    return (
      <>
        <button type="button" aria-disabled={p.heldBy ? "true" : undefined} aria-describedby={p.heldBy}>
          {p.heldBy ? p.heldLabel : "Drag your card photos here"}
        </button>
        {/* The real zone holds the file input; NEO-446 moves focus onto it. */}
        <input type="file" aria-label="Photo files" disabled={p.disabled} />
      </>
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
const openCard = vi.fn();
const pageApi = { notify, openCard, inform: vi.fn() } as unknown as PageApi;

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
  mocks.data.containers = [];
  mocks.upload.mockReset();
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
const describedByIds = (el: Element) => (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);

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

  it("Min price reads $ and commas, commits on Enter, and shows the cents back", async () => {
    newRunIntoBox(HELD);
    fireEvent.click(screen.getByRole("button", { name: "Set a Min price" }));
    const field = screen.getByRole("textbox", { name: "Min price" }) as HTMLInputElement;
    expect(field.getAttribute("type")).toBe("text");
    expect(field.getAttribute("inputmode")).toBe("decimal");
    fireEvent.change(field, { target: { value: "$1,250.5" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field.value).toBe("1250.50");
    expect(zone().getAttribute("aria-disabled")).toBeNull();
  });

  it("a Min price that is not a price keeps the hold, marks the field and says how, tied to it", () => {
    newRunIntoBox(HELD);
    fireEvent.click(screen.getByRole("button", { name: "Set a Min price" }));
    const field = screen.getByRole("textbox", { name: "Min price" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "a buck" } });
    fireEvent.blur(field);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Type a price like 1.50");
    expect(describedByIds(field)).toContain(alert.id);
    // The typed text stays to fix; nothing was stored, so the hold stays.
    expect(field.value).toBe("a buck");
    expect(zone().getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(field, { target: { value: "2" } });
    fireEvent.blur(field);
    expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(field.value).toBe("2.00");
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
  const start = () => mocks.mutation("placeholderStream.startPlaceholderStream");
  const create = () => mocks.mutation("intakeRuns.createIntakeRun");
  const MAKE_ONE = "Make a binder first: the cards need somewhere to go.";

  beforeEach(() => {
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

  it("a drop while the shelf loads waits, then files into the binder the shelf answers (the latest drop wins)", async () => {
    mocks.data.run = null;
    mocks.data.job = null;
    mocks.data.containers = undefined;
    mocks.data.homes = [];
    const { rerender } = render(<Loading initial="/collection/final/intake" />);
    await drop([photoFile("first.jpg")]);
    const second = [photoFile("second-1.jpg"), photoFile("second-2.jpg")];
    await drop(second);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(screen.queryAllByText(MAKE_ONE)).toEqual([]);
    // The shelf arrives, with a binder on it.
    mocks.data.containers = [];
    mocks.data.homes = [{ id: "home1", name: "Binder", kind: "binder" }];
    rerender(<Loading initial="/collection/final/intake" />);
    await act(async () => {});
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.upload).toHaveBeenCalledWith(second, { source: "web", jobId: undefined });
    expect(create()).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-fresh", homeId: "home1" }));
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

describe("NEO-446: setting a loose photo aside", () => {
  const asideMutation = () => mocks.mutation("intakeRuns.setIntakePhotoAside");
  const tooBig = (entryIndex: number) => ({
    entryIndex,
    originalName: `scan-${entryIndex}.jpg`,
    status: "failed",
    errorCode: "ENTRY_TOO_MANY_PIXELS",
    retries: 0,
  });
  const stat = (label: string) => screen.getByText(label, { selector: "dt" }).parentElement?.querySelector("dd")?.textContent;
  const openWith = (images: unknown[]) => {
    const runId = freshRunId();
    setRun(runId, { images });
    const view = render(<Tab runId={runId} />);
    return { runId, ...view };
  };

  beforeEach(() => {
    asideMutation().mockClear();
    (pageApi.inform as ReturnType<typeof vi.fn>).mockClear();
  });

  it("every loose tile has its own Set aside, failed and too-big ones too, and it sends that photo", async () => {
    const { runId } = openWith([photo(0), tooBig(1)]);
    expect(screen.getByRole("button", { name: "Set aside scan-0.jpg" }).textContent).toBe("Set aside");
    const failed = screen.getByRole("button", { name: "Set aside scan-1.jpg" });
    fireEvent.click(failed);
    await waitFor(() =>
      expect(asideMutation()).toHaveBeenCalledWith({ runId, entryIndex: 1, setAside: true }),
    );
    await waitFor(() => expect(pageApi.inform).toHaveBeenCalledWith("Set aside scan-1.jpg."));
  });

  it("is a real button, so the keyboard reaches and presses it", () => {
    openWith([photo(0)]);
    const control = screen.getByRole("button", { name: "Set aside scan-0.jpg" });
    expect(control.tagName).toBe("BUTTON");
    control.focus();
    expect(document.activeElement).toBe(control);
  });

  it("photos of one file name get controls that read differently", () => {
    openWith([
      { entryIndex: 0, originalName: "image.jpg", status: "done" },
      { entryIndex: 1, originalName: "image.jpg", status: "done" },
    ]);
    expect(screen.getByRole("button", { name: "Set aside image.jpg, photo 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set aside image.jpg, photo 2" })).toBeTruthy();
  });

  it("a photo set aside leaves Pairing, can't be picked to pair, and is listed with Bring back", async () => {
    const { runId } = openWith([photo(0), { ...tooBig(1), setAside: true }]);
    expect(stat("Pairing")).toBe("1");
    expect(screen.queryByRole("button", { name: "Set aside scan-1.jpg" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again: scan-1.jpg" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^scan-1\.jpg/ })).toBeNull();
    expect(screen.getByRole("heading", { name: "Set aside" })).toBeTruthy();
    const back = screen.getByRole("button", { name: "Bring back scan-1.jpg" });
    expect(back.textContent).toBe("Bring back");
    fireEvent.click(back);
    await waitFor(() =>
      expect(asideMutation()).toHaveBeenCalledWith({ runId, entryIndex: 1, setAside: false }),
    );
    await waitFor(() => expect(pageApi.inform).toHaveBeenCalledWith("Brought back scan-1.jpg."));
  });

  it("a failed photo set aside isn't counted as one that couldn't be read", () => {
    openWith([{ ...tooBig(0), setAside: true }, tooBig(1)]);
    expect(screen.getByText(/1 photo couldn't be read/, { selector: "p[aria-hidden]" })).toBeTruthy();
  });

  it("after Done, the leave guard stops warning once the last loose photo is set aside", async () => {
    const runId = freshRunId();
    setRun(runId, { images: [photo(0)] });
    const { rerender } = render(<Tab runId={runId} />);
    await pressDone();
    clickLink();
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockClear();

    setRun(runId, { images: [{ ...photo(0), setAside: true }] });
    rerender(<Tab runId={runId} />);
    await waitFor(() => expect(stat("Pairing")).toBe("0"));
    clickLink();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("a refused press says why", async () => {
    openWith([photo(0)]);
    asideMutation().mockRejectedValueOnce(new Error("That photo is in a pair. Unpair it first."));
    fireEvent.click(screen.getByRole("button", { name: "Set aside scan-0.jpg" }));
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(pageApi.inform).not.toHaveBeenCalled();
  });
});

describe("NEO-446: the run's line, the zip wording and Start a new run", () => {
  function Url() {
    const navigate = useNavigate();
    return (
      <>
        <output aria-label="Page address">{useLocation().search}</output>
        <button type="button" onClick={() => navigate(-1)}>Browser back</button>
        <button type="button" onClick={() => navigate(1)}>Browser forward</button>
      </>
    );
  }
  function Screen({ initial }: { initial: string }) {
    return (
      <MemoryRouter initialEntries={[initial]}>
        <PageApiContext.Provider value={pageApi}>
          <RealAddCardsTab />
          <Url />
        </PageApiContext.Provider>
      </MemoryRouter>
    );
  }
  const file = (name: string, type = "image/jpeg") => new File(["x"], name, { type });
  const zip = () => file("cards.zip", "application/zip");
  const drop = async (files: File[]) => {
    await act(async () => mocks.dropzone.at(-1)!.onFiles(files));
  };
  /** Every live-region line on screen, without the page-address readout. */
  const lines = () =>
    screen
      .getAllByRole("status")
      .filter((el) => el.getAttribute("aria-label") !== "Page address")
      // The workspace's own tally ("0 saved.") is not the run's line.
      .filter((el) => !/^\d+ saved\.$/.test(el.textContent ?? ""))
      .map((el) => el.textContent ?? "");
  const url = () => screen.getByRole("status", { name: "Page address" }).textContent;

  /** A run whose job is in `job`; the images stay as setRun leaves them. */
  function runWithJob(job: Record<string, unknown>) {
    const runId = freshRunId();
    setRun(runId);
    mocks.data.job = {
      status: "succeeded",
      mode: "zip",
      totalImages: 0,
      failedImages: 0,
      rejectedEntries: 0,
      ...job,
    };
    return runId;
  }
  const open = (runId: string) => render(<Screen initial={`/collection/final/intake?run=${runId}`} />);

  beforeEach(() => {
    mocks.data.homes = [{ id: "home1", name: "Binder", kind: "binder" }];
    mocks.upload.mockImplementation((files: File[], { jobId }: { jobId?: string }) =>
      Promise.resolve({ ok: true, jobId: jobId ?? "job-fresh", kind: "images", uploaded: files.length, failed: 0, total: files.length }),
    );
  });

  describe("sending", () => {
    it("a zip says 'Sending your zip…' while it goes up, then no 'Sent' line at all", async () => {
      const runId = freshRunId();
      setRun(runId);
      let finish: (v: unknown) => void = () => {};
      mocks.upload.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
      open(runId);
      const sent = [zip()];
      let pending: Promise<void> = Promise.resolve();
      await act(async () => {
        pending = Promise.resolve(mocks.dropzone.at(-1)!.onFiles(sent));
      });
      expect(lines()).toContain("Sending your zip…");
      expect(lines().some((l) => l.includes("Sending your photos"))).toBe(false);
      await act(async () => {
        finish({ ok: true, jobId: `job-${runId}`, kind: "zip", uploaded: 1, failed: 0, total: 1 });
        await pending;
      });
      expect(lines().some((l) => /^Sent /.test(l))).toBe(false);
      expect(lines().some((l) => l.includes("Sending your"))).toBe(false);
      // A zip goes up as handed: it is one file.
      expect(mocks.upload).toHaveBeenCalledWith(sent, { source: "web", jobId: `job-${runId}` });
    });

    it("loose photos say 'Sending your photos…' then count what landed", async () => {
      const runId = freshRunId();
      setRun(runId);
      open(runId);
      await drop([file("a.jpg"), file("b.jpg")]);
      expect(lines()).toContain("Sent 2 photos.");
      mocks.upload.mockResolvedValueOnce({ ok: true, jobId: `job-${runId}`, kind: "images", uploaded: 1, failed: 0, total: 1 });
      await drop([file("c.jpg")]);
      expect(lines()).toContain("Sent 1 photo.");
    });

    it("loose photos with failures count both numbers", async () => {
      const runId = freshRunId();
      setRun(runId);
      mocks.upload.mockResolvedValueOnce({ ok: true, jobId: `job-${runId}`, kind: "images", uploaded: 2, failed: 1, total: 3 });
      open(runId);
      await drop([file("a.jpg"), file("b.jpg"), file("c.jpg")]);
      expect(lines()).toContain("Sent 2 of 3 photos. 1 failed.");
    });

    it("loose photos are handed to upload in natural filename order, and the picker's array is left alone", async () => {
      const runId = freshRunId();
      setRun(runId);
      open(runId);
      const picked = [file("IMG_10.jpg"), file("IMG_2.jpg"), file("img_1.jpg"), file("IMG_02b.jpg")];
      await drop(picked);
      const sent = mocks.upload.mock.calls[0][0] as File[];
      expect(sent.map((f) => f.name)).toEqual(["img_1.jpg", "IMG_2.jpg", "IMG_02b.jpg", "IMG_10.jpg"]);
      expect(picked.map((f) => f.name)).toEqual(["IMG_10.jpg", "IMG_2.jpg", "img_1.jpg", "IMG_02b.jpg"]);
    });

    it("a refused zip says 'that zip', refused photos say 'these photos'", async () => {
      const runId = freshRunId();
      setRun(runId);
      open(runId);
      mocks.upload.mockResolvedValueOnce({ ok: false, reason: "you are over the limit" });
      await drop([zip()]);
      expect(lines()).toContain("Couldn't send that zip: you are over the limit.");
      mocks.upload.mockResolvedValueOnce({ ok: false, reason: "you are over the limit" });
      await drop([file("a.jpg")]);
      expect(lines()).toContain("Couldn't send these photos: you are over the limit.");
    });

    it("a zip over the upload limit says how to split it", async () => {
      const runId = freshRunId();
      setRun(runId);
      open(runId);
      mocks.upload.mockResolvedValueOnce({ ok: false, reason: "that zip is larger than the 500MB limit", overLimitMb: 500 });
      await drop([zip()]);
      expect(lines()).toContain(
        "Couldn't send that zip: it's over 500 MB. Split it into smaller zips, each card's front and back together, one per run.",
      );
    });

    it("an invalid selection (two zips) sends nothing and says nothing new", async () => {
      const runId = freshRunId();
      setRun(runId);
      open(runId);
      await drop([zip(), file("two.zip", "application/zip")]);
      expect(mocks.upload).not.toHaveBeenCalled();
      expect(lines().filter(Boolean)).toEqual([]);
    });
  });

  describe("the run's line", () => {
    it("says nothing while the run is collecting", () => {
      const runId = runWithJob({ status: "collecting", mode: "stream" });
      open(runId);
      expect(lines().filter(Boolean)).toEqual([]);
      expect(screen.queryByRole("button", { name: "Start a new run" })).toBeNull();
      expect(screen.getByRole("button", { name: "Drag your card photos here" })).toBeTruthy();
    });

    it("a zip that was all rejected explains why, offers Start a new run, and hides the lanes", () => {
      const runId = runWithJob({
        status: "failed",
        errorCode: "TOO_MANY_IMAGE_FAILURES",
        totalImages: 0,
        rejectedEntries: 2,
        rejected: { tooBig: 2, wrongFormat: 0, unreadable: 0, examples: [{ name: "a.jpg", kind: "tooBig" }] },
      });
      open(runId);
      expect(lines()).toContain(
        "Whoa, those photos are too big! All 2 are over 64 megapixels or 32 MB. Use your camera's normal setting or shrink them, zip them up again, and start a new run.",
      );
      expect(lines().some((l) => l.includes("all in"))).toBe(false);
      expect(screen.getByRole("button", { name: "Start a new run" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Pairing" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Done adding photos" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Drag your card photos here" })).toBeNull();
    });

    it("a partial failure keeps the lanes, with the line and the button", async () => {
      const runId = runWithJob({
        status: "failed",
        errorCode: "TOO_MANY_IMAGE_FAILURES",
        totalImages: 5,
        failedImages: 3,
      });
      open(runId);
      expect(lines().some((l) => l.startsWith("Most of these photos wouldn't read."))).toBe(true);
      expect(screen.getByRole("button", { name: "Start a new run" })).toBeTruthy();
      expect(await screen.findByRole("heading", { name: "Pairing" })).toBeTruthy();
    });

    it("a healthy finished run says all in, with no Start a new run and the lanes shown", async () => {
      const runId = runWithJob({ status: "succeeded", totalImages: 4 });
      open(runId);
      expect(lines()).toContain("This run's photos are all in. To add more, start a new run.");
      expect(screen.queryByRole("button", { name: "Start a new run" })).toBeNull();
      expect(await screen.findByRole("heading", { name: "Pairing" })).toBeTruthy();
    });

    it("a zip still unpacking says so, calmly", () => {
      const runId = runWithJob({ status: "extracting" });
      open(runId);
      expect(lines()).toContain("Unpacking your zip…");
      expect(screen.queryByRole("button", { name: "Start a new run" })).toBeNull();
    });

    it("some of a zip rejected, rest in: the line names the files and offers the button", () => {
      const runId = runWithJob({
        status: "succeeded",
        totalImages: 3,
        rejectedEntries: 1,
        rejected: { tooBig: 0, wrongFormat: 1, unreadable: 0, examples: [{ name: "IMG.heic", kind: "wrongFormat" }] },
      });
      open(runId);
      expect(lines()).toContain(
        "3 photos made it in. 1 didn't: \"IMG.heic\" isn't a JPEG or PNG. Convert it to JPEG and drop it in a new run, with its other side.",
      );
      expect(screen.getByRole("button", { name: "Start a new run" })).toBeTruthy();
    });

    it("each file name is isolated, so a right-to-left name can't reorder the line", () => {
      const runId = runWithJob({
        status: "succeeded",
        totalImages: 3,
        rejectedEntries: 2,
        rejected: {
          tooBig: 2,
          wrongFormat: 0,
          unreadable: 0,
          examples: [
            { name: "תמונה.jpg", kind: "tooBig" },
            { name: "b.jpg", kind: "tooBig" },
          ],
        },
      });
      const { container } = open(runId);
      expect(Array.from(container.querySelectorAll("bdi")).map((el) => el.textContent)).toEqual(['"תמונה.jpg"', '"b.jpg"']);
      expect(lines()).toContain(
        '3 photos made it in. 2 didn\'t: "תמונה.jpg", "b.jpg" are too big (over 64 megapixels or 32 MB). Shrink them and drop them in a new run, with their other sides.',
      );
    });

    it("Start a new run is filled with nothing below it, outlined when the run has photos", () => {
      const fill = () => screen.getByRole("button", { name: "Start a new run" }).style.getPropertyValue("--nb-fill");
      const empty = open(runWithJob({ status: "failed", errorCode: "CANCELED", totalImages: 0 }));
      expect(fill()).not.toBe("transparent");
      empty.unmount();
      open(runWithJob({ status: "failed", errorCode: "EXTRACT_UNAVAILABLE", totalImages: 4 }));
      expect(fill()).toBe("transparent");
    });

    it("a file name from a zip renders as text, never as markup", () => {
      const name = "<img src=x onerror=alert(1)>.heic";
      const runId = runWithJob({
        status: "succeeded",
        totalImages: 3,
        rejectedEntries: 1,
        rejected: { tooBig: 0, wrongFormat: 1, unreadable: 0, examples: [{ name, kind: "wrongFormat" }] },
      });
      const { container } = open(runId);
      expect(container.querySelector("img[src='x']")).toBeNull();
      expect(lines().some((l) => l.includes(name))).toBe(true);
    });

    it("a gone job row (null) says the reader hit a snag and still offers the way forward", () => {
      const runId = freshRunId();
      setRun(runId);
      mocks.data.job = null;
      open(runId);
      expect(lines()).toContain("Our photo reader hit a snag. That's on us. Start a new run and send them again.");
      expect(screen.getByRole("button", { name: "Start a new run" })).toBeTruthy();
      // The lanes stay: they may hold saved cards.
      expect(screen.queryByRole("heading", { name: "Pairing" })).not.toBeNull();
    });

    it("the line passes axe in both modes, with and without the button", async () => {
      const runId = runWithJob({ status: "failed", errorCode: "CANCELED", totalImages: 0 });
      const { container, rerender } = open(runId);
      await expectAccessibleInBothModes(container, {
        label: "Intake, a stopped run",
        rerender: () => rerender(<Screen initial={`/collection/final/intake?run=${runId}`} />),
      });
    });
  });

  describe("starting a new run", () => {
    it("Start a new run leaves the run, clears the status and moves focus to the drop zone's input", async () => {
      const runId = runWithJob({ status: "collecting", mode: "stream" });
      const { rerender } = open(runId);
      await drop([file("a.jpg")]);
      expect(lines()).toContain("Sent 1 photo.");
      // The run closes under the collector with a problem.
      mocks.data.job = { status: "failed", mode: "zip", errorCode: "CANCELED", totalImages: 0, failedImages: 0, rejectedEntries: 0 };
      rerender(<Screen initial={`/collection/final/intake?run=${runId}`} />);
      fireEvent.click(await screen.findByRole("button", { name: "Start a new run" }));
      await act(async () => {});
      expect(url()).toBe("");
      expect(screen.queryByRole("button", { name: "Start a new run" })).toBeNull();
      expect(lines().filter(Boolean)).toEqual([]);
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Photo files")));
    });

    it("New run on an open run also clears the status and focuses the input", async () => {
      const runId = runWithJob({ status: "collecting", mode: "stream" });
      open(runId);
      await drop([file("a.jpg")]);
      expect(lines()).toContain("Sent 1 photo.");
      fireEvent.click(screen.getByRole("button", { name: "New run" }));
      await act(async () => {});
      expect(url()).toBe("");
      expect(lines()).not.toContain("Sent 1 photo.");
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Photo files")));
    });

    it("with a send still going the input can't take focus, so the drop zone does", async () => {
      const runId = runWithJob({ status: "collecting", mode: "stream" });
      mocks.uploading = true;
      open(runId);
      fireEvent.click(screen.getByRole("button", { name: "New run" }));
      await act(async () => {});
      expect(url()).toBe("");
      const input = screen.getByLabelText<HTMLInputElement>("Photo files");
      expect(input.disabled).toBe(true);
      expect(document.activeElement).toBe(input.parentElement);
      mocks.uploading = false;
    });

    it("Back to the closed run and Forward again doesn't take focus a second time", async () => {
      const runId = runWithJob({ status: "failed", errorCode: "CANCELED", totalImages: 0 });
      open(runId);
      fireEvent.click(screen.getByRole("button", { name: "Start a new run" }));
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Photo files")));
      fireEvent.click(screen.getByRole("button", { name: "Browser back" }));
      await waitFor(() => expect(url()).toBe(`?run=${runId}`));
      const forward = screen.getByRole("button", { name: "Browser forward" });
      forward.focus();
      fireEvent.click(forward);
      await waitFor(() => expect(url()).toBe(""));
      await act(async () => {});
      expect(document.activeElement).toBe(forward);
    });

    it("focus is only taken when the user asked to leave a run, not on a plain visit", () => {
      mocks.data.run = null;
      mocks.data.job = null;
      render(<Screen initial="/collection/final/intake" />);
      expect(document.activeElement).not.toBe(screen.getByLabelText("Photo files"));
    });
  });
});

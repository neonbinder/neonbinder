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

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, type ReactNode, type Ref } from "react";
import { MemoryRouter, useLocation, useNavigate, useSearchParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageApiContext, type PageApi } from "../pageApi";
import { DRAWER_PARAM } from "../drawerParams";
import {
  INTAKE_NEEDS_PRICE_LINE,
  LEAVE_INTAKE_LINE,
  PHOTO_NEWS_QUIET_MS,
  RUN_CLOSED_LINE,
  waitingForPriceLine,
} from "./realLanes";
import RealAddCardsTab from "./RealAddCardsTab";
import { SPEECH_AFTER_FOCUS_MS } from "./ScannerJoin";
import { intakeGateLine, SYNC_STATUS_LINK } from "../inventory/listing/ListingGate";
import { clearAllHeld, heldIntakeKey, holdFiles, readHeld } from "./heldIntake";
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
      /** The signed-in user (`useAuth`); the held photos are keyed by it. */
      userId: "u1" as string | null,
      /** The caller's common prices in dollars by variant; undefined = loading. */
      common: {} as Record<string, number> | undefined,
      /** What the Cascade stand-in picks when "Pick it" is pressed. */
      pick: { variantId: "v1", title: "1988 Topps Base" },
      /** NEO-481 — the saved lines' own photos (`copyPhotos.photosOf`). */
      linePhotos: [] as unknown[],
      /** NEO-481 — the store's copy-photo extension; undefined = none (the viewer opens view-only). */
      copyPhotos: undefined as unknown,
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
      case "copyPhotos.photosOf":
        return mocks.data.linePhotos;
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
  useCopyPhotos: () => mocks.data.copyPhotos,
  useCollectionActions: () => ({ setCommonPrice: mocks.setCommon }),
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
// The shared scan picture has its own test (scan-image.test.tsx). This stand-in
// keeps its contract: with `onOpen` it is a button named `openLabel`, and it
// shows which edit it was handed (`pending`) and the version it reads.
vi.mock("@/app/print/placeholders/scan-image", () => ({
  ScanImage: ({
    onOpen,
    openLabel,
    pending,
    version,
  }: {
    onOpen?: (from: HTMLElement) => void;
    openLabel?: string;
    pending?: { status: string };
    version?: number;
  }) =>
    onOpen ? (
      <button
        type="button"
        aria-label={openLabel}
        data-pending={pending?.status}
        data-version={version}
        onClick={(e) => onOpen(e.currentTarget)}
      >
        scan
      </button>
    ) : (
      <span>scan</span>
    ),
}));
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
// A dialog in place, without the portal and focus trap (the Overlay's own tests): the
// tab's keys tell the card drawer's dialog from any other (the photo viewer's) by it.
vi.mock("../../prototypes/p1/Overlay", () => ({
  default: ({ children, labelledBy }: { children: ReactNode; labelledBy?: string }) => (
    <div role="dialog" aria-labelledby={labelledBy}>
      {children}
    </div>
  ),
}));

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
    closedBy,
  }: {
    open?: boolean;
    images?: unknown[];
    homeKind?: "binder" | "box";
    variantId?: string | null;
    closedBy?: "user" | "idle";
  } = {},
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
  mocks.data.job = { status: open ? "collecting" : "closed", streamClosedBy: closedBy };
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
  mocks.data.linePhotos = [];
  mocks.data.copyPhotos = undefined;
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

/* ------------------------------------------------------------------ */
/* NEO-459 — closed from anywhere is Done                              */
/* ------------------------------------------------------------------ */

describe("RealAddCardsTab, a run the collector closed from elsewhere (NEO-459)", () => {
  const syncLink = () => screen.queryByRole("link", { name: SYNC_STATUS_LINK });
  const SYNCS: ListingGateView = { syncing: true, applies: true, commonPriceCents: 25, variantHasCards: true };
  const closedLine = () => screen.queryByText(RUN_CLOSED_LINE);

  /** Open and on screen, then the close lands by query, as it does from the scanner app. */
  const closedWhileWatching = async (closedBy: "user" | "idle", options: { homeKind?: "binder" | "box" } = {}) => {
    const runId = freshRunId();
    setRun(runId, options);
    const view = render(<Tab runId={runId} />);
    await screen.findByRole("button", { name: "Done adding photos" });
    const land = async () => {
      setRun(runId, { ...options, open: false, closedBy });
      view.rerender(<Tab runId={runId} />);
      await act(async () => {});
    };
    return { runId, land, ...view };
  };

  it("asks before leaving while the columns work, with Done never pressed here", async () => {
    const { land } = await closedWhileWatching("user");
    clickLink();
    expect(confirm).not.toHaveBeenCalled();
    await land();
    expect(closeStream()).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Done adding photos" })).toBeNull();
    screen.getByText("This run's photos are all in. To add more, start a new run.");
    clickLink();
    expect(confirm).toHaveBeenCalledWith(LEAVE_INTAKE_LINE);
  });

  it("an idle sweep's close stays as it was: no guard, no link, no line", async () => {
    mocks.data.gate = SYNCS;
    const { land } = await closedWhileWatching("idle", { homeKind: "box" });
    await land();
    screen.getByText("This run's photos are all in. To add more, start a new run.");
    clickLink();
    expect(confirm).not.toHaveBeenCalled();
    expect(syncLink()).toBeNull();
    expect(closedLine()).toBeNull();
  });

  it("links to Sync status on a box that syncs, in its live region", async () => {
    mocks.data.gate = SYNCS;
    const { land } = await closedWhileWatching("user", { homeKind: "box" });
    expect(syncLink()).toBeNull();
    await land();
    expect(syncLink()?.closest('[role="status"]')).not.toBeNull();
  });

  it("disarms once the columns clear, and keeps the link for the sync that just went", async () => {
    mocks.data.gate = SYNCS;
    const { land, rerender, runId } = await closedWhileWatching("user", { homeKind: "box" });
    await land();
    setRun(runId, { open: false, closedBy: "user", homeKind: "box", images: [] });
    rerender(<Tab runId={runId} />);
    await act(async () => {});
    clickLink();
    expect(confirm).not.toHaveBeenCalled();
    expect(syncLink()).not.toBeNull();
  });

  it("mounting on a run already closed by the collector arms nothing and shows no link: a reload stays as it was", async () => {
    // A first mount with nothing in `doneRuns` is what a reload looks like, and
    // the job reads the same whether the button or the scanner app closed it.
    mocks.data.gate = SYNCS;
    const runId = freshRunId();
    setRun(runId, { open: false, closedBy: "user", homeKind: "box" });
    render(<Tab runId={runId} />);
    await screen.findByRole("heading", { name: "Pairing" });
    await act(async () => {});
    clickLink();
    expect(confirm).not.toHaveBeenCalled();
    expect(syncLink()).toBeNull();
  });

  it("a later visit to a closed and settled run asks nothing and shows no link", async () => {
    mocks.data.gate = SYNCS;
    const runId = freshRunId();
    setRun(runId, { open: false, closedBy: "user", homeKind: "box", images: [] });
    render(<Tab runId={runId} />);
    await screen.findByRole("heading", { name: "Pairing" });
    await act(async () => {});
    clickLink();
    expect(confirm).not.toHaveBeenCalled();
    expect(syncLink()).toBeNull();
  });

  it("a close first seen while the job loads is not a landing", async () => {
    mocks.data.gate = SYNCS;
    const runId = freshRunId();
    setRun(runId, { homeKind: "box" });
    mocks.data.job = undefined;
    const view = render(<Tab runId={runId} />);
    await screen.findByRole("heading", { name: "Pairing" });
    setRun(runId, { open: false, closedBy: "user", homeKind: "box" });
    view.rerender(<Tab runId={runId} />);
    await act(async () => {});
    clickLink();
    expect(confirm).not.toHaveBeenCalled();
    expect(syncLink()).toBeNull();
    expect(closedLine()).toBeNull();
  });

  it("open, then loading, then closed is not a landing either", async () => {
    const { rerender, runId } = await closedWhileWatching("user");
    mocks.data.job = undefined;
    rerender(<Tab runId={runId} />);
    await act(async () => {});
    setRun(runId, { open: false, closedBy: "user" });
    rerender(<Tab runId={runId} />);
    await act(async () => {});
    clickLink();
    expect(confirm).not.toHaveBeenCalled();
    expect(closedLine()).toBeNull();
  });

  it("still asks after a remount, because a live close goes into the Done memory", async () => {
    const { land, unmount, runId } = await closedWhileWatching("user");
    await land();
    unmount();
    setRun(runId, { open: false, closedBy: "user" });
    render(<Tab runId={runId} />);
    await screen.findByRole("heading", { name: "Pairing" });
    clickLink();
    expect(confirm).toHaveBeenCalledWith(LEAVE_INTAKE_LINE);
  });

  it("forgets a live close once the columns clear, so a remount does not ask", async () => {
    const { land, rerender, unmount, runId } = await closedWhileWatching("user");
    await land();
    setRun(runId, { open: false, closedBy: "user", images: [] });
    rerender(<Tab runId={runId} />);
    await act(async () => {});
    unmount();

    setRun(runId, { open: false, closedBy: "user" }); // a card brought back from Set aside
    render(<Tab runId={runId} />);
    await screen.findByRole("heading", { name: "Pairing" });
    clickLink();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("a live close on columns already clear keeps the link here, and a remount forgets it", async () => {
    mocks.data.gate = SYNCS;
    const runId = freshRunId();
    setRun(runId, { homeKind: "box", images: [] });
    const view = render(<Tab runId={runId} />);
    await screen.findByRole("button", { name: "Done adding photos" });
    setRun(runId, { open: false, closedBy: "user", homeKind: "box", images: [] });
    view.rerender(<Tab runId={runId} />);
    await act(async () => {});
    expect(syncLink()).not.toBeNull();
    view.unmount();

    render(<Tab runId={runId} />);
    await screen.findByRole("heading", { name: "Pairing" });
    await act(async () => {});
    expect(syncLink()).toBeNull();
  });

  it("a press on clear columns isn't put back in the Done memory when its own close lands", async () => {
    mocks.data.gate = SYNCS;
    const runId = freshRunId();
    setRun(runId, { homeKind: "box", images: [] });
    const view = render(<Tab runId={runId} />);
    await pressDone(); // the columns are clear, so `doneRuns` has already let go
    setRun(runId, { open: false, closedBy: "user", homeKind: "box", images: [] });
    view.rerender(<Tab runId={runId} />);
    await act(async () => {});
    expect(syncLink()).not.toBeNull();
    view.unmount();

    render(<Tab runId={runId} />);
    await screen.findByRole("heading", { name: "Pairing" });
    await act(async () => {});
    expect(syncLink()).toBeNull();
  });

  it("a press still behaves as today, and the close it causes doesn't stack a second ask", async () => {
    const runId = freshRunId();
    setRun(runId);
    const view = render(<Tab runId={runId} />);
    await pressDone();
    expect(closeStream()).toHaveBeenCalledTimes(1);
    clickLink();
    expect(confirm).toHaveBeenCalledTimes(1);
    setRun(runId, { open: false, closedBy: "user" });
    view.rerender(<Tab runId={runId} />);
    await act(async () => {});
    clickLink();
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  describe("the close said out loud", () => {
    it("says it once when the close lands on screen", async () => {
      const { land } = await closedWhileWatching("user");
      expect(closedLine()).toBeNull();
      await land();
      expect(closedLine()?.getAttribute("role")).toBe("status");
    });

    it("says it for a press too, when the close that press caused lands", async () => {
      const runId = freshRunId();
      setRun(runId);
      const view = render(<Tab runId={runId} />);
      await pressDone();
      expect(closedLine()).toBeNull();
      setRun(runId, { open: false, closedBy: "user" });
      view.rerender(<Tab runId={runId} />);
      await act(async () => {});
      expect(closedLine()).not.toBeNull();
    });

    it("says nothing on opening a run that was already closed", async () => {
      const runId = freshRunId();
      setRun(runId, { open: false, closedBy: "user" });
      render(<Tab runId={runId} />);
      await screen.findByRole("heading", { name: "Pairing" });
      await act(async () => {});
      expect(closedLine()).toBeNull();
    });
  });

  describe("focus when the close takes the control that held it", () => {
    it("from Done adding photos, lands on the Pairing heading", async () => {
      const { land } = await closedWhileWatching("user");
      act(() => screen.getByRole("button", { name: "Done adding photos" }).focus());
      await land();
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Pairing" }));
    });

    it("from inside the Scanner code panel, lands on the Pairing heading", async () => {
      mocks.mutation("intakeScanner.scannerCodeForIntakeRun").mockResolvedValue("AB3X7K");
      const { land } = await closedWhileWatching("user");
      fireEvent.click(screen.getByRole("button", { name: "Use a scanner" }));
      const icon = await screen.findByRole("button", { name: "Copy scanner code" });
      act(() => icon.focus());
      await land();
      expect(screen.queryByRole("group", { name: "Scanner code" })).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Pairing" }));
    });

    it("leaves focus alone when the collector is working elsewhere on the screen", async () => {
      const { land } = await closedWhileWatching("user");
      const defaults = screen.getByRole("button", { name: /^Defaults:/ });
      act(() => defaults.focus());
      await land();
      expect(document.activeElement).toBe(defaults);
    });

    it("doesn't grab focus for someone who had none in the screen's controls", async () => {
      const { land } = await closedWhileWatching("user");
      expect(document.activeElement).toBe(document.body);
      await land();
      expect(document.activeElement).toBe(document.body);
    });

    it("an idle sweep's close parks focus the same, because it takes the same controls", async () => {
      const { land } = await closedWhileWatching("idle");
      act(() => screen.getByRole("button", { name: "Done adding photos" }).focus());
      await land();
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Pairing" }));
    });

    it("an idle sweep's close parks focus from the drop zone too, and still arms nothing and says nothing", async () => {
      mocks.data.gate = SYNCS;
      const { land } = await closedWhileWatching("idle", { homeKind: "box" });
      act(() => screen.getByLabelText(ZONE_NAME).focus());
      await land();
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Pairing" }));
      expect(closedLine()).toBeNull();
      expect(syncLink()).toBeNull();
      clickLink();
      expect(confirm).not.toHaveBeenCalled();
    });

    it("an idle sweep's close leaves focus alone when it is elsewhere on the screen", async () => {
      const { land } = await closedWhileWatching("idle");
      const defaults = screen.getByRole("button", { name: /^Defaults:/ });
      act(() => defaults.focus());
      await land();
      expect(document.activeElement).toBe(defaults);
    });

    it("parks when a run turns out closed as its job loads, with focus in the drop zone", async () => {
      const runId = freshRunId();
      setRun(runId);
      mocks.data.job = undefined;
      const view = render(<Tab runId={runId} />);
      act(() => screen.getByLabelText(ZONE_NAME).focus());
      setRun(runId, { open: false });
      view.rerender(<Tab runId={runId} />);
      await act(async () => {});
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Pairing" }));
    });

    it("Done leaving without a close (its job reloading) doesn't leave a later close grabbing focus", async () => {
      const { land, rerender, runId } = await closedWhileWatching("user");
      act(() => screen.getByRole("button", { name: "Done adding photos" }).focus());
      mocks.data.job = undefined;
      rerender(<Tab runId={runId} />);
      await act(async () => {});
      expect(document.activeElement).toBe(document.body);
      setRun(runId);
      rerender(<Tab runId={runId} />);
      await act(async () => {});
      await land();
      expect(document.activeElement).toBe(document.body);
    });
  });

  describe("the close line and the focus move", () => {
    const NOW = { toFake: ["setTimeout", "clearTimeout"] as ("setTimeout" | "clearTimeout")[] };
    afterEach(() => {
      vi.useRealTimers();
    });

    it("waits after focus parks, so the heading is read first", async () => {
      const { land } = await closedWhileWatching("user");
      act(() => screen.getByRole("button", { name: "Done adding photos" }).focus());
      vi.useFakeTimers(NOW);
      await land();
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Pairing" }));
      expect(closedLine()).toBeNull();
      act(() => {
        vi.advanceTimersByTime(SPEECH_AFTER_FOCUS_MS - 1);
      });
      expect(closedLine()).toBeNull();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(closedLine()?.getAttribute("role")).toBe("status");
    });

    it("the Done memory doesn't wait with it", async () => {
      const { land } = await closedWhileWatching("user");
      act(() => screen.getByRole("button", { name: "Done adding photos" }).focus());
      vi.useFakeTimers(NOW);
      await land();
      clickLink();
      expect(confirm).toHaveBeenCalledWith(LEAVE_INTAKE_LINE);
    });

    it("says it right away when focus didn't move", async () => {
      const { land } = await closedWhileWatching("user");
      const defaults = screen.getByRole("button", { name: /^Defaults:/ });
      act(() => defaults.focus());
      vi.useFakeTimers(NOW);
      await land();
      expect(document.activeElement).toBe(defaults);
      expect(closedLine()).not.toBeNull();
    });

    it("drops the wait when the screen goes away during it", async () => {
      const { land, unmount } = await closedWhileWatching("user");
      act(() => screen.getByRole("button", { name: "Done adding photos" }).focus());
      vi.useFakeTimers(NOW);
      await land();
      expect(vi.getTimerCount()).toBe(1);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("what the close says, in all", () => {
    const heard = (container: HTMLElement) =>
      [...container.querySelectorAll('[role="status"]')].map((el) => el.textContent ?? "").filter(Boolean);

    it("a landing adds the run's line and the close line: the summary's words stay as they were", async () => {
      const { land, container } = await closedWhileWatching("user");
      const before = heard(container);
      expect(before).toEqual(["0 saved."]);
      await land();
      // The first is the closed run's own line (NEO-446 `runNotice`), which any close shows.
      expect(heard(container)).toEqual([
        "This run's photos are all in. To add more, start a new run.",
        "0 saved.",
        RUN_CLOSED_LINE,
      ]);
    });

    it("a press changes none of them until the close lands", async () => {
      const runId = freshRunId();
      setRun(runId);
      const { container } = render(<Tab runId={runId} />);
      const before = heard(container);
      await pressDone();
      expect(heard(container)).toEqual(before);
    });
  });

  describe("moving between runs on Back and Forward", () => {
    const history = { go: (_delta: number) => {} };
    function Moves() {
      const navigate = useNavigate();
      useEffect(() => {
        history.go = (delta) => void navigate(delta);
      }, [navigate]);
      return null;
    }
    /** Run A on screen with run B one Back away. */
    const onA = async (a: string, b: string, options: { homeKind?: "binder" | "box" } = {}) => {
      setRun(a, options);
      const screenNow = () => (
        <MemoryRouter initialEntries={[`/collection/final/intake?run=${b}`, `/collection/final/intake?run=${a}`]} initialIndex={1}>
          <PageApiContext.Provider value={pageApi}>
            <Moves />
            <a href="/inventory" onClick={preventNav}>
              Inventory
            </a>
            <RealAddCardsTab />
          </PageApiContext.Provider>
        </MemoryRouter>
      );
      const view = render(screenNow());
      await screen.findByRole("button", { name: "Done adding photos" });
      const to = async (run: string, delta: number, runOptions: Parameters<typeof setRun>[1] = options) => {
        setRun(run, runOptions);
        await act(async () => history.go(delta));
      };
      const refresh = async () => {
        view.rerender(screenNow());
        await act(async () => {});
      };
      return { to, refresh };
    };

    it("a Done on one run doesn't arm the next, and comes back with its own run", async () => {
      mocks.data.gate = SYNCS;
      const [a, b] = [freshRunId(), freshRunId()];
      const { to } = await onA(a, b, { homeKind: "box" });
      await pressDone();
      expect(syncLink()).not.toBeNull();

      confirm.mockReturnValue(true);
      await to(b, -1);
      expect(syncLink()).toBeNull();
      confirm.mockClear();
      clickLink();
      expect(confirm).not.toHaveBeenCalled();

      await to(a, 1);
      expect(syncLink()).not.toBeNull();
      clickLink();
      expect(confirm).toHaveBeenCalledWith(LEAVE_INTAKE_LINE);
    });

    it("one run's close line doesn't stand on the next", async () => {
      const [a, b] = [freshRunId(), freshRunId()];
      const { refresh, to } = await onA(a, b);
      setRun(a, { open: false, closedBy: "user" });
      await refresh();
      expect(closedLine()).not.toBeNull();
      await to(b, -1);
      expect(closedLine()).toBeNull();
    });

    it("an open run followed by one already closed isn't a close landing", async () => {
      mocks.data.gate = SYNCS;
      const [a, b] = [freshRunId(), freshRunId()];
      const { to } = await onA(a, b, { homeKind: "box" });
      await to(b, -1, { open: false, closedBy: "user", homeKind: "box" });
      await act(async () => {});
      expect(closedLine()).toBeNull();
      expect(syncLink()).toBeNull();
      clickLink();
      expect(confirm).not.toHaveBeenCalled();
    });
  });

  it("passes axe in light and dark, closed from elsewhere with the link showing", async () => {
    mocks.data.gate = SYNCS;
    const { land, container, rerender, runId } = await closedWhileWatching("user", { homeKind: "box" });
    await land();
    await expectAccessibleInBothModes(container, {
      label: "Intake, closed from elsewhere",
      rerender: () => rerender(<Tab runId={runId} />),
    });
  });
});

describe("RealAddCardsTab parkFocus", () => {
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
    const help = () => document.getElementById(describedByIds(minPrice())[0])?.textContent;
    // Blank sells at no price while there is none: the help says the other way out.
    expect(help()).toBe(`Or save it as your common price for ${TITLE}.`);
    fireEvent.change(minPrice(), { target: { value: "0.50" } });
    fireEvent.blur(minPrice());
    expect(screen.queryByText(gateLine)).toBeNull();
    expect(defaultsButton().textContent).toBe("Defaults: Near Mint, $0.50");
    expect(help()).toBe("Leave it blank to sell at your common price.");
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
    const { container, rerender } = newRunIntoBox(HELD);
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
    await expectAccessibleInBothModes(container, { label: "Intake, a Min price that is not a price", rerender: () => rerender(<NewRun />) });
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

  it("a pick that leaves them waiting on a price mutes the tray while focus goes to Min price, then unmutes it", async () => {
    newRunIntoBox(HELD);
    await dropOnZone([photoOf("a.jpg")]);
    const region = screen.getByRole("status", { name: "Waiting photos" });
    expect(region.getAttribute("aria-live")).toBe("polite");
    // What the region was set to each time its words changed.
    const heard: string[] = [];
    const watch = new MutationObserver(() => heard.push(`${region.getAttribute("aria-live")}: ${region.textContent}`));
    watch.observe(region, { childList: true, subtree: true, characterData: true });
    await pickNow();
    await frames();
    watch.disconnect();
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.every((h) => h.startsWith("off: "))).toBe(true);
    expect(document.activeElement).toBe(minPrice());
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("1 photo waiting on a price.");
  });

  it("with no set, photos wait in the tray: the words, the hint, the description, the unload prompt, nothing sent", async () => {
    newRunIntoBox(HELD);
    await dropOnZone([photoOf("a.jpg"), photoOf("b.jpg")]);
    const line = screen.getByText("2 photos waiting. Pick a set and they're off.");
    expect(screen.getByText(/^JPEG, PNG, WebP or one zip\. Drop them whenever\. They wait here until the run is set up/)).toBeTruthy();
    expect(describedByIds(zone())).toContain(line.id);
    // The description reads the node's own name first: the region's label must stay off it.
    expect(line.getAttribute("aria-label")).toBeNull();
    expect(screen.getByRole("status", { name: "Waiting photos" }).textContent).toBe(line.textContent);
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

describe("a lane that scrolls takes the keyboard (NEO-452)", () => {
  const reading = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ ...photo(i), status: "processing" }));
  const list = () => screen.queryByRole("group", { name: "Cropping & reading list" });

  it("has no Tab stop until it can scroll, then a named one around the same list", () => {
    const runId = freshRunId();
    setRun(runId, { images: reading(6) });
    const view = render(<Tab runId={runId} />);
    expect(list()).toBeNull();
    // No scroll container at all below the threshold: axe would ask for a Tab stop on one.
    const lane = screen.getByRole("region", { name: "Cropping & reading, 6" });
    expect(lane.querySelector('[class*="overflow-"]')).toBeNull();
    const tile = screen.getByText("scan-0.jpg");

    setRun(runId, { images: reading(7) });
    view.rerender(<Tab runId={runId} />);
    expect(list()!.getAttribute("tabindex")).toBe("0");
    expect(list()!.querySelector("ul")).toBeTruthy();
    // Crossing the threshold doesn't remount what is in the lane.
    expect(screen.getByText("scan-0.jpg")).toBe(tile);
  });

  it("focus moving between things inside the lane doesn't count as leaving it", () => {
    const runId = freshRunId();
    setRun(runId, { images: reading(7) });
    const view = render(<Tab runId={runId} />);
    act(() => list()!.focus());
    const inside = list()!.querySelector("li")!;
    fireEvent.blur(list()!, { relatedTarget: inside });
    setRun(runId, { images: reading(2) });
    view.rerender(<Tab runId={runId} />);
    expect(list()).toBeTruthy();
  });

  it("keeps the Tab stop under whoever is on it while the lane drains, and lets go after", () => {
    const runId = freshRunId();
    setRun(runId, { images: reading(7) });
    const view = render(<Tab runId={runId} />);
    act(() => list()!.focus());

    setRun(runId, { images: reading(2) });
    view.rerender(<Tab runId={runId} />);
    expect(document.activeElement).toBe(list());

    act(() => list()!.blur());
    expect(list()).toBeNull();
  });
});

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
    // Names that sort the way they were dropped: loose photos go up in natural name order (NEO-446).
    const second = [photoFile("second-1.jpg"), photoFile("second-2.jpg")];
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

describe("NEO-441: the Pairing column's button says what it needs next", () => {
  const SELECT_TWO = "Select 2 to Pair";
  const SELECT_PARTNER = "Select Partner";
  const PAIR = "Pair Images";

  const pairUp = () => mocks.mutation("placeholderPairing.manuallyPairPlaceholderImages");
  const pile = (count: number, runId = freshRunId()) => {
    setRun(runId, { images: Array.from({ length: count }, (_, i) => photo(i)) });
    return { runId, ...render(<Tab runId={runId} />) };
  };
  // The tile, not its Set aside (NEO-446), Try again, or photo and Crop by hand (NEO-481)
  // buttons, which name the photo too.
  const tile = (entryIndex: number) =>
    screen.getByRole("button", {
      name: new RegExp(`^(?!Set aside |Try again: |Open photo |Crop by hand: ).*scan-${entryIndex}\\.jpg`),
    });
  const pick = (entryIndex: number) => fireEvent.click(tile(entryIndex));
  const button = (name: string) => screen.getByRole<HTMLButtonElement>("button", { name });
  const anyPairButton = () => screen.queryByRole("button", { name: new RegExp(`^(${SELECT_TWO}|${SELECT_PARTNER}|${PAIR})$`) });
  /** The label reads as asked, and only a pair can press it. */
  const expectStep = (name: string) => {
    expect(button(name).getAttribute("aria-disabled")).toBe(name === PAIR ? null : "true");
    expect(anyPairButton()).toBe(button(name));
  };

  it("stays reachable by keyboard before two are picked, and pressing it then pairs nothing", async () => {
    pairUp().mockClear();
    pile(3);
    const ask = await screen.findByRole<HTMLButtonElement>("button", { name: SELECT_TWO });
    expect(ask.disabled).toBe(false);
    ask.focus();
    expect(document.activeElement).toBe(ask);
    fireEvent.click(ask);
    pick(0);
    fireEvent.click(button(SELECT_PARTNER));
    expect(pairUp()).not.toHaveBeenCalled();
  });

  it("walks 0, 1, 2 picks: two asks, disabled, then an action", async () => {
    pile(3);
    await screen.findByRole("button", { name: SELECT_TWO });
    expectStep(SELECT_TWO);
    pick(0);
    expectStep(SELECT_PARTNER);
    pick(1);
    expectStep(PAIR);
  });

  it("stays an outline at every step", async () => {
    pile(2);
    const fill = (name: string) => button(name).style.getPropertyValue("--nb-fill");
    await screen.findByRole("button", { name: SELECT_TWO });
    expect(fill(SELECT_TWO)).toBe("transparent");
    pick(0);
    expect(fill(SELECT_PARTNER)).toBe("transparent");
    pick(1);
    expect(fill(PAIR)).toBe("transparent");
  });

  it("steps back down as photos are deselected", async () => {
    pile(2);
    await screen.findByRole("button", { name: SELECT_TWO });
    pick(0);
    pick(1);
    expectStep(PAIR);
    pick(1);
    expectStep(SELECT_PARTNER);
    pick(0);
    expectStep(SELECT_TWO);
  });

  it("a third pick stays at Pair Images, the oldest pick letting go", async () => {
    pile(3);
    await screen.findByRole("button", { name: SELECT_TWO });
    pick(0);
    pick(1);
    pick(2);
    expectStep(PAIR);
    expect(tile(0).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button(PAIR));
    expect(pairUp()).toHaveBeenCalledWith({ jobId: expect.any(String), frontIndex: 1, backIndex: 2 });
  });

  it("Pair Images pairs with the first picked as the front, then the label starts over", async () => {
    const { runId } = pile(3);
    await screen.findByRole("button", { name: SELECT_TWO });
    pick(2);
    pick(0);
    fireEvent.click(button(PAIR));
    expect(pairUp()).toHaveBeenCalledTimes(1);
    expect(pairUp()).toHaveBeenCalledWith({ jobId: `job-${runId}`, frontIndex: 2, backIndex: 0 });
    expectStep(SELECT_TWO);
    expect(tile(2).getAttribute("aria-pressed")).toBe("false");
  });

  it("a picked photo that leaves the pile takes its step with it", async () => {
    const { runId, rerender } = pile(3);
    await screen.findByRole("button", { name: SELECT_TWO });
    pick(0);
    pick(1);
    expectStep(PAIR);
    mocks.data.images = [photo(1), photo(2)];
    rerender(<Tab runId={runId} />);
    expectStep(SELECT_PARTNER);
  });

  it("does not show with one photo in the pile", async () => {
    pile(1);
    await screen.findByRole("button", { name: /^(?!Set aside |Try again: |Open photo |Crop by hand: ).*scan-0\.jpg/ });
    expect(anyPairButton()).toBeNull();
  });

  it("passes axe in light and dark at every step", async () => {
    const { container, rerender, runId } = pile(2);
    const again = () => rerender(<Tab runId={runId} />);
    await screen.findByRole("button", { name: SELECT_TWO });
    await expectAccessibleInBothModes(container, { label: "Pairing, none picked", rerender: again });
    pick(0);
    await expectAccessibleInBothModes(container, { label: "Pairing, one picked", rerender: again });
    pick(1);
    await expectAccessibleInBothModes(container, { label: "Pairing, two picked", rerender: again });
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

  it("a photo set aside shows its whole name, wrapping, above its own Bring back", () => {
    openWith([{ ...photo(0), originalName: "01-bowe-front.jpg", setAside: true }]);
    const name = screen.getByText("01-bowe-front.jpg");
    expect(name.className).toContain("wrap-anywhere");
    expect(name.className).not.toContain("truncate");
    const back = screen.getByRole("button", { name: "Bring back 01-bowe-front.jpg" });
    expect(name.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(back.parentElement?.className).toContain("flex-col");
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

  it("Set aside on a failed tile reads the failure reason; on a read photo there's none to read", () => {
    openWith([photo(0), tooBig(1)]);
    const failed = screen.getByRole("button", { name: "Set aside scan-1.jpg" });
    expect(failed.getAttribute("aria-describedby")).toBe("loose-why-1");
    expect(document.getElementById("loose-why-1")?.textContent).toMatch(/Too big/);
    expect(screen.getByRole("button", { name: "Set aside scan-0.jpg" }).getAttribute("aria-describedby")).toBeNull();
  });

  describe("Try again's name", () => {
    const unread = (entryIndex: number, originalName: string) => ({
      entryIndex,
      originalName,
      status: "failed",
      errorCode: "PHOTO_TIMED_OUT",
      retries: 0,
    });
    const retryMutation = () => mocks.mutation("placeholderStream.retryPlaceholderImage");

    it("keeps the plain file name when only one photo has it", async () => {
      retryMutation().mockResolvedValueOnce({ retried: true });
      openWith([unread(0, "a.jpg"), unread(1, "b.jpg")]);
      fireEvent.click(screen.getByRole("button", { name: "Try again: b.jpg" }));
      await waitFor(() => expect(pageApi.inform).toHaveBeenCalledWith("Trying b.jpg again."));
    });

    it("a press from a stale tab on a photo set aside since says so", async () => {
      retryMutation().mockResolvedValueOnce({ retried: false, reason: "set aside" });
      openWith([unread(0, "a.jpg")]);
      fireEvent.click(screen.getByRole("button", { name: "Try again: a.jpg" }));
      await waitFor(() => expect(notify).toHaveBeenCalledWith("That photo was set aside. Bring it back to pair it."));
    });

    it("tells photos of one file name apart, on the button and in the line", async () => {
      retryMutation().mockResolvedValueOnce({ retried: true });
      openWith([unread(0, "image.jpg"), unread(1, "image.jpg")]);
      expect(screen.getByRole("button", { name: "Try again: image.jpg, photo 1" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Try again: image.jpg, photo 2" }));
      await waitFor(() => expect(pageApi.inform).toHaveBeenCalledWith("Trying image.jpg, photo 2 again."));
    });
  });

  describe("a failed photo cropped by hand (NEO-481)", () => {
    const unread = (extra: Record<string, unknown> = {}) => ({
      entryIndex: 0,
      originalName: "a.jpg",
      status: "failed",
      errorCode: "PHOTO_UNREADABLE",
      retries: 0,
      ...extra,
    });
    const rendering = { pendingEdit: { status: "rendering", turns: 0, crop: { x: 0, y: 0, w: 1, h: 1 } } };

    it("while the crop renders, says Touching it up… and offers no Try again", () => {
      openWith([unread(rendering)]);
      expect(screen.getByText("Touching it up…")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Try again: a.jpg" })).toBeNull();
      // Crop by hand stays, so the viewer (which shows the pending state) can be reopened.
      expect(screen.getByRole("button", { name: "Crop by hand: a.jpg" })).toBeTruthy();
      expect(document.getElementById("loose-why-0")?.textContent).toBe("Couldn't read it");
    });

    it("with no edit in flight, the tile is unchanged: Couldn't read it, Crop by hand and Try again", () => {
      openWith([unread()]);
      expect(screen.queryByText("Touching it up…")).toBeNull();
      expect(document.getElementById("loose-why-0")?.textContent).toBe("Couldn't read it");
      expect(screen.getByRole("button", { name: "Crop by hand: a.jpg" })).toBeTruthy();
      const retry = screen.getByRole("button", { name: "Try again: a.jpg" });
      expect(retry.getAttribute("aria-describedby")).toBe("loose-why-0");
    });

    it("when the crop fails to render, Try again comes back beside the failure and Keep the old photo", () => {
      openWith([unread({ pendingEdit: { ...rendering.pendingEdit, status: "failed" } })]);
      expect(screen.queryByText("Touching it up…")).toBeNull();
      expect(screen.getByText("That edit didn't take. Your old photo is still here.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Try again: a.jpg" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Try again: touch up a.jpg" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Keep the old photo: a.jpg" })).toBeTruthy();
    });
  });

  describe("focus after Bring back", () => {
    const heading = () => document.getElementById("intake-pairing");
    const tile = (n: number) => document.querySelector(`[data-loose-photo="${n}"]`);
    /** A run with photo 1 set aside and its Bring back pressed, the write not repainted yet. */
    const pressBack = async () => {
      const runId = freshRunId();
      setRun(runId, { images: [photo(0), { ...photo(1), setAside: true }] });
      const view = render(<Tab runId={runId} />);
      const back = screen.getByRole("button", { name: "Bring back scan-1.jpg" });
      back.focus();
      fireEvent.click(back);
      await act(async () => {});
      const repaint = (images: unknown[], pairs?: unknown[]) => {
        setRun(runId, { images });
        if (pairs) mocks.data.pairs = pairs;
        view.rerender(<Tab runId={runId} />);
      };
      return { back, repaint };
    };

    it("stays on the button until the photo repaints, then lands on its tile", async () => {
      const { back, repaint } = await pressBack();
      expect(document.activeElement).toBe(back);
      repaint([photo(0), photo(1)]);
      await waitFor(() => expect(document.activeElement).toBe(tile(1)));
    });

    it("keeps waiting through a repaint that hasn't brought the photo back yet", async () => {
      const { back, repaint } = await pressBack();
      back.blur();
      repaint([photo(0), { ...photo(1), setAside: true }, photo(2)]);
      await act(async () => {});
      expect(document.activeElement).not.toBe(heading());
      repaint([photo(0), photo(1), photo(2)]);
      await waitFor(() => expect(document.activeElement).toBe(tile(1)));
    });

    it("falls to the Pairing heading when the photo comes back in a pair", async () => {
      const { repaint } = await pressBack();
      repaint([photo(0), photo(1)], [{ frontIndex: 0, backIndex: 1 }]);
      await waitFor(() => expect(document.activeElement).toBe(heading()));
    });

    it("falls to the heading when a re-pair takes the tile away after focus landed", async () => {
      const { repaint } = await pressBack();
      repaint([photo(0), photo(1)]);
      await waitFor(() => expect(document.activeElement).toBe(tile(1)));
      repaint([photo(0), photo(1)], [{ frontIndex: 0, backIndex: 1 }]);
      await waitFor(() => expect(document.activeElement).toBe(heading()));
    });

    it("leaves focus alone once the collector has moved on", async () => {
      const { repaint } = await pressBack();
      const elsewhere = screen.getByRole("button", { name: "Set aside scan-0.jpg" });
      elsewhere.focus();
      repaint([photo(0), photo(1)]);
      await act(async () => {});
      expect(document.activeElement).toBe(elsewhere);
    });

    it("takes nothing after a refused press, and says why", async () => {
      asideMutation().mockRejectedValueOnce(new Error("nope"));
      const { back, repaint } = await pressBack();
      await waitFor(() => expect(notify).toHaveBeenCalled());
      back.blur();
      repaint([photo(0), photo(1)]);
      await act(async () => {});
      expect(document.activeElement).not.toBe(tile(1));
    });
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

  /** The drop zone's file input (the stand-in carries the real zone's name). */
  const zoneInput = () => screen.getByLabelText<HTMLInputElement>(ZONE_NAME);

  beforeEach(() => {
    mocks.data.homes = [{ id: "home1", name: "Binder", kind: "binder" }];
    // Loaded and nothing to hold (a binder): a drop on an open run goes straight up (NEO-452).
    mocks.data.gate = NO_LISTING;
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
      // A refused pile stays held (NEO-452), and a zip can't share a pile with photos,
      // so the photos are a fresh screen.
      cleanup();
      clearAllHeld();
      const photosRun = freshRunId();
      setRun(photosRun);
      open(photosRun);
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
      expect(zoneInput()).toBeTruthy();
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
      expect(screen.queryByLabelText(ZONE_NAME)).toBeNull();
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
      await waitFor(() => expect(document.activeElement).toBe(zoneInput()));
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
      await waitFor(() => expect(document.activeElement).toBe(zoneInput()));
    });

    it("with a send still going the input still takes focus: it is held, never disabled (NEO-452)", async () => {
      const runId = runWithJob({ status: "collecting", mode: "stream" });
      let finish: (v: unknown) => void = () => {};
      mocks.upload.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
      open(runId);
      await drop([file("a.jpg")]);
      expect(lines()).toContain("Sending your photos…");
      fireEvent.click(screen.getByRole("button", { name: "New run" }));
      await act(async () => {});
      expect(url()).toBe("");
      const input = zoneInput();
      expect(input.disabled).toBe(false);
      expect(input.getAttribute("aria-disabled")).toBe("true");
      expect(document.activeElement).toBe(input);
      await act(async () => {
        finish({ ok: true, jobId: `job-${runId}`, kind: "images", uploaded: 1, failed: 0, total: 1 });
      });
    });

    it("Back to the closed run and Forward again doesn't take focus a second time", async () => {
      const runId = runWithJob({ status: "failed", errorCode: "CANCELED", totalImages: 0 });
      open(runId);
      fireEvent.click(screen.getByRole("button", { name: "Start a new run" }));
      await waitFor(() => expect(document.activeElement).toBe(zoneInput()));
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
      expect(document.activeElement).not.toBe(zoneInput());
    });
  });
});

describe("NEO-481: every photo opens the card photo viewer", () => {
  const CARD = "#47 Le'Veon Bell";
  const reviewRow = (extra: Record<string, unknown> = {}) => ({
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
    haveHere: 0,
    ...extra,
  });
  /** One pair waiting in Needs you (or Saved, with `savedAt`), on a binder or box run. */
  const showPair = (
    extra: Record<string, unknown> = {},
    { homeKind = "binder", images = [photo(0), photo(1)] }: { homeKind?: "binder" | "box"; images?: unknown[] } = {},
  ) => {
    const runId = freshRunId();
    setRun(runId, { images, homeKind });
    mocks.data.pairs = [{ frontIndex: 0, backIndex: 1 }];
    mocks.data.matches = [reviewRow(extra)];
    return { runId, ...render(<Tab runId={runId} />) };
  };
  const viewerHeading = (name: string) => screen.queryByRole("heading", { name, level: 2 });
  /** The open card photo viewer (row D's), found by its heading. */
  const viewerOf = (heading: string) =>
    viewerHeading(heading)?.closest<HTMLElement>("[data-card-photo-viewer]") ?? null;
  const closeViewer = () => {
    const heading = viewerHeading(`Front of ${CARD}`) ?? screen.getByRole("heading", { name: /^(Front|Back) of / });
    const panel = heading.closest("[data-card-photo-viewer]") as HTMLElement;
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
  };
  beforeEach(() => {
    // The viewer mints the scan's address and asks where an edit starts when a side opens.
    // The api stand-in names only `module.fn`, so the nested adapters path reaches `useAction` as undefined.
    mocks.mutation(undefined as unknown as string).mockResolvedValue({
      url: "https://scans.example/scan.jpg",
    });
    mocks.mutation("photoEdits.photoEditSource").mockResolvedValue({ mode: "viewOnly", reason: "Just looking." });
  });

  it("a waiting card's front and back each open the viewer on that side, and Close closes it", async () => {
    showPair();
    expect(viewerHeading(`Front of ${CARD}`)).toBeNull();
    const front = screen.getByRole("button", { name: `Open front of ${CARD}` });
    fireEvent.click(front);
    const viewer = viewerOf(`Front of ${CARD}`);
    expect(viewer).toBeTruthy();
    // Both of the pair's scans are in it: it switches sides itself.
    expect(within(viewer!).getByRole("radiogroup", { name: "Which side" })).toBeTruthy();
    closeViewer();
    expect(viewerHeading(`Front of ${CARD}`)).toBeNull();
    // Focus goes back to the photo that opened it.
    await waitFor(() => expect(document.activeElement).toBe(front));
    fireEvent.click(screen.getByRole("button", { name: `Open back of ${CARD}` }));
    expect(viewerHeading(`Back of ${CARD}`)).toBeTruthy();
  });

  describe("focus comes back when the tile moved lanes while the viewer was open", () => {
    const saved = { savedCopyId: "copy1", savedQuantity: 1, savedAt: 5 };

    it("to the same photo in its new lane", async () => {
      const { runId, rerender } = showPair();
      fireEvent.click(screen.getByRole("button", { name: `Open front of ${CARD}` }));
      mocks.data.matches = [reviewRow(saved)];
      rerender(<Tab runId={runId} />);
      closeViewer();
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole("button", { name: `Open saved photo of ${CARD}` })),
      );
    });

    it("to the card's front when the new lane shows only that", async () => {
      const { runId, rerender } = showPair();
      fireEvent.click(screen.getByRole("button", { name: `Open back of ${CARD}` }));
      mocks.data.matches = [reviewRow(saved)];
      rerender(<Tab runId={runId} />);
      fireEvent.click(within(screen.getByRole("heading", { name: `Back of ${CARD}` }).closest<HTMLElement>("[data-card-photo-viewer]")!).getByRole("button", { name: "Close" }));
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole("button", { name: `Open saved photo of ${CARD}` })),
      );
    });

    it("to the lane's heading when no tile shows it any more", async () => {
      const { runId, rerender } = showPair();
      fireEvent.click(screen.getByRole("button", { name: `Open front of ${CARD}` }));
      mocks.data.matches = [reviewRow({ setAside: true })];
      rerender(<Tab runId={runId} />);
      closeViewer();
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Needs you" })));
    });
  });

  it("e on the selected card opens its front, and the tab's keys stop while the viewer is open", () => {
    showPair();
    const yes = screen.getByRole("button", { name: `Yes, save ${CARD}` });
    yes.focus();
    fireEvent.keyDown(yes, { key: "e" });
    expect(viewerHeading(`Front of ${CARD}`)).toBeTruthy();
    fireEvent.keyDown(yes, { key: "s" });
    expect(mocks.mutation("placeholderPairing.swapPairSides")).not.toHaveBeenCalled();
    // Nor a key pressed inside the viewer itself.
    const close = within(viewerOf(`Front of ${CARD}`)!).getByRole("button", { name: "Close" });
    fireEvent.keyDown(close, { key: "o" });
    expect(screen.queryByRole("heading", { name: CARD, level: 2 })).toBeNull();
  });

  it("with the card drawer open, a key from another dialog never reaches the drawer's card", () => {
    showPair();
    const yes = screen.getByRole("button", { name: `Yes, save ${CARD}` });
    yes.focus();
    fireEvent.keyDown(yes, { key: "o" });
    const drawer = document.getElementById("intake-drawer-title")?.closest<HTMLElement>('[role="dialog"]');
    expect(drawer).toBeTruthy();
    // A dialog the tab didn't open (another screen's viewer, say), over the drawer.
    const other = document.createElement("div");
    other.setAttribute("role", "dialog");
    other.setAttribute("aria-labelledby", "someone-else");
    const inside = document.createElement("button");
    other.append(inside);
    document.body.append(other);
    try {
      fireEvent.keyDown(inside, { key: "s" });
      expect(mocks.mutation("placeholderPairing.swapPairSides")).not.toHaveBeenCalled();
      // The drawer's own keys still work.
      fireEvent.keyDown(within(drawer!).getAllByRole("button")[0], { key: "s" });
      expect(mocks.mutation("placeholderPairing.swapPairSides")).toHaveBeenCalled();
    } finally {
      other.remove();
    }
  });

  it("a loose photo opens on its own name; a failed one says Crop by hand, but never one over the pixel ceiling", () => {
    const runId = freshRunId();
    setRun(runId, {
      images: [
        photo(0),
        { entryIndex: 1, originalName: "scan-1.jpg", status: "failed", errorCode: "PHOTO_TIMED_OUT", retries: 0 },
        { entryIndex: 2, originalName: "scan-2.jpg", status: "failed", errorCode: "ENTRY_TOO_MANY_PIXELS", retries: 0 },
      ],
    });
    render(<Tab runId={runId} />);
    fireEvent.click(screen.getByRole("button", { name: "Open photo scan-0.jpg" }));
    const viewer = viewerOf("Front of scan-0.jpg");
    expect(viewer).toBeTruthy();
    // A loose photo has no other side yet.
    expect(within(viewer!).queryByRole("radiogroup", { name: "Which side" })).toBeNull();
    cleanup();
    render(<Tab runId={runId} />);
    const crop = screen.getByRole("button", { name: "Crop by hand: scan-1.jpg" });
    expect(crop.textContent).toBe("Crop by hand");
    fireEvent.click(crop);
    expect(viewerHeading("Front of scan-1.jpg")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Crop by hand: scan-2.jpg" })).toBeNull();
  });

  it("a Saved tile opens its scans until the line's photos show; while they are on their way, the viewer says so", () => {
    showPair({ savedCopyId: "copy1", savedQuantity: 1, savedAt: 5, photos: "attached" });
    fireEvent.click(screen.getByRole("button", { name: `Open saved photo of ${CARD}` }));
    expect(viewerHeading(`Front of ${CARD}`)).toBeTruthy();
    expect(screen.queryByText("Photos are on their way.")).toBeNull();
    cleanup();
    showPair({ savedCopyId: "copy1", savedQuantity: 1, savedAt: 5, photos: "pending" });
    fireEvent.click(screen.getByRole("button", { name: `Open saved photo of ${CARD}` }));
    expect(screen.getByText("Photos are on their way.")).toBeTruthy();
  });

  describe("a Saved tile with the line's own photos", () => {
    const urls = { imageUrl: "https://photos.example/image.jpg", thumbUrl: "https://photos.example/thumb.jpg" };
    const crop = { cx: 5, cy: 7, w: 4, h: 6, angle: 0, srcW: 10, srcH: 14 };
    const saved = { savedCopyId: "copy1", savedQuantity: 1, savedAt: 5, photos: "attached" };

    it("shows the line's photo and opens the line's photos, through the store's copy-photo source", () => {
      mocks.data.linePhotos = [{ copyId: "copy1", front: urls, back: urls }];
      const usePhotoSource = vi.fn((_copy: { id: string }, label: string) => ({
        label,
        front: { imageUrl: urls.imageUrl, previewKey: "copy:copy1:front", viewOnly: "Store says hi." },
      }));
      mocks.data.copyPhotos = { usePhotoSource };
      showPair(saved);
      const open = screen.getByRole("button", { name: `Open saved photo of ${CARD}` });
      expect(within(open).getByRole("img", { name: `Front of ${CARD}` }).getAttribute("src")).toBe(urls.thumbUrl);
      fireEvent.click(open);
      expect(viewerHeading(`Front of ${CARD}`)).toBeTruthy();
      expect(usePhotoSource).toHaveBeenCalledWith({ id: "copy1" }, CARD, { front: urls, back: urls });
      expect(screen.getByText("Store says hi.")).toBeTruthy();
    });

    it("a store with no viewer source opens them to look at only", () => {
      mocks.data.linePhotos = [{ copyId: "copy1", front: urls }];
      showPair(saved);
      fireEvent.click(screen.getByRole("button", { name: `Open saved photo of ${CARD}` }));
      expect(screen.getByText("These photos can't be turned or cropped here.")).toBeTruthy();
    });

    it("says on the tile when the line's photo is touching up, and when its edit failed, to open it to try again", () => {
      mocks.data.linePhotos = [
        { copyId: "copy1", front: urls, edits: [{ side: "front", status: "rendering", turns: 1, crop, requestedAt: 1 }] },
      ];
      showPair(saved);
      expect(screen.getByText("Touching it up…")).toBeTruthy();
      cleanup();
      mocks.data.linePhotos = [
        {
          copyId: "copy1",
          front: urls,
          edits: [{ side: "front", status: "failed", error: "RENDER_FAILED", turns: 1, crop, requestedAt: 1 }],
        },
      ];
      showPair(saved);
      expect(
        screen.getByText("That edit didn't take. Your old photo is still here. Open the front photo to try again."),
      ).toBeTruthy();
    });
  });

  describe("an edit rendering in the background", () => {
    const pending = (extra: Record<string, unknown>) => ({
      turns: 1,
      crop: null,
      version: 2,
      requestedAt: 1,
      ...extra,
    });

    it("hands the thumbnail the edit (its chip says Touching it up…), with nothing to press", () => {
      showPair({}, { images: [{ ...photo(0), editVersion: 2, pendingEdit: pending({ status: "rendering" }) }, photo(1)] });
      const front = screen.getByRole("button", { name: `Open front of ${CARD}` });
      expect(front.dataset.pending).toBe("rendering");
      expect(front.dataset.version).toBe("2");
      expect(screen.getByRole("button", { name: `Open back of ${CARD}` }).dataset.pending).toBeUndefined();
      expect(screen.queryByRole("button", { name: /Try again: touch up/ })).toBeNull();
    });

    it("a failed render says why, Try again saves the same edit again, and Keep the old photo drops it", async () => {
      const save = mocks.mutation("photoEdits.saveScanEdit");
      const dismiss = mocks.mutation("photoEdits.dismissPhotoEditFailure");
      const { runId, container, rerender } = showPair(
        {},
        {
          images: [
            { ...photo(0), editVersion: 1, pendingEdit: pending({ status: "failed", error: "ENTRY_NOT_FOUND" }) },
            photo(1),
          ],
        },
      );
      expect(screen.getByText(/The original scan just aged out/)).toBeTruthy();
      expect(screen.queryByText("ENTRY_NOT_FOUND")).toBeNull();
      expect(screen.getByRole("button", { name: `Keep the old photo: the front of ${CARD}` })).toBeTruthy();
      await expectAccessibleInBothModes(container, {
        label: "Intake, a tile whose touch-up failed",
        rerender: () => rerender(<Tab runId={runId} />),
      });
      fireEvent.click(screen.getByRole("button", { name: `Try again: touch up the front of ${CARD}` }));
      await waitFor(() =>
        expect(save).toHaveBeenCalledWith({
          jobId: `job-${runId}`,
          entryIndex: 0,
          edit: { turns: 1, crop: null },
          expectVersion: 1,
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: `Keep the old photo: the front of ${CARD}` }));
      await waitFor(() =>
        expect(dismiss).toHaveBeenCalledWith({ ref: { kind: "scan", jobId: `job-${runId}`, entryIndex: 0 } }),
      );
    });
  });

  describe("the per-card price (box runs only)", () => {
    const priceField = () => screen.queryByRole<HTMLInputElement>("textbox", { name: `Price, ${CARD}` });
    const setPrice = () => mocks.mutation("intakeRuns.setIntakeMatchPrice");
    const save = () => mocks.mutation("intakeRuns.saveIntakeMatch");
    const boxWithMin = (minPriceCents?: number, extra: Record<string, unknown> = {}) => {
      const view = showPair(extra, { homeKind: "box" });
      mocks.data.run = { ...(mocks.data.run as object), defaults: minPriceCents === undefined ? undefined : { minPriceCents } };
      view.rerender(<Tab runId={view.runId} />);
      return view;
    };

    it("a binder's cards never show a price; the count is still there", () => {
      showPair();
      expect(screen.getByRole("textbox", { name: "Count" })).toBeTruthy();
      expect(priceField()).toBeNull();
    });

    it("a box's cards start at the run's Min price, else the common price", () => {
      boxWithMin(150);
      expect(priceField()?.value).toBe("1.50");
      cleanup();
      mocks.data.common = { v1: 0.4 };
      boxWithMin(undefined);
      expect(priceField()?.value).toBe("0.40");
    });

    it("shows the card's own kept price over the default", () => {
      boxWithMin(150, { minPriceCents: 325 });
      expect(priceField()?.value).toBe("3.25");
    });

    it("p jumps to the selected card's price", () => {
      boxWithMin(150);
      const yes = screen.getByRole("button", { name: `Yes, save ${CARD}` });
      yes.focus();
      fireEvent.keyDown(yes, { key: "p" });
      expect(document.activeElement).toBe(priceField());
    });

    it("Enter keeps a new price on the card and saves it at that price, never a common price", async () => {
      const { runId } = boxWithMin(150);
      const field = priceField()!;
      fireEvent.change(field, { target: { value: "2.50" } });
      fireEvent.keyDown(field, { key: "Enter" });
      await waitFor(() =>
        expect(save()).toHaveBeenCalledWith({ runId, pairId: "pair1", quantity: 1, details: { minPriceCents: 250 } }),
      );
      expect(setPrice()).toHaveBeenCalledWith({ runId, pairId: "pair1", priceCents: 250 });
      expect(mocks.setCommon).not.toHaveBeenCalled();
    });

    it("Enter on the price it started at, or a blank, writes nothing and saves at the default", async () => {
      const { runId } = boxWithMin(150);
      fireEvent.keyDown(priceField()!, { key: "Enter" });
      await waitFor(() => expect(save()).toHaveBeenCalledWith({ runId, pairId: "pair1", quantity: 1 }));
      expect(setPrice()).not.toHaveBeenCalled();
      cleanup();
      save().mockClear();
      const second = boxWithMin(150);
      fireEvent.change(priceField()!, { target: { value: "" } });
      fireEvent.keyDown(priceField()!, { key: "Enter" });
      await waitFor(() => expect(save()).toHaveBeenCalledWith({ runId: second.runId, pairId: "pair1", quantity: 1 }));
      expect(setPrice()).not.toHaveBeenCalled();
    });

    it("going back to the default clears a kept price rather than writing the default down", async () => {
      const { runId } = boxWithMin(150, { minPriceCents: 325 });
      const field = priceField()!;
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: "1.50" } });
      fireEvent.blur(field);
      await waitFor(() => expect(setPrice()).toHaveBeenCalledWith({ runId, pairId: "pair1", priceCents: null }));
      expect(save()).not.toHaveBeenCalled();
    });

    it("Escape puts back what it showed; a price that doesn't parse says so under the field and saves nothing", async () => {
      const { container, rerender, runId } = boxWithMin(150);
      const field = priceField()!;
      fireEvent.change(field, { target: { value: "9" } });
      fireEvent.keyDown(field, { key: "Escape" });
      expect(field.value).toBe("1.50");
      fireEvent.change(field, { target: { value: "1.2.3" } });
      fireEvent.keyDown(field, { key: "Enter" });
      const why = screen.getByText("That price doesn't look right. Try something like 1.50.");
      expect(why.getAttribute("role")).toBe("alert");
      // The field keeps what was typed, marked and described by the line under it.
      expect(field.value).toBe("1.2.3");
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(why.id);
      expect(notify).not.toHaveBeenCalled();
      expect(save()).not.toHaveBeenCalled();
      expect(setPrice()).not.toHaveBeenCalled();
      // Leaving the field keeps nothing either.
      fireEvent.blur(field);
      expect(setPrice()).not.toHaveBeenCalled();
      await expectAccessibleInBothModes(container, {
        label: "Intake, a card price that doesn't parse",
        rerender: () => rerender(<Tab runId={runId} />),
      });
    });

    it("typing a price clears the line under the field", () => {
      boxWithMin(150);
      const field = priceField()!;
      fireEvent.change(field, { target: { value: "1.2.3" } });
      fireEvent.keyDown(field, { key: "Enter" });
      expect(field.getAttribute("aria-invalid")).toBe("true");
      fireEvent.change(field, { target: { value: "1.25" } });
      expect(screen.queryByText("That price doesn't look right. Try something like 1.50.")).toBeNull();
      expect(field.getAttribute("aria-invalid")).toBeNull();
    });

    it("y in the price is Enter there: a bad price is refused under the field, a good one saves", async () => {
      const { runId } = boxWithMin(150);
      const field = priceField()!;
      fireEvent.change(field, { target: { value: "1.2.3" } });
      fireEvent.keyDown(field, { key: "y" });
      expect(screen.getByText("That price doesn't look right. Try something like 1.50.")).toBeTruthy();
      expect(save()).not.toHaveBeenCalled();
      fireEvent.change(field, { target: { value: "2.75" } });
      fireEvent.keyDown(field, { key: "y" });
      await waitFor(() =>
        expect(save()).toHaveBeenCalledWith({ runId, pairId: "pair1", quantity: 1, details: { minPriceCents: 275 } }),
      );
    });

    describe("a box card saves with a price (Jason, 2026-11-10)", () => {
      const WAIT = INTAKE_NEEDS_PRICE_LINE;
      const yes = () => screen.getByRole("button", { name: `Yes, save ${CARD}` });
      const focusLands = () => waitFor(() => expect(document.activeElement).toBe(priceField()));

      it("with no Min price and no common price the card says so under its price, tied to the field and to Yes", async () => {
        const { container, rerender, runId } = boxWithMin(undefined);
        const line = screen.getByText(WAIT);
        expect(priceField()!.getAttribute("aria-describedby")?.split(" ")).toContain(line.id);
        expect(yes().getAttribute("aria-disabled")).toBe("true");
        expect(yes().getAttribute("aria-describedby")).toBe(line.id);
        await expectAccessibleInBothModes(container, {
          label: "Intake, a box card waiting for a price",
          rerender: () => rerender(<Tab runId={runId} />),
        });
      });

      it("Yes, y and Enter in the count save nothing and send focus to the card's price", async () => {
        boxWithMin(undefined);
        fireEvent.click(yes());
        await focusLands();
        yes().focus();
        fireEvent.keyDown(yes(), { key: "y" });
        await focusLands();
        const count = screen.getByRole("textbox", { name: "Count" });
        count.focus();
        fireEvent.keyDown(count, { key: "Enter" });
        await focusLands();
        expect(save()).not.toHaveBeenCalled();
      });

      it("Enter on a blank price keeps focus there and saves nothing; a typed price saves at it", async () => {
        const { runId } = boxWithMin(undefined);
        const field = priceField()!;
        field.focus();
        fireEvent.keyDown(field, { key: "Enter" });
        await focusLands();
        expect(save()).not.toHaveBeenCalled();
        fireEvent.change(field, { target: { value: "0.75" } });
        fireEvent.keyDown(field, { key: "Enter" });
        await waitFor(() =>
          expect(save()).toHaveBeenCalledWith({ runId, pairId: "pair1", quantity: 1, details: { minPriceCents: 75 } }),
        );
      });

      it("a price typed and left, then Yes, saves: the kept price counts before the row comes back with it", async () => {
        const { runId } = boxWithMin(undefined);
        const field = priceField()!;
        fireEvent.focus(field);
        fireEvent.change(field, { target: { value: "1.25" } });
        fireEvent.blur(field);
        expect(screen.queryByText(WAIT)).toBeNull();
        fireEvent.click(yes());
        await waitFor(() => expect(save()).toHaveBeenCalledWith({ runId, pairId: "pair1", quantity: 1 }));
        expect(setPrice()).toHaveBeenCalledWith({ runId, pairId: "pair1", priceCents: 125 });
      });

      it("the card's own kept price, the run's Min price or a common price each lift it", () => {
        boxWithMin(undefined, { minPriceCents: 300 });
        expect(screen.queryByText(WAIT)).toBeNull();
        cleanup();
        boxWithMin(0);
        expect(screen.queryByText(WAIT)).toBeNull();
        expect(yes().getAttribute("aria-disabled")).toBe("false");
      });

      it("a common price set while the card waits lifts it with nothing retyped", async () => {
        const { rerender, runId } = boxWithMin(undefined);
        expect(screen.getByText(WAIT)).toBeTruthy();
        mocks.data.common = { v1: 0.4 };
        rerender(<Tab runId={runId} />);
        expect(screen.queryByText(WAIT)).toBeNull();
        fireEvent.click(yes());
        await waitFor(() => expect(save()).toHaveBeenCalledWith({ runId, pairId: "pair1", quantity: 1 }));
      });

      it("says nothing while the common price is still on its way; the server judges", () => {
        mocks.data.common = undefined;
        boxWithMin(undefined);
        expect(screen.queryByText(WAIT)).toBeNull();
      });

      it("a binder card never waits for a price", async () => {
        const { runId } = showPair();
        expect(screen.queryByText(WAIT)).toBeNull();
        fireEvent.click(yes());
        await waitFor(() => expect(save()).toHaveBeenCalledWith({ runId, pairId: "pair1", quantity: 1 }));
      });

      it("the drawer's Save this card waits too, and sends focus to the drawer's price", async () => {
        boxWithMin(undefined);
        fireEvent.click(screen.getByRole("button", { name: `Review ${CARD}` }));
        const dialog = screen.getByRole("dialog");
        const saveCard = within(dialog).getByRole("button", { name: "Save this card" });
        const drawerPrice = within(dialog).getByRole("textbox", { name: `Price, ${CARD}` });
        const line = within(dialog).getByText(WAIT);
        expect(saveCard.getAttribute("aria-disabled")).toBe("true");
        expect(saveCard.getAttribute("aria-describedby")).toBe(line.id);
        fireEvent.click(saveCard);
        await waitFor(() => expect(document.activeElement).toBe(drawerPrice));
        expect(screen.getByRole("dialog")).toBeTruthy();
        expect(save()).not.toHaveBeenCalled();
      });

      it("a refusal from the server for want of a price says so and sends focus to the price", async () => {
        const { runId } = boxWithMin(150);
        save().mockRejectedValueOnce(Object.assign(new Error(WAIT), { data: { code: "INTAKE_NEEDS_PRICE", message: WAIT } }));
        fireEvent.click(yes());
        await waitFor(() => expect(notify).toHaveBeenCalledWith(WAIT));
        await focusLands();
        expect(save()).toHaveBeenCalledWith({ runId, pairId: "pair1", quantity: 1 });
      });

      it("Save N matched saves the priced cards, says how many wait, and lands on the first waiting price", async () => {
        const runId = freshRunId();
        setRun(runId, { images: [photo(0), photo(1), photo(2), photo(3)], homeKind: "box" });
        mocks.data.pairs = [
          { frontIndex: 0, backIndex: 1 },
          { frontIndex: 2, backIndex: 3 },
        ];
        const other = { _id: "card2", cardNumber: "48", cardName: "Antonio Brown" };
        mocks.data.matches = [
          reviewRow({ minPriceCents: 200 }),
          reviewRow({ _id: "match2", pairId: "pair2", frontIndex: 2, backIndex: 3, cardId: "card2", card: other }),
        ];
        render(<Tab runId={runId} />);
        fireEvent.click(screen.getByRole("button", { name: "Save 2 matched" }));
        await waitFor(() => expect(save()).toHaveBeenCalledTimes(1));
        expect(save()).toHaveBeenCalledWith({ runId, pairId: "pair1", quantity: 1 });
        expect(notify).toHaveBeenCalledWith(waitingForPriceLine(1));
        await waitFor(() =>
          expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Price, #48 Antonio Brown" })),
        );
      });
    });
  });
});

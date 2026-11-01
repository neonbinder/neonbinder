/**
 * NEO-370 — the intake tab's leave-guard wiring. After "Done adding photos"
 * the tab arms `useLeaveGuard` until every column but Saved clears; the Done
 * memory (`doneRuns`) outlives a remount; a refused close disarms; a Back
 * answered "Stay" parks focus on Done, else the Pairing heading.
 *
 * The guard itself is the real hook (its own test pins the DOM mechanics);
 * the wrapper below only records the options the tab hands it.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageApiContext, type PageApi } from "../pageApi";
import { LEAVE_INTAKE_LINE } from "./realLanes";
import RealAddCardsTab from "./RealAddCardsTab";

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
    },
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
  useSide: () => "collection",
  useContainers: () => [],
  homesOnSide: () => [],
  useDefaultCondition: () => "Near Mint",
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
vi.mock("@/app/print/placeholders/dropzone", () => ({ Dropzone: () => <div>dropzone</div> }));
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

function setRun(runId: string, { open = true, images = [photo(0)] }: { open?: boolean; images?: unknown[] } = {}) {
  mocks.data.run = {
    _id: runId,
    jobId: `job-${runId}`,
    homeId: "home1",
    homeName: "Binder",
    homeKind: "binder",
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

/**
 * NEO-170 — the operator's pipeline view and its abort lever.
 *
 * Two things here are load-bearing enough to pin down, and neither is visible
 * in a screenshot:
 *
 * 1. **Abort appears on exactly the non-terminal runs.** The button is the only
 *    way to stop a wedged batch, and offering it on a run that already finished
 *    sends an admin into another user's job for a no-op. The status list is a
 *    Convex union that has grown twice already (NEO-170 added "collecting"), so
 *    the rule is asserted as "everything except succeeded/failed", not as a
 *    fixed list of buttons.
 * 2. **The confirm step actually confirms.** A destructive cross-user action
 *    behind a dialog is only safe if the dialog can also be BACKED OUT of, so
 *    Escape-without-mutation is a case here alongside the happy path.
 *
 * The relative timestamps are not re-asserted — lib/time/relative-time.test.ts
 * owns those boundaries, and repeating them here would only duplicate coverage.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `?raw` gives the route table as text. Importing src/main.tsx for real would
// run it — it calls createRoot(...).render() on module load.
import mainSource from "@/src/main.tsx?raw";
import { NAV_ITEMS } from "@/components/modules/binder-tabs";

type Run = {
  jobId: string;
  userId: string;
  mode: "zip" | "stream";
  status: string;
  totalImages: number;
  processedImages: number;
  failedImages: number;
  rejectedEntries: number;
  createdAt: number;
  lastActivityAt?: number;
  errorCode?: string;
};

const mocks = vi.hoisted(() => ({
  runs: undefined as unknown[] | undefined,
  abort: vi.fn(),
}));

// Plain string tokens for the generated api, so `useMutation` can be told apart
// from `useQuery` without a real Convex client — the house style (see
// components/modules/profile-credentials-panel.test.tsx).
vi.mock("@/convex/_generated/api", () => ({
  api: {
    placeholderPipeline: {
      adminListPlaceholderJobs: "placeholderPipeline:adminListPlaceholderJobs",
      adminCancelPlaceholderBatch:
        "placeholderPipeline:adminCancelPlaceholderBatch",
    },
  },
}));

vi.mock("convex/react", () => ({
  useQuery: () => mocks.runs,
  useMutation: () => mocks.abort,
  useAction: () => vi.fn(),
}));

import PipelineRunsPage from "./page";

const NOW = Date.now();

function run(overrides: Partial<Run> = {}): Run {
  return {
    jobId: "3f2a1b8c-1111-2222-3333-444455556666",
    userId: "user_2abcDEF",
    mode: "zip",
    status: "processing",
    totalImages: 40,
    processedImages: 10,
    failedImages: 2,
    rejectedEntries: 0,
    createdAt: NOW - 5 * 60_000,
    lastActivityAt: NOW - 60_000,
    ...overrides,
  };
}

function rowFor(shortId: string): HTMLElement {
  return screen
    .getByRole("heading", { name: `Run ${shortId}` })
    .closest("li") as HTMLElement;
}

describe("PipelineRunsPage", () => {
  beforeEach(() => {
    mocks.runs = undefined;
    mocks.abort = vi.fn().mockResolvedValue({ canceled: true, canceledCount: 7 });
  });

  it("says it is loading before the subscription resolves", () => {
    render(<PipelineRunsPage />);
    expect(screen.getByText("Loading pipeline runs…")).not.toBeNull();
  });

  it("explains an empty list instead of showing a bare page", () => {
    mocks.runs = [];
    render(<PipelineRunsPage />);
    expect(
      screen.getByText(/No pipeline runs yet\./),
    ).not.toBeNull();
  });

  it("shows owner, mode, status and progress for each run", () => {
    mocks.runs = [
      run(),
      run({
        jobId: "aaaabbbb-9999-0000-1111-222233334444",
        userId: "user_9zzz",
        mode: "stream",
        status: "succeeded",
        processedImages: 12,
        totalImages: 12,
        failedImages: 0,
      }),
    ];
    render(<PipelineRunsPage />);

    const first = within(rowFor("3f2a1b8c"));
    expect(first.getByText("user_2abcDEF")).not.toBeNull();
    expect(first.getByText("Zip upload")).not.toBeNull();
    expect(first.getByText("Processing")).not.toBeNull();
    // One composed sentence, not three numbers: the E2E driver asserts the
    // string it can see, and progress read as separate cells cannot be matched.
    expect(first.getByText("12 of 40 images, 2 failed")).not.toBeNull();

    const second = within(rowFor("aaaabbbb"));
    expect(second.getByText("Scanner stream")).not.toBeNull();
    expect(second.getByText("Succeeded")).not.toBeNull();
    expect(second.getByText("12 of 12 images")).not.toBeNull();
  });

  it("surfaces the error code on a failed run", () => {
    mocks.runs = [run({ status: "failed", errorCode: "CANCELED" })];
    render(<PipelineRunsPage />);
    expect(within(rowFor("3f2a1b8c")).getByText("CANCELED")).not.toBeNull();
  });

  it.each([
    "pending",
    "uploaded",
    "collecting",
    "extracting",
    "processing",
    "pairing",
  ])("offers Abort on a %s run", (status) => {
    mocks.runs = [run({ status })];
    render(<PipelineRunsPage />);
    // Named per RUN, not just "Abort" — twenty identical buttons are unusable
    // to a screen reader.
    expect(
      screen.getByRole("button", { name: "Abort run 3f2a1b8c" }),
    ).not.toBeNull();
  });

  it.each(["succeeded", "failed"])(
    "offers no Abort on a %s run",
    (status) => {
      mocks.runs = [run({ status })];
      render(<PipelineRunsPage />);
      expect(screen.queryByRole("button", { name: /^Abort run/ })).toBeNull();
    },
  );

  it("aborts the run the button belongs to, and reports what was canceled", async () => {
    mocks.runs = [
      run(),
      run({ jobId: "aaaabbbb-9999-0000-1111-222233334444", status: "pairing" }),
    ];
    render(<PipelineRunsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Abort run aaaabbbb" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Abort run aaaabbbb?")).not.toBeNull();
    // Nothing has happened yet — the dialog is a gate, not a delay.
    expect(mocks.abort).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, Abort" }));

    await waitFor(() =>
      expect(mocks.abort).toHaveBeenCalledWith({
        jobId: "aaaabbbb-9999-0000-1111-222233334444",
      }),
    );
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.getByText("Aborted run aaaabbbb — 7 queued images canceled."),
      ).not.toBeNull(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reports a run that finished before the click landed, without calling it an error", async () => {
    mocks.runs = [run()];
    mocks.abort = vi.fn().mockResolvedValue({
      canceled: false,
      canceledCount: 0,
      reason: "job is already succeeded",
    });
    render(<PipelineRunsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Abort run 3f2a1b8c" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, Abort" }));

    const notice = await screen.findByText(
      "Run 3f2a1b8c was not aborted — job is already succeeded.",
    );
    // role="status", not "alert": the run reaching a terminal state on its own
    // is ordinary, and colouring it red sends an operator looking for a fault.
    expect(notice.getAttribute("role")).toBe("status");
  });

  it("says so when the mutation throws", async () => {
    mocks.runs = [run()];
    mocks.abort = vi.fn().mockRejectedValue(new Error("network"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<PipelineRunsPage />);
      fireEvent.click(screen.getByRole("button", { name: "Abort run 3f2a1b8c" }));
      fireEvent.click(screen.getByRole("button", { name: "Yes, Abort" }));
      const notice = await screen.findByText(
        "Couldn't abort run 3f2a1b8c. Please try again.",
      );
      expect(notice.getAttribute("role")).toBe("alert");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("backs out on Escape without touching the run", () => {
    mocks.runs = [run()];
    render(<PipelineRunsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Abort run 3f2a1b8c" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.abort).not.toHaveBeenCalled();
  });

  it("opens with focus on Cancel, so a reflexive Enter is the safe one", async () => {
    mocks.runs = [run()];
    render(<PipelineRunsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Abort run 3f2a1b8c" }));
    const dialog = screen.getByRole("dialog");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });

    // An earlier version focused the dialog container and treated Enter as
    // "confirm", so the first keystroke on a just-announced confirm dialog
    // aborted somebody's run (WCAG 3.3.4). Enter still confirms — one Tab away,
    // on the confirm button's own activation.
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(cancel, { key: "Enter" });
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.abort).not.toHaveBeenCalled();
  });

  it("is reachable — main.tsx routes /pipeline-runs behind the admin guard", () => {
    expect(mainSource).toContain('from "@/app/pipeline-runs/page"');
    expect(mainSource).toMatch(
      /path="\/pipeline-runs"\s+element=\{<PipelineRuns \/>\}/,
    );
    // Inside the <AdminLayout> block, not merely inside ProtectedLayout: every
    // signed-in user would otherwise reach every other user's job ids by URL.
    const adminBlock = mainSource.slice(
      mainSource.indexOf("<Route element={<AdminLayout />}>"),
    );
    expect(adminBlock.slice(0, adminBlock.indexOf("</Route>"))).toContain(
      '"/pipeline-runs"',
    );
  });

  it("is in the nav as an admin-only tab", () => {
    const item = NAV_ITEMS.find((navItem) => navItem.path === "/pipeline-runs");
    expect(item?.label).toBe("Pipeline Runs");
    expect(item?.requiresAdmin).toBe(true);
  });
});

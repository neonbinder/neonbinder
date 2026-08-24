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
import { SECTIONS } from "@/src/layouts/admin-section-layout";

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
  source?: "scanner" | "web";
};

const mocks = vi.hoisted(() => ({
  runs: undefined as unknown[] | undefined,
  abort: vi.fn(),
  // The owner-label resolver. Stable across renders so a test can assert it was
  // called ONCE for the distinct id set.
  resolveOwner: vi.fn(),
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
  // The page resolves the owner action through `makeFunctionReference`, so
  // `useAction` receives a FunctionReference object rather than a token; there
  // is only one action on the page, so the mock can ignore it.
  useAction: () => mocks.resolveOwner,
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
    // Default: resolver returns no labels, so owners fall back to their ids.
    mocks.resolveOwner = vi.fn().mockResolvedValue({});
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
    // Owner falls back to the raw id until label resolution returns (the mocked
    // action returns nothing here), so the id is what shows.
    expect(first.getByText("user_2abcDEF")).not.toBeNull();
    expect(first.getByText("Zip upload")).not.toBeNull();
    expect(first.getByText("Processing")).not.toBeNull();
    // One composed sentence, not three numbers: the E2E driver asserts the
    // string it can see, and progress read as separate cells cannot be matched.
    // 40 total, 10 processed + 2 failed = 12 done, 28 still queued.
    expect(
      first.getByText("12 of 40 images · 28 in queue · 2 failed"),
    ).not.toBeNull();

    const second = within(rowFor("aaaabbbb"));
    expect(second.getByText("Scanner stream")).not.toBeNull();
    expect(second.getByText("Succeeded")).not.toBeNull();
    // Nothing failed and nothing left — the queue count still reads, as 0.
    expect(second.getByText("12 of 12 images · 0 in queue")).not.toBeNull();
  });

  it("surfaces the error code on a failed run", () => {
    mocks.runs = [run({ status: "failed", errorCode: "CANCELED" })];
    render(<PipelineRunsPage />);
    expect(within(rowFor("3f2a1b8c")).getByText("CANCELED")).not.toBeNull();
  });

  it("labels the source as scanner, web, or an em dash when absent", () => {
    mocks.runs = [
      run({ jobId: "1111aaaa-0000-0000-0000-000000000000", source: "scanner" }),
      run({ jobId: "2222bbbb-0000-0000-0000-000000000000", source: "web" }),
      run({ jobId: "3333cccc-0000-0000-0000-000000000000" }),
    ];
    render(<PipelineRunsPage />);
    expect(within(rowFor("1111aaaa")).getByText("Scanner")).not.toBeNull();
    expect(within(rowFor("2222bbbb")).getByText("Web app")).not.toBeNull();
    // Absent → em dash, never a guess. The word carries it, not colour.
    expect(within(rowFor("3333cccc")).getByText("—")).not.toBeNull();
  });

  describe("owner labels", () => {
    it("resolves the distinct owner set exactly once and renders the labels", async () => {
      mocks.resolveOwner = vi.fn().mockResolvedValue({
        user_2abcDEF: "ken@example.com",
        user_9zzz: "griffey",
      });
      mocks.runs = [
        run({ jobId: "1111aaaa-0000-0000-0000-000000000000", userId: "user_2abcDEF" }),
        run({ jobId: "2222bbbb-0000-0000-0000-000000000000", userId: "user_9zzz" }),
        // A THIRD row owned by the first user — the resolver must still be
        // handed each id once, not once per row.
        run({ jobId: "3333cccc-0000-0000-0000-000000000000", userId: "user_2abcDEF" }),
      ];
      render(<PipelineRunsPage />);

      await waitFor(() =>
        expect(within(rowFor("1111aaaa")).getByText("ken@example.com")).not.toBeNull(),
      );
      expect(within(rowFor("2222bbbb")).getByText("griffey")).not.toBeNull();
      // The reused owner id resolves from the same single call.
      expect(within(rowFor("3333cccc")).getByText("ken@example.com")).not.toBeNull();

      expect(mocks.resolveOwner).toHaveBeenCalledTimes(1);
      const arg = mocks.resolveOwner.mock.calls[0][0] as { userIds: string[] };
      expect([...arg.userIds].sort()).toEqual(["user_2abcDEF", "user_9zzz"]);

      // The raw id is folded into the accessible name once a label resolves —
      // a `title` tooltip is mouse-only, and support needs the id from the
      // keyboard too (WCAG-equitable access).
      expect(
        within(rowFor("1111aaaa")).getByText("ken@example.com").getAttribute("aria-label"),
      ).toBe("ken@example.com (id user_2abcDEF)");
    });

    it("shows the raw id until (and if) resolution returns nothing", async () => {
      // The default resolver returns {}. The owner must render as its id, never
      // blank, and the id stays available for support.
      mocks.runs = [run({ userId: "user_2abcDEF" })];
      render(<PipelineRunsPage />);
      const owner = within(rowFor("3f2a1b8c")).getByText("user_2abcDEF");
      expect(owner).not.toBeNull();
      expect(owner.getAttribute("title")).toBe("user_2abcDEF");
    });
  });

  describe("filter and sort", () => {
    const A = "1111aaaa-0000-0000-0000-000000000000";
    const B = "2222bbbb-0000-0000-0000-000000000000";
    const C = "3333cccc-0000-0000-0000-000000000000";

    function threeRuns() {
      mocks.runs = [
        run({ jobId: A, status: "collecting", createdAt: 100, lastActivityAt: 100, errorCode: undefined }),
        run({ jobId: B, status: "failed", createdAt: 300, lastActivityAt: 300, errorCode: "CANCELED" }),
        run({ jobId: C, status: "processing", createdAt: 200, lastActivityAt: 500, errorCode: undefined }),
      ];
    }

    /** The rendered rows' short ids, top to bottom. Run cards head with h3 —
     * the page's own h2 sits under the Admin section layout's h1. */
    function renderedOrder(): string[] {
      return screen
        .getAllByRole("heading", { level: 3 })
        .map((h) => (h.textContent ?? "").replace("Run ", ""));
    }

    it("defaults to last-activity descending", () => {
      threeRuns();
      render(<PipelineRunsPage />);
      // C (500) > B (300) > A (100).
      expect(renderedOrder()).toEqual(["3333cccc", "2222bbbb", "1111aaaa"]);
      expect(
        (screen.getByLabelText("Sort by") as HTMLSelectElement).value,
      ).toBe("lastActivity");
    });

    it("re-sorts by created when chosen", () => {
      threeRuns();
      render(<PipelineRunsPage />);
      fireEvent.change(screen.getByLabelText("Sort by"), {
        target: { value: "created" },
      });
      // B (300) > C (200) > A (100).
      expect(renderedOrder()).toEqual(["2222bbbb", "3333cccc", "1111aaaa"]);
    });

    it("re-sorts by error, grouping coded runs first and nulls last", () => {
      threeRuns();
      render(<PipelineRunsPage />);
      fireEvent.change(screen.getByLabelText("Sort by"), {
        target: { value: "error" },
      });
      // B has CANCELED; A and C have none → they follow, newest-created first.
      expect(renderedOrder()).toEqual(["2222bbbb", "3333cccc", "1111aaaa"]);
    });

    it("narrows to a single status when a filter chip is pressed", () => {
      threeRuns();
      render(<PipelineRunsPage />);
      const chip = screen.getByRole("button", { name: "Collecting" });
      fireEvent.click(chip);
      expect(renderedOrder()).toEqual(["1111aaaa"]);
      expect(chip.getAttribute("aria-pressed")).toBe("true");
      // The active chip carries a non-colour cue (WCAG 1.4.1): the green and
      // grey tints are ~1.1:1 apart in luminance, so the checkmark is what
      // distinguishes "selected" without colour. It stays out of the accessible
      // name — `getByRole({name: "Collecting"})` above still resolves it.
      expect(chip.textContent).toContain("✓");
      expect(
        screen.getByRole("button", { name: "All" }).textContent,
      ).not.toContain("✓");
    });

    it("announces an empty filtered view through a live region", () => {
      threeRuns();
      render(<PipelineRunsPage />);
      // No run is pairing.
      fireEvent.click(screen.getByRole("button", { name: "Pairing" }));
      expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
      const message = screen.getByText(/No runs match this filter/);
      // Selecting a zero-match filter must be announced, not left for the user
      // to discover by navigating into an emptied list (WCAG 4.1.3).
      expect(message.closest("[role='status'][aria-live='polite']")).not.toBeNull();
    });

    it("says the view is limited to the loaded page", () => {
      threeRuns();
      render(<PipelineRunsPage />);
      expect(
        screen.getByText(/Filters and sorting apply to these, not the full history/),
      ).not.toBeNull();
    });
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

  it("is reachable — main.tsx routes it under /admin behind the admin guard", () => {
    expect(mainSource).toContain('from "@/app/pipeline-runs/page"');
    // NEO-155 folded this into the /admin section; the top-level era's URL
    // redirects rather than 404ing.
    expect(mainSource).toMatch(
      /path="pipeline-runs"\s+element=\{<PipelineRuns \/>\}/,
    );
    expect(mainSource).toMatch(
      /path="\/pipeline-runs"\s+element=\{<Navigate to="\/admin\/pipeline-runs" replace \/>\}/,
    );
    // Inside the <AdminLayout> block, not merely inside ProtectedLayout: every
    // signed-in user would otherwise reach every other user's job ids by URL.
    const adminBlock = mainSource.slice(
      mainSource.indexOf("<Route element={<AdminLayout />}>"),
    );
    expect(adminBlock.slice(0, adminBlock.indexOf("</Route>"))).toContain(
      'path="pipeline-runs"',
    );
  });

  it("is an admin-section tool behind the admin-only nav tab", () => {
    // The top-level "Pipeline Runs" tab folded into the Admin section tab
    // (NEO-155): the door in the nav is Admin, the tool is a SECTIONS entry.
    expect(NAV_ITEMS.some((navItem) => navItem.path === "/pipeline-runs")).toBe(
      false,
    );
    expect(NAV_ITEMS.find((navItem) => navItem.path === "/admin")?.requiresAdmin).toBe(
      true,
    );
    const section = SECTIONS.find(
      (s) => s.path === "/admin/pipeline-runs",
    );
    expect(section?.label).toBe("Pipeline Runs");
  });
});

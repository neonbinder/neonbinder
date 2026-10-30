import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import type { Id } from "@/convex/_generated/dataModel";
import { ScannerJoin, startRefusal } from "./ScannerJoin";

/**
 * NEO-386 — "Use a scanner": which writes each path makes, what it says when
 * the server refuses, and that the code takes focus once it shows.
 */
const calls = vi.hoisted(() => ({
  start: vi.fn(),
  create: vi.fn(),
  mint: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(ref);
    if (name === "placeholderStream:startPlaceholderStream") return calls.start;
    if (name === "intakeRuns:createIntakeRun") return calls.create;
    if (name === "intakeScanner:scannerCodeForIntakeRun") return calls.mint;
    throw new Error(`unexpected mutation ${name}`);
  },
}));

const RUN = "run1" as Id<"intakeRuns">;
const HOME = "home1" as Id<"collectionContainers">;

beforeEach(() => {
  calls.start.mockReset().mockResolvedValue({ started: true, jobId: "job-1" });
  calls.create.mockReset().mockResolvedValue(RUN);
  calls.mint.mockReset().mockResolvedValue("AB3X7K");
});
afterEach(cleanup);

function renderJoin(props: Partial<Parameters<typeof ScannerJoin>[0]> = {}) {
  const onRunStarted = vi.fn();
  const view = render(
    <ScannerJoin runId={null} newRun={{ homeId: HOME }} kind="binder" onRunStarted={onRunStarted} {...props} />,
  );
  return { onRunStarted, view };
}

describe("ScannerJoin", () => {
  it("with no run, starts a scanner session and a run, then shows the run's code", async () => {
    const { onRunStarted, view } = renderJoin();
    fireEvent.click(screen.getByRole("button", { name: "Use a scanner" }));
    await waitFor(() => expect(onRunStarted).toHaveBeenCalledWith(RUN));
    expect(calls.start).toHaveBeenCalledWith({ source: "scanner" });
    expect(calls.create).toHaveBeenCalledWith({ homeId: HOME, jobId: "job-1" });
    // The parent opens the run; the code shows for it.
    view.rerender(<ScannerJoin runId={RUN} newRun={{ homeId: HOME }} kind="binder" onRunStarted={onRunStarted} />);
    const panel = await screen.findByRole("group", { name: "Scanner code" });
    expect(panel.textContent).toContain("Type this code in NeonBinder Scanner");
    // The code and the how-to are read out with the group, not just its name.
    expect(panel.getAttribute("aria-describedby")?.split(" ").map((id) => document.getElementById(id)?.textContent)).toEqual([
      "A B 3 X 7 K",
      expect.stringContaining("Type this code"),
    ]);
    expect(within(panel).getByRole("link", { name: /^Apple chip/ }).getAttribute("href")).toMatch(/scanner-mac-arm64\.zip$/);
    expect(within(panel).getByRole("link", { name: /^Intel chip/ }).getAttribute("href")).toMatch(/scanner-mac-x64\.zip$/);
    expect(within(panel).getByRole("link", { name: /^API key/ }).getAttribute("href")).toBe("/profile/api-keys");
    await waitFor(() => expect(document.activeElement).toBe(panel));
  });

  it("with a run open, gets that run's code and starts nothing", async () => {
    const { onRunStarted } = renderJoin({ runId: RUN });
    fireEvent.click(screen.getByRole("button", { name: "Use a scanner" }));
    expect(await screen.findByRole("group", { name: "Scanner code" })).toBeTruthy();
    expect(calls.mint).toHaveBeenCalledWith({ runId: RUN });
    expect(calls.start).not.toHaveBeenCalled();
    expect(calls.create).not.toHaveBeenCalled();
    expect(onRunStarted).not.toHaveBeenCalled();
  });

  it("with nowhere to file, says to make one", async () => {
    renderJoin({ newRun: null, kind: "box" });
    fireEvent.click(screen.getByRole("button", { name: "Use a scanner" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Make a box first: the cards need somewhere to go.");
    expect(calls.start).not.toHaveBeenCalled();
  });

  it("says so in the screen's words when the server won't start a run", async () => {
    calls.start.mockResolvedValue({
      started: false,
      reason: "you already have 2 active batches (limit 2) — finish or cancel one first",
    });
    renderJoin();
    fireEvent.click(screen.getByRole("button", { name: "Use a scanner" }));
    expect((await screen.findByRole("alert")).textContent).toBe("You've got too many runs going. Finish one first.");
    expect(calls.create).not.toHaveBeenCalled();
  });

  it("shows a failed code request and keeps the button", async () => {
    calls.mint.mockRejectedValue(new Error("Intake run not found"));
    renderJoin({ runId: RUN });
    fireEvent.click(screen.getByRole("button", { name: "Use a scanner" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use a scanner" })).toBeTruthy();
  });
});

describe("startRefusal", () => {
  it("maps the rate limit and anything else", () => {
    expect(startRefusal("you have started 9 batches in the last 10 minutes (limit 8) — wait")).toMatch(/few minutes/);
    expect(startRefusal(undefined)).toBe("Couldn't start a run. Try again.");
  });
});

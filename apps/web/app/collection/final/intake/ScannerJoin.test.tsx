import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  close: vi.fn(),
  mint: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(ref);
    if (name === "placeholderStream:startPlaceholderStream") return calls.start;
    if (name === "intakeRuns:createIntakeRun") return calls.create;
    if (name === "placeholderStream:closePlaceholderStream") return calls.close;
    if (name === "intakeScanner:scannerCodeForIntakeRun") return calls.mint;
    throw new Error(`unexpected mutation ${name}`);
  },
}));

const RUN = "run1" as Id<"intakeRuns">;
const HOME = "home1" as Id<"collectionContainers">;
const VARIANT = "variant1" as Id<"selectorOptions">;
const NEW_RUN = { homeId: HOME, variantId: VARIANT };

beforeEach(() => {
  calls.start.mockReset().mockResolvedValue({ started: true, jobId: "job-1" });
  calls.create.mockReset().mockResolvedValue(RUN);
  calls.close.mockReset().mockResolvedValue(null);
  calls.mint.mockReset().mockResolvedValue("AB3X7K");
});
afterEach(cleanup);

function renderJoin(props: Partial<Parameters<typeof ScannerJoin>[0]> = {}) {
  const onRunStarted = vi.fn();
  const view = render(
    <ScannerJoin runId={null} newRun={NEW_RUN} kind="binder" loading={false} onRunStarted={onRunStarted} {...props} />,
  );
  return { onRunStarted, view };
}

describe("ScannerJoin", () => {
  it("with no run, starts a scanner session and a run, then shows the run's code", async () => {
    const { onRunStarted, view } = renderJoin();
    fireEvent.click(screen.getByRole("button", { name: "Use a scanner" }));
    await waitFor(() => expect(onRunStarted).toHaveBeenCalledWith(RUN));
    expect(calls.start).toHaveBeenCalledWith({ source: "scanner" });
    expect(calls.create).toHaveBeenCalledWith({ homeId: HOME, variantId: VARIANT, jobId: "job-1" });
    // The parent opens the run; the code shows for it.
    view.rerender(
      <ScannerJoin runId={RUN} newRun={NEW_RUN} kind="binder" loading={false} onRunStarted={onRunStarted} />,
    );
    const panel = await screen.findByRole("group", { name: "Scanner code" });
    expect(panel.textContent).toContain("Type or paste this code in NeonBinder Scanner");
    // The code and the how-to are read out with the group, not just its name.
    expect(panel.getAttribute("aria-describedby")?.split(" ").map((id) => document.getElementById(id)?.textContent)).toEqual([
      "A B 3 X 7 K",
      expect.stringContaining("Type or paste this code"),
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

  it("copies the bare code on Copy code, and says how to recover when the clipboard refuses", async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderJoin({ runId: RUN });
    fireEvent.click(screen.getByRole("button", { name: "Use a scanner" }));
    const panel = await screen.findByRole("group", { name: "Scanner code" });
    // Nothing is copied until asked.
    expect(writeText).not.toHaveBeenCalled();
    const copy = within(panel).getByRole("button", { name: "Copy code" });
    fireEvent.click(copy);
    await waitFor(() =>
      expect(within(panel).getByRole("status").textContent).toBe("Scanner code copied. Paste it into NeonBinder Scanner."),
    );
    expect(writeText).toHaveBeenCalledWith("AB3X7K");
    fireEvent.click(copy);
    await waitFor(() =>
      expect(within(panel).getByRole("status").textContent).toBe("Couldn't reach your clipboard. Type the code in by hand."),
    );
  });

  it("with nowhere to file, says to make one", async () => {
    renderJoin({ newRun: null, kind: "box" });
    const button = screen.getByRole("button", { name: "Use a scanner" });
    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toBe("Make a box first: the cards need somewhere to go.");
    expect(calls.start).not.toHaveBeenCalled();
  });

  // NEO-416 — while the homes or the open run are still loading, "no run" and
  // "no home" are not yet true: a click then would start a second run, or say
  // to make a binder the collector already has.
  it("while loading, holds the button (still focusable) and a click starts nothing", async () => {
    renderJoin({ loading: true });
    const button = screen.getByRole("button", { name: "Use a scanner" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    await act(async () => {});
    expect(calls.start).not.toHaveBeenCalled();
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.mint).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("held for a reason: stays on screen, aria-disabled and described by it, and a click starts nothing", async () => {
    renderJoin({ heldReason: "Pick a set first, then get a code." });
    const button = screen.getByRole("button", { name: "Use a scanner" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    const reason = screen.getByText("Pick a set first, then get a code.");
    expect(button.getAttribute("aria-describedby")?.split(" ")).toContain(reason.id);
    fireEvent.click(button);
    await act(async () => {});
    expect(calls.start).not.toHaveBeenCalled();
    expect(calls.create).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("no reason held: nothing is described, and the button works", () => {
    renderJoin();
    const button = screen.getByRole("button", { name: "Use a scanner" });
    expect(button.getAttribute("aria-describedby")).toBeNull();
    expect(button.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("while the homes load, does not say to make one", async () => {
    renderJoin({ loading: true, newRun: null });
    fireEvent.click(screen.getByRole("button", { name: "Use a scanner" }));
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
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

  it("a refused run closes the session it just opened, so it holds no active-batch slot", async () => {
    calls.create.mockRejectedValue(new Error("Pick a set first: cards are matched in it."));
    renderJoin();
    fireEvent.click(screen.getByRole("button", { name: "Use a scanner" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Pick a set first");
    expect(calls.close).toHaveBeenCalledWith({ jobId: "job-1" });
    expect(calls.mint).not.toHaveBeenCalled();
  });

  it("a refused run still says why when closing the session fails too", async () => {
    calls.create.mockRejectedValue(new Error("Pick a set first: cards are matched in it."));
    calls.close.mockRejectedValue(new Error("gone"));
    renderJoin();
    fireEvent.click(screen.getByRole("button", { name: "Use a scanner" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Pick a set first");
    expect(screen.getByRole("button", { name: "Use a scanner" }).getAttribute("aria-disabled")).not.toBe("true");
  });

  it("an open run's code never closes anything", async () => {
    renderJoin({ runId: RUN });
    fireEvent.click(screen.getByRole("button", { name: "Use a scanner" }));
    await screen.findByRole("group", { name: "Scanner code" });
    expect(calls.close).not.toHaveBeenCalled();
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

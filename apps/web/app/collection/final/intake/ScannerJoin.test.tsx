import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import type { Id } from "@/convex/_generated/dataModel";
import { ScannerJoin, SPEECH_AFTER_FOCUS_MS, startRefusal } from "./ScannerJoin";

/**
 * NEO-386 — "Use a scanner": which writes each path makes, what it says when
 * the server refuses, and that the code takes focus once it shows.
 *
 * NEO-459 — the click copies the code too. Whether a real browser honours the
 * gesture is out of reach here; what is pinned is that the write starts inside
 * the click, which is the part this code controls.
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

const COPIED = "Scanner code copied. Paste it into NeonBinder Scanner.";
const REFUSED = "No auto-copy this time. Press Copy scanner code or type the code in by hand.";
/** The line waits a beat after focus moves, so finding it allows for a loaded machine. */
const SAID = { timeout: 5000 };

/** Stands in for the browser's: holds what it was made with. */
class FakeClipboardItem {
  constructor(readonly parts: Record<string, Promise<Blob>>) {}
}
/** What the real write does: waits on the item's promise, then holds the text. */
const onClipboard = { text: null as string | null };
const write = vi.fn();
const writeText = vi.fn();
const fillsIn = async ([item]: FakeClipboardItem[]) => {
  onClipboard.text = await (await item.parts["text/plain"]).text();
};

beforeEach(() => {
  calls.start.mockReset().mockResolvedValue({ started: true, jobId: "job-1" });
  calls.create.mockReset().mockResolvedValue(RUN);
  calls.close.mockReset().mockResolvedValue(null);
  calls.mint.mockReset().mockResolvedValue("AB3X7K");
  onClipboard.text = null;
  write.mockReset().mockImplementation(fillsIn);
  writeText.mockReset().mockImplementation(async (text: string) => {
    onClipboard.text = text;
  });
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  Object.defineProperty(navigator, "clipboard", { value: { write, writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

  describe("copying on the click (NEO-459)", () => {
    const press = () => fireEvent.click(screen.getByRole("button", { name: "Use a scanner" }));
    const openPanel = async () => {
      press();
      return screen.findByRole("group", { name: "Scanner code" });
    };
    /** The panel's own line, not the icon's status beside it. */
    const line = (text: string) => screen.findByText(text, { selector: "p" }, SAID);

    it("starts the write inside the click, before the code exists, then fills in the bare code", async () => {
      let mint = (_code: string) => {};
      calls.mint.mockImplementation(() => new Promise((resolve) => (mint = resolve)));
      renderJoin({ runId: RUN });
      press();
      // Nothing has been awaited since fireEvent returned: this is still the click.
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0][0][0]).toBeInstanceOf(FakeClipboardItem);
      expect(onClipboard.text).toBeNull();
      await act(async () => mint("AB3X7K"));
      await waitFor(() => expect(onClipboard.text).toBe("AB3X7K"));
      expect(writeText).not.toHaveBeenCalled();
      expect(await line(COPIED)).toBeTruthy();
    });

    it("does the same when it has to start a run first", async () => {
      let started = (_session: unknown) => {};
      calls.start.mockImplementation(() => new Promise((resolve) => (started = resolve)));
      const { onRunStarted, view } = renderJoin();
      press();
      expect(write).toHaveBeenCalledTimes(1);
      expect(calls.create).not.toHaveBeenCalled();
      await act(async () => started({ started: true, jobId: "job-1" }));
      await waitFor(() => expect(onRunStarted).toHaveBeenCalledWith(RUN));
      view.rerender(
        <ScannerJoin runId={RUN} newRun={NEW_RUN} kind="binder" loading={false} onRunStarted={onRunStarted} />,
      );
      expect(await line(COPIED)).toBeTruthy();
      expect(onClipboard.text).toBe("AB3X7K");
    });

    it("falls back to writeText with the code in hand when write is missing", async () => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      renderJoin({ runId: RUN });
      await openPanel();
      expect(await line(COPIED)).toBeTruthy();
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith("AB3X7K");
    });

    it("falls back to writeText when ClipboardItem is missing", async () => {
      vi.stubGlobal("ClipboardItem", undefined);
      renderJoin({ runId: RUN });
      await openPanel();
      expect(await line(COPIED)).toBeTruthy();
      expect(writeText).toHaveBeenCalledWith("AB3X7K");
      expect(write).not.toHaveBeenCalled();
    });

    it("falls back to writeText, only once the code is in, when write refuses straight away", async () => {
      write.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
      let mint = (_code: string) => {};
      calls.mint.mockImplementation(() => new Promise((resolve) => (mint = resolve)));
      renderJoin({ runId: RUN });
      press();
      await act(async () => {});
      expect(writeText).not.toHaveBeenCalled();
      await act(async () => mint("AB3X7K"));
      expect(await line(COPIED)).toBeTruthy();
      expect(writeText).toHaveBeenCalledWith("AB3X7K");
    });

    it("a clipboard that refuses both says what to do, and doesn't read as an error", async () => {
      write.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
      writeText.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
      renderJoin({ runId: RUN });
      const panel = await openPanel();
      const said = await line(REFUSED);
      expect(said.getAttribute("role")).toBe("status");
      expect(said.className).not.toContain("pink");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(document.activeElement).toBe(panel);
    });

    it("no clipboard at all (an insecure page) is a refusal too", async () => {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      renderJoin({ runId: RUN });
      await openPanel();
      expect(await line(REFUSED)).toBeTruthy();
    });

    it.each([
      ["a failed code request", () => calls.mint.mockRejectedValue(new Error("Intake run not found")), { runId: RUN }],
      [
        "a run that won't start",
        () => calls.start.mockResolvedValue({ started: false, reason: "you have started 9 batches in the last 10 minutes" }),
        {},
      ],
      ["nowhere to file", () => {}, { newRun: null }],
    ])("%s copies nothing and leaves no unhandled rejection", async (_name, arrange, props) => {
      const stray: unknown[] = [];
      const onStray = (reason: unknown) => stray.push(reason);
      process.on("unhandledRejection", onStray);
      try {
        arrange();
        renderJoin(props);
        press();
        await screen.findByRole("alert");
        // Unhandled rejections are reported after the microtask queue drains.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(onClipboard.text).toBeNull();
        expect(writeText).not.toHaveBeenCalled();
        expect(screen.queryByText(COPIED)).toBeNull();
        expect(screen.queryByText(REFUSED)).toBeNull();
        expect(stray).toEqual([]);
      } finally {
        process.off("unhandledRejection", onStray);
      }
    });

    it("no write method and a failed code request leaves no unhandled rejection either", async () => {
      const stray: unknown[] = [];
      const onStray = (reason: unknown) => stray.push(reason);
      process.on("unhandledRejection", onStray);
      try {
        Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
        calls.mint.mockRejectedValue(new Error("Intake run not found"));
        renderJoin({ runId: RUN });
        press();
        await screen.findByRole("alert");
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(writeText).not.toHaveBeenCalled();
        expect(stray).toEqual([]);
      } finally {
        process.off("unhandledRejection", onStray);
      }
    });

    it("says so in a live region that was already there, once the panel has focus", async () => {
      const { view } = renderJoin({ runId: RUN });
      const region = view.container.querySelector('[role="status"]');
      expect(region?.textContent).toBe("");
      const panel = await openPanel();
      const said = await line(COPIED);
      // The same node from the first render: it was never inserted along with its words.
      expect(said).toBe(region);
      expect(panel.contains(said)).toBe(true);
      expect(document.activeElement).toBe(panel);
    });

    describe("the wait after the focus move", () => {
      const NOW = { toFake: ["setTimeout", "clearTimeout"] as ("setTimeout" | "clearTimeout")[] };
      /** Holds the frame back, so the test says when the focus move happens. */
      const holdFrame = () => {
        const held = { frame: (() => {}) as FrameRequestCallback };
        const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
          held.frame = cb;
          return 7;
        });
        return { held, raf };
      };

      afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
      });

      it("keeps the words back until the panel has had focus for the wait", async () => {
        const { held } = holdFrame();
        renderJoin({ runId: RUN });
        const panel = await openPanel();
        await waitFor(() => expect(onClipboard.text).toBe("AB3X7K"));
        await act(async () => {});
        expect(document.activeElement).not.toBe(panel);
        expect(screen.queryByText(COPIED)).toBeNull();

        vi.useFakeTimers(NOW);
        act(() => held.frame(0));
        expect(document.activeElement).toBe(panel);
        expect(screen.queryByText(COPIED)).toBeNull();
        act(() => {
          vi.advanceTimersByTime(SPEECH_AFTER_FOCUS_MS - 1);
        });
        expect(screen.queryByText(COPIED)).toBeNull();
        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(screen.getByText(COPIED).getAttribute("role")).toBe("status");
      });

      it("waits about 400ms", () => {
        expect(SPEECH_AFTER_FOCUS_MS).toBe(400);
      });

      it("drops the timer when the panel goes away during the wait", async () => {
        const { held } = holdFrame();
        const { view } = renderJoin({ runId: RUN });
        await openPanel();
        vi.useFakeTimers(NOW);
        act(() => held.frame(0));
        expect(vi.getTimerCount()).toBe(1);
        view.unmount();
        expect(vi.getTimerCount()).toBe(0);
      });

      it("cancels the frame when the panel goes away before the focus move", async () => {
        const cancel = vi.spyOn(window, "cancelAnimationFrame");
        holdFrame();
        const { view } = renderJoin({ runId: RUN });
        await openPanel();
        expect(cancel).not.toHaveBeenCalled();
        view.unmount();
        expect(cancel).toHaveBeenCalledWith(7);
      });
    });
  });

  describe("the copy icon beside the code (NEO-459)", () => {
    const panelUp = async () => {
      renderJoin({ runId: RUN });
      fireEvent.click(screen.getByRole("button", { name: "Use a scanner" }));
      const panel = await screen.findByRole("group", { name: "Scanner code" });
      await screen.findByText(COPIED, undefined, SAID);
      return panel;
    };

    it("sits in the code's row by name, in the section's blue, and the old text button is gone", async () => {
      const panel = await panelUp();
      const icon = within(panel).getByRole("button", { name: "Copy scanner code" });
      expect(icon.closest("p")).toBe(within(panel).getByText("Scanner code").closest("p"));
      expect(icon.className).toContain("text-neon-blue-text");
      // 44px on a phone, 32px from `sm` up, and the row as tall either way.
      expect(icon.className).toContain("h-11 w-11 -my-1.5 sm:my-0 sm:h-8 sm:w-8");
      expect(within(panel).getAllByRole("button")).toEqual([icon]);
      // Still named and described by the code alone, with a button in that row.
      expect(panel.getAttribute("aria-describedby")?.split(" ").map((id) => document.getElementById(id)?.textContent)).toEqual([
        "A B 3 X 7 K",
        expect.stringContaining("Type or paste this code"),
      ]);
    });

    it("copies the bare code, and takes over from the line the auto-copy left", async () => {
      const panel = await panelUp();
      writeText.mockClear();
      fireEvent.click(within(panel).getByRole("button", { name: "Copy scanner code" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("AB3X7K"));
      // Said once, by the icon's own status, not twice.
      await waitFor(() => expect(screen.getAllByText(COPIED)).toHaveLength(1));
      expect(screen.getByText(COPIED).className).toContain("sr-only");
    });

    it("a late auto-copy can't put its line back after a press on the icon", async () => {
      let settle = () => {};
      write.mockImplementation(() => new Promise<void>((resolve) => (settle = resolve)));
      renderJoin({ runId: RUN });
      fireEvent.click(screen.getByRole("button", { name: "Use a scanner" }));
      const panel = await screen.findByRole("group", { name: "Scanner code" });
      fireEvent.click(within(panel).getByRole("button", { name: "Copy scanner code" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("AB3X7K"));
      await act(async () => {
        settle();
      });
      // Past the panel's wait, so its line would be showing by now if the late result had landed.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, SPEECH_AFTER_FOCUS_MS + 50));
      });
      expect(screen.queryByText(COPIED, { selector: "p" })).toBeNull();
    });

    it("a press leaves a later code's own answer alone", async () => {
      const { view } = renderJoin({ runId: RUN });
      fireEvent.click(screen.getByRole("button", { name: "Use a scanner" }));
      fireEvent.click(await within(await screen.findByRole("group", { name: "Scanner code" })).findByRole("button", { name: "Copy scanner code" }));
      // A different run: the button is back, and its press starts over.
      const other = "run2" as Id<"intakeRuns">;
      calls.mint.mockResolvedValue("ZZ9Y8W");
      view.rerender(<ScannerJoin runId={other} newRun={NEW_RUN} kind="binder" loading={false} onRunStarted={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: "Use a scanner" }));
      expect(await screen.findByText(COPIED, { selector: "p" }, SAID)).toBeTruthy();
    });

    it("says how to recover when the clipboard refuses a press", async () => {
      const panel = await panelUp();
      writeText.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
      fireEvent.click(within(panel).getByRole("button", { name: "Copy scanner code" }));
      await within(panel).findByText("Couldn't reach your clipboard. Type the code in by hand.");
      expect(screen.queryByRole("alert")).toBeNull();
    });
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

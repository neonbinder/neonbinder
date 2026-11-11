/**
 * NEO-478 — "Add the publisher's checklist": the preview IS the parse, skipped
 * lines are listed, Escape / Ctrl+Enter / Cmd+Enter, and focus returns to the
 * opener.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import PublishedChecklistDialog, {
  NOTHING_READS,
  NOTHING_TO_USE,
  PICK_A_SUBSET,
  SUBSET_QUESTION,
  PublishedChecklistChip,
  checklistTeamsLine,
  chipText,
  rowCountText,
  skippedLinesText,
} from "./PublishedChecklistDialog";

const PASTE = [
  "60 Rhett Lowder - Cincinnati Reds (Future Stars)",
  "34 Team Card - Kansas City Royals",
  "Base Set",
].join("\n");

function open(over: Partial<React.ComponentProps<typeof PublishedChecklistDialog>> = {}) {
  const onUse = vi.fn();
  const onCancel = vi.fn();
  const utils = render(<PublishedChecklistDialog onUse={onUse} onCancel={onCancel} {...over} />);
  return { onUse, onCancel, ...utils };
}

const box = () => screen.getByLabelText("Paste the checklist") as HTMLTextAreaElement;
const paste = async (text: string) => {
  await act(async () => {
    fireEvent.change(box(), { target: { value: text } });
  });
};

describe("PublishedChecklistDialog", () => {
  it("is a named modal dialog that opens on the paste box with 0 rows", () => {
    open();
    expect(screen.getByRole("dialog", { name: "Publisher's checklist" })).toBeTruthy();
    expect(document.activeElement).toBe(box());
    expect(screen.getByText("0 rows")).toBeTruthy();
    expect(screen.getByLabelText("Choose a file")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use this checklist" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("previews exactly what the parser reads, with the row count", async () => {
    open();
    await paste(PASTE);
    await waitFor(() => expect(screen.getByText("2 rows")).toBeTruthy());
    const table = screen.getByRole("table");
    expect(within(table).getByText("Rhett Lowder")).toBeTruthy();
    expect(within(table).getByText("Cincinnati Reds")).toBeTruthy();
    expect(within(table).getByText("Kansas City Royals")).toBeTruthy();
    // The Team Card row has no player.
    expect(within(table).getByText("None")).toBeTruthy();
  });

  it("lists every skipped line with its number and reason, never dropping one silently", async () => {
    open();
    await paste(PASTE);
    await waitFor(() => expect(screen.getByRole("heading", { name: /Skipped lines/ })).toBeTruthy());
    expect(screen.getByText("(1)")).toBeTruthy();
    expect(screen.getByText("Line 3")).toBeTruthy();
    expect(screen.getByText("“Base Set”")).toBeTruthy();
  });

  it("shows an NNO line as a row numbered NNO, not as a skipped line (PR 451 D-B)", async () => {
    const text = "NNO Chris Potter - Roanoke Express\n7 Jon Larson - Roanoke Express";
    const { onUse } = open();
    await paste(text);
    await waitFor(() => expect(screen.getByText("2 rows")).toBeTruthy());
    const table = screen.getByRole("table");
    expect(within(table).getByText("NNO")).toBeTruthy();
    expect(within(table).getByText("Chris Potter")).toBeTruthy();
    expect(screen.getByText(/every line made it/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use this checklist" }));
    expect(onUse).toHaveBeenCalledWith({
      rows: [
        { number: "NNO", players: ["Chris Potter"], teams: ["Roanoke Express"], noNumber: true },
        { number: "7", players: ["Jon Larson"], teams: ["Roanoke Express"] },
      ],
      text,
      format: "lines",
      skippedCount: 0,
    });
  });

  it("says nothing was skipped when every line made it", async () => {
    open();
    await paste("1 A Guy - Team A");
    await waitFor(() => expect(screen.getByText("1 row")).toBeTruthy());
    expect(screen.getByText(/every line made it/)).toBeTruthy();
  });

  it("Use this checklist hands on the parsed rows, the text, the format and the skipped count", async () => {
    const { onUse } = open();
    await paste(PASTE);
    await waitFor(() => expect(screen.getByText("2 rows")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Use this checklist" }));
    expect(onUse).toHaveBeenCalledWith({
      rows: [
        { number: "60", players: ["Rhett Lowder"], teams: ["Cincinnati Reds"] },
        { number: "34", players: [], teams: ["Kansas City Royals"] },
      ],
      text: PASTE,
      format: "lines",
      skippedCount: 1,
    });
  });

  it("refuses to use an empty or unreadable paste", async () => {
    const { onUse } = open();
    const use = screen.getByRole("button", { name: "Use this checklist" });
    expect(use.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(use);
    await paste("nothing readable here");
    fireEvent.click(use);
    expect(onUse).not.toHaveBeenCalled();
  });

  /** The visible count line: what the paste box and Use are described by. */
  const countLine = () => {
    const id = box().getAttribute("aria-describedby")!;
    return document.getElementById(id)!;
  };
  /** The one live region the count, the bad-paste line and a blocked press share. */
  const countStatus = () =>
    document.querySelector<HTMLElement>("[data-checklist-count-status]")!;

  it("shows the count on a line the paste box and Use are described by, which is NOT a live region", async () => {
    open();
    const line = countLine();
    expect(line.getAttribute("role")).toBeNull();
    expect(line.getAttribute("aria-live")).toBeNull();
    expect(line.textContent).toBe("0 rows.");
    expect(screen.getByRole("button", { name: "Use this checklist" }).getAttribute("aria-describedby")).toBe(
      line.id,
    );
    await paste(PASTE);
    await waitFor(() => expect(countLine().textContent).toBe("2 rows. 1 line skipped."));
    expect(skippedLinesText(3)).toBe("3 lines skipped.");
    expect(skippedLinesText(1)).toBe("1 line skipped.");
  });

  it("announces the count in ONE always-mounted sr-only status, once the paste holds still", async () => {
    open();
    const region = countStatus();
    expect(region.getAttribute("role")).toBe("status");
    expect(region.className).toContain("sr-only");
    expect(region.textContent).toBe("0 rows.");
    await paste(PASTE);
    // On screen at once; not said yet.
    await waitFor(() => expect(countLine().textContent).toBe("2 rows. 1 line skipped."));
    expect(countStatus().textContent).toBe("0 rows.");
    await waitFor(() => expect(countStatus().textContent).toBe("2 rows. 1 line skipped."), {
      timeout: 3000,
    });
    // The same node, never remounted: a live region must exist before it speaks.
    expect(countStatus()).toBe(region);
  });

  it("says why nothing reads at once, in the status and on the count line, not again in the preview", async () => {
    open();
    await paste("nothing readable here");
    await waitFor(() => expect(countStatus().textContent).toBe(NOTHING_READS));
    expect(countLine().textContent).toBe(NOTHING_READS);
    expect(NOTHING_READS).toBe("Nothing reads as a card yet. Each line starts with its card number.");
    // The count line and its live region: nowhere else.
    expect(screen.getAllByText(/Nothing reads as a card/)).toHaveLength(2);
    expect(screen.getByText(/Try a line like/)).toBeTruthy();
  });

  it("a blocked press says so in the region and puts focus in the paste box; typing clears it", async () => {
    open();
    const use = screen.getByRole("button", { name: "Use this checklist" });
    act(() => {
      use.focus();
    });
    fireEvent.click(use);
    expect(countStatus().textContent).toBe(NOTHING_TO_USE);
    expect(document.activeElement).toBe(box());
    // Unreadable text: the press still wins until the paste changes.
    await paste("nothing readable here");
    await waitFor(() => expect(countStatus().textContent).toBe(NOTHING_READS));
    fireEvent.click(use);
    expect(countStatus().textContent).toBe(NOTHING_TO_USE);
    await paste("1 A Guy - Team A");
    await waitFor(() => expect(countLine().textContent).toBe("1 row."));
    expect(countStatus().textContent).not.toBe(NOTHING_TO_USE);
  });

  it("the file note never flips its role on a mounted node, and carries no explicit aria-live", async () => {
    open();
    const input = screen.getByLabelText("Choose a file") as HTMLInputElement;
    // Idle: an empty, always-mounted status region, never display:none.
    const idle = screen
      .getAllByRole("status")
      .find((el) => el.textContent === "" && el !== countStatus())!;
    expect(idle).toBeTruthy();
    expect(idle.className).not.toContain("hidden");
    const good = new File(["9 A Guy - Team A"], "list.txt", { type: "text/plain" });
    Object.defineProperty(good, "text", { value: async () => "9 A Guy - Team A" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [good] } });
    });
    // The status line spoke from the SAME node it was idle on.
    expect(idle.isConnected).toBe(true);
    expect(idle.textContent).toMatch(/Read list\.txt/);
    expect(idle.getAttribute("aria-live")).toBeNull();
    const big = new File(["x"], "huge.csv");
    Object.defineProperty(big, "size", { value: 3 * 1024 * 1024 });
    await act(async () => {
      fireEvent.change(input, { target: { files: [big] } });
    });
    // An error is a NEW alert node, not the status one with its role swapped.
    const alert = screen.getByRole("alert");
    expect(alert).not.toBe(idle);
    expect(idle.isConnected).toBe(false);
    expect(alert.getAttribute("aria-live")).toBeNull();
  });

  it("Ctrl+Enter and Cmd+Enter in the paste box use the checklist", async () => {
    const { onUse } = open();
    await paste("1 A Guy - Team A");
    await waitFor(() => expect(screen.getByText("1 row")).toBeTruthy());
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
    expect(onUse).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    expect(onUse).toHaveBeenCalledTimes(2);
  });

  it("a plain Enter in the paste box is just a newline: it does not use the checklist", async () => {
    const { onUse } = open();
    await paste("1 A Guy - Team A");
    await waitFor(() => expect(screen.getByText("1 row")).toBeTruthy());
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onUse).not.toHaveBeenCalled();
  });

  it("Escape cancels from anywhere in the dialog, Cancel does too", () => {
    const { onCancel } = open();
    fireEvent.keyDown(screen.getByRole("button", { name: "Use this checklist" }), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("reopening shows what was pasted", async () => {
    open({ initial: { rows: [], text: "5 Z Guy - Team Z", format: "lines", skippedCount: 0 } });
    expect(box().value).toBe("5 Z Guy - Team Z");
    await waitFor(() => expect(screen.getByText("1 row")).toBeTruthy());
  });

  it("reads a chosen file into the paste box and the preview", async () => {
    open();
    const input = screen.getByLabelText("Choose a file") as HTMLInputElement;
    const file = new File(["Number,Player,Team\n9,A Guy,Boston Red Sox"], "list.csv", {
      type: "text/csv",
    });
    Object.defineProperty(file, "text", { value: async () => "Number,Player,Team\n9,A Guy,Boston Red Sox" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await waitFor(() => expect(screen.getByText("1 row")).toBeTruthy());
    expect(screen.getByText(/Read list.csv/)).toBeTruthy();
    expect(screen.getByText(/Read as CSV/)).toBeTruthy();
  });

  it("refuses a file over 2 MB and says so as an alert", async () => {
    open();
    const input = screen.getByLabelText("Choose a file") as HTMLInputElement;
    const big = new File(["x"], "huge.csv");
    Object.defineProperty(big, "size", { value: 3 * 1024 * 1024 });
    await act(async () => {
      fireEvent.change(input, { target: { files: [big] } });
    });
    expect(screen.getByRole("alert").textContent).toMatch(/huge\.csv is too big/);
    expect(box().value).toBe("");
  });

  it("refuses a paste over 2 MB with an alert instead of parsing it", async () => {
    const { onUse } = open();
    const line = "1 A Guy - Team A\n";
    await paste(line.repeat(Math.ceil((2 * 1024 * 1024 + 1) / line.length)));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/under 2 MB/));
    expect(screen.getByText("0 rows")).toBeTruthy();
    // Nothing was read, so there is no skipped-lines list either.
    expect(screen.queryByRole("heading", { name: /Skipped lines/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use this checklist" }));
    expect(onUse).not.toHaveBeenCalled();
  });

  it("opens with the subhead's copy and an example labelled as one, never a placeholder", () => {
    open();
    expect(
      screen.getByText(
        "Paste it straight off the checklist page, or pick a file. We line it up by card number and only look up teams your list leaves out.",
      ),
    ).toBeTruthy();
    expect(box().getAttribute("placeholder")).toBeNull();
    expect(screen.getByText("Example lines")).toBeTruthy();
  });

  it("paints Choose a file as the secondary outline button: a 1px edge, the cyan fill on hover", () => {
    open();
    const face = screen.getByLabelText("Choose a file").closest("label")!;
    expect(face.className).toContain("border-neon-blue-text");
    expect(face.className).not.toContain("border-2");
    expect(face.className).toContain("hover:bg-neon-blue");
    expect(face.className).toContain("hover:text-on-neon-blue");
  });

  describe("subsets (S6)", () => {
    const SUBSETS = [
      "Number,Player,Team,Subset",
      "1,Mike Trout,Los Angeles Angels,Base",
      "2,Shohei Ohtani,Los Angeles Dodgers,Base",
      "RA-1,Jackson Holliday,Baltimore Orioles,Rookie Autographs",
    ].join("\n");
    const question = () => screen.getByRole("group", { name: SUBSET_QUESTION });

    it("asks which subsets belong, none ticked, and holds Use until one is", async () => {
      const { onUse } = open();
      await paste(SUBSETS);
      await waitFor(() => expect(question()).toBeTruthy());
      const base = within(question()).getByRole("checkbox", { name: "Base" }) as HTMLInputElement;
      const autos = within(question()).getByRole("checkbox", {
        name: "Rookie Autographs",
      }) as HTMLInputElement;
      expect(base.checked).toBe(false);
      expect(autos.checked).toBe(false);
      // Each box is described by its row count.
      expect(document.getElementById(base.getAttribute("aria-describedby")!)!.textContent).toBe(
        "2 rows",
      );
      expect(countLine().textContent).toBe("0 rows.");
      expect(screen.queryByRole("table")).toBeNull();
      const use = screen.getByRole("button", { name: "Use this checklist" });
      expect(use.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(use);
      expect(onUse).not.toHaveBeenCalled();
      // A held press says why at once and lands on the first box.
      expect(countStatus().textContent).toBe(PICK_A_SUBSET);
      expect(document.activeElement).toBe(base);
    });

    it("uses only the ticked subsets' rows, and hands the ticks on", async () => {
      const { onUse } = open();
      await paste(SUBSETS);
      await waitFor(() => expect(question()).toBeTruthy());
      fireEvent.click(within(question()).getByRole("checkbox", { name: "Base" }));
      await waitFor(() => expect(countLine().textContent).toBe("2 rows."));
      const table = screen.getByRole("table");
      expect(within(table).getByText("Mike Trout")).toBeTruthy();
      expect(within(table).queryByText("Jackson Holliday")).toBeNull();
      const use = screen.getByRole("button", { name: "Use this checklist" });
      expect(use.getAttribute("aria-disabled")).toBeNull();
      fireEvent.click(use);
      expect(onUse).toHaveBeenCalledTimes(1);
      const used = onUse.mock.calls[0][0];
      expect(used.rows.map((r: { number: string }) => r.number)).toEqual(["1", "2"]);
      expect(used.subsets).toEqual(["Base"]);
      expect(used.text).toBe(SUBSETS);
    });

    it("unticking the last subset holds Use again", async () => {
      open();
      await paste(SUBSETS);
      await waitFor(() => expect(question()).toBeTruthy());
      const base = within(question()).getByRole("checkbox", { name: "Base" });
      fireEvent.click(base);
      await waitFor(() => expect(countLine().textContent).toBe("2 rows."));
      fireEvent.click(base);
      await waitFor(() => expect(countLine().textContent).toBe("0 rows."));
      expect(
        screen.getByRole("button", { name: "Use this checklist" }).getAttribute("aria-disabled"),
      ).toBe("true");
    });

    it("reopening shows the ticks it was used with", async () => {
      open({
        initial: { rows: [], text: SUBSETS, format: "csv", skippedCount: 0, subsets: ["Rookie Autographs"] },
      });
      await waitFor(() => expect(question()).toBeTruthy());
      expect(
        (within(question()).getByRole("checkbox", { name: "Rookie Autographs" }) as HTMLInputElement)
          .checked,
      ).toBe(true);
      expect((within(question()).getByRole("checkbox", { name: "Base" }) as HTMLInputElement).checked).toBe(
        false,
      );
      await waitFor(() => expect(countLine().textContent).toBe("1 row."));
    });

    it("never asks when the paste has no subset column", async () => {
      open();
      await paste(PASTE);
      await waitFor(() => expect(countLine().textContent).toBe("2 rows. 1 line skipped."));
      expect(screen.queryByRole("group", { name: SUBSET_QUESTION })).toBeNull();
    });
  });

  it("puts focus back on the opener when it closes", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    const ref = { current: opener };
    const { unmount } = open({ restoreFocusRef: ref });
    unmount();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });
});

describe("the copy helpers and the chip", () => {
  it("spell the contract's strings", () => {
    expect(rowCountText(1)).toBe("1 row");
    expect(rowCountText(1234)).toBe("1,234 rows");
    expect(chipText(248)).toBe("Publisher's checklist: 248 rows");
    expect(chipText(18, 0)).toBe("Publisher's checklist: 18 rows");
    expect(chipText(18, 2)).toBe("Publisher's checklist: 18 rows · 2 skipped");
    expect(checklistTeamsLine(240, 248)).toBe("Teams from your checklist: 240 of 248 cards");
    expect(checklistTeamsLine(1, 1)).toBe("Teams from your checklist: 1 of 1 card");
  });

  it("the chip shows the count and a Remove with the contract's accessible name", () => {
    const onRemove = vi.fn();
    render(<PublishedChecklistChip rowCount={248} onRemove={onRemove} />);
    expect(screen.getByText("Publisher's checklist: 248 rows")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove the publisher's checklist" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("the chip's text is a button that reopens the dialog, and says what was skipped", () => {
    const onOpen = vi.fn();
    render(<PublishedChecklistChip rowCount={18} skippedCount={2} onOpen={onOpen} onRemove={vi.fn()} />);
    const reopen = screen.getByRole("button", { name: "Publisher's checklist: 18 rows · 2 skipped" });
    expect(reopen.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(reopen);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // Its touch extension is not clipped: the truncation is on the text inside.
    expect(reopen.className).not.toContain("truncate");
  });

  it("a disabled chip does not reopen", () => {
    const onOpen = vi.fn();
    render(<PublishedChecklistChip rowCount={3} onOpen={onOpen} onRemove={vi.fn()} disabled />);
    fireEvent.click(screen.getByRole("button", { name: "Publisher's checklist: 3 rows" }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("Remove is quiet at rest and pink with its own ink under the pointer or focus", () => {
    render(<PublishedChecklistChip rowCount={3} onRemove={vi.fn()} />);
    const remove = screen.getByRole("button", { name: "Remove the publisher's checklist" });
    expect(remove.className).toContain("text-ink-2");
    expect(remove.className).not.toMatch(/(^|\s)text-neon-pink-text/);
    expect(remove.className).toContain("hover:bg-neon-pink");
    expect(remove.className).toContain("hover:text-on-neon-pink");
    expect(remove.className).toContain("focus-visible:bg-neon-pink");
  });

  it("a disabled chip does not remove", () => {
    const onRemove = vi.fn();
    render(<PublishedChecklistChip rowCount={3} onRemove={onRemove} disabled />);
    fireEvent.click(screen.getByRole("button", { name: "Remove the publisher's checklist" }));
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("Remove is at least a 24px target (WCAG 2.5.8), 44px to a finger, in a one-line chip", () => {
    render(<PublishedChecklistChip rowCount={3} onRemove={vi.fn()} />);
    const remove = screen.getByRole("button", { name: "Remove the publisher's checklist" });
    expect(remove.className).toContain("min-h-6");
    // 24px + 10px above and below: the target grows, the chip does not.
    expect(remove.className).toContain("after:-inset-y-2.5");
    expect(remove.className).not.toContain("min-h-11");
  });
});

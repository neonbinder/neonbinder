/**
 * NEO-478 — "Add the publisher's checklist": the preview IS the parse, skipped
 * lines are listed, Escape / Ctrl+Enter / Cmd+Enter, and focus returns to the
 * opener.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import PublishedChecklistDialog, {
  PublishedChecklistChip,
  checklistTeamsLine,
  chipText,
  rowCountText,
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
    expect(screen.getByText(/Nothing here reads as a card yet/)).toBeTruthy();
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

  it("a disabled chip does not remove", () => {
    const onRemove = vi.fn();
    render(<PublishedChecklistChip rowCount={3} onRemove={onRemove} disabled />);
    fireEvent.click(screen.getByRole("button", { name: "Remove the publisher's checklist" }));
    expect(onRemove).not.toHaveBeenCalled();
  });
});

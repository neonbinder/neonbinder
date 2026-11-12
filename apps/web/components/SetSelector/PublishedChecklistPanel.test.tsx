/**
 * NEO-496 — the set's publisher checklist panel: upload with a preview,
 * saving in whole-section calls with progress, a replay-safe retry, Replace,
 * Remove behind a confirm, and the server's refusals in operator words.
 *
 * convex/react is module-mocked, routed by the (string-mocked) function
 * reference, as SetAttributesPanel.test.tsx does.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    publishedChecklists: {
      getForSet: "publishedChecklists.getForSet",
      start: "publishedChecklists.start",
      addSections: "publishedChecklists.addSections",
      finish: "publishedChecklists.finish",
      remove: "publishedChecklists.remove",
    },
  },
}));

type Stored = {
  checklistId: string;
  fileName: string;
  format: string;
  sectionCount: number;
  rowCount: number;
  byteSize: number;
  finishedAt: number;
} | null;

let stored: Stored | undefined;
const mockStart = vi.fn();
const mockAddSections = vi.fn();
const mockFinish = vi.fn();
const mockRemove = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string) => (ref === "publishedChecklists.getForSet" ? stored : undefined),
  useMutation: (ref: string) => {
    if (ref === "publishedChecklists.start") return mockStart;
    if (ref === "publishedChecklists.addSections") return mockAddSections;
    if (ref === "publishedChecklists.finish") return mockFinish;
    if (ref === "publishedChecklists.remove") return mockRemove;
    return vi.fn();
  },
}));

import PublishedChecklistPanel, {
  NO_SECTIONS_FOUND,
  NOTHING_TO_SAVE,
  sectionNumbersText,
  storedFormatOf,
} from "./PublishedChecklistPanel";
import {
  SAVE_INTERRUPTED,
  planChecklistBatches,
  uploadChecklist,
  uploadFailure,
} from "./published-checklist-upload";

const SET_ID = "set-1" as Id<"selectorOptions">;
const CHECKLIST_ID = "cl-1" as Id<"publishedChecklists">;

/** Three sections, two under the AUTOGRAPH group, NNO rows, three skipped lines. */
const TOPPS = [
  "2026 Topps Chrome Baseball Checklist",
  "BASE CARDS",
  "1 Ken Griffey Jr. - Seattle Mariners",
  "2 Johnny Bench - Cincinnati Reds",
  "Rookie",
  "AUTOGRAPH",
  "FANATICS AUTHENTICS",
  "NNO Chase Utley - Philadelphia Phillies",
  "NNO Mike Trout - Los Angeles Angels",
  "CHROME LEGEND AUTOGRAPHS",
  "CLA-1 Jackson Holliday - Baltimore Orioles",
  "CLA-10 Roman Anthony - Boston Red Sox",
  "NNO Some Guy - Boston Red Sox",
  "Rookie",
].join("\n");

const fileOf = (name: string, contents: string | Uint8Array) =>
  new File([contents as BlobPart], name);

function renderPanel(over: Partial<React.ComponentProps<typeof PublishedChecklistPanel>> = {}) {
  const onStatus = vi.fn();
  const utils = render(
    <PublishedChecklistPanel
      setId={SET_ID}
      setName="2026 Topps Chrome"
      setYear="2026"
      onStatus={onStatus}
      {...over}
    />,
  );
  return { onStatus, ...utils };
}

async function choose(label: string, file: File) {
  const input = screen.getByLabelText(label) as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
}

const preview = () => screen.getByRole("dialog", { name: "Checklist preview" });

beforeEach(() => {
  stored = null;
  mockStart.mockReset().mockResolvedValue({ checklistId: CHECKLIST_ID });
  let saved = 0;
  let rows = 0;
  mockAddSections.mockReset().mockImplementation(async (args: { sections: { rows: unknown[] }[] }) => {
    saved += args.sections.length;
    rows += args.sections.reduce((n, s) => n + s.rows.length, 0);
    return { sectionCount: saved, rowCount: rows, byteSize: 100 };
  });
  mockFinish.mockReset().mockResolvedValue(null);
  mockRemove.mockReset().mockResolvedValue({ removed: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PublishedChecklistPanel — no checklist yet", () => {
  it("is a named section with Upload checklist and a paste door, and no Remove", () => {
    renderPanel();
    const region = screen.getByRole("region", { name: "Publisher checklist" });
    expect(within(region).getByLabelText("Upload checklist")).toBeTruthy();
    expect((screen.getByLabelText("Upload checklist") as HTMLInputElement).accept).toBe(
      ".xlsx,.pdf,.csv,.tsv,.txt",
    );
    expect(within(region).getByRole("button", { name: "Paste one instead" })).toBeTruthy();
    expect(within(region).queryByRole("button", { name: "Remove checklist" })).toBeNull();
    // No status region of its own: the attributes panel keeps the one (NEO-412).
    expect(within(region).queryByRole("status")).toBeNull();
  });

  it("shows a file the reader refuses as an alert in the panel, and opens no preview", async () => {
    renderPanel();
    const xls = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    await choose("Upload checklist", fileOf("old.xls", xls));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/old \.xls workbook/));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockStart).not.toHaveBeenCalled();
  });
});

describe("PublishedChecklistPanel — the preview", () => {
  it("lists every section with its cards and numbers, under its group, NNO said out loud", async () => {
    const { onStatus } = renderPanel();
    await choose("Upload checklist", fileOf("topps.txt", TOPPS));
    expect(onStatus).toHaveBeenCalledWith("Reading topps.txt…");
    const dialog = await waitFor(preview);
    expect(within(dialog).getByText("3 sections")).toBeTruthy();
    expect(within(dialog).getByText("7 cards")).toBeTruthy();
    const table = within(dialog).getByRole("table", { name: "Sections the checklist will save" });
    const rowOf = (name: string) =>
      within(table).getByRole("rowheader", { name }).closest("tr") as HTMLElement;
    expect(within(rowOf("BASE CARDS")).getByText("1 to 2")).toBeTruthy();
    expect(within(rowOf("FANATICS AUTHENTICS")).getByText("NNO only")).toBeTruthy();
    expect(within(rowOf("CHROME LEGEND AUTOGRAPHS")).getByText("CLA-1 to CLA-10, plus 1 NNO")).toBeTruthy();
    // One group heading over the run of its two sections.
    expect(within(table).getAllByRole("columnheader", { name: "AUTOGRAPH" })).toHaveLength(1);
    // Nothing is saved by looking.
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("groups skipped lines by reason, with each reason's count", async () => {
    renderPanel();
    await choose("Upload checklist", fileOf("topps.txt", TOPPS));
    const dialog = await waitFor(preview);
    expect(within(dialog).getByRole("heading", { name: "Skipped lines (3)" })).toBeTruthy();
    const noNumber = within(dialog).getByText("No card number at the start").closest("details")!;
    expect(within(noNumber).getByText("(2)")).toBeTruthy();
    expect(within(noNumber).getByText("Line 5")).toBeTruthy();
    expect(within(noNumber).getByText("Line 14")).toBeTruthy();
    const title = within(dialog).getByText("Looks like a title, not a card").closest("details")!;
    expect(within(title).getByText("(1)")).toBeTruthy();
  });

  it("says why a paste with no section heading has nothing to save, and saves nothing", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Paste one instead" }));
    const box = within(preview()).getByLabelText("Paste the set's checklist");
    expect(document.activeElement).toBe(box);
    await act(async () => {
      fireEvent.change(box, { target: { value: "1 A Guy - Team A\n2 B Guy - Team B" } });
    });
    await waitFor(() => expect(within(preview()).getByText(NO_SECTIONS_FOUND)).toBeTruthy());
    fireEvent.click(within(preview()).getByRole("button", { name: "Save checklist" }));
    expect(within(preview()).getByText(NOTHING_TO_SAVE)).toBeTruthy();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("Escape and Cancel close it without saving", async () => {
    renderPanel();
    await choose("Upload checklist", fileOf("topps.txt", TOPPS));
    fireEvent.keyDown(await waitFor(preview), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await choose("Upload checklist", fileOf("topps.txt", TOPPS));
    fireEvent.click(within(await waitFor(preview)).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockStart).not.toHaveBeenCalled();
  });
});

describe("PublishedChecklistPanel — saving", () => {
  it("starts, sends whole sections from ordinal 0, finishes with the totals, and says so", async () => {
    const { onStatus } = renderPanel();
    await choose("Upload checklist", fileOf("topps.txt", TOPPS));
    await act(async () => {
      fireEvent.click(within(await waitFor(preview)).getByRole("button", { name: "Save checklist" }));
    });
    await waitFor(() => expect(mockFinish).toHaveBeenCalled());
    expect(mockStart).toHaveBeenCalledWith({ setId: SET_ID, fileName: "topps.txt", format: "txt" });
    expect(mockAddSections).toHaveBeenCalledTimes(1);
    const sent = mockAddSections.mock.calls[0][0];
    expect(sent.checklistId).toBe(CHECKLIST_ID);
    expect(sent.firstOrdinal).toBe(0);
    expect(sent.sections.map((s: { name: string }) => s.name)).toEqual([
      "BASE CARDS",
      "FANATICS AUTHENTICS",
      "CHROME LEGEND AUTOGRAPHS",
    ]);
    expect(sent.sections[1]).toMatchObject({ group: "AUTOGRAPH" });
    expect(mockFinish).toHaveBeenCalledWith({ checklistId: CHECKLIST_ID, sectionCount: 3, rowCount: 7 });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onStatus).toHaveBeenCalledWith("Checklist saved: 3 sections, 7 cards.");
  });

  it("shows its progress in sections while the save is in flight, and Stop saving ends it", async () => {
    let release: (v: unknown) => void = () => {};
    mockAddSections.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    renderPanel();
    await choose("Upload checklist", fileOf("topps.txt", TOPPS));
    await act(async () => {
      fireEvent.click(within(await waitFor(preview)).getByRole("button", { name: "Save checklist" }));
    });
    const bar = await waitFor(() => within(preview()).getByRole("progressbar", { name: "Saving the checklist" }));
    expect(bar.getAttribute("aria-valuetext")).toBe("Saving 0 of 3 sections");
    // Said in the dialog's status line, not only drawn.
    expect(
      within(preview())
        .getAllByRole("status")
        .some((el) => el.textContent === "Saving 0 of 3 sections"),
    ).toBe(true);
    expect(within(preview()).getByRole("button", { name: "Saving..." }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(within(preview()).getByRole("button", { name: "Stop saving" }));
    await act(async () => {
      release({ sectionCount: 3, rowCount: 7, byteSize: 1 });
    });
    // Stopped after the call in flight: never made the checklist the set's.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockFinish).not.toHaveBeenCalled();
  });

  it("a lost call: says so in plain words, and Try again resumes the same upload from the confirmed section", async () => {
    mockAddSections.mockRejectedValueOnce(new Error("network"));
    renderPanel();
    await choose("Upload checklist", fileOf("topps.txt", TOPPS));
    await act(async () => {
      fireEvent.click(within(await waitFor(preview)).getByRole("button", { name: "Save checklist" }));
    });
    const alert = await waitFor(() => within(preview()).getByRole("alert"));
    expect(alert.textContent).toBe(SAVE_INTERRUPTED);
    await act(async () => {
      fireEvent.click(within(preview()).getByRole("button", { name: "Try again" }));
    });
    await waitFor(() => expect(mockFinish).toHaveBeenCalled());
    // Same upload, same first section: nothing doubled, no second start.
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockAddSections).toHaveBeenCalledTimes(2);
    expect(mockAddSections.mock.calls[1][0]).toMatchObject({ checklistId: CHECKLIST_ID, firstOrdinal: 0 });
  });

  it("a section the server refuses: names it in collector words, never 'batch', and holds Save until the file changes", async () => {
    mockAddSections.mockRejectedValueOnce(
      new ConvexError("Section “FUTURE STARS” has 2500 rows; the limit is 2000."),
    );
    renderPanel();
    await choose("Upload checklist", fileOf("topps.txt", TOPPS));
    await act(async () => {
      fireEvent.click(within(await waitFor(preview)).getByRole("button", { name: "Save checklist" }));
    });
    const alert = await waitFor(() => within(preview()).getByRole("alert"));
    expect(alert.textContent).toBe(
      "“FUTURE STARS” has 2,500 cards, and one section holds up to 2,000. Split it in the file, then upload it again.",
    );
    const save = within(preview()).getByRole("button", { name: "Save checklist" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(save);
    expect(mockAddSections).toHaveBeenCalledTimes(1);
    // A fresh file clears the refusal.
    await choose("Choose another file", fileOf("topps-fixed.txt", TOPPS));
    await waitFor(() => expect(within(preview()).queryByRole("alert")).toBeNull());
    expect(
      within(preview()).getByRole("button", { name: "Save checklist" }).getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("the server's bookkeeping refusal reads as an interrupted save, never its own words", async () => {
    mockAddSections.mockRejectedValueOnce(
      new ConvexError("This batch starts at section 4, but 3 sections have arrived. Upload the file again."),
    );
    renderPanel();
    await choose("Upload checklist", fileOf("topps.txt", TOPPS));
    await act(async () => {
      fireEvent.click(within(await waitFor(preview)).getByRole("button", { name: "Save checklist" }));
    });
    const alert = await waitFor(() => within(preview()).getByRole("alert"));
    expect(alert.textContent).toBe(SAVE_INTERRUPTED);
    expect(alert.textContent).not.toMatch(/batch|chunk/i);
  });

  it("a pasted checklist is saved as a paste", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Paste one instead" }));
    await act(async () => {
      fireEvent.change(within(preview()).getByLabelText("Paste the set's checklist"), {
        target: { value: TOPPS },
      });
    });
    await waitFor(() => expect(within(preview()).getByText("3 sections")).toBeTruthy());
    await act(async () => {
      fireEvent.click(within(preview()).getByRole("button", { name: "Save checklist" }));
    });
    await waitFor(() => expect(mockFinish).toHaveBeenCalled());
    expect(mockStart).toHaveBeenCalledWith({ setId: SET_ID, fileName: "Pasted checklist", format: "paste" });
  });

  it("a PDF goes through the PDF reader and is saved as a PDF", async () => {
    const readPdf = vi.fn(async () => ({
      ok: true as const,
      pages: 1,
      lines: [
        { page: 1, line: 1, cells: ["FUTURE STARS"], xs: [50] },
        { page: 1, line: 2, cells: ["FS-1", "Jackson Holliday", "Baltimore Orioles"], xs: [50, 120, 300] },
        { page: 1, line: 3, cells: ["FS-2", "Roman Anthony", "Boston Red Sox"], xs: [50, 120, 300] },
      ],
    }));
    renderPanel({ readers: { readPdf } });
    await choose("Upload checklist", fileOf("topps.pdf", "%PDF-1.7\n"));
    const dialog = await waitFor(preview);
    expect(readPdf).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole("rowheader", { name: "FUTURE STARS" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Save checklist" }));
    });
    await waitFor(() => expect(mockFinish).toHaveBeenCalled());
    expect(mockStart).toHaveBeenCalledWith({ setId: SET_ID, fileName: "topps.pdf", format: "pdf" });
  });
});

describe("PublishedChecklistPanel — a checklist on the set", () => {
  beforeEach(() => {
    stored = {
      checklistId: CHECKLIST_ID,
      fileName: "2026-donruss.xlsx",
      format: "xlsx",
      sectionCount: 273,
      rowCount: 18068,
      byteSize: 1,
      finishedAt: Date.UTC(2026, 10, 11, 18),
    };
  });

  it("shows the file, its size, Replace, a paste door and Remove", () => {
    renderPanel();
    const region = screen.getByRole("region", { name: "Publisher checklist" });
    expect(within(region).getByText("2026-donruss.xlsx")).toBeTruthy();
    expect(within(region).getByText(/273 sections, 18,068 cards\./)).toBeTruthy();
    expect(within(region).getByLabelText("Replace checklist")).toBeTruthy();
    expect(within(region).getByRole("button", { name: "Paste a replacement" })).toBeTruthy();
    expect(within(region).getByRole("button", { name: "Remove checklist" })).toBeTruthy();
    expect(within(region).queryByLabelText("Upload checklist")).toBeNull();
  });

  it("Replace previews the new file, says what it replaces, and saves it as a new upload", async () => {
    renderPanel();
    await choose("Replace checklist", fileOf("topps.txt", TOPPS));
    const dialog = await waitFor(preview);
    expect(dialog.textContent).toMatch(/topps\.txt replaces 2026-donruss\.xlsx once it's saved/);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Save checklist" }));
    });
    await waitFor(() => expect(mockFinish).toHaveBeenCalled());
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("Remove asks first: Cancel keeps it, Yes, remove it removes it", async () => {
    const { onStatus } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Remove checklist" }));
    const confirm = screen.getByRole("dialog", { name: "Remove this set's checklist?" });
    expect(confirm.textContent).toMatch(/Syncs in 2026 Topps Chrome stop reading 2026-donruss\.xlsx/);
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockRemove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove checklist" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Yes, remove it" }));
    });
    expect(mockRemove).toHaveBeenCalledWith({ setId: SET_ID });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onStatus).toHaveBeenCalledWith("Checklist removed.");
  });

  it("a refused Remove stays in the confirm with a reason", async () => {
    mockRemove.mockRejectedValueOnce(new Error("Server Error"));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Remove checklist" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Yes, remove it" }));
    });
    const confirm = screen.getByRole("dialog", { name: "Remove this set's checklist?" });
    expect(within(confirm).getByRole("alert").textContent).toBe(
      "Couldn't remove the checklist. Try again.",
    );
  });
});

describe("helpers", () => {
  it("sectionNumbersText: a range as printed, NNO said, one number alone", () => {
    const row = (number: string, noNumber?: true) => ({ number, players: [], teams: [], ...(noNumber ? { noNumber } : {}) });
    expect(sectionNumbersText({ rows: [row("1"), row("200")] })).toBe("1 to 200");
    expect(sectionNumbersText({ rows: [row("7")] })).toBe("7");
    expect(sectionNumbersText({ rows: [row("NNO", true)] })).toBe("NNO only");
    expect(sectionNumbersText({ rows: [row("1"), row("NNO", true), row("30")] })).toBe("1 to 30, plus 1 NNO");
  });

  it("storedFormatOf: cells say their own format, text goes by its extension", () => {
    expect(storedFormatOf("a.CSV", { kind: "text", text: "" })).toBe("csv");
    expect(storedFormatOf("a.tsv", { kind: "text", text: "" })).toBe("tsv");
    expect(storedFormatOf("a.txt", { kind: "text", text: "" })).toBe("txt");
    expect(storedFormatOf("a.xlsx", { kind: "cells", cells: { format: "xlsx", records: [] } })).toBe("xlsx");
  });
});

describe("planChecklistBatches", () => {
  const section = (name: string, rows: number, wide = 0) => ({
    name,
    key: name.toLowerCase(),
    rows: Array.from({ length: rows }, (_, i) => ({
      number: String(i + 1),
      players: [`Player ${i}${"x".repeat(wide)}`],
      teams: [],
    })),
  });

  it("sends whole sections, in order, with each call's first ordinal", () => {
    const batches = planChecklistBatches([section("A", 3), section("B", 3), section("C", 3)], { rows: 6 });
    expect(batches.map((b) => [b.firstOrdinal, b.sections.map((s) => s.name), b.rowCount])).toEqual([
      [0, ["A", "B"], 6],
      [2, ["C"], 3],
    ]);
  });

  it("holds the section, row and byte limits, never splitting a section", () => {
    expect(planChecklistBatches([section("A", 1), section("B", 1), section("C", 1)], { sections: 2 }).map((b) => b.sections.length)).toEqual([2, 1]);
    const sizes = planChecklistBatches([section("A", 10, 100), section("B", 10, 100)], { bytes: 1500 });
    expect(sizes).toHaveLength(2);
    for (const b of sizes) expect(b.byteSize).toBeLessThanOrEqual(1500 * 2);
    // A section bigger than any call still gets a call of its own, whole.
    const huge = planChecklistBatches([section("A", 1), section("Big", 5), section("C", 1)], { rows: 3 });
    expect(huge.map((b) => b.sections.map((s) => s.name))).toEqual([["A"], ["Big"], ["C"]]);
    expect(huge[1].sections[0].rows).toHaveLength(5);
  });

  it("measures bytes the way the server stores a row, flags included", () => {
    const [batch] = planChecklistBatches([section("A", 2)]);
    expect(batch.byteSize).toBeGreaterThan(0);
    const [bare] = planChecklistBatches([section("A", 2)], { bytes: batch.byteSize - 1 });
    // One row per call once two no longer fit... but a section is never split.
    expect(bare.sections[0].rows).toHaveLength(2);
  });

  it("drops the parser's key: the wire carries name, group and rows only", () => {
    const [batch] = planChecklistBatches([{ ...section("A", 1), group: "INSERT" }]);
    expect(Object.keys(batch.sections[0]).sort()).toEqual(["group", "name", "rows"]);
  });
});

describe("uploadChecklist", () => {
  const sections = ["A", "B", "C"].map((name) => ({
    name,
    key: name.toLowerCase(),
    rows: [{ number: "1", players: ["P"], teams: [] }],
  }));
  const batches = planChecklistBatches(sections, { sections: 1 });
  const base = { setId: SET_ID, fileName: "f.csv", format: "csv" as const, batches };

  function server() {
    let count = 0;
    const api = {
      start: vi.fn(async () => {
        count = 0;
        return { checklistId: CHECKLIST_ID };
      }),
      addSections: vi.fn(async (args: { firstOrdinal: number; sections: unknown[] }) => {
        if (args.firstOrdinal !== count) {
          throw new ConvexError(`This batch starts at section ${args.firstOrdinal + 1}, but ${count} sections have arrived. Upload the file again.`);
        }
        count += args.sections.length;
        return { sectionCount: count, rowCount: count, byteSize: 1 };
      }),
      finish: vi.fn(async () => null),
    };
    return api;
  }

  it("reports progress after every confirmed call, then finishes with the totals", async () => {
    const api = server();
    const progress: number[] = [];
    const out = await uploadChecklist(api, { ...base, onProgress: (saved) => progress.push(saved) });
    expect(out).toEqual({ ok: true, sectionCount: 3, rowCount: 3 });
    expect(progress).toEqual([0, 1, 2, 3]);
    expect(api.finish).toHaveBeenCalledWith({ checklistId: CHECKLIST_ID, sectionCount: 3, rowCount: 3 });
  });

  it("a refused call hands back the server's confirmed count, and resuming sends from there", async () => {
    const api = server();
    const real = api.addSections.getMockImplementation()!;
    api.addSections.mockImplementationOnce(real).mockImplementationOnce(async () => {
      throw new Error("network");
    });
    const first = await uploadChecklist(api, base);
    expect(first).toMatchObject({ ok: false, checkpoint: { checklistId: CHECKLIST_ID, sectionsSaved: 1 } });
    if (first.ok || first.stopped) throw new Error("expected a refusal");
    const again = await uploadChecklist(api, { ...base, resumeFrom: first.checkpoint });
    expect(again).toMatchObject({ ok: true });
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(api.addSections.mock.calls.map((c) => c[0].firstOrdinal)).toEqual([0, 1, 1, 2]);
  });

  it("a lost call that had in fact landed: the resume is refused, so it starts over once, never doubling", async () => {
    const api = server();
    const real = api.addSections.getMockImplementation()!;
    // The second call lands on the server but its answer is lost.
    api.addSections.mockImplementationOnce(real).mockImplementationOnce(async (args) => {
      await real(args);
      throw new Error("network");
    });
    const first = await uploadChecklist(api, base);
    if (first.ok || first.stopped) throw new Error("expected a refusal");
    expect(first.checkpoint?.sectionsSaved).toBe(1);
    const again = await uploadChecklist(api, { ...base, resumeFrom: first.checkpoint });
    expect(again).toEqual({ ok: true, sectionCount: 3, rowCount: 3 });
    expect(api.start).toHaveBeenCalledTimes(2);
    // The refused resume (ordinal 1 after 2 arrived), then 0, 1, 2 afresh.
    expect(api.addSections.mock.calls.map((c) => c[0].firstOrdinal)).toEqual([0, 1, 1, 0, 1, 2]);
  });

  it("stops between calls when asked, and never finishes", async () => {
    const api = server();
    let stop = false;
    const out = await uploadChecklist(api, {
      ...base,
      onProgress: (saved) => {
        if (saved === 1) stop = true;
      },
      shouldStop: () => stop,
    });
    expect(out).toEqual({ ok: false, stopped: true });
    expect(api.finish).not.toHaveBeenCalled();
  });
});

describe("uploadFailure", () => {
  const cases: Array<[string, RegExp, "retry" | "file"]> = [
    ["This batch starts at section 4, but 3 sections have arrived. Upload the file again.", /pick up where it left off/, "retry"],
    ["A batch can carry at most 100 sections; this one has 101.", /pick up where it left off/, "retry"],
    ["That checklist upload has already finished or was stopped. Upload the file again.", /pick up where it left off/, "retry"],
    ["The upload is incomplete: 2 sections and 4 rows arrived, not 3 and 5. Upload the file again.", /pick up where it left off/, "retry"],
    ["Section “Base” is too large to store (over 2 MB).", /“Base” is too big to keep in one piece/, "file"],
    ["This checklist is too large to store (over 16 MB).", /too big to keep\. Leave out the sections/, "file"],
    ["A checklist can have at most 1000 sections.", /more than 1,000 sections/, "file"],
    ["A checklist can have at most 50000 rows.", /more than 50,000 cards/, "file"],
    ["Two sections are named “Base”.", /Rename one in the file/, "file"],
    ["Row 3 of section “Base” says No Team and names a team.", /^Row 3 of section “Base” says No Team and names a team\. Fix it in the file/, "file"],
  ];
  it.each(cases)("%s", (server, copy, fix) => {
    const out = uploadFailure(new ConvexError(server));
    expect(out.message).toMatch(copy);
    expect(out.fix).toBe(fix);
    expect(out.message).not.toMatch(/batch|chunk|arrived/i);
  });

  it("a plain Error (redacted on prod) or a dropped line reads as an interrupted save", () => {
    expect(uploadFailure(new Error("Admin access required"))).toEqual({ message: SAVE_INTERRUPTED, fix: "retry" });
    expect(uploadFailure("boom")).toEqual({ message: SAVE_INTERRUPTED, fix: "retry" });
  });
});

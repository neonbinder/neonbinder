/**
 * NEO-349 — the blackout label: a solid black 4×6 sheet that covers the old
 * label on a reused mailer.
 *
 * What is pinned here is what the paper depends on and an E2E spec cannot see:
 * the print dialog is the browser's, so a spec can press the button but never
 * read the document handed to it. A page that printed at the wrong size, or a
 * body without the black fill, would pass any spec and still waste a label.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/print/print-html", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/print/print-html")>()),
  printHtmlDocument: vi.fn(),
}));

import { printHtmlDocument } from "@/lib/print/print-html";
import { DEFAULT_LABEL_FORMAT } from "@/lib/shipping/label-formats";
import BlackoutLabelPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  (printHtmlDocument as Mock).mockResolvedValue(undefined);
});

function printButton() {
  return screen.getByRole("button", { name: "Print Blackout Label" });
}

describe("BlackoutLabelPage", () => {
  it("shows a true-size black preview and a print button, with nothing to fill in", () => {
    render(<BlackoutLabelPage />);

    // h2 — the Print Shop h1 belongs to PrintLayout.
    expect(
      screen.getByRole("heading", { level: 2, name: "Blackout Label" }),
    ).toBeTruthy();

    const preview = screen.getByRole("img", {
      name: "A solid black 4 by 6 inch label",
    });
    expect(preview.style.width).toBe(`${DEFAULT_LABEL_FORMAT.widthIn}in`);
    expect(preview.style.height).toBe(`${DEFAULT_LABEL_FORMAT.heightIn}in`);
    expect(preview.style.background).toMatch(/#000|rgb\(0, 0, 0\)/);

    // The scroll container is keyboard-reachable for narrow screens.
    const group = screen.getByRole("group", { name: "Preview" });
    expect(group.getAttribute("tabindex")).toBe("0");

    // No gate: the button is live from the first render.
    expect((printButton() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/Print at 100% scale/)).toBeTruthy();
  });

  it("prints a full-bleed black page at the shared 4×6 label size", async () => {
    render(<BlackoutLabelPage />);
    await act(async () => {
      fireEvent.click(printButton());
    });

    expect(printHtmlDocument).toHaveBeenCalledTimes(1);
    const [options] = (printHtmlDocument as Mock).mock.calls[0];
    const { widthIn, heightIn } = DEFAULT_LABEL_FORMAT;

    // The same page the shipping label prints at, so one printer setup does both.
    expect(options.page).toEqual({ widthIn, heightIn });
    // The block fills the page exactly, in pure black.
    expect(options.bodyHtml).toContain(`width:${widthIn}in`);
    expect(options.bodyHtml).toContain(`height:${heightIn}in`);
    expect(options.bodyHtml).toContain("background:#000");
    // And the document behind it is black too, so a page rounded a hair larger
    // than the block still prints no white edge.
    expect(options.css).toMatch(/html, body \{[^}]*background: #000/);
    // Nothing a seller typed reaches this document — there is no input at all.
    expect(options.bodyHtml).not.toMatch(/<(script|img|svg)/i);
  });

  it("says why when the print dialog cannot open", async () => {
    (printHtmlDocument as Mock).mockRejectedValueOnce(
      new Error("Print frame was not reachable"),
    );
    render(<BlackoutLabelPage />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("");

    await act(async () => {
      fireEvent.click(printButton());
    });
    expect(alert.textContent).toBe("Print frame was not reachable");

    // A retry clears the old message before trying again.
    (printHtmlDocument as Mock).mockResolvedValueOnce(undefined);
    await act(async () => {
      fireEvent.click(printButton());
    });
    expect(alert.textContent).toBe("");
  });
});

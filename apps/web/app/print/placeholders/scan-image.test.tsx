import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScanImage } from "./scan-image";

/**
 * NEO-481 — a hand edit writes a new version of a scan's output, so the
 * row's `editVersion` is part of the signed URL's key: a new version mints a
 * new URL, the same version never mints twice. With `onOpen` the picture is a
 * button that opens the photo viewer.
 */
const mint = vi.hoisted(() => vi.fn(async (args: { jobId: string; entryIndex: number }) => ({ url: `https://signed/${args.entryIndex}/${mint.mock.calls.length}` })));
vi.mock("convex/react", () => ({ useAction: () => mint }));

afterEach(() => {
  cleanup();
  mint.mockClear();
});

describe("ScanImage", () => {
  it("mints again when the edit version changes, and only then", async () => {
    const { rerender } = render(<ScanImage jobId="j" entryIndex={3} alt="Front scan" />);
    await waitFor(() => expect(screen.getByRole("img", { name: "Front scan" }).getAttribute("src")).toBe("https://signed/3/1"));
    rerender(<ScanImage jobId="j" entryIndex={3} alt="Front scan" />);
    rerender(<ScanImage jobId="j" entryIndex={3} alt="Front scan" version={undefined} />);
    expect(mint).toHaveBeenCalledTimes(1);

    rerender(<ScanImage jobId="j" entryIndex={3} alt="Front scan" version={1} />);
    await waitFor(() => expect(screen.getByRole("img", { name: "Front scan" }).getAttribute("src")).toBe("https://signed/3/2"));
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("with onOpen, the picture is a button named for what it opens", async () => {
    const onOpen = vi.fn();
    render(<ScanImage jobId="j" entryIndex={0} alt="Front scan" onOpen={onOpen} openLabel="Open front of Ken Griffey Jr." />);
    const button = await screen.findByRole("button", { name: "Open front of Ken Griffey Jr." });
    await waitFor(() => expect(screen.getByRole("img", { name: "Front scan" })).toBeTruthy());
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledWith(button);
  });

  it("while an edit renders, says so over the picture", async () => {
    render(<ScanImage jobId="j" entryIndex={0} alt="Front scan" pending={{ status: "rendering", edit: { turns: 1, crop: null } }} />);
    await screen.findByText("Touching it up…");
  });
});

import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Dropzone } from "./dropzone";
import { expectAccessibleInBothModes } from "@/lib/testing/axe";

/**
 * The drop zone. NEO-452 made it always open: a caller that isn't ready to
 * send takes the files anyway and holds them in a tray of its own, so the only
 * thing that stops a drop is `disabled` (a send is running), which is
 * `aria-disabled`, never the native attribute. The headline and
 * the accessible name never change for a caller's state (the E2E specs find it
 * by that name); `hint` and `describedBy` say what a drop will do.
 */
const NAME = "Drag your card photos here, or browse your files";
const DEFAULT_HINT = /JPEG or PNG, or a single zip\. Uploading starts as soon as you choose/;

function setup(props: Partial<Parameters<typeof Dropzone>[0]> = {}) {
  const onFiles = vi.fn();
  const view = render(<Dropzone quiet files={[]} disabled={false} onFiles={onFiles} {...props} />);
  return { view, onFiles };
}

const input = () => screen.getByLabelText(NAME) as HTMLInputElement;
const jpeg = (name = "front.jpg") => new File(["x"], name, { type: "image/jpeg" });
const drop = (el: Element, files = [jpeg()]) => fireEvent.drop(el, { dataTransfer: { files } });
const choose = (files: File[]) => fireEvent.change(input(), { target: { files } });

afterEach(cleanup);

describe("Dropzone, always open (NEO-452)", () => {
  it("is never aria-disabled or inert: the same headline and name, usual hint, a drop sends the files", () => {
    const { onFiles } = setup();
    const el = input();
    expect(el.disabled).toBe(false);
    expect(el.getAttribute("aria-disabled")).toBeNull();
    expect(el.getAttribute("aria-describedby")).toBeNull();
    expect(screen.getByText("Drag your card photos here")).toBeTruthy();
    expect(screen.getByText(DEFAULT_HINT)).toBeTruthy();
    drop(el.closest("label")!);
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(["front.jpg"]);
  });

  it("a click opens the picker: nothing cancels it", () => {
    setup();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    input().dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });

  it("a caller's hint replaces the usual line, and its describedBy ids reach the input", () => {
    setup({ hint: "Drop them whenever. They wait here.", describedBy: "why tray" });
    expect(screen.getByText("Drop them whenever. They wait here.")).toBeTruthy();
    expect(screen.queryByText(DEFAULT_HINT)).toBeNull();
    expect(input().getAttribute("aria-describedby")).toBe("why tray");
    // The name and the headline are the same with a hint as without.
    expect(screen.getByText("Drag your card photos here")).toBeTruthy();
    expect(input().getAttribute("aria-disabled")).toBeNull();
  });

  it("a hint does not stop a drop", () => {
    const { onFiles } = setup({ hint: "They wait here." });
    drop(input().closest("label")!);
    expect(onFiles).toHaveBeenCalledTimes(1);
  });

  it("chosen from the picker, the files arrive and the input is emptied", () => {
    const { onFiles } = setup();
    choose([jpeg("a.jpg"), jpeg("b.jpg")]);
    expect(onFiles).toHaveBeenCalledTimes(1);
    // A copy, taken before the input was cleared.
    expect(onFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(["a.jpg", "b.jpg"]);
  });

  it("empties the input after reading it, or choosing the same files again would fire no change", () => {
    setup();
    const assigned = vi.fn();
    Object.defineProperty(input(), "value", { configurable: true, get: () => "C:\\fakepath\\a.jpg", set: assigned });
    choose([jpeg("a.jpg")]);
    expect(assigned).toHaveBeenCalledWith("");
  });

  it("picking the same files again fires again: the input forgot them", () => {
    const { onFiles } = setup();
    const same = jpeg("same.jpg");
    choose([same]);
    choose([same]);
    expect(onFiles).toHaveBeenCalledTimes(2);
    expect(onFiles.mock.calls[1][0]).toEqual([same]);
  });

  it("an empty choice sends nothing", () => {
    const { onFiles } = setup();
    choose([]);
    drop(input().closest("label")!, []);
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("hands the caller its input, to put focus back on", () => {
    const ref = createRef<HTMLInputElement>();
    setup({ inputRef: ref });
    expect(ref.current).toBe(input());
  });

  it("the tray sits inside the drag target, so a drop on it counts instead of the browser opening the file", () => {
    const { onFiles } = setup({ tray: <p>2 photos waiting.</p>, trayFilled: true });
    drop(screen.getByText("2 photos waiting."));
    expect(onFiles).toHaveBeenCalledTimes(1);
  });

  it("a dragover on the tray is cancelled, which is what makes it a drop target", () => {
    setup({ tray: <p>2 photos waiting.</p> });
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    screen.getByText("2 photos waiting.").dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
  });

  it("drawing the tray changes nothing about the headline", () => {
    setup({ tray: <p>1 photo waiting.</p>, trayFilled: true });
    expect(screen.getByText("Drag your card photos here")).toBeTruthy();
    expect(screen.getByText("1 photo waiting.")).toBeTruthy();
  });
});

describe("Dropzone while a send is running (disabled)", () => {
  it("says it is sending and is aria-disabled, never natively disabled (a send would drop the focus to the page's top)", () => {
    setup({ disabled: true });
    expect(input().disabled).toBe(false);
    expect(input().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Sending your photos…")).toBeTruthy();
    expect(screen.queryByText("Drag your card photos here")).toBeNull();
  });

  it("is described by its headline, so a screen reader hears that it is sending, ahead of the caller's description", () => {
    setup({ disabled: true, describedBy: "why" });
    const ids = (input().getAttribute("aria-describedby") ?? "").split(" ");
    expect(document.getElementById(ids[0])?.textContent).toBe("Sending your photos…");
    expect(ids).toContain("why");
  });

  it("keeps focus where it was when a send starts", () => {
    const view = setup();
    input().focus();
    view.view.rerender(<Dropzone quiet files={[]} disabled onFiles={view.onFiles} />);
    expect(document.activeElement).toBe(input());
  });

  it("a drop sends nothing, and tells the caller it arrived", () => {
    const onFilesWhileDisabled = vi.fn();
    const { onFiles } = setup({ disabled: true, onFilesWhileDisabled });
    drop(input().closest("label")!);
    expect(onFiles).not.toHaveBeenCalled();
    expect(onFilesWhileDisabled).toHaveBeenCalledTimes(1);
  });

  it("a drop with no files in it is not news", () => {
    const onFilesWhileDisabled = vi.fn();
    setup({ disabled: true, onFilesWhileDisabled });
    drop(input().closest("label")!, []);
    expect(onFilesWhileDisabled).not.toHaveBeenCalled();
  });

  it("a file picker answering during the send is ignored, and reported", () => {
    const onFilesWhileDisabled = vi.fn();
    const { onFiles } = setup({ disabled: true, onFilesWhileDisabled });
    choose([jpeg()]);
    expect(onFiles).not.toHaveBeenCalled();
    expect(onFilesWhileDisabled).toHaveBeenCalledTimes(1);
  });

  it("a click opens no picker while it sends", () => {
    setup({ disabled: true });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    input().dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });

  it("a drop on the tray sends nothing either", () => {
    const { onFiles } = setup({ disabled: true, tray: <p>2 photos waiting.</p> });
    drop(screen.getByText("2 photos waiting."));
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("keeps its accessible name", () => {
    setup({ disabled: true });
    expect(screen.getByLabelText(NAME)).toBeTruthy();
  });
});

describe("Dropzone explains a selection it refuses", () => {
  it("a zip mixed with photos is an alert beside the zone, even when the caller is quiet", () => {
    setup({ files: [new File(["x"], "pile.zip", { type: "application/zip" }), jpeg()] });
    expect(screen.getByRole("alert").textContent).toMatch(/not both/);
  });

  it("a good selection raises no alert", () => {
    setup({ files: [jpeg()] });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Dropzone accessibility", () => {
  it("passes axe in light and dark, with the usual hint and with a hint, a tray and a description", async () => {
    const plain = setup();
    await expectAccessibleInBothModes(plain.view.container, { label: "Dropzone, open" });
    cleanup();
    const busy = setup({
      hint: "Drop them whenever. They wait here until the run is set up.",
      describedBy: "why",
      tray: <p id="why">2 photos waiting. Pick a set and they're off.</p>,
      trayFilled: true,
    });
    await expectAccessibleInBothModes(busy.view.container, { label: "Dropzone, hint and tray" });
    cleanup();
    const sending = setup({ disabled: true });
    await expectAccessibleInBothModes(sending.view.container, { label: "Dropzone, sending" });
  });
});

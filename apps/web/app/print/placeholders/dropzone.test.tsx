import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { Dropzone } from "./dropzone";
import { expectAccessibleInBothModes } from "@/lib/testing/axe";

/**
 * NEO-370 — the drop zone held for a reason the caller shows beside it
 * (`heldBy`): still a Tab stop, `aria-disabled`, described by the reason; a
 * click (the picker) and a drop do nothing; the headline says what to do.
 * Its accessible name never changes (the E2E specs find it by that name).
 */
const NAME = "Drag your card photos here, or browse your files";

function setup(held: boolean) {
  const onFiles = vi.fn();
  const view = render(
    <div>
      {held && <p id="why">Price tag first!</p>}
      <Dropzone
        quiet
        files={[]}
        disabled={false}
        onFiles={onFiles}
        heldBy={held ? "why" : undefined}
        heldLabel="Set a price, then drop your photos"
      />
    </div>,
  );
  return { view, onFiles };
}

const input = () => screen.getByLabelText(NAME) as HTMLInputElement;
const drop = (el: Element) => {
  const file = new File(["x"], "front.jpg", { type: "image/jpeg" });
  fireEvent.drop(el, { dataTransfer: { files: [file] } });
};

afterEach(cleanup);

describe("Dropzone held (NEO-370)", () => {
  it("held: focusable, aria-disabled, described by the reason, and its headline says what to do", () => {
    setup(true);
    const el = input();
    expect(el.disabled).toBe(false);
    expect(el.getAttribute("aria-disabled")).toBe("true");
    expect(el.getAttribute("aria-describedby")).toBe("why");
    expect(screen.getByText("Set a price, then drop your photos")).toBeTruthy();
    expect(screen.queryByText("Drag your card photos here")).toBeNull();
  });

  it("held: a click opens no picker and a drop sends nothing", () => {
    const { onFiles } = setup(true);
    const click = createEvent.click(input());
    fireEvent(input(), click);
    expect(click.defaultPrevented).toBe(true);
    drop(input().closest("label")!);
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("open: no hold, the usual headline, and a drop sends the files", () => {
    const { onFiles } = setup(false);
    const el = input();
    expect(el.getAttribute("aria-disabled")).toBeNull();
    expect(el.getAttribute("aria-describedby")).toBeNull();
    expect(screen.getByText("Drag your card photos here")).toBeTruthy();
    const click = createEvent.click(el);
    fireEvent(el, click);
    expect(click.defaultPrevented).toBe(false);
    drop(el.closest("label")!);
    expect(onFiles).toHaveBeenCalledTimes(1);
  });

  it("passes axe in light and dark, held and open", async () => {
    const held = setup(true);
    await expectAccessibleInBothModes(held.view.container, { label: "Dropzone, held" });
    cleanup();
    const open = setup(false);
    await expectAccessibleInBothModes(open.view.container, { label: "Dropzone, open" });
  });
});

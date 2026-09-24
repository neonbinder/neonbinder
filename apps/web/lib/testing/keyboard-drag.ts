/**
 * NEO-300 — drive a REAL dnd-kit keyboard drag in happy-dom.
 *
 * happy-dom does no layout: every element measures 0×0 at (0,0), so a
 * keyboard drag has nothing to collide with and every drop lands nowhere,
 * which is exactly the bug the keyboard-aware collision fixes. `stubLayout`
 * gives chosen elements a rectangle (everything else stays 0×0), so a
 * component test can lift an item with Space, move it with the arrows and
 * drop it with Space through dnd-kit's own KeyboardSensor and collision code.
 *
 * The DragOverlay wrapper is the one element dnd-kit positions itself (inline
 * `position: fixed` plus top/left/width/height copied from the lifted item),
 * and dnd-kit measures that wrapper's only child. Both are measured from the
 * wrapper's inline values, because the overlay's rectangle is what a drag
 * collides with.
 */
import { act, fireEvent } from "@testing-library/react";

export type Box = { top: number; left: number; width: number; height: number };

function domRect({ top, left, width, height }: Box): DOMRect {
  return {
    top,
    left,
    width,
    height,
    bottom: top + height,
    right: left + width,
    x: left,
    y: top,
    toJSON() {
      return this;
    },
  } as DOMRect;
}

const px = (v: string) => Number.parseFloat(v) || 0;

/** Give `boxes` their rectangles until the returned restore is called. */
export function stubLayout(boxes: Map<Element, Box>): () => void {
  const proto = Element.prototype;
  const original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: Element) {
    const box = boxes.get(this);
    if (box) return domRect(box);
    // dnd-kit measures the overlay's only child, not the wrapper it styled.
    for (const el of [this, this.parentElement]) {
      const style = (el as HTMLElement | null)?.style;
      if (style?.position === "fixed" && style.width) {
        return domRect({
          top: px(style.top),
          left: px(style.left),
          width: px(style.width),
          height: px(style.height),
        });
      }
    }
    return domRect({ top: 0, left: 0, width: 0, height: 0 });
  };
  return () => {
    proto.getBoundingClientRect = original;
  };
}

/** dnd-kit attaches its keydown listener on a timeout after the lift. */
async function tick() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/**
 * Space on `handle`, `presses` ArrowDown/ArrowUp/ArrowLeft/ArrowRight (25px
 * each, dnd-kit's default), then Space to drop.
 */
export async function keyboardDrag(
  handle: Element,
  moves: Array<"ArrowDown" | "ArrowUp" | "ArrowLeft" | "ArrowRight">,
): Promise<void> {
  act(() => {
    fireEvent.keyDown(handle, { key: " ", code: "Space" });
  });
  await tick();
  for (const code of moves) {
    act(() => {
      fireEvent.keyDown(document, { key: code, code });
    });
  }
  await tick();
  act(() => {
    fireEvent.keyDown(document, { key: " ", code: "Space" });
  });
  await tick();
}

/**
 * NEO-300 — the shared collision rule, on its own. Each modal that uses it
 * proves a real keyboard drop lands in its own component test.
 */
import { describe, expect, test } from "vitest";
import { keyboardAwareCollision } from "./keyboard-aware-collision";

const rect = (top: number, height: number) => ({
  top,
  left: 0,
  width: 400,
  height,
  bottom: top + height,
  right: 400,
});

function args(pointer: { x: number; y: number } | null) {
  const droppableRects = new Map([
    ["upper", rect(0, 100)],
    ["lower", rect(120, 100)],
  ]);
  return {
    active: { id: "row" },
    // The dragged item sits over "lower"...
    collisionRect: rect(150, 30),
    droppableRects,
    droppableContainers: [...droppableRects.keys()].map((id) => ({ id })),
    // ...while the pointer, when there is one, is over "upper".
    pointerCoordinates: pointer,
  } as unknown as Parameters<typeof keyboardAwareCollision>[0];
}

describe("keyboardAwareCollision", () => {
  test("a keyboard drag (no pointer) lands where the dragged item overlaps", () => {
    expect(keyboardAwareCollision(args(null)).map((c) => c.id)).toEqual([
      "lower",
    ]);
  });

  test("a pointer drag lands under the pointer, as before", () => {
    expect(
      keyboardAwareCollision(args({ x: 10, y: 50 })).map((c) => c.id),
    ).toEqual(["upper"]);
  });
});

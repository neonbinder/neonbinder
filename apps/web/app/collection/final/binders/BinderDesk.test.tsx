import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import BinderDesk from "./BinderDesk";
import type { PageModel } from "./model";

/**
 * The phone layout (`wide` false) turns the page on a swipe. A swipe must be
 * sideways on purpose: at least 50px across and at least 1.5x as far across as
 * it is down, so a diagonal scroll down the page does not turn it. A touch the
 * browser cancels forgets where it started.
 */

const page = (): PageModel => ({
  section: null,
  pockets: Array.from({ length: 9 }, () => ({ content: { kind: "empty" as const } })),
});
const PAGES = [page(), page(), page(), page(), page()];

function renderDesk(opts: { at?: number; wide?: boolean } = {}) {
  const onTurn = vi.fn();
  render(
    <BinderDesk
      pages={PAGES}
      wide={opts.wide ?? false}
      at={opts.at ?? 2}
      onTurn={onTurn}
      vinyl="#123456"
      cover={null}
      variant="binder"
      aimed={null}
      wholeBinderDrop={false}
      reducedMotion
      name="Test binder"
      onOpen={vi.fn()}
      onAdd={vi.fn()}
      onAim={vi.fn()}
    />,
  );
  return { onTurn, region: screen.getByRole("region", { name: "Test binder, open" }) };
}

const point = (x: number, y: number) => ({ clientX: x, clientY: y });
function swipe(region: Element, from: [number, number], to: [number, number]) {
  fireEvent.touchStart(region, { touches: [point(...from)] });
  fireEvent.touchEnd(region, { changedTouches: [point(...to)] });
}

describe("BinderDesk — swipe to turn (phone)", () => {
  test("a swipe left turns to the next page", () => {
    const { onTurn, region } = renderDesk({ at: 2 });
    swipe(region, [200, 100], [100, 100]);
    expect(onTurn).toHaveBeenCalledExactlyOnceWith(3);
  });

  test("a swipe right turns to the previous page", () => {
    const { onTurn, region } = renderDesk({ at: 2 });
    swipe(region, [100, 100], [200, 100]);
    expect(onTurn).toHaveBeenCalledExactlyOnceWith(1);
  });

  test("a swipe left on the last page does not turn past it", () => {
    const { onTurn, region } = renderDesk({ at: 4 });
    swipe(region, [200, 100], [100, 100]);
    expect(onTurn).not.toHaveBeenCalled();
  });

  test("a swipe right on the first page does not turn before it", () => {
    const { onTurn, region } = renderDesk({ at: 0 });
    swipe(region, [100, 100], [200, 100]);
    expect(onTurn).not.toHaveBeenCalled();
  });

  test("a vertical swipe does not turn", () => {
    const { onTurn, region } = renderDesk();
    swipe(region, [100, 50], [100, 300]);
    expect(onTurn).not.toHaveBeenCalled();
  });

  test("a diagonal swipe (as far down as across) does not turn", () => {
    const { onTurn, region } = renderDesk();
    swipe(region, [200, 100], [100, 200]);
    expect(onTurn).not.toHaveBeenCalled();
  });

  test("49px across does not turn; 50px does", () => {
    const short = renderDesk();
    swipe(short.region, [200, 100], [151, 100]);
    expect(short.onTurn).not.toHaveBeenCalled();
    swipe(short.region, [200, 100], [150, 100]);
    expect(short.onTurn).toHaveBeenCalledExactlyOnceWith(3);
  });

  test("across must be at least 1.5x down: 100 across, 67 down does not turn, 66 does", () => {
    const { onTurn, region } = renderDesk();
    swipe(region, [200, 100], [100, 167]); // 100 < 1.5 * 67
    expect(onTurn).not.toHaveBeenCalled();
    swipe(region, [200, 100], [100, 166]); // 100 >= 1.5 * 66
    expect(onTurn).toHaveBeenCalledExactlyOnceWith(3);
  });

  test("the 1.5 ratio is exact at the boundary: 75 across, 50 down turns", () => {
    const { onTurn, region } = renderDesk();
    swipe(region, [200, 100], [125, 150]);
    expect(onTurn).toHaveBeenCalledExactlyOnceWith(3);
  });

  test("a touchend after a touchcancel, with no fresh touchstart, does nothing", () => {
    const { onTurn, region } = renderDesk();
    fireEvent.touchStart(region, { touches: [point(200, 100)] });
    fireEvent.touchCancel(region);
    fireEvent.touchEnd(region, { changedTouches: [point(100, 100)] });
    expect(onTurn).not.toHaveBeenCalled();
  });

  test("a swipe is one gesture: its start is forgotten once it ends", () => {
    const { onTurn, region } = renderDesk();
    swipe(region, [200, 100], [100, 100]);
    fireEvent.touchEnd(region, { changedTouches: [point(0, 100)] });
    expect(onTurn).toHaveBeenCalledTimes(1);
  });
});

describe("BinderDesk — wide layout", () => {
  test("a swipe does not turn the page on a wide screen", () => {
    const { onTurn, region } = renderDesk({ wide: true, at: 1 });
    swipe(region, [200, 100], [100, 100]);
    expect(onTurn).not.toHaveBeenCalled();
  });
});

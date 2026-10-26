import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useRef, type CSSProperties } from "react";
import { HEADER_HEIGHT_EVENT, HEADER_HEIGHT_VAR, useStickyHeaderHeight } from "./useStickyHeaderHeight";

function Header({ style }: { style: CSSProperties }) {
  const ref = useRef<HTMLElement>(null);
  useStickyHeaderHeight(ref);
  return <header ref={ref} style={style} />;
}

const published = () => document.documentElement.style.getPropertyValue(HEADER_HEIGHT_VAR);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useStickyHeaderHeight", () => {
  it("publishes a sticky header's height, rounded up, and announces it", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 78.4 } as DOMRect);
    const heard = vi.fn();
    window.addEventListener(HEADER_HEIGHT_EVENT, heard);
    render(<Header style={{ position: "sticky" }} />);
    window.removeEventListener(HEADER_HEIGHT_EVENT, heard);
    expect(published()).toBe("79px");
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("publishes 0px while the header scrolls away (not sticky), whatever its height", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 78 } as DOMRect);
    render(<Header style={{ position: "static" }} />);
    expect(published()).toBe("0px");
  });

  it("takes the value back off <html> when the header goes", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 64 } as DOMRect);
    const { unmount } = render(<Header style={{ position: "sticky" }} />);
    expect(published()).toBe("64px");
    unmount();
    expect(published()).toBe("");
  });
});

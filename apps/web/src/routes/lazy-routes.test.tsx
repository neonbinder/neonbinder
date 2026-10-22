import { lazy } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Deferred, PrefetchBinderTabs } from "./lazy-routes";

type IdleCb = (deadline: unknown) => void;
const hadIdle = Object.getOwnPropertyDescriptor(window, "requestIdleCallback");
const hadCancel = Object.getOwnPropertyDescriptor(window, "cancelIdleCallback");

function restore(key: "requestIdleCallback" | "cancelIdleCallback", d?: PropertyDescriptor) {
  if (d) Object.defineProperty(window, key, d);
  else delete (window as unknown as Record<string, unknown>)[key];
}

afterEach(() => {
  cleanup();
  restore("requestIdleCallback", hadIdle);
  restore("cancelIdleCallback", hadCancel);
  vi.useRealTimers();
});

// Captured before any test installs fake timers.
const realSetTimeout = setTimeout;

/** Unhandled rejections seen while `fn` runs and the microtask queue drains. */
async function unhandledDuring(fn: () => void | Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const on = (reason: unknown) => seen.push(reason);
  const saved = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", on);
  try {
    await fn();
    // unhandledRejection fires after the microtask queue drains.
    await new Promise((r) => realSetTimeout(r, 20));
  } finally {
    process.off("unhandledRejection", on);
    for (const l of saved) process.on("unhandledRejection", l);
  }
  return seen;
}

const loaders = () => Array.from({ length: 6 }, () => vi.fn(() => Promise.resolve({})));

describe("PrefetchBinderTabs — with requestIdleCallback", () => {
  let idle: Map<number, IdleCb>;
  let requestIdleCallback: ReturnType<typeof vi.fn>;
  let cancelIdleCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    idle = new Map();
    let next = 1;
    requestIdleCallback = vi.fn((cb: IdleCb) => {
      idle.set(next, cb);
      return next++;
    });
    cancelIdleCallback = vi.fn((id: number) => {
      idle.delete(id);
    });
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      writable: true,
      value: requestIdleCallback,
    });
    Object.defineProperty(window, "cancelIdleCallback", {
      configurable: true,
      writable: true,
      value: cancelIdleCallback,
    });
  });

  const runIdle = () =>
    act(() => {
      for (const cb of [...idle.values()]) cb({});
    });

  test("loads nothing until the browser is idle", () => {
    const l = loaders();
    render(<PrefetchBinderTabs loaders={l} />);
    expect(requestIdleCallback).toHaveBeenCalledTimes(1);
    for (const load of l) expect(load).not.toHaveBeenCalled();
  });

  test("calls every loader exactly once when idle", () => {
    const l = loaders();
    render(<PrefetchBinderTabs loaders={l} />);
    runIdle();
    for (const load of l) expect(load).toHaveBeenCalledTimes(1);
  });

  test("a rejecting loader neither throws nor stops the others", async () => {
    const l = loaders();
    // Not a vi.fn: a mock records the returned promise, which marks it handled.
    let rejecting = 0;
    l[1] = (() => {
      rejecting++;
      return Promise.reject(new Error("chunk 404"));
    }) as never;
    render(<PrefetchBinderTabs loaders={l} />);
    const seen = await unhandledDuring(() => {
      expect(() => runIdle()).not.toThrow();
    });
    expect(seen).toEqual([]);
    expect(rejecting).toBe(1);
    for (const load of l.filter((_, i) => i !== 1)) expect(load).toHaveBeenCalledTimes(1);
  });

  test("unmounting before idle cancels the pending callback", () => {
    const l = loaders();
    const { unmount } = render(<PrefetchBinderTabs loaders={l} />);
    unmount();
    expect(cancelIdleCallback).toHaveBeenCalledWith(1);
    runIdle();
    for (const load of l) expect(load).not.toHaveBeenCalled();
  });
});

describe("PrefetchBinderTabs — without requestIdleCallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    restore("requestIdleCallback");
    restore("cancelIdleCallback");
  });

  test("falls back to a 1.5s timer, then calls every loader once", () => {
    const l = loaders();
    render(<PrefetchBinderTabs loaders={l} />);
    act(() => {
      vi.advanceTimersByTime(1499);
    });
    for (const load of l) expect(load).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    for (const load of l) expect(load).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    for (const load of l) expect(load).toHaveBeenCalledTimes(1);
  });

  test("unmounting clears the timer", () => {
    const l = loaders();
    const { unmount } = render(<PrefetchBinderTabs loaders={l} />);
    unmount();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    for (const load of l) expect(load).not.toHaveBeenCalled();
  });

  test("a rejecting loader does not throw or leave an unhandled rejection", async () => {
    const l = loaders();
    let rejecting = 0; // not a vi.fn: a mock marks its promise handled
    l[0] = (() => {
      rejecting++;
      return Promise.reject(new Error("offline"));
    }) as never;
    render(<PrefetchBinderTabs loaders={l} />);
    const seen = await unhandledDuring(() => {
      expect(() =>
        act(() => {
          vi.advanceTimersByTime(1500);
        }),
      ).not.toThrow();
    });
    expect(seen).toEqual([]);
    expect(rejecting).toBe(1);
  });
});

describe("Deferred", () => {
  test("shows the status line until the lazy child resolves, then the child", async () => {
    let resolve!: (m: { default: () => React.ReactElement }) => void;
    const Child = lazy(
      () =>
        new Promise<{ default: () => React.ReactElement }>((r) => {
          resolve = r;
        }),
    );
    render(
      <Deferred>
        <Child />
      </Deferred>,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Sleeving the cards…");
    expect(screen.queryByText("The page")).toBeNull();

    await act(async () => {
      resolve({ default: () => <p>The page</p> });
    });
    expect(screen.getByText("The page")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("renders a non-lazy child with no status line", () => {
    render(
      <Deferred>
        <p>Plain</p>
      </Deferred>,
    );
    expect(screen.getByText("Plain")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

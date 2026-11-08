import { lazy, StrictMode, Suspense, useEffect } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import * as Sentry from "@sentry/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  APP_BOUNDARY_OPTIONS,
  CHUNK_RELOAD_GUARD_KEY,
  CHUNK_RELOAD_WINDOW_MS,
  isChunkLoadError,
} from "./chunk-reload";

const CHROME = "Failed to fetch dynamically imported module: https://app.example/assets/page-abc.js";
const MESSAGE = "An error occurred. Please refresh the page.";
const LOADING = "Sleeving the cards…";
const T0 = 1_800_000_000_000;

describe("isChunkLoadError", () => {
  test.each([
    ["Chrome", CHROME],
    ["Chrome, local dev", "Failed to fetch dynamically imported module: http://localhost:3001/app/about/page.tsx"],
    ["Safari", "Importing a module script failed."],
    ["Firefox", "error loading dynamically imported module: https://app.example/assets/page-abc.js"],
    ["Firefox, older", "error loading dynamically imported module"],
    ["Vite's CSS preload", "Unable to preload CSS for /assets/page-abc.css"],
  ])("%s is a chunk failure", (_browser, message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
  });

  test.each([
    ["a generic fetch failure", new TypeError("Failed to fetch")],
    ["Safari's generic fetch failure", new TypeError("Load failed")],
    ["a Convex miss", new Error("Could not find public function for 'cards:list'")],
    ["a bad import name", new SyntaxError("Importing binding name 'x' is not found.")],
    ["an app bug", new TypeError("Cannot read properties of undefined (reading 'map')")],
    ["no message", new Error()],
    ["a thrown string", CHROME],
    ["a non-string message", { message: 42 }],
    ["undefined", undefined],
    ["null", null],
  ])("%s is not", (_label, error) => {
    expect(isChunkLoadError(error)).toBe(false);
  });
});

describe("the top-level boundary", () => {
  let reload: ReturnType<typeof vi.spyOn>;

  /** Renders the real boundary around a lazy page whose import rejects, as a new page load would. */
  function crashOnce(error: unknown = new TypeError(CHROME), { strict = false } = {}) {
    const Page = lazy(() => Promise.reject(error) as Promise<{ default: () => null }>);
    const App = Sentry.withErrorBoundary(function App() {
      return (
        <Suspense fallback={null}>
          <Page />
        </Suspense>
      );
    }, APP_BOUNDARY_OPTIONS);
    return render(strict ? <StrictMode><App /></StrictMode> : <App />);
  }

  const guard = () => window.sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY);

  beforeEach(() => {
    window.sessionStorage.clear();
    vi.spyOn(Date, "now").mockReturnValue(T0);
    // React logs every caught error; the crash is the point of these tests.
    vi.spyOn(console, "error").mockImplementation(() => {});
    reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("a first chunk failure reloads, records the guard and shows the loading line, not the message", async () => {
    crashOnce();

    expect((await screen.findByRole("status")).textContent).toBe(LOADING);
    expect(screen.queryByText(MESSAGE)).toBeNull();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(guard()).toBe(String(T0));
  });

  test("StrictMode's second render of the fallback does not read as a second failure", async () => {
    crashOnce(new TypeError(CHROME), { strict: true });

    expect((await screen.findByRole("status")).textContent).toBe(LOADING);
    expect(screen.queryByText(MESSAGE)).toBeNull();
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(reload).toHaveBeenCalledTimes(1);
    expect(guard()).toBe(String(T0));
  });

  test("the crashed page's cleanups run before the reload, so a leave guard cannot prompt", async () => {
    let cleanedUp = false;
    let cleanedUpAtReload: boolean | undefined;
    reload.mockImplementation(() => {
      cleanedUpAtReload = cleanedUp;
    });
    function LeaveGuard() {
      useEffect(
        () => () => {
          cleanedUp = true;
        },
        [],
      );
      return null;
    }
    const Page = lazy(() => Promise.reject(new TypeError(CHROME)) as Promise<{ default: () => null }>);
    const App = Sentry.withErrorBoundary(function App() {
      return (
        <>
          <LeaveGuard />
          <Suspense fallback={null}>
            <Page />
          </Suspense>
        </>
      );
    }, APP_BOUNDARY_OPTIONS);
    render(<App />);

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(cleanedUpAtReload).toBe(true);
  });

  test("a second failure inside the window shows the message and does not reload", async () => {
    window.sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, String(T0));
    vi.mocked(Date.now).mockReturnValue(T0 + CHUNK_RELOAD_WINDOW_MS - 1);

    crashOnce();

    await screen.findByText(MESSAGE);
    expect(screen.queryByText(LOADING)).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    // The guard keeps its first time: one reload per window, however often this repeats.
    expect(guard()).toBe(String(T0));
  });

  test.each([
    ["a chunk failure past the guard", new TypeError(CHROME), false],
    ["any other error", new TypeError("Cannot read properties of undefined (reading 'map')"), false],
    ["StrictMode", new TypeError(CHROME), true],
  ])("the message is an alert that takes focus, inside a main landmark: %s", async (_label, error, strict) => {
    window.sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, String(T0));

    crashOnce(error, { strict });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(MESSAGE);
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(alert.getAttribute("tabindex")).toBe("-1");
    expect(screen.getByRole("main").contains(alert)).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("the loading line stays a status, not an alert, and does not take focus", async () => {
    crashOnce();

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe(LOADING);
    expect(screen.getByRole("main").contains(status)).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(document.activeElement).not.toBe(status);
  });

  test("a failure after the window reloads again and restarts the guard", async () => {
    window.sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, String(T0));
    const later = T0 + CHUNK_RELOAD_WINDOW_MS;
    vi.mocked(Date.now).mockReturnValue(later);

    crashOnce();

    expect((await screen.findByRole("status")).textContent).toBe(LOADING);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(guard()).toBe(String(later));
  });

  test.each([
    ["garbage", "not-a-time"],
    ["a time in the future", String(T0 + 1)],
  ])("a guard holding %s does not stop the reload", async (_label, stored) => {
    window.sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, stored);

    crashOnce();

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(guard()).toBe(String(T0));
  });

  test.each<[string, () => void]>([
    [
      "storage cannot be reached",
      () =>
        vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
          throw new DOMException("denied", "SecurityError");
        }),
    ],
    [
      "the guard cannot be read",
      () =>
        vi.spyOn(window, "sessionStorage", "get").mockReturnValue({
          getItem: () => {
            throw new Error("no");
          },
          setItem: () => {},
        } as unknown as Storage),
    ],
    [
      "the guard cannot be written",
      () =>
        vi.spyOn(window, "sessionStorage", "get").mockReturnValue({
          getItem: () => null,
          setItem: () => {
            throw new DOMException("full", "QuotaExceededError");
          },
        } as unknown as Storage),
    ],
  ])("when %s it shows the message and never reloads", async (_label, breakStorage) => {
    breakStorage();

    crashOnce();

    await screen.findByText(MESSAGE);
    expect(reload).not.toHaveBeenCalled();
  });

  test("any other error shows the message, never reloads and leaves the guard alone", async () => {
    crashOnce(new TypeError("Cannot read properties of undefined (reading 'map')"));

    await screen.findByText(MESSAGE);
    expect(screen.queryByRole("status")).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    expect(guard()).toBeNull();
  });

  describe("what Sentry records", () => {
    const sent: Sentry.ErrorEvent[] = [];

    beforeAll(() => {
      // A real client, so this proves the event the SDK builds rather than the
      // setter calls (the browser SDK stamps exceptions "error" before the scope
      // applies). Dropped in beforeSend, so nothing reaches the transport.
      Sentry.init({
        dsn: "https://key@example.invalid/1",
        defaultIntegrations: false,
        beforeSend: (event) => {
          sent.push(event);
          return null;
        },
      });
    });

    beforeEach(() => {
      sent.length = 0;
    });

    test("a failure the reload will recover is a warning, tagged recovering", async () => {
      crashOnce();

      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0].level).toBe("warning");
      expect(sent[0].tags).toMatchObject({ chunk_reload: "recovering" });
    });

    test("a failure the reload did not fix stays an error, tagged gave_up", async () => {
      window.sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, String(T0));

      crashOnce();

      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0].level).toBe("error");
      expect(sent[0].tags).toMatchObject({ chunk_reload: "gave_up" });
    });

    test("any other error is the plain error it was", async () => {
      crashOnce(new TypeError("Cannot read properties of undefined (reading 'map')"));

      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0].level).toBe("error");
      expect(sent[0].tags?.chunk_reload).toBeUndefined();
    });
  });
});

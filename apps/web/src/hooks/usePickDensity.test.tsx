/**
 * NEO-522 — the Pick List's Spacious / Condensed setting: one per device,
 * Spacious unless this browser saved Condensed, and never lost (or thrown)
 * when storage refuses it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  PICK_DENSITY_KEY,
  isPickListPage,
  readPickDensity,
  resetPickDensityForTests,
  usePickDensity,
  useWidePickPage,
} from "./usePickDensity";

function Probe({ path = "/inventory", search = "?tab=pick" }: { path?: string; search?: string }) {
  const [density, setDensity] = usePickDensity();
  const wide = useWidePickPage(path, search);
  return (
    <>
      <output aria-label="Density">{density}</output>
      <output aria-label="Wide">{String(wide)}</output>
      <button type="button" onClick={() => setDensity("condensed")}>
        Condensed
      </button>
      <button type="button" onClick={() => setDensity("spacious")}>
        Spacious
      </button>
    </>
  );
}

const shown = (name: string) => screen.getByRole("status", { name }).textContent;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetPickDensityForTests();
});

describe("usePickDensity", () => {
  it("is Spacious when nothing is saved", () => {
    render(<Probe />);
    expect(shown("Density")).toBe("spacious");
    expect(shown("Wide")).toBe("true");
  });

  it("switches every reader at once and saves the choice on this device", () => {
    render(
      <>
        <Probe />
      </>,
    );
    act(() => screen.getByRole("button", { name: "Condensed" }).click());
    expect(shown("Density")).toBe("condensed");
    // The page frame follows: a condensed Pick List keeps the 6xl column.
    expect(shown("Wide")).toBe("false");
    expect(window.localStorage.getItem(PICK_DENSITY_KEY)).toBe("condensed");

    // A fresh visit reads it back.
    cleanup();
    resetPickDensityForTests();
    render(<Probe />);
    expect(shown("Density")).toBe("condensed");
  });

  it("reads anything but a saved Condensed as Spacious", () => {
    window.localStorage.setItem(PICK_DENSITY_KEY, "tiny");
    expect(readPickDensity()).toBe("spacious");
  });

  it("is Spacious when storage throws on read, and still switches for this visit when it throws on write", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    render(<Probe />);
    expect(shown("Density")).toBe("spacious");
    act(() => screen.getByRole("button", { name: "Condensed" }).click());
    expect(shown("Density")).toBe("condensed");
  });

  it("follows a switch made in another tab", () => {
    render(<Probe />);
    act(() => {
      window.localStorage.setItem(PICK_DENSITY_KEY, "condensed");
      window.dispatchEvent(new StorageEvent("storage", { key: PICK_DENSITY_KEY, newValue: "condensed" }));
    });
    expect(shown("Density")).toBe("condensed");
  });

  it("opens the wide page only on a spacious Pick List", () => {
    render(<Probe path="/inventory" search="?tab=list" />);
    expect(shown("Wide")).toBe("false");
  });
});

describe("isPickListPage", () => {
  it("is the Pick List tab of the signed-in inventory and of the demo's", () => {
    expect(isPickListPage("/inventory", "?tab=pick")).toBe(true);
    expect(isPickListPage("/demo/inventory", "?tab=pick&pv=box")).toBe(true);
    expect(isPickListPage("/inventory", "?tab=sales")).toBe(false);
    expect(isPickListPage("/demo/collection", "?tab=pick")).toBe(false);
    expect(isPickListPage("/inventory", "")).toBe(false);
  });
});

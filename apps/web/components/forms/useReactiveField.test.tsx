/**
 * NEO-39 — Unit tests for useReactiveField.
 *
 * The 3-point invariant under test:
 *
 *  1. Focus-guard (focused): while the input is focused, an external `value`
 *     change is IGNORED — the DOM input value stays exactly what the user typed.
 *  2. Mirror (idle): while the input is idle (blurred, not saving), an external
 *     `value` change IS written into the DOM input.
 *  3. Read-at-commit: on commit (blur and Enter both commit), `onSave` is called
 *     with the LIVE DOM value, never a stale or lagged copy.
 *
 * Additionally:
 *  4. Busy-guard: while a save is in flight (busyRef = true), an external `value`
 *     change is IGNORED even though the input is not focused.
 *
 * Each test also implicitly demonstrates that the OLD controlled pattern
 * (`value={draft}` + `useEffect(() => setDraft(value), [value])`) would fail:
 * the useEffect there would overwrite the draft on every external push, losing
 * the user's in-flight keystrokes. This hook avoids that by writing directly to
 * the DOM ref and never touching React state for the field value.
 *
 * Focus note: `fireEvent.focus` dispatches a FocusEvent but does NOT call
 * `element.focus()`, so `document.activeElement` is NOT updated by it alone.
 * The hook checks `document.activeElement === el` in its mirroring effect, so
 * we must call `el.focus()` directly to set the real activeElement, then also
 * fire the React `onFocus` synthetic event so `focusedRef` is set. Both are
 * required: `focusedRef` guards the commit no-op while `activeElement` guards
 * the mirroring effect.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReactiveField } from "./useReactiveField";

// ---------------------------------------------------------------------------
// Harness component
// ---------------------------------------------------------------------------

/**
 * Minimal test harness: exposes a single input whose `value` prop (the
 * "external reactive value") can be changed by re-rendering with a new
 * `currentValue`. The onSave / onEmptyCommit callbacks are passed through so
 * each test can assert on them.
 */
interface HarnessProps {
  currentValue: string;
  onSave: (trimmed: string) => Promise<unknown> | unknown;
  onEmptyCommit?: () => Promise<unknown> | unknown;
  compareBaseline?: string;
}

function Harness({ currentValue, onSave, onEmptyCommit, compareBaseline }: HarnessProps) {
  const { inputProps, busy, error } = useReactiveField({
    value: currentValue,
    onSave,
    onEmptyCommit,
    compareBaseline,
  });

  return (
    <>
      <input aria-label="field" {...inputProps} />
      {busy && <span data-testid="busy">busy</span>}
      {error && <span data-testid="error">{error}</span>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Focus the input using a real DOM `.focus()` call (updates document.activeElement)
 * AND dispatch the React synthetic focus event so `focusedRef` inside the hook
 * is set to true. Both are required — see file-level note.
 */
function focusInput(el: HTMLInputElement): void {
  el.focus();
  fireEvent.focus(el);
}

/**
 * Blur the input using a real DOM `.blur()` call (clears document.activeElement)
 * AND dispatch the React synthetic blur event so the hook's onBlur handler runs
 * and triggers commit.
 */
function blurInput(el: HTMLInputElement): void {
  el.blur();
  fireEvent.blur(el);
}

/**
 * Simulate the user typing a value into the input.
 *
 * Because the input is uncontrolled we set el.value directly rather than
 * going through individual keydown/keyup events — this is sufficient to
 * exercise the DOM-ref read-at-commit behaviour.
 */
function typeInto(el: HTMLInputElement, text: string): void {
  el.value = text;
  fireEvent.input(el, { target: { value: text } });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("useReactiveField", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Invariant 1 — Focus-guard: external push is IGNORED while focused
  // -------------------------------------------------------------------------
  describe("focus-guard (invariant 1)", () => {
    it("should NOT mirror external value into DOM while the input is focused", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      const { rerender } = render(
        <Harness currentValue="server-value" onSave={onSave} />,
      );

      const input = screen.getByRole("textbox", { name: "field" }) as HTMLInputElement;
      expect(input.value).toBe("server-value");

      // User focuses and starts typing
      focusInput(input);
      typeInto(input, "user is typing");

      // External server push arrives while the user is still focused
      await act(async () => {
        rerender(<Harness currentValue="new-server-value" onSave={onSave} />);
      });

      // The hook's mirroring effect checks document.activeElement === el and
      // bails out — the DOM value must stay as what the user typed.
      expect(input.value).toBe("user is typing");

      // Confirm document.activeElement is correctly set (validates the guard
      // mechanism itself is exercising the right code path).
      expect(document.activeElement).toBe(input);
    });

    it("should NOT mirror external value while focused even when push happens multiple times", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      const { rerender } = render(
        <Harness currentValue="v1" onSave={onSave} />,
      );

      const input = screen.getByRole("textbox", { name: "field" }) as HTMLInputElement;
      focusInput(input);
      typeInto(input, "draft");

      // Three rapid server pushes while focused
      for (const push of ["v2", "v3", "v4"]) {
        await act(async () => {
          rerender(<Harness currentValue={push} onSave={onSave} />);
        });
      }

      expect(input.value).toBe("draft");
    });
  });

  // -------------------------------------------------------------------------
  // Invariant 2 — Mirror: external push IS applied while idle (blurred)
  // -------------------------------------------------------------------------
  describe("mirror (invariant 2)", () => {
    it("should mirror external value into DOM while the input is idle", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      const { rerender } = render(
        <Harness currentValue="initial" onSave={onSave} />,
      );

      const input = screen.getByRole("textbox", { name: "field" }) as HTMLInputElement;
      expect(input.value).toBe("initial");

      // Input is never focused — it is idle
      await act(async () => {
        rerender(<Harness currentValue="updated-by-server" onSave={onSave} />);
      });

      expect(input.value).toBe("updated-by-server");
    });

    it("should mirror external value after the user blurs (returns to idle)", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      const { rerender } = render(
        <Harness currentValue="v1" onSave={onSave} />,
      );

      const input = screen.getByRole("textbox", { name: "field" }) as HTMLInputElement;

      // Focus, type, blur (commit fires with typed value)
      focusInput(input);
      typeInto(input, "v1-edit");

      await act(async () => {
        blurInput(input);
      });

      // After blur the input is idle; external push should now be mirrored
      await act(async () => {
        rerender(<Harness currentValue="v2-from-server" onSave={onSave} />);
      });

      expect(input.value).toBe("v2-from-server");
    });

    it("should mirror multiple external pushes while idle, keeping only the latest", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      const { rerender } = render(
        <Harness currentValue="a" onSave={onSave} />,
      );

      const input = screen.getByRole("textbox", { name: "field" }) as HTMLInputElement;

      for (const val of ["b", "c", "d"]) {
        await act(async () => {
          rerender(<Harness currentValue={val} onSave={onSave} />);
        });
      }

      expect(input.value).toBe("d");
    });
  });

  // -------------------------------------------------------------------------
  // Invariant 3 — Read-at-commit: onSave called with live DOM value
  // -------------------------------------------------------------------------
  describe("read-at-commit (invariant 3)", () => {
    it("should call onSave with the live DOM value on blur, not the stale external value", async () => {
      // This is the core regression test: the old controlled pattern would have
      // called onSave("server-value") because the useEffect(setDraft) overwrote
      // the draft before blur. This hook reads the DOM ref directly.
      const onSave = vi.fn().mockResolvedValue(undefined);
      const { rerender } = render(
        <Harness currentValue="server-value" onSave={onSave} />,
      );

      const input = screen.getByRole("textbox", { name: "field" }) as HTMLInputElement;

      focusInput(input);
      typeInto(input, "user typed value");

      // External push while focused (would scramble the old controlled pattern)
      await act(async () => {
        rerender(<Harness currentValue="new-server-value" onSave={onSave} />);
      });

      // Commit via blur
      await act(async () => {
        blurInput(input);
      });

      expect(onSave).toHaveBeenCalledOnce();
      expect(onSave).toHaveBeenCalledWith("user typed value");
    });

    it("should call onSave with the live DOM value on Enter keypress", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      const { rerender } = render(
        <Harness currentValue="original" onSave={onSave} />,
      );

      const input = screen.getByRole("textbox", { name: "field" }) as HTMLInputElement;

      focusInput(input);
      typeInto(input, "edited value");

      // External push while focused
      await act(async () => {
        rerender(<Harness currentValue="server-pushed" onSave={onSave} />);
      });

      // Commit via Enter
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
      });

      expect(onSave).toHaveBeenCalledOnce();
      expect(onSave).toHaveBeenCalledWith("edited value");
    });

    it("should trim whitespace from the committed value", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<Harness currentValue="x" onSave={onSave} />);

      const input = screen.getByRole("textbox", { name: "field" }) as HTMLInputElement;
      focusInput(input);
      typeInto(input, "  padded  ");

      await act(async () => {
        blurInput(input);
      });

      expect(onSave).toHaveBeenCalledWith("padded");
    });

    it("should NOT call onSave when the committed value equals the external value (no-op)", async () => {
      const onSave = vi.fn();
      render(<Harness currentValue="unchanged" onSave={onSave} />);

      const input = screen.getByRole("textbox", { name: "field" }) as HTMLInputElement;
      focusInput(input);
      // User does not change anything

      await act(async () => {
        blurInput(input);
      });

      expect(onSave).not.toHaveBeenCalled();
    });

    it("should NOT call onSave when committed value equals compareBaseline, not value", async () => {
      // Rows where displayed value is an inherited fallback but the persisted
      // override is empty — compareBaseline is the persisted value.
      const onSave = vi.fn();
      render(
        <Harness
          currentValue="inherited-display"
          onSave={onSave}
          compareBaseline="persisted-override"
        />,
      );

      const input = screen.getByRole("textbox", { name: "field" }) as HTMLInputElement;
      focusInput(input);
      typeInto(input, "persisted-override");

      await act(async () => {
        blurInput(input);
      });

      expect(onSave).not.toHaveBeenCalled();
    });

    it("should call onEmptyCommit when the user clears the field", async () => {
      const onSave = vi.fn();
      const onEmptyCommit = vi.fn().mockResolvedValue(undefined);
      render(
        <Harness currentValue="has-value" onSave={onSave} onEmptyCommit={onEmptyCommit} />,
      );

      const input = screen.getByRole("textbox", { name: "field" }) as HTMLInputElement;
      focusInput(input);
      typeInto(input, ""); // user clears

      await act(async () => {
        blurInput(input);
      });

      expect(onEmptyCommit).toHaveBeenCalledOnce();
      expect(onSave).not.toHaveBeenCalled();
    });

    it("should reset input to external value when field is cleared and no onEmptyCommit provided", async () => {
      const onSave = vi.fn();
      render(<Harness currentValue="original-value" onSave={onSave} />);

      const input = screen.getByRole("textbox", { name: "field" }) as HTMLInputElement;
      focusInput(input);
      typeInto(input, "");

      await act(async () => {
        blurInput(input);
      });

      expect(onSave).not.toHaveBeenCalled();
      // Input resets to the external value
      expect(input.value).toBe("original-value");
    });
  });

  // -------------------------------------------------------------------------
  // Invariant 4 — Busy-guard: external push IGNORED while save is in flight
  // -------------------------------------------------------------------------
  describe("busy-guard (invariant 4)", () => {
    it("should NOT mirror external value while a save is in flight", async () => {
      // Set up a save that resolves on demand so we can hold it in-flight
      let resolveSave!: (value: unknown) => void;
      const onSave = vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
      );

      const { rerender } = render(
        <Harness currentValue="initial" onSave={onSave} />,
      );

      const input = screen.getByRole("textbox", { name: "field" }) as HTMLInputElement;

      // User types and commits — save is now in flight
      focusInput(input);
      typeInto(input, "committed value");

      await act(async () => {
        blurInput(input);
      });

      // Save is in flight — busy indicator is shown
      expect(screen.getByTestId("busy")).toBeDefined();

      // External push arrives while save is pending
      await act(async () => {
        rerender(<Harness currentValue="server-pushed-during-save" onSave={onSave} />);
      });

      // The DOM value must NOT change — the busy guard suppresses mirroring
      expect(input.value).toBe("committed value");

      // Resolve the save — busy clears
      await act(async () => {
        resolveSave(undefined);
      });

      expect(screen.queryByTestId("busy")).toBeNull();
    });

    it("should mirror external value after the save resolves", async () => {
      let resolveSave!: (value: unknown) => void;
      const onSave = vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
      );

      const { rerender } = render(
        <Harness currentValue="v1" onSave={onSave} />,
      );

      const input = screen.getByRole("textbox", { name: "field" }) as HTMLInputElement;

      focusInput(input);
      typeInto(input, "v1-edit");

      await act(async () => {
        blurInput(input);
      });

      // External push during save — ignored
      await act(async () => {
        rerender(<Harness currentValue="v2-post-save" onSave={onSave} />);
      });
      expect(input.value).toBe("v1-edit");

      // Resolve the save
      await act(async () => {
        resolveSave(undefined);
      });

      // Now another external push arrives — should be mirrored because we're idle
      await act(async () => {
        rerender(<Harness currentValue="v3-after-save" onSave={onSave} />);
      });

      expect(input.value).toBe("v3-after-save");
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  describe("error handling", () => {
    it("should surface error message when onSave throws", async () => {
      const onSave = vi.fn().mockRejectedValue(new Error("save failed"));
      render(<Harness currentValue="x" onSave={onSave} />);

      const input = screen.getByRole("textbox", { name: "field" }) as HTMLInputElement;
      focusInput(input);
      typeInto(input, "new value");

      await act(async () => {
        blurInput(input);
      });

      expect(screen.getByTestId("error").textContent).toBe("save failed");
    });

    it("should clear error on successful subsequent commit", async () => {
      let callCount = 0;
      const onSave = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error("transient error"));
        return Promise.resolve(undefined);
      });

      render(<Harness currentValue="x" onSave={onSave} />);
      const input = screen.getByRole("textbox", { name: "field" }) as HTMLInputElement;

      // First commit — fails
      focusInput(input);
      typeInto(input, "attempt1");
      await act(async () => {
        blurInput(input);
      });
      expect(screen.getByTestId("error")).toBeDefined();

      // Second commit with a different value — succeeds
      focusInput(input);
      typeInto(input, "attempt2");
      await act(async () => {
        blurInput(input);
      });

      expect(screen.queryByTestId("error")).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // defaultValue initialisation
  // -------------------------------------------------------------------------
  describe("initialisation", () => {
    it("should initialise the input with the external value as defaultValue", () => {
      const onSave = vi.fn();
      render(<Harness currentValue="starting-value" onSave={onSave} />);
      const input = screen.getByRole("textbox", { name: "field" }) as HTMLInputElement;
      expect(input.value).toBe("starting-value");
    });
  });
});

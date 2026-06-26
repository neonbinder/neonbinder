import { useCallback, useEffect, useRef, useState } from "react";

/**
 * NEO-39 — shared reactive-safe field primitive (uncontrolled).
 *
 * Fixes a recurring bug class: a single component is simultaneously a live
 * reactive view of server state (a `useQuery` pushes fresh values underneath
 * you) AND an editor with local draft state. The old controlled pattern
 * (`value={draft}` + `useEffect(() => setDraft(value), [value])`) loses the
 * race — an externally triggered re-render resets/lags the controlled value
 * before the user's keystrokes commit, so the submit handler reads stale,
 * empty, or cross-wired state. Confirmed instances: NEO-36 (add-card form
 * dropped the last-typed field), NEO-38 (SetAttributesPanel committed a value
 * into the wrong field).
 *
 * This is the CI-verified fix from NEO-38/PR#46, generalized into one hook —
 * deliberately NOT react-hook-form. (An RHF-backed version of this hook read
 * `getValues()`, which did not reflect the live DOM under Maestro/edit load and
 * reintroduced the cross-field scramble; reading the DOM ref directly is what
 * actually works.) The contract:
 *
 *   1. The input is **uncontrolled** — `defaultValue` only, no React `value`
 *      binding. React never reconciles the DOM value, so the field holds
 *      exactly what the user typed.
 *   2. **Focus-guard mirroring** — external `value` changes are written into
 *      the input (a direct DOM write, no React state) ONLY when the field is
 *      neither focused nor mid-save. While the user is typing (or a save is in
 *      flight) external pushes are ignored, so in-flight keystrokes survive.
 *   3. **Read-at-commit** — commit reads the live DOM value (`ref.current.value`),
 *      never a lagged copy.
 *
 * This hook owns ONE field. Each editable row mounts its own `useReactiveField`
 * (per-field autosave), mirroring how the existing rows each carry their own
 * busy/error/commit state.
 */

export type ReactiveFieldOptions = {
  /**
   * The external (reactive) value this field mirrors + displays. When the
   * field is idle (not focused, not saving) a change here is written into the
   * input. While focused/saving it is ignored.
   */
  value: string;
  /**
   * Persist a non-empty, changed value. Called with the trimmed live value.
   * Throwing surfaces the message via the returned `error`.
   */
  onSave: (trimmed: string) => Promise<unknown> | unknown;
  /**
   * Optional handler for an empty commit (the user cleared the field). When
   * provided it runs instead of `onSave` — used by rows where "" means
   * "revert to inherited" or "clear the field". When omitted, an empty commit
   * is a no-op that resets the input back to `value`.
   */
  onEmptyCommit?: () => Promise<unknown> | unknown;
  /**
   * Baseline used for the no-op check: if the trimmed live value equals this,
   * commit does nothing. Defaults to `value`. Rows whose displayed value
   * differs from their persisted value (e.g. a per-card field that shows the
   * inherited fallback but persists only an explicit override) pass the
   * persisted value here.
   */
  compareBaseline?: string;
};

/**
 * Props the consumer spreads onto its `<input>`: `ref` + `defaultValue` make
 * it uncontrolled; `onFocus`/`onBlur`/`onKeyDown` layer the focus-guard +
 * commit-on-blur/Enter on top. The caller still supplies its own `aria-label`,
 * `placeholder`, `className`, `disabled`, etc.
 */
export type ReactiveFieldInputProps = {
  ref: (el: HTMLInputElement | null) => void;
  defaultValue: string;
  onFocus: React.FocusEventHandler<HTMLInputElement>;
  onBlur: React.FocusEventHandler<HTMLInputElement>;
  onKeyDown: React.KeyboardEventHandler<HTMLInputElement>;
};

export type ReactiveFieldApi = {
  /** Spread onto the `<input>`: wires the uncontrolled ref + focus-guard + commit. */
  inputProps: ReactiveFieldInputProps;
  /** True while a save is in flight. Drives the disabled/busy affordance. */
  busy: boolean;
  /** Last commit error message, or null. */
  error: string | null;
  /** Imperatively commit the live value (blur + Enter both route here). */
  commit: () => Promise<void>;
};

export function useReactiveField({
  value,
  onSave,
  onEmptyCommit,
  compareBaseline,
}: ReactiveFieldOptions): ReactiveFieldApi {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Track focus + busy in refs (synchronous) so the mirroring effect honors
  // the focus-guard without depending on React state timing.
  const focusedRef = useRef(false);
  const busyRef = useRef(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Focus-guard mirroring: when the external value changes AND the field is
  // idle (not focused, not saving), write it into the input via a direct DOM
  // write. While focused or saving we deliberately drop the update so in-flight
  // typing is preserved. No React value state is involved, so a reactive
  // re-render can never reconcile/scramble the DOM value across rows.
  useEffect(() => {
    const el = inputRef.current;
    if (!el || busyRef.current) return;
    if (typeof document !== "undefined" && document.activeElement === el) return;
    el.value = value ?? "";
  }, [value]);

  const runCommit = useCallback(async () => {
    if (busyRef.current) return;
    // Read the LIVE DOM value at commit — never a lagged React/library copy.
    const el = inputRef.current;
    const trimmed = (el?.value ?? "").trim();
    const baseline = compareBaseline ?? value;

    // No-op: unchanged vs the persisted baseline.
    if (trimmed === baseline) return;

    if (trimmed.length === 0) {
      if (onEmptyCommit) {
        setBusy(true);
        busyRef.current = true;
        try {
          await onEmptyCommit();
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
          busyRef.current = false;
        }
        return;
      }
      // No empty handler → treat as no-op and reset the input to the external
      // value (matches the existing "empty input reverts" UX).
      if (el) el.value = value ?? "";
      return;
    }

    setBusy(true);
    busyRef.current = true;
    try {
      await onSave(trimmed);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  }, [value, compareBaseline, onSave, onEmptyCommit]);

  const onFocus = useCallback(() => {
    focusedRef.current = true;
  }, []);

  const onBlur = useCallback(() => {
    focusedRef.current = false;
    void runCommit();
  }, [runCommit]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void runCommit();
      }
    },
    [runCommit],
  );

  return {
    inputProps: {
      ref: (el: HTMLInputElement | null) => {
        inputRef.current = el;
      },
      defaultValue: value ?? "",
      onFocus,
      onBlur,
      onKeyDown,
    },
    busy,
    error,
    commit: runCommit,
  };
}

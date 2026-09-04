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
 *
 * NEO-216 widened it from `<input>` to `<input> | <textarea>` (the card
 * drawer's listing description is multi-line and now autosaves per field like
 * everything else in that drawer). The element type is a type parameter that
 * defaults to `HTMLInputElement`, so every existing caller is unchanged.
 */

/**
 * The elements this hook can drive. `<textarea>` was added for NEO-216 (the
 * card drawer's listing description): the commit/mirror/read-at-commit
 * contract is identical for both, only the "commit without leaving the field"
 * keystroke differs — see `enterCommit`.
 */
export type ReactiveFieldElement = HTMLInputElement | HTMLTextAreaElement;

/**
 * Shown when a commit is attempted while the previous one is still in flight.
 * Exported so a caller can assert on it rather than duplicating the wording.
 */
export const BUSY_MESSAGE = "Still saving the previous change — try again.";

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
  /**
   * Which keystroke commits without leaving the field.
   *
   * `"enter"` (default) suits a single-line `<input>`, where Enter has no
   * other meaning. `"modEnter"` is for a `<textarea>`: there, a bare Enter is
   * a newline the operator deliberately typed, so swallowing it to save would
   * make multi-line text impossible to write. Blur commits either way.
   */
  enterCommit?: "enter" | "modEnter";
};

/**
 * Props the consumer spreads onto its `<input>`/`<textarea>`: `ref` +
 * `defaultValue` make it uncontrolled; `onFocus`/`onBlur`/`onKeyDown` layer
 * the focus-guard + commit-on-blur/Enter on top. The caller still supplies its
 * own `aria-label`, `placeholder`, `className`, `disabled`, etc.
 */
export type ReactiveFieldInputProps<
  E extends ReactiveFieldElement = HTMLInputElement,
> = {
  ref: (el: E | null) => void;
  defaultValue: string;
  onFocus: React.FocusEventHandler<E>;
  onBlur: React.FocusEventHandler<E>;
  onKeyDown: React.KeyboardEventHandler<E>;
};

export type ReactiveFieldApi<
  E extends ReactiveFieldElement = HTMLInputElement,
> = {
  /** Spread onto the field: wires the uncontrolled ref + focus-guard + commit. */
  inputProps: ReactiveFieldInputProps<E>;
  /** True while a save is in flight. Drives the disabled/busy affordance. */
  busy: boolean;
  /** Last commit error message, or null. */
  error: string | null;
  /** Imperatively commit the live value (blur + Enter both route here). */
  commit: () => Promise<void>;
  /**
   * Replace the field's contents programmatically and commit them. Retires any
   * standing error first — it described the value being replaced. Use this,
   * never a hand-rolled `el.value = x` followed by `commit()`.
   */
  replace: (next: string) => Promise<void>;
};

export function useReactiveField<
  E extends ReactiveFieldElement = HTMLInputElement,
>({
  value,
  onSave,
  onEmptyCommit,
  compareBaseline,
  enterCommit = "enter",
}: ReactiveFieldOptions): ReactiveFieldApi<E> {
  const inputRef = useRef<E | null>(null);
  // Track focus + busy in refs (synchronous) so the mirroring effect honors
  // the focus-guard without depending on React state timing.
  const focusedRef = useRef(false);
  const busyRef = useRef(false);
  // The exact value the in-flight save is for. Lets the busy guard tell a
  // DUPLICATE commit of the edit already being saved (Enter and then tabbing
  // away fire two commits for one edit; so does a real `.blur()` alongside a
  // synthetic one in tests) apart from a genuinely NEW edit arriving mid-save.
  // Only the second is being dropped, so only the second is worth saying.
  const inFlightValueRef = useRef<string | null>(null);

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
    // The error described the text we just overwrote. Leaving it up points a
    // refusal at content that is no longer on screen — see `replace` below for
    // the same rule applied to a programmatic replacement.
    setError(null);
  }, [value]);

  const runCommit = useCallback(async () => {
    // Read the LIVE DOM value at commit — never a lagged React/library copy.
    const el = inputRef.current;
    const trimmed = (el?.value ?? "").trim();
    const baseline = compareBaseline ?? value;

    // No-op: unchanged vs the persisted baseline. Checked BEFORE the busy
    // guard so a redundant commit while a save is in flight stays silent —
    // there is nothing being dropped.
    if (trimmed === baseline) return;

    // A DIFFERENT change arriving while a save is in flight is dropped — the hook
    // owns one field and will not interleave two writes on it. That drop used
    // to be silent, which is the worst possible way to lose an edit: the new
    // value sits in the input looking saved. It is reported instead, and the
    // value is left alone so the operator can simply commit again.
    //
    // Deliberately NOT a queued retry: queueing would re-read the DOM after
    // the first save settles, and by then the focus-guard mirroring may have
    // replaced what is in the field — so the queued write could persist a
    // value nobody typed. Every caller gets the message for free through the
    // `error` they already render.
    if (busyRef.current) {
      if (trimmed !== inFlightValueRef.current) setError(BUSY_MESSAGE);
      return;
    }

    if (trimmed.length === 0) {
      if (onEmptyCommit) {
        setBusy(true);
        busyRef.current = true;
        inFlightValueRef.current = "";
        try {
          await onEmptyCommit();
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
          busyRef.current = false;
          inFlightValueRef.current = null;
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
    inFlightValueRef.current = trimmed;
    try {
      await onSave(trimmed);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      busyRef.current = false;
      inFlightValueRef.current = null;
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
    (e: React.KeyboardEvent<E>) => {
      if (e.key !== "Enter") return;
      // A textarea's bare Enter belongs to the operator (it is a newline they
      // meant to type), so only Cmd/Ctrl+Enter commits there.
      if (enterCommit === "modEnter" && !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      void runCommit();
    },
    [runCommit, enterCommit],
  );

  /**
   * Replace the field's contents programmatically, then commit them.
   *
   * NEO-216 bug (CI, PR #225): the card drawer's Regenerate button used to
   * write the generated title into the DOM itself and call `commit()`. When
   * the operator had just been REFUSED an over-cap title, the refusal left
   * `error` set AND left the stored value unchanged — so the regenerated title
   * frequently equalled the stored one, `runCommit` returned at its no-op
   * guard, and the alert about the 157-character title stayed on screen above
   * a field now holding a 71-character one.
   *
   * Clearing `error` here rather than inside `runCommit` is the point: the
   * error belongs to the VALUE that was refused, so it must die the moment
   * that value is replaced, whether or not the follow-up commit does anything.
   * If the replacement is itself refused, `runCommit` sets the new message
   * over the cleared one.
   */
  const replace = useCallback(
    async (next: string) => {
      const el = inputRef.current;
      if (el) el.value = next;
      setError(null);
      await runCommit();
    },
    [runCommit],
  );

  return {
    inputProps: {
      ref: (el: E | null) => {
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
    replace,
  };
}

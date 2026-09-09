---
name: patterns-modal-dialog
description: WAI-ARIA dialog pattern checklist and implementation patterns for custom modals in apps/web (non-Radix dialogs)
metadata:
  type: project
---

# Custom Modal Dialog Accessibility Pattern

For any custom `role="dialog"` overlay in apps/web (not using Radix `Dialog` primitive):

## Required a11y checklist

1. **Focus on open** — `useEffect` on the open-state boolean, move focus into dialog with `requestAnimationFrame` (gives VoiceOver time to register the dialog). For destructive confirm dialogs, default focus to the Cancel/safe button, NOT the destructive action.

2. **Focus return on close** — Capture `document.activeElement as HTMLElement` into a `useRef` at the moment the trigger fires (before `setState`). In the same `useEffect`, restore focus when the state goes false.

3. **Focus trap** — `onKeyDown` handler on the `role="dialog"` element. Query `button:not([disabled]),[href],input:not([disabled]),...,[tabindex]:not([tabindex="-1"])`. On Tab/Shift+Tab at boundary, call `e.preventDefault()` and jump to last/first.

4. **ARIA labelling** — Prefer `aria-labelledby` pointing to a visible `id`-tagged heading/text over `aria-label`. Keeps accessible name in sync with visible content (WCAG 2.5.3). Use `aria-describedby` if there is additional description text beyond the title.

5. **Escape key** — `window.addEventListener("keydown", ...)` scoped to when dialog is open is acceptable. Must clean up via `return () => removeEventListener(...)`. Must guard on `credsBusy`/loading states where applicable.

## Implementation template

```tsx
const triggerRef = useRef<HTMLElement | null>(null);
const cancelButtonRef = useRef<HTMLButtonElement>(null);
const dialogRef = useRef<HTMLDivElement>(null);

// Capture trigger at open time
const handleOpen = () => {
  triggerRef.current = document.activeElement as HTMLElement;
  setOpen(true);
};

// Focus in / focus return
useEffect(() => {
  if (open) {
    const raf = requestAnimationFrame(() => cancelButtonRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  } else {
    triggerRef.current?.focus();
    triggerRef.current = null;
  }
}, [open]);

// Focus trap
const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
  if (e.key !== "Tab") return;
  const dialog = dialogRef.current;
  if (!dialog) return;
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
    )
  );
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
};
```

```tsx
<div
  ref={dialogRef}
  role="dialog"
  aria-modal="true"
  aria-labelledby="dialog-title"
  onKeyDown={handleKeyDown}
  onClick={handleBackdropClick}
>
  <div onClick={(e) => e.stopPropagation()}>
    <p id="dialog-title">...</p>
    <NeonButton cancel onClick={handleDestructive}>Confirm</NeonButton>
    <NeonButton ref={cancelButtonRef} onClick={handleClose}>Cancel</NeonButton>
  </div>
</div>
```

## Applied in

- `/apps/web/app/profile/page.tsx` — clear-confirm modal (NEO-39 worktree), `confirmingClear` state
- `/apps/web/components/SetSelector/CardPairingModal.tsx` (NEO-137, new file) — textbook instance of
  the checklist violated wholesale: `role="dialog"` + `aria-modal="true"` + an `onKeyDown` Escape
  check, but zero `useEffect` in the file. Confirmed: Escape does nothing until the user has already
  Tab'd/clicked something inside the portal (React portal `onKeyDown` only fires for events whose
  real DOM target is a descendant — focus never gets moved in, so it starts outside), no focus trap
  (sighted keyboard users Tab through the entire underlying virtualized list before reaching the
  dialog), no focus-return on close. `ReconciliationModal.tsx` (the sibling/reference file in this
  same directory) has the SAME gaps but never claims `role="dialog"`/`aria-modal` in the first place —
  so it isn't lying to AT the way a file that adds the ARIA without the behavior is. When a new modal
  in this directory adds `role="dialog"`/`aria-modal="true"`, treat it as a promise that must be
  checked against this whole list, not just the Escape key.

## New anti-patterns confirmed in `abort-run-dialog.tsx` (NEO-170, 2026-08-18)

A hand-rolled confirm dialog that deliberately deviates from the template above (focuses the
`tabIndex={-1}` CONTAINER on open, not a button, specifically so it can make Enter-from-container
confirm the destructive action) reproduces several failure modes worth checking for by name on any
future dialog in this shape:

1. **Enter-confirms-from-container is a keyboard hazard, not a convenience.** If the dialog's default
   focus target is the container (not the safe/Cancel button) and its `onKeyDown` treats "Enter while
   `event.target` is not itself a button/link/input" as "confirm," then the very first keystroke a
   keyboard or screen-reader user reflexively tries on a freshly-opened confirm dialog (Enter) fires the
   DESTRUCTIVE action with zero navigation required. This is the template's Rule 1 inverted — the
   template says default focus for destructive dialogs goes to the safe button precisely so a reflexive
   Enter is harmless. If a dialog focuses the container instead specifically to enable Enter-confirms,
   push back: recommend defaulting focus to the Cancel/safe button (which, via native `<button>` Enter
   activation, still lets Enter-on-Cancel cancel — the correct behavior) and DELETE the container's
   Enter-confirm special case entirely; it solves a problem ("Enter should confirm") that doesn't need
   solving once focus starts on a real button, while removing a real one (accidental destructive
   confirm). Cite this as WCAG 3.3.4 Error Prevention (the confirmation step is undermined) plus 2.4.7
   Focus Visible if (as below) the container also has no visible focus ring.

2. **The `tabIndex={-1}` container, focused directly with `outline-none` in its className, is
   invisible when focused.** Tailwind's `outline-none` strips the native ring with no `focus-visible:`
   replacement. A full-viewport `fixed inset-0` container being invisibly focused is a real 2.4.7
   failure regardless of point 1 — fixing point 1 (default focus to a real button) fixes this too, since
   Radix `Button`/`NeonButton` DO ship a visible `:focus-visible` outline (confirmed in
   `node_modules/@radix-ui/themes/components.css`, `.rt-BaseButton:where(...):where(:focus-visible)`).

3. **Disabling every focusable element inside the dialog during an async action breaks the trap —
   and likely ejects focus from the modal entirely, not just at the Tab boundary.** If BOTH the
   confirm and cancel buttons get `disabled={busy}` at the same time, and the container is
   intentionally excluded from the trap's own focusable-elements query (because it's `tabIndex={-1}`),
   then the moment `busy` flips true: (a) the trap's `focusable` array is empty, so a Tab press has
   nothing to redirect to — Tab leaks out of the modal into the underlying page despite
   `aria-modal="true"`; and (b) per standard cross-browser behavior, disabling the CURRENTLY FOCUSED
   element (the button the user just clicked/activated) blurs it and typically moves focus to
   `document.body` immediately — before the user even presses Tab. So the modal can be non-modal for
   the entire duration of the async action, starting the instant it begins. This also silences the
   dialog's only "operation in progress" signal for AT users (the button label swapping to e.g.
   "Aborting...") since that same button both disables AND loses focus in the same moment. Fix: never
   disable every focusable element in a trapped dialog simultaneously — either use `aria-disabled`
   instead of the native `disabled` attribute (keeps the element focusable/in the tab order while still
   blocking re-activation via the click handler), or explicitly refocus the dialog container
   (`dialogRef.current?.focus()`) in a `useEffect` keyed on the busy flag the instant it flips true, so
   focus has somewhere valid to land inside the subtree before the browser's own blur-to-body kicks in.

4. **A dialog's own unmount-time focus-restore can race and defeat a parent's more specific
   focus-redirect, silently recreating "Focus-loss-on-remove" below.** If the PARENT tries to redirect
   focus somewhere specific after a successful action (e.g. to a heading that will survive, because it
   knows the original trigger element is about to unmount too), and the DIALOG's own cleanup
   unconditionally does `if (trigger?.isConnected) trigger.focus()` on unmount, the two can race: the
   dialog closes (parent state → null) on the SAME synchronous tick as the parent's manual
   `.focus(heading)` call, but the dialog's cleanup effect runs LATER (React's commit/effect phase,
   after the triggering event/promise-continuation's synchronous code has already finished) — so if the
   original trigger element is STILL connected at that later point (very likely when the trigger's
   removal depends on a separate async data update, e.g. a reactive query round-trip, rather than the
   same local state change that closed the dialog), the dialog's cleanup steals focus back onto the
   soon-to-be-removed trigger, and once THAT unmounts moments later, focus silently reverts to
   `<body>` anyway — the exact failure mode below, just deferred by one extra hop. Fix: don't let the
   dialog's cleanup unconditionally own focus-restore; either have it call a parent-supplied `onClose`
   callback that receives the captured trigger element and lets the PARENT make the one true decision
   about where focus goes (including the "I already redirected it elsewhere" case), or have the parent
   set a ref flag immediately before closing the dialog on the special-case path, and have the dialog's
   cleanup check that flag before doing its own default restore.

## Focus-loss-on-remove — a related but distinct failure mode

Any list where clicking an item's own action button (`Keep`, `Unlink`, `Remove`, `Link shared` …)
causes that exact `<button>`/`<li>` to unmount from the array driving the render: React does not
restore focus, so it silently reverts to `<body>`. For a keyboard/screen-reader user working through
a list one item at a time this means every single action resets them to the top of the page — a
severe, easy-to-miss defect distinct from the modal-open/close checklist above (it fires on every
in-dialog state change, not just open/close). Found in `CardPairingModal.tsx` (`LINK`/`UNLINK`/
`KEEP`/`UNKEEP` reducer actions, NEO-137) and in the new "Link shared" button added to
`ReconciliationModal.tsx` in the same PR. Check for this specifically whenever a dialog's reducer
removes-from-array on the same action that a list item's own click handler dispatches. Fix: capture
a ref to a stable nearby element (next sibling, or the column's filter input) and focus it in a
`useEffect` keyed off the list's length/identity after the removal.

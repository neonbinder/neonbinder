import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

/**
 * NEO-313 — the quiet "which sport is this?" override.
 *
 * Jason, 2026-09-28: a football player on a baseball card is "a very rare
 * occurance so everything automated should continue to assume that players,
 * sports, and leagues align to the set." So this control is AVAILABLE and
 * deliberately NOT prominent:
 *
 *  - It reads as muted text with a small caret ("Sport: Baseball ▾"), the same
 *    weight as the metadata around it. No border, no fill, no badge.
 *  - It never takes focus on its own and never changes what Enter does: it is
 *    one ordinary button in the tab order, reached only by Tab or a click.
 *  - Once the value differs from the set's sport, the sport name turns
 *    neon-yellow, so an operator glancing back can see this name was moved
 *    off the default. That is the only emphasis it ever carries.
 *
 * ## Why not a native `<select>`
 *
 * Maestro's web driver resolves an `<option>` tap by scanning EVERY `<option>`
 * on the page and taking the first bounds match, so a second native select is
 * unreachable — and a select here would sit ABOVE the ones the hosts already
 * render (the admin sport filter, the league-level field), stealing their taps.
 * The choices are plain buttons in a small list instead, tapped by their text.
 *
 * ## Keyboard
 *
 * Enter / Space / ArrowDown on the closed trigger opens the list with focus on
 * the current sport. Arrow keys move, Home / End jump, typing a sport's first
 * letters jumps to it, Enter or Space picks, Escape closes and returns focus to
 * the trigger. Escape is stopped here while the list is open, so "close this
 * list" can never become "cancel the review" in a host dialog. Tab out of the
 * list closes it.
 *
 * No host handles Enter at the dialog level (the review wizard's Enter-confirm
 * lives on its Confirm button alone), so Enter on this trigger or an option
 * only ever does what the focused button does.
 *
 * ## Order and height
 *
 * The set's sport first — it is the default and the way back — then the rest
 * alphabetically. The list is capped at `max-h-48` and scrolls inside itself,
 * so a deployment with many sport rows never pushes it over a host's footer;
 * the focused option is always scrolled into view, so typing a sport's first
 * letters is also how a long list reaches a row below the fold.
 *
 * ## Ids
 *
 * The trigger and the options carry NO DOM id: maestro-web reports
 * `resource-id` as `node.id || node.ariaLabel`, so an id would hide the
 * accessible name every flow targets. The one id is on the non-interactive
 * list wrapper, for `aria-controls`.
 */
export default function SportSwitch({
  value,
  onChange,
  setSportId,
  disabled = false,
  label = "Sport for this name",
  prefix = "Sport:",
}: {
  /** The sport currently in force (a sport-level `selectorOptions` id). */
  value: Id<"selectorOptions">;
  /** Called with the picked sport. Not called when the current one is re-picked. */
  onChange: (sportId: Id<"selectorOptions">) => void;
  /** The set's own sport — the default, and what "overridden" is measured against. */
  setSportId: Id<"selectorOptions">;
  /**
   * Refuses to open. Rendered with `aria-disabled`, never native `disabled`,
   * so a keyboard operator parked on it is not thrown out of the tab order
   * for the length of a round trip.
   */
  disabled?: boolean;
  /**
   * The ACCESSIBLE name, before the current value: "Sport for this name"
   * announces as "Sport for this name: Baseball". Give a second instance on
   * the same screen wording that shares no substring with this one.
   */
  label?: string;
  /**
   * The visible lead-in before the sport name. Pass `null` where the context
   * already says it is a sport (the review wizard's "(Player · Baseball ▾)").
   */
  prefix?: string | null;
}) {
  const sports = useQuery(api.selectorOptions.getSelectorOptions, {
    level: "sport",
  });
  const options = useMemo(
    () =>
      [...(sports ?? [])]
        .map((s) => ({ id: s._id, name: s.value }))
        .sort((a, b) => {
          // The set's sport leads; everything else is alphabetical.
          if (a.id === setSportId) return -1;
          if (b.id === setSportId) return 1;
          return a.name.localeCompare(b.name);
        }),
    [sports, setSportId],
  );

  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  /** Letters typed on the open list, for jump-to-sport; cleared after a pause. */
  const typeahead = useRef({ text: "", at: 0 });

  const currentName =
    options.find((o) => o.id === value)?.name ??
    // Before the sports list lands, and for a sport row that has since been
    // removed, say nothing rather than a raw id.
    "…";
  const overridden = value !== setSportId;

  // A switch that goes disabled while open (a decision starting elsewhere)
  // closes rather than leaving a list whose picks are refused.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- an open list must not outlive the permission to pick from it
    if (disabled) setOpen(false);
  }, [disabled]);

  // Focus follows the roving index while the list is open.
  useEffect(() => {
    if (!open) return;
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>(
      "[data-sport-switch-option]",
    );
    const target = buttons?.[activeIdx];
    if (!target) return;
    // Scroll ourselves, to the NEAREST edge: the list scrolls inside a capped
    // box, and a plain focus() may centre the row or move the page instead.
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIdx]);

  /**
   * Jump to the first sport whose name starts with the letters typed so far
   * (the listbox typeahead convention). Repeating one letter cycles through
   * the sports that start with it.
   */
  const jumpTo = (key: string) => {
    const now = Date.now();
    const prev = typeahead.current;
    const text = now - prev.at > 700 ? key : prev.text + key;
    typeahead.current = { text, at: now };
    const lower = text.toLocaleLowerCase();
    const repeat = lower.length > 1 && [...lower].every((c) => c === lower[0]);
    const needle = repeat ? lower[0] : lower;
    const start = repeat || needle.length === 1 ? activeIdx + 1 : activeIdx;
    for (let step = 0; step < options.length; step++) {
      const idx = (start + step) % options.length;
      if (options[idx].name.toLocaleLowerCase().startsWith(needle)) {
        setActiveIdx(idx);
        return;
      }
    }
  };

  const openList = () => {
    if (disabled || options.length === 0) return;
    const idx = options.findIndex((o) => o.id === value);
    setActiveIdx(idx >= 0 ? idx : 0);
    setOpen(true);
  };

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const pick = (id: Id<"selectorOptions">) => {
    close(true);
    if (id !== value) onChange(id);
  };

  return (
    <span
      className="relative inline-flex items-baseline"
      onBlur={(e) => {
        // Tab (or a click) out of the whole control closes the list.
        if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={`${label}: ${currentName}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-disabled={disabled || undefined}
        data-sport-switch-trigger=""
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            openList();
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            close(true);
          }
        }}
        // `p-1.5 -m-1.5`: a 28px-tall hit area (SC 2.5.8) around text that
        // still sits exactly where it did — the padding is cancelled by the
        // margin, so nothing around it moves.
        className="-m-1.5 inline-flex items-baseline gap-1 rounded-sm p-1.5 text-xs text-gray-400 hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF] focus-visible:ring-offset-1 focus-visible:ring-offset-gray-900 aria-disabled:cursor-not-allowed aria-disabled:hover:text-gray-400"
      >
        {prefix ? <span>{prefix}</span> : null}
        <span
          className={
            overridden
              ? "text-[#FFE600] underline decoration-dotted underline-offset-2"
              : "underline decoration-dotted decoration-gray-600 underline-offset-2"
          }
        >
          {currentName}
        </span>
        {/* Decorative: aria-haspopup already says there is a list. */}
        <span aria-hidden="true" className="text-[0.625rem] leading-none">
          {open ? "▴" : "▾"}
        </span>
      </button>

      {open && (
        // The id lives on this non-interactive wrapper, never on the listbox:
        // maestro-web's resource-id is `node.id || ariaLabel`, so an id on the
        // listbox would hide "Choose a sport" from every flow. aria-controls
        // points here; the wrapper's only child is the listbox.
        <div id={listId} className="absolute left-0 top-full z-20 mt-1">
          <div
            ref={listRef}
            role="listbox"
            aria-label="Choose a sport"
            className="max-h-48 min-w-[10rem] overflow-y-auto overscroll-contain rounded-md border border-gray-600 bg-gray-950 p-1 shadow-lg shadow-black/60"
            onKeyDown={(e) => {
              const last = options.length - 1;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIdx((i) => Math.min(i + 1, last));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIdx((i) => Math.max(i - 1, 0));
              } else if (e.key === "Home") {
                e.preventDefault();
                setActiveIdx(0);
              } else if (e.key === "End") {
                e.preventDefault();
                setActiveIdx(last);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close(true);
              } else if (
                e.key.length === 1 &&
                e.key !== " " &&
                !e.ctrlKey &&
                !e.metaKey &&
                !e.altKey
              ) {
                e.preventDefault();
                jumpTo(e.key);
              }
            }}
          >
            {options.map((o, idx) => {
              const selected = o.id === value;
              const isSetSport = o.id === setSportId;
              return (
                <button
                  key={o.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  tabIndex={idx === activeIdx ? 0 : -1}
                  data-sport-switch-option=""
                  // Keep focus where it is on press: Safari does not focus a
                  // clicked button, so the blur would land on <body> and the
                  // wrapper's close would unmount this option before its click.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o.id)}
                  onMouseEnter={() => setActiveIdx(idx)}
                  className={`flex w-full items-baseline justify-between gap-3 rounded px-2 py-1.5 text-left text-xs focus:outline-none ${
                    idx === activeIdx
                      ? "bg-gray-800 text-gray-100"
                      : "text-gray-300"
                  } focus-visible:ring-2 focus-visible:ring-[#00B7FF]`}
                >
                  <span>{o.name}</span>
                  {/* What "default" means here, said once, in the list itself —
                    never as a banner outside it. */}
                  <span className="inline-flex items-baseline gap-1.5 text-[0.625rem] text-gray-400">
                    {isSetSport && <span>set&apos;s sport</span>}
                    {/* aria-selected carries this for assistive tech. */}
                    {selected && <span aria-hidden="true">✓</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </span>
  );
}

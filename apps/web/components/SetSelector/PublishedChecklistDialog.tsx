import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type Ref,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import NeonButton from "../modules/NeonButton";
import { Input } from "../primitives/Input";
import { Textarea } from "../primitives/Textarea";
import { inertBackground } from "@/lib/dom/inert-background";
import {
  parsePublishedChecklist,
  type PublishedChecklistParse,
  type PublishedChecklistRow,
} from "@/lib/checklists/parse-published-checklist";

/**
 * NEO-478 — "Add the publisher's checklist".
 *
 * The publisher's own checklist (Topps, Panini, Upper Deck…) already says who
 * is on every card and for which team. Pasting it in before a sync means the
 * set builder reads players and teams from it by card number, and asks the
 * marketplace about a card only when the checklist has no row for it. That is
 * what keeps a 900-card sync from making 900 per-card marketplace calls.
 *
 * ## What the dialog does
 *
 *   ┌ Publisher's checklist ─────────────────────────────────────────────┐
 *   │ Paste it, or pick a file. Rows line up by card number.             │
 *   ├──────────────────────────────┬─────────────────────────────────────┤
 *   │ Paste the checklist          │ 248 rows                            │
 *   │ ┌──────────────────────────┐ │ ┌ #  │ Players       │ Team ───────┐ │
 *   │ │60 Rhett Lowder - Reds    │ │ │ 60 │ Rhett Lowder  │ Cincinnati…│ │
 *   │ │…                         │ │ │ …                               │ │
 *   │ └──────────────────────────┘ │ Skipped lines                       │
 *   │ [Choose a file] .csv .tsv .txt│ Line 1  “Base Set” no card number  │
 *   ├──────────────────────────────┴─────────────────────────────────────┤
 *   │                                [Cancel] [Use this checklist]       │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * The preview IS the parse: what the table shows is exactly what the sync
 * gets. Every line that did not become a row is listed under "Skipped lines"
 * with the reason, so nothing is dropped behind the operator's back.
 *
 * ## State
 *
 * In-view state only. The text and the file live in this dialog while it is
 * open; "Use this checklist" hands the parsed rows to the checklist section,
 * which holds them (in memory, for this leaf) until the sync or Remove. The
 * file is never uploaded or kept, and nothing goes in the URL — adding a
 * checklist is an in-view tweak, not somewhere the operator went.
 *
 * ## Keyboard
 *
 * Opens on the paste box. Tab: paste box → Choose a file → Cancel → Use this
 * checklist. Ctrl/Cmd+Enter in the paste box uses the checklist; Escape
 * cancels from anywhere in the dialog. Focus goes back to the button that
 * opened it.
 */

/** What the section holds once the operator uses a checklist. */
export type PublishedChecklist = {
  rows: PublishedChecklistRow[];
  /** Kept so reopening the dialog shows what was pasted. Never sent anywhere. */
  text: string;
  format: PublishedChecklistParse["format"];
  skippedCount: number;
};

/** The largest file read, in bytes — a real checklist is a few dozen KB. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Rows drawn in the preview table; the count above it is always the whole. */
const PREVIEW_ROWS = 150;
/** Skipped lines drawn; the heading's count is always the whole. */
const PREVIEW_SKIPPED = 50;

/** "1 row", "248 rows" — the count the E2E suite reads. */
export function rowCountText(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"}`;
}

/** The chip's text: "Publisher's checklist: 248 rows". */
export function chipText(n: number): string {
  return `Publisher's checklist: ${rowCountText(n)}`;
}

/** The sync result's line: "Teams from your checklist: 240 of 248 cards". */
export function checklistTeamsLine(matched: number, total: number): string {
  return `Teams from your checklist: ${matched.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${total === 1 ? "card" : "cards"}`;
}

/** The paste box holds text, but no line of it reads as a card. */
export const NOTHING_READS =
  "Nothing reads as a card yet. Each line starts with its card number.";
/** Said when "Use this checklist" is pressed with no rows to use. */
export const NOTHING_TO_USE = "Nothing to use yet — paste lines that start with a card number.";

/** "3 lines skipped." — the count's second half, when any line was. */
export function skippedLinesText(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "line" : "lines"} skipped.`;
}

const FORMAT_LABEL: Record<PublishedChecklistParse["format"], string> = {
  lines: "checklist lines",
  csv: "CSV",
  tsv: "tab-separated",
};

/** The preview's header cell: stuck to the top of the dialog body, opaque. */
const HEAD_CELL =
  "sticky top-0 z-10 border-b border-rule bg-raised-deep px-3 py-1.5 font-medium";
/** A preview row: a rule under every cell but the last row's. */
const BODY_ROW = "[&>td]:border-b [&>td]:border-rule [&:last-child>td]:border-b-0";

const PLACEHOLDER = [
  "60 Rhett Lowder - Cincinnati Reds (Future Stars)",
  "11 Alonso/Schwarber/Soto (League Leaders)",
  "34 Team Card - Kansas City Royals",
].join("\n");

export default function PublishedChecklistDialog({
  initial,
  setYear,
  onUse,
  onCancel,
  restoreFocusRef,
}: {
  /** The checklist already in use, so reopening shows it. */
  initial?: PublishedChecklist | null;
  /**
   * The set's year ("1995"). A line numbered with it is the checklist's
   * title, not a card, and is listed under Skipped lines instead.
   */
  setYear?: string | null;
  onUse: (checklist: PublishedChecklist) => void;
  onCancel: () => void;
  /** Where focus goes when the dialog closes. */
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  const leadId = useId();
  const fileHintId = useId();
  const countId = useId();
  const [text, setText] = useState(initial?.text ?? "");
  const [fileNote, setFileNote] = useState<{ tone: "status" | "error"; text: string } | null>(
    null,
  );
  /**
   * A press of "Use this checklist" with nothing to use, and the text it was
   * pressed over: the message stands until the paste changes.
   */
  const [blockedFor, setBlockedFor] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);

  // A 2,000-line paste re-parses off the keystroke's own render.
  const deferredText = useDeferredValue(text);
  const parsed = useMemo(
    () => parsePublishedChecklist(deferredText, { setYear }),
    [deferredText, setYear],
  );
  const stale = deferredText !== text;
  const hasText = text.trim() !== "";
  const canUse = !stale && parsed.rows.length > 0;

  // Inert the page behind, focus the paste box; on close, put focus back.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = restoreFocusRef?.current ?? null;
    const release = inertBackground(dialog);
    pasteRef.current?.focus();
    return () => {
      release();
      // After release: an inert element cannot take focus.
      requestAnimationFrame(() => opener?.focus());
    };
  }, [restoreFocusRef]);

  const applyChecklist = () => {
    if (!canUse) {
      // A parse still catching up is not "nothing": the press is just early.
      if (stale) return;
      setBlockedFor(text);
      pasteRef.current?.focus();
      return;
    }
    onUse({
      rows: parsed.rows,
      text,
      format: parsed.format,
      skippedCount: parsed.skipped.length,
    });
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared so picking the same file again still fires a change.
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setFileNote({ tone: "error", text: `${file.name} is too big — a checklist file is under 2 MB.` });
      return;
    }
    try {
      const contents = await file.text();
      setText(contents);
      setFileNote({ tone: "status", text: `Read ${file.name}. Check the preview, then use it.` });
    } catch {
      setFileNote({ tone: "error", text: `Couldn’t read ${file.name}. Try pasting it instead.` });
    }
  };

  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };

  const onPasteKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      applyChecklist();
    }
  };

  const blocked = blockedFor !== null && blockedFor === text;
  const unreadable = hasText && !stale && !parsed.tooBig && parsed.rows.length === 0;

  const shownRows = parsed.rows.slice(0, PREVIEW_ROWS);
  const shownSkipped = parsed.skipped.slice(0, PREVIEW_SKIPPED);

  return createPortal(
    // createPortal(document.body) escapes the root Theme's CSS scope.
    <Theme>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={leadId}
          onKeyDown={onDialogKeyDown}
          className="flex max-h-[85vh] w-full max-w-4xl flex-col rounded-lg border border-rule-strong bg-raised-deep shadow-xl shadow-offset"
        >
          <header className="border-b border-rule-strong px-5 py-4">
            <h2 id={titleId} className="text-lg font-semibold text-ink">
              Publisher&apos;s checklist
            </h2>
            <p id={leadId} className="mt-0.5 text-sm text-ink-2">
              Paste it straight off the checklist page, or pick a file. Rows line up by card
              number — the marketplace only gets asked about cards your list skips.
            </p>
          </header>

          {/* The scroller carries no padding: a sticky header sticks at the
              scroller's padding edge, so padding here left a strip above the
              preview's header for rows to scroll through. The padding is on
              the grid inside it instead. */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="grid grid-cols-1 gap-5 p-5 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
              {/* Left: what goes in. */}
              <div className="flex min-w-0 flex-col gap-3">
                <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
                  Paste the checklist
                  <Textarea
                    bare
                    ref={pasteRef}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={onPasteKeyDown}
                    placeholder={PLACEHOLDER}
                    spellCheck={false}
                    aria-describedby={countId}
                    className="min-h-48 w-full resize-y px-3 py-2 font-mono text-xs leading-relaxed md:min-h-72"
                  />
                </label>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {/* The visible label IS the control's face: the file input
                      sits inside it, visually hidden but focusable, so Tab
                      lands here and Enter/Space opens the picker. The ring
                      follows focus-within. */}
                  <label className="inline-flex cursor-pointer items-center rounded-md border-2 border-neon-blue-text px-3 py-1.5 text-sm font-semibold text-neon-blue-text transition-colors hover:bg-neon-blue/10 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus max-sm:min-h-11">
                    Choose a file
                    <Input
                      bare
                      type="file"
                      accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
                      aria-describedby={fileHintId}
                      onChange={(e) => void onFile(e)}
                      className="sr-only"
                    />
                  </label>
                  <span id={fileHintId} className="text-xs text-ink-3">
                    .csv, .tsv or .txt — it stays on your computer
                  </span>
                </div>
                {/* Keyed on the tone, so the role never flips on a mounted
                    node: an error mounts a fresh alert (announced as it
                    appears), while idle and "Read list.csv" share one status
                    region that is always mounted, so its first message is
                    heard. No explicit aria-live: the role carries the
                    politeness. Never `empty:hidden`: a live region that is
                    display:none drops the message that reveals it. */}
                <p
                  key={fileNote?.tone === "error" ? "error" : "status"}
                  role={fileNote?.tone === "error" ? "alert" : "status"}
                  className={`text-xs ${
                    fileNote?.tone === "error" ? "text-neon-pink-text" : "text-ink-2"
                  }`}
                >
                  {fileNote?.text ?? ""}
                </p>
              </div>

              {/* Right: what the sync will get. */}
              <div className="flex min-w-0 flex-col gap-3">
                {/* Wraps phrase by phrase: each half of the count, and "Read as
                    …", is `whitespace-nowrap`, so a narrow column (a phone)
                    moves a whole phrase to the next line instead of splitting
                    "2 lines skipped." */}
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  {/* ONE always-mounted status region for what the paste
                      reads as: "248 rows. 3 lines skipped.", or why nothing
                      does, or why "Use this checklist" did nothing. The paste
                      box and that button are described by it. */}
                  <p id={countId} role="status" className="min-w-0">
                    {blocked ? (
                      <span className="text-sm font-semibold text-neon-pink-text">
                        {NOTHING_TO_USE}
                      </span>
                    ) : unreadable ? (
                      <span className="text-sm text-neon-pink-text">{NOTHING_READS}</span>
                    ) : (
                      <>
                        <span
                          className={`whitespace-nowrap text-2xl font-semibold tabular-nums ${
                            parsed.rows.length > 0 ? "text-neon-green-text" : "text-ink-3"
                          }`}
                        >
                          {rowCountText(parsed.rows.length)}
                        </span>
                        <span className="sr-only">.</span>
                        {hasText && parsed.skipped.length > 0 && (
                          <>
                            {" "}
                            <span className="inline-block whitespace-nowrap text-xs text-ink-3">
                              {skippedLinesText(parsed.skipped.length)}
                            </span>
                          </>
                        )}
                      </>
                    )}
                  </p>
                  {hasText && parsed.rows.length > 0 && (
                    <p className="whitespace-nowrap text-xs text-ink-3">
                      Read as {FORMAT_LABEL[parsed.format]}
                    </p>
                  )}
                </div>

                {parsed.rows.length > 0 ? (
                  // `overflow-clip`, not `hidden`: it rounds the header's corners
                  // without becoming a scroll container, so the header still
                  // sticks to the dialog body, the element that scrolls.
                  <div className="overflow-clip rounded-md border border-rule">
                    {/* `border-separate`: a collapsed border does not travel with
                        a sticky cell, so the rules sit on the cells. */}
                    <table className="w-full table-fixed border-separate border-spacing-0 text-left text-sm">
                      <caption className="sr-only">Preview of the rows the sync will use</caption>
                      <colgroup>
                        <col className="w-20" />
                        <col />
                        <col />
                      </colgroup>
                      {/* Sticky and opaque on each cell (a background on <thead>
                          does not paint under a sticky row in every browser),
                          so rows scroll UNDER the header, never through it. */}
                      <thead className="text-xs text-ink-3">
                        <tr>
                          <th scope="col" className={HEAD_CELL}>
                            Card #
                          </th>
                          <th scope="col" className={HEAD_CELL}>
                            Players
                          </th>
                          <th scope="col" className={HEAD_CELL}>
                            Teams
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {shownRows.map((row, i) => (
                          <tr key={`${row.number}-${i}`} className={BODY_ROW}>
                            <td className="px-3 py-1 align-top font-semibold tabular-nums text-neon-green-text">
                              {row.number}
                            </td>
                            <td className="px-3 py-1 align-top text-ink">
                              {row.players.length > 0 ? (
                                row.players.join(", ")
                              ) : (
                                <span className="text-ink-3">None</span>
                              )}
                            </td>
                            <td className="px-3 py-1 align-top text-ink-2">
                              {row.teams.length > 0 ? (
                                row.teams.join(", ")
                              ) : (
                                <span className="text-ink-3">None</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {parsed.rows.length > shownRows.length && (
                      <p className="border-t border-rule px-3 py-1.5 text-xs text-ink-3">
                        Showing the first {shownRows.length}. All {parsed.rows.length.toLocaleString("en-US")} go to the sync.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="rounded-md border border-dashed border-rule-strong px-3 py-6 text-center text-sm text-ink-3">
                    {parsed.tooBig ? (
                      <span role="alert" className="text-neon-pink-text">
                        Whoa, that&apos;s a lot. A pasted checklist is under 2 MB — paste just this
                        set&apos;s list.
                      </span>
                    ) : hasText ? (
                      // Why nothing reads is said once, in the status above;
                      // here, what a line that does read looks like.
                      "Try a line like “60 Rhett Lowder - Cincinnati Reds”."
                    ) : (
                      "Your rows show up here as you paste."
                    )}
                  </p>
                )}

                {hasText && !parsed.tooBig && (
                  <div>
                    <h3 className="text-sm font-semibold text-ink-2">
                      Skipped lines
                      {parsed.skipped.length > 0 && (
                        <span className="ml-1.5 font-normal tabular-nums text-ink-3">
                          ({parsed.skipped.length})
                        </span>
                      )}
                    </h3>
                    {parsed.skipped.length === 0 ? (
                      <p className="mt-1 text-xs text-ink-3">None — every line made it.</p>
                    ) : (
                      <ul className="mt-1 space-y-1">
                        {shownSkipped.map((line) => (
                          <li key={line.line} className="text-xs">
                            <span className="tabular-nums text-ink-3">Line {line.line}</span>{" "}
                            <span className="break-words text-ink-2">“{line.text.trim()}”</span>{" "}
                            <span className="text-neon-pink-text">{line.reason}</span>
                          </li>
                        ))}
                        {parsed.skipped.length > shownSkipped.length && (
                          <li className="text-xs text-ink-3">
                            …and {parsed.skipped.length - shownSkipped.length} more.
                          </li>
                        )}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-rule-strong px-5 py-3">
            <NeonButton variant="negative" outline onClick={onCancel}>
              Cancel
            </NeonButton>
            <NeonButton
              onClick={applyChecklist}
              aria-disabled={!canUse || undefined}
              aria-describedby={countId}
            >
              Use this checklist
            </NeonButton>
          </footer>
        </div>
      </div>
    </Theme>,
    document.body,
  );
}

/**
 * The chip beside the checklist header once a publisher's checklist is in
 * use: "Publisher's checklist: 248 rows" and its Remove. While it shows, the
 * chip is the checklist's handle: "Add the publisher's checklist" is gone, and
 * Remove brings it back.
 *
 * One line at every width, so it stays a pill: the text truncates, and
 * Remove's 44px touch target is an invisible 10px extension above and below
 * the 24px button (`after:`), not a taller chip (a 44px-tall chip read as an
 * oval on a phone).
 */
export function PublishedChecklistChip({
  rowCount,
  onRemove,
  disabled = false,
  removeRef,
}: {
  rowCount: number;
  onRemove: () => void;
  disabled?: boolean;
  /** Remove, so focus can land on it when the chip appears. */
  removeRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <div className="mb-3 inline-flex max-w-full items-center gap-2 rounded-full border border-neon-purple-text/70 bg-neon-purple/10 py-1 pl-3 pr-1 text-sm">
      <span className="min-w-0 truncate text-ink">{chipText(rowCount)}</span>
      <button
        ref={removeRef}
        type="button"
        onClick={() => {
          if (!disabled) onRemove();
        }}
        aria-disabled={disabled || undefined}
        aria-label="Remove the publisher's checklist"
        className={`relative min-h-6 shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold text-neon-pink-text transition-colors after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-[''] hover:bg-neon-pink/15 focus-outline ${
          disabled ? "cursor-not-allowed opacity-60" : ""
        }`}
      >
        Remove
      </button>
    </div>
  );
}

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
import { Checkbox } from "../primitives/Checkbox";
import { inertBackground } from "@/lib/dom/inert-background";
import { useDebouncedValue } from "@/src/hooks/useDebouncedValue";
import {
  filterRowsBySubsets,
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
 *   │ Paste it, or pick a file. We line it up by card number…            │
 *   ├──────────────────────────────┬─────────────────────────────────────┤
 *   │ Paste the checklist          │ ┌ Which of these belong to this set?│
 *   │                              │ │ [ ] Base Set  [ ] Future Stars    │
 *   │                              │ 248 rows                            │
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
 * with the reason, so nothing is dropped behind the operator's back. A card
 * printed with no number ("NNO") is a row like any other, numbered "NNO": the
 * sync pairs it by player (PR 451 D-B), so it is never listed as skipped.
 *
 * ## No Team (NEO-489)
 *
 * A team cell that says exactly "No Team" (any case, any spacing) is the
 * checklist saying the card shows no team. The row keeps `teams: []` and
 * carries `noTeam: true`; its Teams cell reads "No team" at a team's
 * strength, where a blank cell (no claim, so the team is looked up) reads a
 * muted "None". The sync takes the claim as the card's answer and never asks
 * about it. "No Team" beside a real team is a contradiction the parser will
 * not settle: the line is skipped with the parser's own reason
 * (`NO_TEAM_AND_A_TEAM`), shown under Skipped lines like every other.
 *
 * ## Subsets
 *
 * A checklist page often carries several subsets under one heading (Base Set,
 * Future Stars, a parallel run). When the parse finds two or more, the
 * preview asks "Which of these belong to this set?" with one checkbox each,
 * none ticked: guessing which subset is this leaf would be the parser
 * deciding for the operator. "Use this checklist" is held until one is
 * ticked, and only the ticked subsets' rows (`filterRowsBySubsets`) are
 * counted, previewed and used.
 *
 * ## Announcements
 *
 * The visible count is NOT a live region: read out on every keystroke, it
 * talked over the typing. An always-mounted sr-only status says it once the
 * paste has held still for 1.5 s. Why nothing reads, and why a press of "Use
 * this checklist" did nothing, go in the same status at once.
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
  /**
   * The subsets ticked, when the paste carried two or more; `rows` holds only
   * theirs. Kept so reopening the dialog shows the same ticks.
   */
  subsets?: string[];
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

/**
 * The chip's text: "Publisher's checklist: 248 rows", and " · 2 skipped" when
 * any line of the paste was.
 */
export function chipText(n: number, skipped = 0): string {
  const base = `Publisher's checklist: ${rowCountText(n)}`;
  return skipped > 0 ? `${base} · ${skipped.toLocaleString("en-US")} skipped` : base;
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
/** The subset question's legend. */
export const SUBSET_QUESTION = "Which of these belong to this set?";
/** Said when "Use this checklist" is pressed before any subset is ticked. */
export const PICK_A_SUBSET = "Tick at least one subset first — then use it.";

/** NEO-489 — the team cell of a row whose checklist said "No Team". */
export const NO_TEAM_CELL = "No team";
/** How long the paste must hold still before its count is announced. */
export const COUNT_ANNOUNCE_DEBOUNCE_MS = 1500;

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

/**
 * What a readable line looks like, shown in the empty preview under an
 * "Example" label. Not the paste box's placeholder: grey text in the box read
 * like a checklist already pasted.
 */
const EXAMPLE_LINES = [
  "60 Rhett Lowder - Cincinnati Reds (Future Stars)",
  "11 Alonso/Schwarber/Soto (League Leaders)",
  "34 Team Card - Kansas City Royals",
];

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
  const subsetBaseId = useId();
  const [text, setText] = useState(initial?.text ?? "");
  /** The subsets ticked, in tick order; read against the parse's own list. */
  const [ticked, setTicked] = useState<string[]>(initial?.subsets ?? []);
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
  const firstSubsetRef = useRef<HTMLInputElement>(null);

  // A 2,000-line paste re-parses off the keystroke's own render.
  const deferredText = useDeferredValue(text);
  const parsed = useMemo(
    () => parsePublishedChecklist(deferredText, { setYear }),
    [deferredText, setYear],
  );
  const stale = deferredText !== text;
  const hasText = text.trim() !== "";
  /** Two or more subsets: the operator says which belong before any row is used. */
  const subsets = useMemo(
    () => ((parsed.subsets?.length ?? 0) >= 2 ? (parsed.subsets ?? []) : []),
    [parsed.subsets],
  );
  const asksSubsets = subsets.length > 0;
  /** Ticks that still name one of this parse's subsets, in the parse's order. */
  const chosen = useMemo(() => subsets.filter((s) => ticked.includes(s)), [subsets, ticked]);
  const subsetPending = asksSubsets && chosen.length === 0;
  /** What the sync gets: every row, or only the ticked subsets' rows. */
  const usedRows = useMemo(
    () =>
      !asksSubsets
        ? parsed.rows
        : chosen.length === 0
          ? []
          : filterRowsBySubsets(parsed.rows, chosen),
    [asksSubsets, chosen, parsed.rows],
  );
  /** Rows per subset, for the count beside each tick. */
  const subsetRowCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!asksSubsets) return counts;
    for (const row of parsed.rows) {
      if (row.subset !== undefined) counts.set(row.subset, (counts.get(row.subset) ?? 0) + 1);
    }
    return counts;
  }, [asksSubsets, parsed.rows]);
  /**
   * Painted from the (deferred) parse alone, so the button does not flash
   * grey on every keystroke while the parse catches up; a press while it is
   * still catching up is ignored by `applyChecklist`.
   */
  const canUse = usedRows.length > 0;

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
    // A parse still catching up is not "nothing": the press is just early.
    if (stale) return;
    if (!canUse) {
      setBlockedFor(text);
      // Held for a tick: the first subset is what needs doing. Otherwise the paste.
      if (subsetPending) firstSubsetRef.current?.focus();
      else pasteRef.current?.focus();
      return;
    }
    onUse({
      rows: usedRows,
      text,
      format: parsed.format,
      skippedCount: parsed.skipped.length,
      ...(asksSubsets ? { subsets: chosen } : {}),
    });
  };

  const toggleSubset = (subset: string, on: boolean) => {
    setTicked((prev) =>
      on ? (prev.includes(subset) ? prev : [...prev, subset]) : prev.filter((s) => s !== subset),
    );
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

  // A blocked press holds until the paste changes, or (when it was a
  // missing tick) until a subset is ticked.
  const blocked = blockedFor !== null && blockedFor === text && !canUse;
  const unreadable = hasText && !stale && !parsed.tooBig && parsed.rows.length === 0;

  const shownRows = usedRows.slice(0, PREVIEW_ROWS);
  const shownSkipped = parsed.skipped.slice(0, PREVIEW_SKIPPED);

  /** "248 rows. 3 lines skipped." — the count as a sentence, for the status. */
  const countSentence = `${rowCountText(usedRows.length)}.${
    hasText && parsed.skipped.length > 0 ? ` ${skippedLinesText(parsed.skipped.length)}` : ""
  }`;
  const announcedCount = useDebouncedValue(countSentence, COUNT_ANNOUNCE_DEBOUNCE_MS);
  const blockedMessage = subsetPending ? PICK_A_SUBSET : NOTHING_TO_USE;
  /** The status: why not, at once; otherwise the count once it holds still. */
  const statusText = blocked ? blockedMessage : unreadable ? NOTHING_READS : announcedCount;

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
              Paste it straight off the checklist page, or pick a file. We line it up by card
              number and only look up teams your list leaves out. Card with no team? Write
              “No Team” where its team goes.
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
                    spellCheck={false}
                    aria-describedby={countId}
                    className="min-h-48 w-full resize-y px-3 py-2 font-mono text-xs leading-relaxed md:min-h-72"
                  />
                </label>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {/* The visible label IS the control's face: the file input
                      sits inside it, visually hidden but focusable, so Tab
                      lands here and Enter/Space opens the picker. The ring
                      follows focus-within. Painted as NeonButton's secondary
                      outline (`neonButtonPaint("secondary", true)`): a 1px
                      edge in the hue, filling with it (and its ink) under the
                      pointer, so it reads as the button it acts as. */}
                  <label className="inline-flex h-8 cursor-pointer items-center rounded-md border border-neon-blue-text px-3 text-sm font-medium text-neon-blue-text transition-colors hover:border-neon-blue hover:bg-neon-blue hover:text-on-neon-blue focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus max-sm:min-h-11">
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
                {/* Two or more subsets: which belong to this set. Nothing is
                    ticked to start, and nothing is used until one is. */}
                {asksSubsets && (
                  <fieldset className="rounded-md border border-rule-strong px-3 pb-3 pt-1">
                    <legend className="px-1 text-sm font-semibold text-ink">
                      {SUBSET_QUESTION}
                    </legend>
                    <p className="mb-2 text-xs text-ink-3">
                      This checklist has {subsets.length} subsets. Only the ones you tick are used.
                    </p>
                    <ul className="flex flex-wrap gap-x-4 gap-y-1">
                      {subsets.map((subset, i) => {
                        const countOf = `${subsetBaseId}-${i}`;
                        const on = chosen.includes(subset);
                        return (
                          <li key={subset}>
                            {/* The whole row is the target; the box's own
                                name is the subset's, and its row count is
                                its description. */}
                            <label className="flex cursor-pointer items-center gap-2 py-1 text-sm text-ink max-sm:min-h-11">
                              <Checkbox
                                ref={i === 0 ? firstSubsetRef : undefined}
                                checked={on}
                                onChange={(e) => toggleSubset(subset, e.target.checked)}
                                aria-label={subset}
                                aria-describedby={countOf}
                                className="items-center"
                              />
                              <span>{subset}</span>
                              <span id={countOf} className="tabular-nums text-xs text-ink-3">
                                {rowCountText(subsetRowCounts.get(subset) ?? 0)}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </fieldset>
                )}

                {/* Wraps phrase by phrase: each half of the count, and "Read as
                    …", is `whitespace-nowrap`, so a narrow column (a phone)
                    moves a whole phrase to the next line instead of splitting
                    "2 lines skipped." */}
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  {/* What the paste reads as: "248 rows. 3 lines skipped.", or
                      why nothing does, or why "Use this checklist" did
                      nothing. The paste box and that button are described by
                      it. Not a live region: the sr-only status below speaks
                      for it. */}
                  <p id={countId} className="min-w-0">
                    {blocked ? (
                      <span className="text-sm font-semibold text-neon-pink-text">
                        {blockedMessage}
                      </span>
                    ) : unreadable ? (
                      <span className="text-sm text-neon-pink-text">{NOTHING_READS}</span>
                    ) : (
                      <>
                        <span
                          className={`whitespace-nowrap text-2xl font-semibold tabular-nums ${
                            usedRows.length > 0 ? "text-neon-green-text" : "text-ink-3"
                          }`}
                        >
                          {rowCountText(usedRows.length)}
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
                {/* The one live region for the count: always mounted, after
                    the visible count (so a text locator's first match is the
                    one on screen). The count is said once the paste holds
                    still for 1.5 s; a blocked press and an unreadable paste
                    are said at once. */}
                <p role="status" className="sr-only" data-checklist-count-status="">
                  {statusText}
                </p>

                {usedRows.length > 0 ? (
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
                              ) : row.noTeam ? (
                                // The checklist's answer, so it reads at a
                                // team's strength, unlike a blank cell.
                                NO_TEAM_CELL
                              ) : (
                                <span className="text-ink-3">None</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {usedRows.length > shownRows.length && (
                      <p className="border-t border-rule px-3 py-1.5 text-xs text-ink-3">
                        Showing the first {shownRows.length}. All {usedRows.length.toLocaleString("en-US")} go to the sync.
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-rule-strong px-3 py-6 text-center text-sm text-ink-3">
                    {parsed.tooBig ? (
                      <p role="alert" className="text-neon-pink-text">
                        Whoa, that&apos;s a lot. A pasted checklist is under 2 MB — paste just this
                        set&apos;s list.
                      </p>
                    ) : subsetPending ? (
                      <p>Tick the subsets that belong to this set, and their rows show up here.</p>
                    ) : hasText ? (
                      // Why nothing reads is said once, in the count above;
                      // here, what a line that does read looks like.
                      <p>Try a line like “60 Rhett Lowder - Cincinnati Reds”.</p>
                    ) : (
                      <>
                        <p>Your rows show up here as you paste.</p>
                        {/* Labelled as an example and kept out of the paste
                            box, so it never reads as a checklist already
                            pasted. */}
                        <figure className="mx-auto mt-4 w-fit max-w-full text-left">
                          <figcaption className="text-xs font-semibold text-ink-2">
                            Example lines
                          </figcaption>
                          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-ink-3">
                            {EXAMPLE_LINES.join("\n")}
                          </pre>
                        </figure>
                      </>
                    )}
                  </div>
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
 * use: "Publisher's checklist: 248 rows" (" · 2 skipped" when lines were) and
 * its Remove. While it shows, the chip is the checklist's handle: "Add the
 * publisher's checklist" is gone, Remove brings it back, and the chip's text
 * is itself a button that reopens the dialog on what was pasted, to edit it.
 *
 * One line at every width, so it stays a pill: the text truncates, and
 * Remove's 44px touch target is an invisible 10px extension above and below
 * the 24px button (`after:`), not a taller chip (a 44px-tall chip read as an
 * oval on a phone).
 *
 * Remove is quiet-destructive: neutral ink at rest (pink text on the chip was
 * 4.1:1 in dark), the pink fill with its own ink under the pointer or focus.
 */
export function PublishedChecklistChip({
  rowCount,
  skippedCount = 0,
  onOpen,
  onRemove,
  disabled = false,
  openRef,
  removeRef,
}: {
  rowCount: number;
  /** Lines of the paste that did not become rows. */
  skippedCount?: number;
  /** Reopens the dialog on the checklist in use. */
  onOpen?: () => void;
  onRemove: () => void;
  disabled?: boolean;
  /** The chip's text button, so focus can come back to it from the dialog. */
  openRef?: Ref<HTMLButtonElement>;
  /** Remove, so focus can land on it when the chip appears. */
  removeRef?: Ref<HTMLButtonElement>;
}) {
  const label = chipText(rowCount, skippedCount);
  return (
    <div className="mb-3 inline-flex max-w-full items-center gap-1 rounded-full border border-neon-purple-text/70 py-1 pl-1 pr-1 text-sm">
      {onOpen ? (
        <button
          ref={openRef}
          type="button"
          onClick={() => {
            if (!disabled) onOpen();
          }}
          aria-disabled={disabled || undefined}
          aria-haspopup="dialog"
          title="Open it to check or change it"
          className={`relative flex min-h-6 min-w-0 rounded-full px-2 py-0.5 text-left text-ink underline-offset-2 transition-colors after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-[''] hover:bg-hover-raised hover:underline focus-outline ${
            disabled ? "cursor-not-allowed opacity-60" : ""
          }`}
        >
          {/* Truncated inside, never on the button: overflow on the button
              would clip its touch extension. */}
          <span className="min-w-0 truncate">{label}</span>
        </button>
      ) : (
        <span className="min-w-0 truncate px-2 text-ink">{label}</span>
      )}
      <button
        ref={removeRef}
        type="button"
        onClick={() => {
          if (!disabled) onRemove();
        }}
        aria-disabled={disabled || undefined}
        aria-label="Remove the publisher's checklist"
        className={`relative min-h-6 shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold text-ink-2 transition-colors after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-[''] focus-outline ${
          disabled
            ? "cursor-not-allowed opacity-60"
            : "hover:bg-neon-pink hover:text-on-neon-pink focus-visible:bg-neon-pink focus-visible:text-on-neon-pink"
        }`}
      >
        Remove
      </button>
    </div>
  );
}

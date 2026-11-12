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
} from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import NeonButton from "../modules/NeonButton";
import { ConfirmDialog } from "../modules/confirm-dialog";
import { Input } from "../primitives/Input";
import { Textarea } from "../primitives/Textarea";
import { inertBackground } from "@/lib/dom/inert-background";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
import {
  CHECKLIST_FILE_ACCEPT,
  checklistFileNameProblem,
  readChecklistFile,
  readChecklistSections,
  type ChecklistFileReaders,
  type ChecklistInput,
} from "@/lib/checklists/read-checklist-file";
import type {
  ChecklistSection,
  ChecklistSections,
} from "@/lib/checklists/checklist-sections";
import type { SkippedLine } from "@/lib/checklists/parse-published-checklist";
import {
  planChecklistBatches,
  uploadChecklist,
  uploadFailure,
  type ChecklistUploadApi,
  type StoredChecklistFormat,
  type UploadCheckpoint,
  type UploadFailure,
} from "./published-checklist-upload";

/**
 * NEO-496 — the set's official checklist: one file on the SET, stored, that
 * every insert and parallel sync of the set can read as one more source.
 *
 *   ┌ Official checklist ──────────────────────────────────────────────┐
 *   │ none:  [Upload checklist]  Paste one instead               │
 *   │ ready: 2026-donruss.xlsx                                   │
 *   │        273 sections, 18,068 cards. Saved Nov 11, 2026.     │
 *   │        [Replace checklist]  Paste a replacement  [Remove]  │
 *   └────────────────────────────────────────────────────────────┘
 *
 * Choosing a file reads it in the browser (`readChecklistFile`: the
 * spreadsheet and PDF readers load only when such a file is chosen) and opens
 * the preview: every section with its card count and number range, under its
 * group heading, the sections left out whole and why, and every skipped line
 * grouped by reason. Nothing is saved until "Save checklist", which sends the
 * sections in whole-section calls (`published-checklist-upload.ts`) with
 * progress, and makes the new file the set's checklist only once every
 * section has arrived.
 *
 * Upload, Replace and Remove write nothing to the set's rows or cards (Jason,
 * Q2): the next sync reads the new file. Remove confirms first. Nothing here,
 * or anywhere else, says whether a card is on the checklist (N1).
 *
 * ## Navigation
 *
 * The panel follows the set the drill URL names; the preview and the confirm
 * are in-view dialogs, kept out of the URL, so Back never lands in one.
 *
 * ## Keyboard
 *
 * Upload / Replace are file inputs inside their visible labels (Tab lands
 * on them, Enter or Space opens the picker). The preview opens focused on
 * its first control; Escape cancels it (or stops a save in flight); focus
 * goes back to where it was opened from, or to Replace once a save lands.
 */

/** Rows drawn per skip reason; the count beside the reason is always the whole. */
const SKIPPED_PER_REASON = 50;

const n = (value: number) => value.toLocaleString("en-US");

/** "1 card", "1,643 cards". */
export function cardCountText(count: number): string {
  return `${n(count)} ${count === 1 ? "card" : "cards"}`;
}

/** "1 section", "56 sections". */
export function sectionCountText(count: number): string {
  return `${n(count)} ${count === 1 ? "section" : "sections"}`;
}

/** "56 sections, 1,643 cards". */
export function checklistSizeText(sections: number, cards: number): string {
  return `${sectionCountText(sections)}, ${cardCountText(cards)}`;
}

/** "Saving 100 of 273 sections" — the save's progress, in sections. */
export function savingText(saved: number, total: number): string {
  return `Saving ${n(saved)} of ${sectionCountText(total)}`;
}

/**
 * A section's card numbers as the preview shows them: "1 to 200",
 * "FS-1 to FS-10", "NNO only", "1 to 30, plus 2 NNO". The first and last
 * numbered rows in file order, as printed: a range, never a claim that every
 * number between is there.
 */
export function sectionNumbersText(section: Pick<ChecklistSection, "rows">): string {
  const numbered = section.rows.filter((r) => !r.noNumber);
  const nno = section.rows.length - numbered.length;
  if (numbered.length === 0) return nno > 0 ? "NNO only" : "";
  const first = numbered[0].number;
  const last = numbered[numbered.length - 1].number;
  const range = first === last ? first : `${first} to ${last}`;
  return nno > 0 ? `${range}, plus ${n(nno)} NNO` : range;
}

/** The stored format for a file the reader read. */
export function storedFormatOf(fileName: string, input: ChecklistInput): StoredChecklistFormat {
  if (input.kind === "cells") return input.cells.format;
  const ext = /\.(csv|tsv|txt)$/i.exec(fileName)?.[1]?.toLowerCase();
  return ext === "csv" || ext === "tsv" ? ext : "txt";
}

/** The name a pasted checklist is saved under. */
export const PASTED_FILE_NAME = "Pasted checklist";

/** Said when the parse found cards but no section to put them in. */
export const NO_SECTIONS_FOUND =
  "No sections found. A set checklist needs a section heading (like FUTURE STARS) above its cards, or a set column.";

/** Said when "Save checklist" is pressed with nothing to save. */
export const NOTHING_TO_SAVE = "Nothing to save yet. Choose a file or paste a checklist first.";

/** Skipped lines, grouped by reason, in the order each reason first appears. */
export function groupSkippedByReason(
  skipped: readonly SkippedLine[],
): Array<{ reason: string; lines: SkippedLine[] }> {
  const byReason = new Map<string, SkippedLine[]>();
  for (const line of skipped) {
    const list = byReason.get(line.reason);
    if (list) list.push(line);
    else byReason.set(line.reason, [line]);
  }
  return [...byReason].map(([reason, lines]) => ({ reason, lines }));
}

/** What the preview reads from: a file already read, or the paste box. */
type Source =
  | { kind: "file"; name: string; format: StoredChecklistFormat; input: ChecklistInput }
  | { kind: "paste" };

/** The file-input face, painted as NeonButton's secondary outline. */
const FILE_BUTTON_FACE =
  "inline-flex h-8 cursor-pointer items-center rounded-md border border-neon-blue-text px-3 text-sm font-medium text-neon-blue-text transition-colors hover:border-neon-blue hover:bg-neon-blue hover:text-on-neon-blue focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus max-sm:min-h-11";
/**
 * A quiet action: ink-2 text that brightens under the pointer. At least 24px
 * tall (WCAG 2.5.8) on every width, 44px on a phone.
 */
const QUIET_BUTTON =
  "inline-flex min-h-6 items-center rounded text-sm text-ink-2 underline underline-offset-2 transition-colors hover:text-ink focus-outline max-sm:min-h-11";


/** A file input inside its visible label: the label IS the control's face. */
function FilePickButton({
  label,
  describedBy,
  onFile,
  inputRef,
}: {
  label: string;
  describedBy?: string;
  onFile: (file: File) => void;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <label className={FILE_BUTTON_FACE}>
      {label}
      <Input
        bare
        ref={inputRef}
        type="file"
        accept={CHECKLIST_FILE_ACCEPT}
        aria-describedby={describedBy}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const file = e.target.files?.[0];
          // Cleared so choosing the same file again still fires a change.
          e.target.value = "";
          if (file) onFile(file);
        }}
        className="sr-only"
      />
    </label>
  );
}

export default function PublishedChecklistPanel({
  setId,
  setName,
  setYear,
  onStatus,
  readers,
}: {
  setId: Id<"selectorOptions">;
  /** The set's own name, for the remove confirm. */
  setName: string;
  /** The set's year, so a "2026 …" title line is read as a title, not a card. */
  setYear?: string | null;
  /**
   * Says a status line ("Reading …", "Checklist saved: …") through the
   * attributes panel's own status region: that panel keeps ONE `status`
   * (NEO-412), so this one adds none of its own.
   */
  onStatus: (message: string) => void;
  /** The spreadsheet / PDF readers; a test stands in for pdf.js here. */
  readers?: ChecklistFileReaders;
}) {
  const headingId = useId();
  const hintId = useId();
  const readErrorId = useId();
  const stored = useQuery(api.publishedChecklists.getForSet, { setId });
  const start = useMutation(api.publishedChecklists.start);
  const addSections = useMutation(api.publishedChecklists.addSections);
  const finish = useMutation(api.publishedChecklists.finish);
  const remove = useMutation(api.publishedChecklists.remove);

  const [reading, setReading] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Source | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  /**
   * What to say, and where to land, once the dialog that just closed is gone.
   * Said from the effect below, which runs after the dialog's own cleanup has
   * released the inert page: a line written into the status region while the
   * page is still inert is never spoken (A2).
   */
  const afterClose = useRef<{ message: string; focus: () => HTMLElement | null } | null>(null);
  useEffect(() => {
    if (preview || confirmRemove) return;
    const pending = afterClose.current;
    if (!pending) return;
    afterClose.current = null;
    requestAnimationFrame(() => {
      pending.focus()?.focus();
      onStatus(pending.message);
    });
  }, [preview, confirmRemove, onStatus]);

  /** Where the preview was opened from, so focus can go back on Cancel. */
  const openerRef = useRef<HTMLElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  // A different set: whatever this panel was doing belonged to the last one.
  const [shownFor, setShownFor] = useState(setId);
  if (shownFor !== setId) {
    setShownFor(setId);
    setPreview(null);
    setReading(null);
    setReadError(null);
    setConfirmRemove(false);
  }

  const onFile = async (file: File, opener: HTMLElement | null) => {
    if (reading) return;
    openerRef.current = opener;
    // A name the server would refuse is refused before anything is read or
    // said (the reader refuses it too; this keeps "Reading …" unsaid).
    const refusal = checklistFileNameProblem(file.name);
    if (refusal) {
      setReadError(refusal);
      return;
    }
    setReadError(null);
    setReading(file.name);
    onStatus(`Reading ${file.name}…`);
    const read = await readChecklistFile(file, readers);
    setReading(null);
    if (!read.ok) {
      setReadError(read.message);
      return;
    }
    setPreview({
      kind: "file",
      name: file.name,
      format: storedFormatOf(file.name, read.input),
      input: read.input,
    });
  };

  const openPaste = (opener: HTMLElement | null) => {
    openerRef.current = opener;
    setReadError(null);
    setPreview({ kind: "paste" });
  };

  const uploadApi: ChecklistUploadApi = useMemo(
    () => ({ start, addSections, finish }),
    [start, addSections, finish],
  );

  const ready = stored ?? null;
  const fileHint = ".xlsx, .pdf, .csv, .tsv or .txt. One file covers the whole set.";
  // The picker reads the refusal out with its hint while one stands (A-N6).
  const pickDescribedBy = readError ? `${hintId} ${readErrorId}` : hintId;

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={reading !== null || undefined}
      className="space-y-2 rounded-md border border-rule p-3"
    >
      <h4 id={headingId} className="text-sm font-semibold text-ink">
        Official checklist
      </h4>

      {ready ? (
        <div className="space-y-1">
          <p className="max-w-full break-words text-sm font-medium text-ink">{ready.fileName}</p>
          <p className="text-xs text-ink-3">
            {checklistSizeText(ready.sectionCount, ready.rowCount)}. Saved{" "}
            {new Date(ready.finishedAt).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
            . Syncs in this set read its sections.
          </p>
        </div>
      ) : (
        <p className="text-xs text-ink-3">
          Got the official checklist? Upload it once and every insert and parallel sync in this
          set reads it. Nothing changes until you sync.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {ready ? (
          <>
            <FilePickButton
              label="Replace checklist"
              describedBy={pickDescribedBy}
              inputRef={replaceInputRef}
              onFile={(file) => void onFile(file, replaceInputRef.current)}
            />
            <button
              type="button"
              className={QUIET_BUTTON}
              onClick={(e) => openPaste(e.currentTarget)}
              aria-haspopup="dialog"
            >
              Paste a replacement
            </button>
            <NeonButton
              variant="negative"
              outline
              size="1"
              onClick={() => {
                setRemoveError(null);
                setConfirmRemove(true);
              }}
              aria-haspopup="dialog"
            >
              Remove checklist
            </NeonButton>
          </>
        ) : (
          <>
            <FilePickButton
              label="Upload checklist"
              describedBy={pickDescribedBy}
              inputRef={uploadInputRef}
              onFile={(file) => void onFile(file, uploadInputRef.current)}
            />
            <button
              type="button"
              className={QUIET_BUTTON}
              onClick={(e) => openPaste(e.currentTarget)}
              aria-haspopup="dialog"
            >
              Paste one instead
            </button>
          </>
        )}
      </div>
      <p id={hintId} className="text-xs text-ink-3">
        {fileHint}
      </p>

      {reading && <p className="text-xs text-ink-2">Reading {reading}…</p>}
      {readError && (
        <p id={readErrorId} role="alert" className="text-xs text-neon-pink-text">
          {readError}
        </p>
      )}

      {preview && (
        <SetChecklistPreviewDialog
          key={preview.kind === "file" ? `file:${preview.name}` : "paste"}
          setId={setId}
          initialSource={preview}
          setYear={setYear}
          replacing={ready?.fileName ?? null}
          api={uploadApi}
          readers={readers}
          onCancel={() => {
            setPreview(null);
            const opener = openerRef.current;
            requestAnimationFrame(() => {
              if (opener?.isConnected) opener.focus();
            });
          }}
          onSaved={(saved) => {
            // Upload became Replace: land there.
            afterClose.current = {
              message: `Checklist saved: ${checklistSizeText(saved.sectionCount, saved.rowCount)}.`,
              focus: () => replaceInputRef.current ?? uploadInputRef.current,
            };
            setPreview(null);
          }}
        />
      )}

      {confirmRemove && ready && (
        <ConfirmDialog
          title="Remove this set's checklist?"
          description={`Syncs in ${setName} stop reading ${ready.fileName}. Cards and sets already built stay exactly as they are, and you can upload a checklist again any time.`}
          confirmLabel="Yes, remove it"
          busyLabel="Removing..."
          busy={removing}
          error={removeError}
          onCancel={() => setConfirmRemove(false)}
          onConfirm={async () => {
            setRemoving(true);
            setRemoveError(null);
            try {
              await remove({ setId });
              afterClose.current = {
                message: "Checklist removed.",
                focus: () => uploadInputRef.current,
              };
              setConfirmRemove(false);
            } catch (e) {
              setRemoveError(userFacingMessage(e, "Couldn't remove the checklist. Try again."));
            } finally {
              setRemoving(false);
            }
          }}
        />
      )}
    </section>
  );
}

type SaveState =
  | { kind: "idle" }
  | { kind: "saving"; saved: number; total: number }
  | { kind: "failed"; failure: UploadFailure; checkpoint: UploadCheckpoint | null };

/**
 * The preview before anything is saved, and the save itself. Portalled, with
 * the page behind it inert, like the leaf's checklist dialog.
 */
export function SetChecklistPreviewDialog({
  setId,
  initialSource,
  setYear,
  replacing,
  api: uploadApi,
  readers,
  onCancel,
  onSaved,
}: {
  setId: Id<"selectorOptions">;
  initialSource: Source;
  setYear?: string | null;
  /** The file this save replaces, when the set already has one. */
  replacing: string | null;
  api: ChecklistUploadApi;
  readers?: ChecklistFileReaders;
  onCancel: () => void;
  onSaved: (saved: { sectionCount: number; rowCount: number }) => void;
}) {
  const titleId = useId();
  const leadId = useId();
  const summaryId = useId();
  const errorId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stopRef = useRef(false);

  const [source, setSource] = useState<Source>(initialSource);
  const [text, setText] = useState("");
  const [fileNote, setFileNote] = useState<{ tone: "status" | "error"; text: string } | null>(
    null,
  );
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [blocked, setBlocked] = useState(false);

  const deferredText = useDeferredValue(text);
  const parsed: ChecklistSections | null = useMemo(() => {
    if (source.kind === "file") return readChecklistSections(source.input, { setYear });
    if (deferredText.trim() === "") return null;
    return readChecklistSections({ kind: "text", text: deferredText }, { setYear });
  }, [source, deferredText, setYear]);
  const stale = source.kind === "paste" && deferredText !== text;
  const sections = useMemo(() => parsed?.sections ?? [], [parsed]);
  const batches = useMemo(() => planChecklistBatches(sections), [sections]);
  const canSave = sections.length > 0;
  const saving = save.kind === "saving";

  // Inert the page behind, focus the first control; on close, the opener
  // gets focus back (the panel decides where, as it knows what is left).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const release = inertBackground(dialog);
    (pasteRef.current ?? fileInputRef.current)?.focus();
    return release;
  }, []);

  const resetSave = () => {
    setSave({ kind: "idle" });
    setBlocked(false);
  };

  const onFile = async (file: File) => {
    const refusal = checklistFileNameProblem(file.name);
    if (refusal) {
      setFileNote({ tone: "error", text: refusal });
      return;
    }
    setFileNote({ tone: "status", text: `Reading ${file.name}…` });
    const read = await readChecklistFile(file, readers);
    if (!read.ok) {
      setFileNote({ tone: "error", text: read.message });
      return;
    }
    resetSave();
    setSource({
      kind: "file",
      name: file.name,
      format: storedFormatOf(file.name, read.input),
      input: read.input,
    });
    setFileNote({ tone: "status", text: `Read ${file.name}. Check the sections, then save.` });
  };

  const runSave = async (resumeFrom: UploadCheckpoint | null) => {
    if (saving || stale) return;
    if (!canSave) {
      setBlocked(true);
      return;
    }
    stopRef.current = false;
    const total = sections.length;
    setSave({ kind: "saving", saved: 0, total });
    const result = await uploadChecklist(uploadApi, {
      setId,
      fileName: source.kind === "file" ? source.name : PASTED_FILE_NAME,
      format: source.kind === "file" ? source.format : "paste",
      batches,
      resumeFrom,
      onProgress: (saved) => setSave({ kind: "saving", saved, total }),
      shouldStop: () => stopRef.current,
    });
    if (result.ok) {
      onSaved({ sectionCount: result.sectionCount, rowCount: result.rowCount });
      return;
    }
    if (result.stopped) {
      onCancel();
      return;
    }
    setSave({
      kind: "failed",
      failure: uploadFailure(result.error),
      checkpoint: result.checkpoint,
    });
  };

  const cancelOrStop = () => {
    if (saving) {
      // Stops after the call in flight; the server expires the half upload.
      stopRef.current = true;
      return;
    }
    onCancel();
  };

  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelOrStop();
    }
  };

  const failed = save.kind === "failed" ? save : null;
  const retryable = failed?.failure.fix === "retry";
  const primaryLabel = saving ? "Saving..." : retryable ? "Try again" : "Save checklist";
  // Painted from the (deferred) parse alone, so the button does not flash on
  // every keystroke; a press while the parse catches up is ignored.
  const primaryHeld = saving || !canSave || (failed !== null && !retryable);

  const grouped = useMemo(() => groupSkippedByReason(parsed?.skipped ?? []), [parsed]);
  const skippedSections = parsed?.skippedSections ?? [];

  /** The status line: why not, at once; the save's progress; else nothing. */
  const statusText =
    blocked && !canSave
      ? NOTHING_TO_SAVE
      : save.kind === "saving"
        ? savingText(save.saved, save.total)
        : "";

  let lead: string;
  if (source.kind === "file") {
    lead = replacing
      ? `${source.name} replaces ${replacing} once it's saved. Nothing in the set changes until a sync uses it.`
      : `${source.name}. Nothing in the set changes until a sync uses it.`;
  } else {
    lead = replacing
      ? `Paste the whole checklist, section headings and all. It replaces ${replacing} once it's saved.`
      : "Paste the whole checklist, section headings and all. Each heading (like FUTURE STARS) starts a section.";
  }

  return createPortal(
    <Theme>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={leadId}
          onKeyDown={onDialogKeyDown}
          className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg border border-rule-strong bg-raised-deep shadow-xl shadow-offset"
        >
          <header className="border-b border-rule-strong px-5 py-4">
            <h2 id={titleId} className="text-lg font-semibold text-ink">
              Checklist preview
            </h2>
            <p id={leadId} className="mt-0.5 break-words text-sm text-ink-2">
              {lead}
            </p>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex flex-col gap-4 p-5">
              {source.kind === "paste" && (
                <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
                  Paste the set&apos;s checklist
                  <Textarea
                    bare
                    ref={pasteRef}
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value);
                      resetSave();
                    }}
                    spellCheck={false}
                    aria-describedby={summaryId}
                    readOnly={saving}
                    className="min-h-40 w-full resize-y px-3 py-2 font-mono text-xs leading-relaxed"
                  />
                </label>
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <FilePickButton
                  label={source.kind === "file" ? "Choose another file" : "Choose a file instead"}
                  inputRef={fileInputRef}
                  onFile={(file) => {
                    if (!saving) void onFile(file);
                  }}
                />
                {source.kind === "file" && (
                  <button
                    type="button"
                    className={QUIET_BUTTON}
                    onClick={() => {
                      if (saving) return;
                      resetSave();
                      setFileNote(null);
                      setSource({ kind: "paste" });
                      requestAnimationFrame(() => pasteRef.current?.focus());
                    }}
                  >
                    Paste instead
                  </button>
                )}
              </div>
              <p
                key={fileNote?.tone === "error" ? "error" : "status"}
                role={fileNote?.tone === "error" ? "alert" : "status"}
                className={`text-xs ${fileNote?.tone === "error" ? "text-neon-pink-text" : "text-ink-2"}`}
              >
                {fileNote?.text ?? ""}
              </p>

              {/* What the save gets. Not a live region: the status below speaks. */}
              <div id={summaryId}>
                {parsed?.tooBig ? (
                  <p role="alert" className="text-sm text-neon-pink-text">
                    Whoa, that&apos;s a lot to paste. Over 2 MB? Upload the file instead.
                  </p>
                ) : parsed && sections.length === 0 ? (
                  <p className="text-sm text-neon-pink-text">{NO_SECTIONS_FOUND}</p>
                ) : (
                  <p className="flex flex-wrap items-baseline gap-x-3">
                    <span
                      className={`whitespace-nowrap text-2xl font-semibold tabular-nums ${
                        canSave ? "text-neon-green-text" : "text-ink-3"
                      }`}
                    >
                      {sectionCountText(sections.length)}
                    </span>
                    <span className="whitespace-nowrap text-sm text-ink-2">
                      {cardCountText(parsed?.rowCount ?? 0)}
                    </span>
                  </p>
                )}
              </div>

              {sections.length > 0 && (
                <div className="overflow-clip rounded-md border border-rule">
                  <table className="w-full table-fixed border-separate border-spacing-0 text-left text-sm">
                    <caption className="sr-only">Sections the checklist will save</caption>
                    <colgroup>
                      <col />
                      <col className="w-20" />
                      <col className="w-[38%]" />
                    </colgroup>
                    <thead className="text-xs text-ink-3">
                      <tr>
                        <th scope="col" className={HEAD_CELL}>
                          Section
                        </th>
                        <th scope="col" className={`${HEAD_CELL} text-right`}>
                          Cards
                        </th>
                        <th scope="col" className={HEAD_CELL}>
                          Numbers
                        </th>
                      </tr>
                    </thead>
                    {/* One body per run of sections: a group's heading
                        heads its own body (scope="rowgroup"), so a screen
                        reader reads it with every section beneath it. */}
                    {sectionRuns(sections).map((run) => (
                      <tbody key={run.sections[0].key}>
                        {run.group && (
                          <tr>
                            <th
                              scope="rowgroup"
                              colSpan={3}
                              className="border-b border-rule bg-raised px-3 pb-1 pt-2 text-xs font-semibold text-ink-2"
                            >
                              {run.group}
                            </th>
                          </tr>
                        )}
                        {run.sections.map((section) => (
                          <tr key={section.key} className={BODY_ROW}>
                            <th
                              scope="row"
                              className={`break-words px-3 py-1 align-top font-medium text-ink ${
                                section.group ? "pl-6" : ""
                              }`}
                            >
                              {section.name}
                            </th>
                            <td className="px-3 py-1 text-right align-top tabular-nums text-neon-green-text">
                              {n(section.rows.length)}
                            </td>
                            <td className="break-words px-3 py-1 align-top text-ink-2">
                              {sectionNumbersText(section)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    ))}
                  </table>
                </div>
              )}

              {skippedSections.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-ink-2">
                    Sections left out{" "}
                    <span className="font-normal tabular-nums text-ink-3">
                      ({n(skippedSections.length)})
                    </span>
                  </h3>
                  <ul className="mt-1 space-y-1">
                    {skippedSections.map((s) => (
                      <li key={s.name} className="break-words text-xs">
                        <span className="text-ink">{s.name}</span>{" "}
                        <span className="tabular-nums text-ink-3">({cardCountText(s.rowCount)})</span>{" "}
                        <span className="text-neon-pink-text">{s.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {parsed && !parsed.tooBig && (
                <div>
                  <h3 className="text-sm font-semibold text-ink-2">
                    Skipped lines{" "}
                    <span className="font-normal tabular-nums text-ink-3">
                      ({n(parsed.skipped.length)})
                    </span>
                  </h3>
                  {grouped.length === 0 ? (
                    <p className="mt-1 text-xs text-ink-3">None. Every line made it.</p>
                  ) : (
                    <ul className="mt-1 space-y-1">
                      {grouped.map(({ reason, lines }) => (
                        <li key={reason}>
                          <details className="text-xs">
                            <summary className="cursor-pointer rounded text-ink-2 focus-outline">
                              {reason}{" "}
                              <span className="tabular-nums text-ink-3">({n(lines.length)})</span>
                            </summary>
                            <ul className="mt-1 space-y-0.5 pl-4">
                              {lines.slice(0, SKIPPED_PER_REASON).map((line) => (
                                <li
                                  key={`${line.sheet ?? ""}:${line.line}:${line.page ?? ""}`}
                                  className="break-words"
                                >
                                  <span className="tabular-nums text-ink-3">
                                    Line {line.line}
                                    {line.page !== undefined ? `, page ${line.page}` : ""}
                                    {line.sheet !== undefined ? `, sheet ${line.sheet}` : ""}
                                  </span>{" "}
                                  <span className="text-ink-2">“{line.text.trim()}”</span>
                                </li>
                              ))}
                              {lines.length > SKIPPED_PER_REASON && (
                                <li className="text-ink-3">
                                  …and {n(lines.length - SKIPPED_PER_REASON)} more.
                                </li>
                              )}
                            </ul>
                          </details>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>

          <footer className="flex flex-col gap-2 border-t border-rule-strong px-5 py-3">
            {save.kind === "saving" && (
              <div
                role="progressbar"
                aria-label="Saving the checklist"
                aria-valuemin={0}
                aria-valuemax={save.total}
                aria-valuenow={save.saved}
                aria-valuetext={savingText(save.saved, save.total)}
                className="h-1.5 w-full overflow-hidden rounded-full bg-chip"
              >
                <div
                  className="h-full rounded-full bg-neon-green transition-[width] duration-300 motion-reduce:transition-none"
                  style={{ width: `${save.total === 0 ? 0 : (100 * save.saved) / save.total}%` }}
                />
              </div>
            )}
            {failed && (
              <p id={errorId} role="alert" className="text-sm text-neon-pink-text">
                {failed.failure.message}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {/* The save's progress, said as it moves; the reason a press
                  did nothing, at once. Always mounted. */}
              <p role="status" className="mr-auto text-xs tabular-nums text-ink-2">
                {statusText}
              </p>
              <NeonButton variant="negative" outline onClick={cancelOrStop}>
                {saving ? "Stop saving" : "Cancel"}
              </NeonButton>
              <NeonButton
                onClick={() => {
                  // Held while saving, while a paste is still being read, and
                  // after a refusal only a change to the file can fix. With
                  // nothing to save, the press says so (runSave).
                  if (saving || stale || (failed !== null && !retryable)) return;
                  void runSave(retryable ? (failed?.checkpoint ?? null) : null);
                }}
                aria-disabled={primaryHeld || undefined}
                aria-describedby={failed ? errorId : summaryId}
              >
                {primaryLabel}
              </NeonButton>
            </div>
          </footer>
        </div>
      </div>
    </Theme>,
    document.body,
  );
}

/** The preview's header cell: stuck to the top of the dialog body, opaque. */
const HEAD_CELL =
  "sticky top-0 z-10 border-b border-rule bg-raised-deep px-3 py-1.5 font-medium";
/** A preview row: a rule under every cell but the table's last row's. */
const BODY_ROW =
  "[&>*]:border-b [&>*]:border-rule [tbody:last-child>&:last-child>*]:border-b-0";

/**
 * The sections in runs that share a group, in order: a grouped run is headed
 * by its group, an ungrouped run has no heading. A group that comes back after
 * another section starts a new run, as the file has it.
 */
export function sectionRuns<S extends { group?: string; key: string }>(
  sections: readonly S[],
): Array<{ group?: string; sections: S[] }> {
  const runs: Array<{ group?: string; sections: S[] }> = [];
  for (const section of sections) {
    const last = runs[runs.length - 1];
    if (last && last.group === section.group) last.sections.push(section);
    else runs.push({ group: section.group, sections: [section] });
  }
  return runs;
}

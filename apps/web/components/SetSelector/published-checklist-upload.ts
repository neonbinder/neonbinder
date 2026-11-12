/**
 * NEO-496 — saving a set's publisher checklist: how its sections are split
 * into server calls, the calls themselves (start → addSections × N →
 * finish), and what the operator is told when one is refused.
 *
 * ## Calls
 *
 * Each `addSections` call carries WHOLE sections, never a split one, and
 * stays inside the server's limits (`BATCH_MAX_SECTIONS`, `BATCH_MAX_ROWS`,
 * `BATCH_MAX_BYTES`, the last measured with `storedRowBytes`, the size
 * Convex itself counts). The plan is a pure function of the sections, so a
 * retry plans the same calls again and lands on the same boundaries.
 *
 * ## Replay safety
 *
 * `firstOrdinal` is the number of sections the server has confirmed, never a
 * counter the client bumps on its own: a call the server refused, or one
 * whose answer was lost, is never counted. "Try again" resumes from the last
 * confirmed section on the same upload. If the resumed run's first call is
 * refused (the lost call had in fact landed, so the ordinals no longer line
 * up; or the upload expired), it starts the upload over once: `start`
 * retires the operator's own unfinished upload, so nothing is doubled.
 *
 * ## Copy
 *
 * The server's refusals name its own plumbing ("batch", "rows arrived");
 * `uploadFailure` turns them into what the operator can do: fix the file,
 * or try again. Never shown: the internal words (operator-copy rule).
 */
import { ConvexError } from "convex/values";
import type { Id } from "../../convex/_generated/dataModel";
import {
  BATCH_MAX_BYTES,
  BATCH_MAX_ROWS,
  BATCH_MAX_SECTIONS,
  MAX_CHECKLIST_ROWS,
  MAX_SECTION_ROWS,
  MAX_SECTIONS,
  storedRowBytes,
} from "../../convex/lib/publishedChecklistSections";
import type {
  ChecklistSection,
  ChecklistSectionRow,
} from "@/lib/checklists/checklist-sections";

/** The `format` a stored checklist records. */
export type StoredChecklistFormat = "xlsx" | "pdf" | "csv" | "tsv" | "txt" | "paste";

/** One section as it crosses the wire. */
export type UploadSection = { name: string; group?: string; rows: ChecklistSectionRow[] };

/** One `addSections` call. */
export type ChecklistBatch = {
  firstOrdinal: number;
  sections: UploadSection[];
  rowCount: number;
  byteSize: number;
};

/**
 * A row's size with both flags present: an upper bound on what the server
 * stores for it (its re-check only trims strings and may add a flag), so a
 * call planned within the limit is never over it on the server.
 */
function rowBytes(row: ChecklistSectionRow): number {
  return storedRowBytes({
    number: row.number,
    players: row.players,
    teams: row.teams,
    noNumber: true,
    noTeam: true,
  });
}

/**
 * Split sections, in file order, into calls of whole sections within the
 * server's per-call limits. A section too big for any call on its own gets a
 * call to itself, so the server says which section and why.
 */
export function planChecklistBatches(
  sections: readonly ChecklistSection[],
  limits: { sections?: number; rows?: number; bytes?: number } = {},
): ChecklistBatch[] {
  const maxSections = limits.sections ?? BATCH_MAX_SECTIONS;
  const maxRows = limits.rows ?? BATCH_MAX_ROWS;
  const maxBytes = limits.bytes ?? BATCH_MAX_BYTES;
  const batches: ChecklistBatch[] = [];
  let current: ChecklistBatch | null = null;
  let ordinal = 0;
  for (const section of sections) {
    const bytes = section.rows.reduce((n, r) => n + rowBytes(r), 0);
    const rows = section.rows.length;
    const fits =
      current !== null &&
      current.sections.length < maxSections &&
      current.rowCount + rows <= maxRows &&
      current.byteSize + bytes <= maxBytes;
    if (!fits) {
      current = { firstOrdinal: ordinal, sections: [], rowCount: 0, byteSize: 0 };
      batches.push(current);
    }
    current!.sections.push({
      name: section.name,
      ...(section.group ? { group: section.group } : {}),
      rows: section.rows,
    });
    current!.rowCount += rows;
    current!.byteSize += bytes;
    ordinal += 1;
  }
  return batches;
}

/** The three mutations, as `useMutation` hands them over. */
export type ChecklistUploadApi = {
  start: (args: {
    setId: Id<"selectorOptions">;
    fileName: string;
    format: StoredChecklistFormat;
  }) => Promise<{ checklistId: Id<"publishedChecklists"> }>;
  addSections: (args: {
    checklistId: Id<"publishedChecklists">;
    firstOrdinal: number;
    sections: UploadSection[];
  }) => Promise<{ sectionCount: number; rowCount: number; byteSize: number }>;
  finish: (args: {
    checklistId: Id<"publishedChecklists">;
    sectionCount: number;
    rowCount: number;
  }) => Promise<null>;
};

/** Where an interrupted upload got to: the server's confirmed count. */
export type UploadCheckpoint = {
  checklistId: Id<"publishedChecklists">;
  sectionsSaved: number;
};

export type UploadResult =
  | { ok: true; sectionCount: number; rowCount: number }
  | { ok: false; stopped: true }
  | { ok: false; stopped?: false; error: unknown; checkpoint: UploadCheckpoint | null };

export type UploadOptions = {
  setId: Id<"selectorOptions">;
  fileName: string;
  format: StoredChecklistFormat;
  batches: readonly ChecklistBatch[];
  /** Continue this upload rather than starting a new one ("Try again"). */
  resumeFrom?: UploadCheckpoint | null;
  /** Sections the server has confirmed so far, after every call. */
  onProgress?: (sectionsSaved: number, sectionCount: number) => void;
  /** Checked between calls: true stops the upload (the server expires it). */
  shouldStop?: () => boolean;
};

/**
 * Upload a planned checklist. Never throws: a refusal comes back with the
 * checkpoint to resume from.
 */
export async function uploadChecklist(
  api: ChecklistUploadApi,
  options: UploadOptions,
): Promise<UploadResult> {
  const { batches } = options;
  const sectionCount = batches.reduce((n, b) => n + b.sections.length, 0);
  const rowCount = batches.reduce((n, b) => n + b.rowCount, 0);

  type Attempt =
    | UploadResult
    | { ok: false; firstCallRefused: true };

  const attempt = async (from: UploadCheckpoint | null): Promise<Attempt> => {
    const resuming = from !== null;
    let checkpoint: UploadCheckpoint | null = from;
    let firstCall = true;
    const refused = (error: unknown): Attempt =>
      resuming && firstCall
        ? { ok: false, firstCallRefused: true }
        : { ok: false, error, checkpoint };
    try {
      if (checkpoint === null) {
        const { checklistId } = await api.start({
          setId: options.setId,
          fileName: options.fileName,
          format: options.format,
        });
        checkpoint = { checklistId, sectionsSaved: 0 };
        firstCall = false;
      }
      options.onProgress?.(checkpoint.sectionsSaved, sectionCount);
      const startAt = checkpoint.sectionsSaved;
      // A checkpoint off a call boundary cannot be continued cleanly.
      if (startAt !== sectionCount && !batches.some((b) => b.firstOrdinal === startAt)) {
        return refused(new Error("Checkpoint is off a call boundary"));
      }
      for (const batch of batches) {
        if (batch.firstOrdinal < startAt) continue;
        if (options.shouldStop?.()) return { ok: false, stopped: true };
        const saved = await api.addSections({
          checklistId: checkpoint.checklistId,
          firstOrdinal: batch.firstOrdinal,
          sections: batch.sections,
        });
        firstCall = false;
        checkpoint = { checklistId: checkpoint.checklistId, sectionsSaved: saved.sectionCount };
        options.onProgress?.(saved.sectionCount, sectionCount);
      }
      if (options.shouldStop?.()) return { ok: false, stopped: true };
      await api.finish({ checklistId: checkpoint.checklistId, sectionCount, rowCount });
      return { ok: true, sectionCount, rowCount };
    } catch (error) {
      return refused(error);
    }
  };

  const first = await attempt(options.resumeFrom ?? null);
  if ("firstCallRefused" in first) {
    // The resumed upload no longer lines up: start it over, once.
    const again = await attempt(null);
    return "firstCallRefused" in again ? { ok: false, error: null, checkpoint: null } : again;
  }
  return first;
}

/** What the operator is told about a failed save, and what fixes it. */
export type UploadFailure = {
  message: string;
  /** "retry": Try again resumes. "file": the file needs a change first. */
  fix: "retry" | "file";
};

/** Said when the save broke off partway (lost connection, an expired upload). */
export const SAVE_INTERRUPTED =
  "The save stopped partway. Try again and we'll pick up where it left off.";

const n = (value: number) => value.toLocaleString("en-US");
const FIX_THE_FILE = "Fix it in the file, then upload it again.";

/**
 * Turn a refusal from start / addSections / finish into operator copy. Only
 * a ConvexError's text is ever read (a plain Error is redacted on prod); the
 * server's plumbing words never reach the screen.
 */
export function uploadFailure(error: unknown): UploadFailure {
  if (!(error instanceof ConvexError) || typeof error.data !== "string") {
    return { message: SAVE_INTERRUPTED, fix: "retry" };
  }
  const text = error.data;
  let m: RegExpMatchArray | null;
  // The upload's own bookkeeping: nothing in the file to fix.
  if (/batch|upload|arrived|no sections yet/i.test(text)) {
    return { message: SAVE_INTERRUPTED, fix: "retry" };
  }
  if ((m = text.match(/^Section (“.+”) has (\d+) rows; the limit/))) {
    return {
      message: `${m[1]} has ${n(Number(m[2]))} cards, and one section holds up to ${n(MAX_SECTION_ROWS)}. Split it in the file, then upload it again.`,
      fix: "file",
    };
  }
  if ((m = text.match(/^Section (“.+”) is too large to store/))) {
    return {
      message: `${m[1]} is too big to keep in one piece. Split it in the file, then upload it again.`,
      fix: "file",
    };
  }
  if (/^This checklist is too large to store/.test(text)) {
    return {
      message:
        "This checklist is too big to keep. Leave out the sections this set doesn't need, then upload it again.",
      fix: "file",
    };
  }
  if (/at most \d+ sections/.test(text)) {
    return {
      message: `That's more than ${n(MAX_SECTIONS)} sections, more than one set holds. Upload just this set's checklist.`,
      fix: "file",
    };
  }
  if (/at most \d+ rows/.test(text)) {
    return {
      message: `That's more than ${n(MAX_CHECKLIST_ROWS)} cards, more than one set holds. Upload just this set's checklist.`,
      fix: "file",
    };
  }
  if ((m = text.match(/^Two sections are named (“.+”)/))) {
    return {
      message: `Two sections are named ${m[1]}. Rename one in the file, then upload it again.`,
      fix: "file",
    };
  }
  if (/^A checklist can only be added to a set/.test(text)) {
    return { message: "A checklist goes on a set. Pick the set, then upload it there.", fix: "file" };
  }
  // A row or name the server refused, named by section and row: the
  // server's words are the operator's, plus what to do about it.
  return { message: `${text.replace(/\s*$/, "")} ${FIX_THE_FILE}`, fix: "file" };
}

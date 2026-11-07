import { useEffect, useId, useRef, useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionArgs } from "convex/server";
import CopyButton from "@/components/modules/CopyButton";
import NeonButton from "@/components/modules/NeonButton";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { writeErrorMessage } from "../data/store";
import { RING } from "./ui";

/**
 * The NeonBinder Scanner app, as release.yml publishes it from main (one zip
 * per Mac architecture, its scanner driver inside).
 */
const SCANNER_RELEASE = "https://github.com/neonbinder/neonbinder/releases/download/scanner-latest";
export const SCANNER_DOWNLOADS = {
  arm64: `${SCANNER_RELEASE}/neonbinder-scanner-mac-arm64.zip`,
  x64: `${SCANNER_RELEASE}/neonbinder-scanner-mac-x64.zip`,
} as const;
const DOWNLOAD_LINK = "text-neon-blue-text underline underline-offset-2 hover:decoration-2 focus-outline rounded-sm";

type NewRun = Omit<FunctionArgs<typeof api.intakeRuns.createIntakeRun>, "jobId">;

/** The server's refusal at the active-batch cap, in this screen's words. */
export function startRefusal(reason: string | undefined): string {
  if (reason && /active batch/i.test(reason)) return "You've got too many runs going. Finish one first.";
  if (reason && /in the last/i.test(reason)) return "You've started a lot of runs just now. Try again in a few minutes.";
  return "Couldn't start a run. Try again.";
}

/** What the panel says about the copy nobody pressed a control for (NEO-459). */
const AUTO_COPIED = "Scanner code copied. Paste it into NeonBinder Scanner.";
const AUTO_COPY_REFUSED = "No auto-copy this time. Press Copy scanner code or type the code in by hand.";

/**
 * How long a live region's words wait after focus moves. A screen reader reads
 * the newly focused element first, and VoiceOver can lose words committed in the
 * same tick as the move.
 */
export const SPEECH_AFTER_FOCUS_MS = 400;

/**
 * NEO-459 — puts text that isn't known yet on the clipboard. Answers whether it
 * got there, and never rejects: a failed `text` copies nothing and answers false.
 *
 * Call it synchronously in the click, before anything is awaited. Safari only
 * accepts a clipboard write made inside the user's gesture, and the code lands
 * after mutations, so a `writeText` once it arrives is refused there. A write
 * started in the click with a promise for its contents keeps the gesture and
 * fills in later. Where that is missing or refused, `writeText` gets a go once
 * the code is in hand, which browsers that are looser about the gesture take.
 */
function copyWhenReady(text: Promise<string>): Promise<boolean> {
  let written: Promise<void>;
  try {
    const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
    // The caller reports a failed `text`; a write that never picks this up must not.
    blob.catch(() => {});
    written = navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
  } catch (error) {
    written = Promise.reject(error);
  }
  return written.then(
    () => true,
    async () => {
      try {
        await navigator.clipboard.writeText(await text);
        return true;
      } catch {
        return false;
      }
    },
  );
}

/**
 * NEO-386 — "Use a scanner": the code the scanner script joins this run with
 * (`apps/scanner`, `convex/intakeScanner.ts`). With no run open yet, it starts
 * one first, the way the first dropped photos do, so the collector can load
 * the feeder before any photo exists. Scans then land in the lanes below like
 * dropped photos, each card's two sides already in order.
 *
 * Focus moves to the code once it shows, so a keyboard or screen-reader user
 * hears it; the button stays focusable while busy (`aria-disabled`).
 *
 * NEO-459 — the click also copies the code, and the panel says how that went.
 * The line is one always-mounted live region on the root, which is the same
 * node before and after the panel: a region inserted as its text appears is
 * announced unreliably (see `CopyButton`). Its words wait until a moment after
 * the panel has taken focus, because the focus move would cut off anything said
 * before it or with it (`SPEECH_AFTER_FOCUS_MS`).
 *
 * NEO-416 — held the same way while `loading`: until the homes and the open
 * run have loaded, "no run" and "no home" are not known yet, and a click
 * would start a second run or say to make a home the collector already has.
 */
export function ScannerJoin({
  runId,
  newRun,
  kind,
  loading,
  onRunStarted,
}: {
  runId: Id<"intakeRuns"> | null;
  /** What a run started from here files into; null when there is no home yet. */
  newRun: NewRun | null;
  kind: "binder" | "box";
  /** The homes or the open run are still loading; the button holds. */
  loading: boolean;
  onRunStarted: (runId: Id<"intakeRuns">) => void;
}) {
  const startStream = useMutation(api.placeholderStream.startPlaceholderStream);
  const createRun = useMutation(api.intakeRuns.createIntakeRun);
  const mintCode = useMutation(api.intakeScanner.scannerCodeForIntakeRun);
  const [code, setCode] = useState<{ runId: Id<"intakeRuns">; code: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  /** The clipboard's answer for a code, and the code whose line may now be said. */
  const [clip, setClip] = useState<{ code: string; copied: boolean } | null>(null);
  const [speakFor, setSpeakFor] = useState<string | null>(null);
  /** A press on the icon has the last word: a slower auto-copy must not answer after it. */
  const iconPressed = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const problemId = useId();

  const shown = code && code.runId === runId ? code.code : null;
  useEffect(() => {
    if (!shown) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      panel.current?.focus();
      timer = setTimeout(() => setSpeakFor(shown), SPEECH_AFTER_FOCUS_MS);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [shown]);
  const clipLine =
    shown && speakFor === shown && clip?.code === shown ? (clip.copied ? AUTO_COPIED : AUTO_COPY_REFUSED) : "";

  const requestCode = async () => {
    let id = runId;
    if (!id) {
      if (!newRun) throw new Error(`Make a ${kind} first: the cards need somewhere to go.`);
      const session = await startStream({ source: "scanner" });
      if (!session.started || !session.jobId) throw new Error(startRefusal(session.reason));
      id = await createRun({ ...newRun, jobId: session.jobId });
      onRunStarted(id);
    }
    return { runId: id, code: await mintCode({ runId: id }) };
  };

  const onUse = async () => {
    if (busy || loading) return;
    setBusy(true);
    setProblem("");
    setClip(null);
    iconPressed.current = false;
    // No await before the copy starts: it has to be inside the click (`copyWhenReady`).
    const minted = requestCode();
    const copied = copyWhenReady(minted.then((m) => m.code));
    try {
      const got = await minted;
      setCode(got);
      void copied.then((ok) => {
        if (!iconPressed.current) setClip({ code: got.code, copied: ok });
      });
    } catch (error) {
      setProblem(writeErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={panel}
      tabIndex={shown ? -1 : undefined}
      role={shown ? "group" : undefined}
      aria-labelledby={shown ? labelId : undefined}
      aria-describedby={shown ? `${labelId}-code ${labelId}-how` : undefined}
      className={
        shown
          ? `flex flex-col gap-2 rounded-md border border-rule p-3 text-sm text-ink-2 ${RING}`
          : "flex flex-wrap items-center gap-3 text-sm text-ink-2"
      }
    >
      {shown ? (
        <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span id={labelId}>Scanner code</span>
          <span aria-hidden="true" className="font-mono text-xl font-semibold tracking-widest text-ink">
            {shown.slice(0, 3)} {shown.slice(3)}
          </span>
          <span id={`${labelId}-code`} className="sr-only">
            {shown.split("").join(" ")}
          </span>
          {/* Copies the bare code (the app ignores the space). A press takes over
              from the line below, which would otherwise stand there out of date. */}
          <span
            onClickCapture={() => {
              iconPressed.current = true;
              setClip(null);
            }}
          >
            <CopyButton
              variant="icon"
              size="touch"
              tone="blue"
              value={shown}
              copyLabel="Copy scanner code"
              copiedMessage={AUTO_COPIED}
              failedMessage="Couldn't reach your clipboard. Type the code in by hand."
            />
          </span>
        </p>
      ) : (
        <>
          <NeonButton
            variant="secondary"
            outline
            aria-disabled={busy || loading}
            aria-describedby={problem ? problemId : undefined}
            onClick={() => void onUse()}
          >
            {busy ? "Getting a code…" : "Use a scanner"}
          </NeonButton>
          <span>Got a scanner with a feeder? Get a code and its cards land right here.</span>
          {problem && (
            <span id={problemId} role="alert" className="text-neon-pink-text">
              {problem}
            </span>
          )}
        </>
      )}
      {/* One node for both looks (see above): out of the row's flow while empty. */}
      <p role="status" aria-live="polite" className={clipLine ? "m-0" : "sr-only"}>
        {clipLine}
      </p>
      {shown && (
        <>
          <p id={`${labelId}-how`} className="m-0">
            Type or paste this code in NeonBinder Scanner on the Mac the scanner is plugged into. Cards land here as they feed.
          </p>
          <p className="m-0">
            <strong className="font-semibold text-ink">First time?</strong> On that Mac, download NeonBinder Scanner
            for an{" "}
            <a className={DOWNLOAD_LINK} href={SCANNER_DOWNLOADS.arm64}>
              Apple chip<span className="sr-only"> (downloads a zip)</span>
            </a>{" "}
            or an{" "}
            <a className={DOWNLOAD_LINK} href={SCANNER_DOWNLOADS.x64}>
              Intel chip<span className="sr-only"> (downloads a zip)</span>
            </a>{" "}
            Mac (Apple menu, About This Mac: &ldquo;Chip&rdquo; means Apple, &ldquo;Processor&rdquo; means Intel). Open the
            zip and double-click the app. If macOS blocks it, go to System Settings, Privacy &amp; Security, and press Open
            Anyway. The first time, it asks for an{" "}
            <a className={DOWNLOAD_LINK} href="/profile/api-keys" target="_blank" rel="noopener">
              API key<span className="sr-only"> (opens in a new tab)</span>
            </a>
            .
          </p>
        </>
      )}
    </div>
  );
}

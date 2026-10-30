import { useEffect, useId, useRef, useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionArgs } from "convex/server";
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
const DOWNLOAD_LINK = "text-neon-teal-text hover:decoration-2 underline focus-outline rounded-sm";

type NewRun = Omit<FunctionArgs<typeof api.intakeRuns.createIntakeRun>, "jobId">;

/** The server's refusal at the active-batch cap, in this screen's words. */
export function startRefusal(reason: string | undefined): string {
  if (reason && /active batch/i.test(reason)) return "You've got too many runs going. Finish one first.";
  if (reason && /in the last/i.test(reason)) return "You've started a lot of runs just now. Try again in a few minutes.";
  return "Couldn't start a run. Try again.";
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
 */
export function ScannerJoin({
  runId,
  newRun,
  kind,
  onRunStarted,
}: {
  runId: Id<"intakeRuns"> | null;
  /** What a run started from here files into; null when there is no home yet. */
  newRun: NewRun | null;
  kind: "binder" | "box";
  onRunStarted: (runId: Id<"intakeRuns">) => void;
}) {
  const startStream = useMutation(api.placeholderStream.startPlaceholderStream);
  const createRun = useMutation(api.intakeRuns.createIntakeRun);
  const mintCode = useMutation(api.intakeScanner.scannerCodeForIntakeRun);
  const [code, setCode] = useState<{ runId: Id<"intakeRuns">; code: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const problemId = useId();

  const shown = code && code.runId === runId ? code.code : null;
  useEffect(() => {
    if (shown) requestAnimationFrame(() => panel.current?.focus());
  }, [shown]);

  const onUse = async () => {
    if (busy) return;
    setBusy(true);
    setProblem("");
    try {
      let id = runId;
      if (!id) {
        if (!newRun) {
          setProblem(`Make a ${kind} first: the cards need somewhere to go.`);
          return;
        }
        const session = await startStream({ source: "scanner" });
        if (!session.started || !session.jobId) {
          setProblem(startRefusal(session.reason));
          return;
        }
        id = await createRun({ ...newRun, jobId: session.jobId });
        onRunStarted(id);
      }
      setCode({ runId: id, code: await mintCode({ runId: id }) });
    } catch (error) {
      setProblem(writeErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  if (shown) {
    return (
      <div
        ref={panel}
        tabIndex={-1}
        role="group"
        aria-labelledby={labelId}
        className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-rule p-3 text-sm text-ink-2 ${RING}`}
      >
        <p className="m-0 flex items-baseline gap-2">
          <span id={labelId}>Scanner code</span>
          <span aria-hidden="true" className="font-mono text-xl font-semibold tracking-widest text-ink">
            {shown.slice(0, 3)} {shown.slice(3)}
          </span>
          <span className="sr-only">{shown.split("").join(" ")}</span>
        </p>
        <p className="m-0">
          On the scanner&apos;s computer, open NeonBinder Scanner and type this code. Cards land here as they feed.
        </p>
        <p className="m-0">
          Don&apos;t have it yet? Download for a Mac with an{" "}
          <a className={DOWNLOAD_LINK} href={SCANNER_DOWNLOADS.arm64}>
            Apple chip
          </a>{" "}
          or an{" "}
          <a className={DOWNLOAD_LINK} href={SCANNER_DOWNLOADS.x64}>
            Intel chip
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-ink-2">
      <NeonButton
        variant="secondary"
        outline
        aria-disabled={busy}
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
    </div>
  );
}

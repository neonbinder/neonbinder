import { useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionArgs } from "convex/server";
import NeonButton from "@/components/modules/NeonButton";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { writeErrorMessage } from "../data/store";

type NewRun = Omit<FunctionArgs<typeof api.intakeRuns.createIntakeRun>, "jobId">;

/**
 * NEO-386 — "Use a scanner": the code the scanner script joins this run with
 * (`apps/scanner`, `convex/intakeScanner.ts`). With no run open yet, it starts
 * one first, the way the first dropped photos do, so the collector can load
 * the feeder before any photo exists. Scans then land in the lanes below like
 * dropped photos, each card's two sides already in order.
 */
export function ScannerJoin({
  runId,
  newRun,
  onRunStarted,
}: {
  runId: Id<"intakeRuns"> | null;
  /** What a run started from here files into; null when there is no home yet. */
  newRun: NewRun | null;
  onRunStarted: (runId: Id<"intakeRuns">) => void;
}) {
  const startStream = useMutation(api.placeholderStream.startPlaceholderStream);
  const createRun = useMutation(api.intakeRuns.createIntakeRun);
  const mintCode = useMutation(api.intakeScanner.scannerCodeForIntakeRun);
  const [code, setCode] = useState<{ runId: Id<"intakeRuns">; code: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  const shown = code && code.runId === runId ? code.code : null;

  const onUse = async () => {
    setBusy(true);
    setProblem("");
    try {
      let id = runId;
      if (!id) {
        if (!newRun) {
          setProblem("Pick where the cards go first.");
          return;
        }
        const session = await startStream({ source: "scanner" });
        if (!session.started || !session.jobId) {
          setProblem(`Couldn't start a run: ${session.reason ?? "try again"}.`);
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-rule p-3 text-sm text-ink-2">
        <p className="m-0 flex items-baseline gap-2">
          <span>Scanner code</span>
          <span
            className="font-mono text-xl font-semibold tracking-widest text-ink"
            aria-label={`Scanner code ${shown.split("").join(" ")}`}
          >
            {shown.slice(0, 3)} {shown.slice(3)}
          </span>
        </p>
        <p className="m-0">
          On the scanner&apos;s computer, in <code>apps/scanner</code>, run <code>npm run scan {shown}</code>.
          Cards show up here as they feed.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-ink-2">
      <NeonButton variant="secondary" outline disabled={busy} onClick={() => void onUse()}>
        {busy ? "Getting a code…" : "Use a scanner"}
      </NeonButton>
      <span>Feeding cards through a scanner? Get a code to join this run from it.</span>
      {problem && (
        <span role="alert" className="text-neon-pink-text">
          {problem}
        </span>
      )}
    </div>
  );
}

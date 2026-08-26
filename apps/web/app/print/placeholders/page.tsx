import { useQuery } from "convex/react";
import { Squares2X2Icon } from "@heroicons/react/24/outline";
import { Link, useSearchParams } from "react-router";
import { api } from "@/convex/_generated/api";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import CardIntake from "./intake";

/**
 * /print/placeholders — the Print Shop's placeholder tool (NEO-146).
 *
 * Upload photos, watch them crop and pair, correct what the matcher got wrong,
 * print the sheet. One control takes either a zip or loose images; see
 * ./intake.tsx.
 *
 * ## The numbered-rectangle tool is gone
 * NEO-157 shipped a sheet of numbered blanks here, and said so in its own
 * header: "NEO-152 will fill these pockets with real card images". It was
 * scaffolding — a way to answer the paper questions (does a cut card fit the
 * pocket, does the duplexer land the back on the right front) before there were
 * any cards to print. Real cards answer them directly now: card 1's front must
 * have card 1's BACK behind it, which you can read off the printed sheet
 * without needing a number on it.
 *
 * ## Resuming
 * A batch runs for minutes. `?jobId=` makes one addressable, and the "recent
 * runs" list below covers the case the URL cannot — arriving at the page with
 * no query string and still finding the run you left. Both are needed: the URL
 * is what a reload and the E2E entry point rely on, the list is what a human
 * coming back to the tool relies on.
 */

/** Recent runs are a resume affordance, not history — a handful is plenty. */
const RECENT_RUN_LIMIT = 8;

function statusLabel(job: {
  status: string;
  totalImages: number;
  processedImages: number;
  failedImages: number;
}): string {
  if (job.status === "succeeded") {
    const failed = job.failedImages > 0 ? `, ${job.failedImages} failed` : "";
    return `Finished — ${job.processedImages} of ${job.totalImages} images${failed}`;
  }
  if (job.status === "failed") return "Failed";
  if (job.status === "canceled") return "Canceled";
  if (job.totalImages > 0) {
    return `${job.status} — ${job.processedImages} of ${job.totalImages}`;
  }
  return job.status;
}

function RecentRuns() {
  const [searchParams] = useSearchParams();
  const openJobId = searchParams.get("jobId");
  const runs = useQuery(api.placeholderPipeline.listMyPlaceholderJobs, {
    limit: RECENT_RUN_LIMIT,
  });

  // Undefined is "still loading" and empty is "you have never run one". Neither
  // deserves a section: a spinner here would flash on every page load, and an
  // empty list is noise in front of someone who has not uploaded anything yet.
  if (runs === undefined || runs.length === 0) return null;

  return (
    <section aria-labelledby="recent-runs-heading" className="space-y-2">
      <h3 id="recent-runs-heading" className="text-lg font-semibold">
        Recent runs
      </h3>
      <ul className="space-y-1 text-sm list-none p-0">
        {runs.map((run) => {
          const isOpen = run.jobId === openJobId;
          return (
            <li key={run.jobId} className="flex flex-wrap items-baseline gap-2">
              {/* A link, not a button: a run IS a URL, so it should be
                  middle-clickable and bookmarkable like one. */}
              <Link
                to={`/print/placeholders?jobId=${run.jobId}`}
                className="text-neon-blue underline"
                aria-current={isOpen ? "true" : undefined}
              >
                {run.jobId.slice(0, 8)}
              </Link>
              <span className="text-slate-400">{statusLabel(run)}</span>
              {/* `active` is computed server-side from the same ACTIVE_STATUSES
                  the batch caps use, so this badge and the server's "you already
                  have N active batches" refusal can never disagree. */}
              {run.active && (
                <span className="text-xs text-neon-green">running</span>
              )}
              {isOpen && <span className="text-xs text-slate-500">(open)</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function PlaceholderSheetsPage() {
  useDocumentTitle("Placeholder Sheets | Neon Binder");

  return (
    <div className="space-y-12 py-8 px-4">
      <div className="text-center">
        <Squares2X2Icon className="w-16 h-16 text-neon-purple mx-auto mb-4" />
        {/* h2, not h1: the "Print Shop" h1 lives in PrintLayout (NEO-145). */}
        <h2 className="text-3xl font-bold mb-2">Placeholder Sheets</h2>
        <p className="text-gray-400 max-w-xl mx-auto">
          Fill a 9-pocket binder page with cards that live somewhere else.
          Upload photos, check the pairs, print a sheet to cut up.
        </p>
      </div>

      <CardIntake />

      <RecentRuns />
    </div>
  );
}

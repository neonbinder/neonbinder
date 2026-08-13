import React, { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Button, Input } from "@/components/primitives";
import { contrastRatio, normalizeHexColor } from "@/lib/print/contrast";

/**
 * NEO-147 — the team colors worklist, on the Set Builder admin page.
 *
 * Spine labels print a player's name in team colors, and `teams.colors` was
 * populated on 0 of 58 prod rows. The backfill
 * (`convex/teamColorSources.ts`) closes most of that gap automatically, but
 * two cases need a human and this is where they land:
 *
 *  - **Ambiguous.** A name matched several source pages — the site carries 10+
 *    distinct "Huskies" — so the backfill parked the candidates instead of
 *    guessing. Picking one here resolves it exactly as an automatic match
 *    would, provenance included, so the next backfill pass skips it.
 *  - **Missing.** No source will ever carry Estrellas Orientales. Typing two
 *    hex values is the fix, and it is permanent: a row with colors leaves the
 *    worklist for good.
 *
 * Everything here is admin-gated twice over — every mutation and action calls
 * `requireAdmin`, and `AdminLayout` keeps non-admins off the page entirely.
 */

type Team = Doc<"teams">;

/** Mirrors the server-side batch cap, for the button's explanatory text. */
const ENRICH_BATCH = 50;

function ColorSwatch({ hex, label }: { hex?: string; label: string }) {
  return (
    <span
      className="inline-block h-4 w-4 rounded border border-slate-600 align-middle"
      style={{ background: hex ?? "transparent" }}
      title={hex ? `${label}: ${hex}` : `${label}: not set`}
      aria-label={hex ? `${label} ${hex}` : `${label} not set`}
      role="img"
    />
  );
}

/**
 * Manual hex entry for one team.
 *
 * Local state rather than a controlled value fed from the query: the row is
 * live (Convex pushes updates), and binding the inputs straight to it would
 * drop keystrokes when an unrelated update landed mid-edit.
 */
function ManualColorRow({ team }: { team: Team }) {
  const saveTeamFields = useMutation(api.teams.saveTeamFields);
  const enrichFromWikidata = useAction(api.teams.enrichFromWikidata);

  const [primary, setPrimary] = useState(team.colors?.primary ?? "");
  const [secondary, setSecondary] = useState(team.colors?.secondary ?? "");
  const [busy, setBusy] = useState<null | "save" | "discover">(null);
  const [error, setError] = useState<string | null>(null);

  const normalizedPrimary = normalizeHexColor(primary);
  const normalizedSecondary = secondary ? normalizeHexColor(secondary) : null;
  const canSave = normalizedPrimary !== null && (!secondary || normalizedSecondary);

  const ratio =
    normalizedPrimary && normalizedSecondary
      ? contrastRatio(normalizedSecondary, normalizedPrimary)
      : null;

  const save = async () => {
    if (!canSave) return;
    setBusy("save");
    setError(null);
    try {
      await saveTeamFields({
        id: team._id,
        colors: {
          primary: normalizedPrimary!,
          secondary: normalizedSecondary ?? undefined,
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(null);
    }
  };

  /**
   * Re-run every source for this one team. Best-effort by design: the action
   * swallows source errors, so the row simply updates or does not. An
   * unchanged row IS the "found nothing" signal.
   */
  const discover = async () => {
    setBusy("discover");
    setError(null);
    try {
      await enrichFromWikidata({ id: team._id });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Discovery failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="rounded-md border border-slate-800 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <ColorSwatch hex={team.colors?.primary} label="Primary" />
        <ColorSwatch hex={team.colors?.secondary} label="Secondary" />
        <span className="text-sm font-medium">{team.name}</span>
        {team.league && (
          <span className="text-xs text-slate-500">{team.league}</span>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Input
          label="Primary"
          value={primary}
          placeholder="#01214b"
          onChange={(e) => setPrimary(e.target.value)}
          className="w-32"
        />
        <Input
          label="Secondary"
          value={secondary}
          placeholder="#ffffff"
          onChange={(e) => setSecondary(e.target.value)}
          className="w-32"
        />
        <Button
          type="button"
          variant="primary"
          onClick={save}
          disabled={!canSave || busy !== null}
        >
          {busy === "save" ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={discover}
          disabled={busy !== null}
        >
          {busy === "discover" ? "Searching…" : "Discover"}
        </Button>
      </div>

      {ratio !== null && (
        <p className="text-xs text-slate-500">
          Contrast {ratio.toFixed(1)}:1
        </p>
      )}
      {error && (
        <p className="text-xs text-neon-pink" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** One ambiguous team: pick which source page is actually this team. */
function CandidateRow({ team }: { team: Team }) {
  const chooseColorSource = useAction(api.teamColorSources.chooseColorSource);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (url: string) => {
    setBusy(url);
    setError(null);
    try {
      const outcome = await chooseColorSource({ teamId: team._id, url });
      if (outcome === "unreadable") {
        setError("That page did not yield colors. Try another, or enter them by hand.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not apply that source");
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="rounded-md border border-slate-800 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{team.name}</span>
        <span className="text-xs text-slate-500">
          {team.colorCandidates?.length} possible matches
        </span>
      </div>
      <ul className="flex flex-wrap gap-2">
        {(team.colorCandidates ?? []).map((candidate) => (
          <li key={candidate.url}>
            <Button
              type="button"
              variant="outline"
              onClick={() => choose(candidate.url)}
              disabled={busy !== null}
            >
              {busy === candidate.url ? "Applying…" : candidate.name}
            </Button>
          </li>
        ))}
      </ul>
      {error && (
        <p className="text-xs text-neon-pink" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export default function TeamColorAdmin({
  sportId,
}: {
  sportId?: Id<"selectorOptions">;
}) {
  const review = useQuery(api.teams.listColorReview, sportId ? { sportId } : {});
  const indexStatus = useQuery(api.teamColorSources.indexStatus);
  const refreshIndex = useAction(api.teamColorSources.refreshIndex);
  const enrichUnenriched = useMutation(api.teams.enrichUnenrichedTeams);

  const [refreshing, setRefreshing] = useState(false);
  const [enqueueing, setEnqueueing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleRefresh = async () => {
    setRefreshing(true);
    setMessage(null);
    try {
      const result = await refreshIndex();
      setMessage(
        result.indexed === 0
          ? "Could not reach the color source — the existing index was left alone."
          : `Indexed ${result.indexed} pages (${result.removed} stale removed).`,
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  };

  const handleEnrich = async () => {
    setEnqueueing(true);
    setMessage(null);
    try {
      const { enqueued } = await enrichUnenrichedTeamsArgs(enrichUnenriched, sportId);
      setMessage(
        enqueued === 0
          ? "Nothing left to enrich."
          : `Queued ${enqueued} teams. They resolve one at a time over the next few minutes.`,
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not queue teams");
    } finally {
      setEnqueueing(false);
    }
  };

  if (review === undefined) return null;

  const nothingToDo =
    review.ambiguous.length === 0 && review.missing.length === 0;

  return (
    <section className="mb-8 p-4 rounded-lg border border-neon-purple/40 bg-neon-purple/5 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-neon-purple">Team Colors</h2>
        <p className="text-sm text-slate-400">
          Spine labels print in team colors. {review.resolvedCount} of{" "}
          {review.totalCount} teams have them.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh color index"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={handleEnrich}
          disabled={enqueueing || (indexStatus?.count ?? 0) === 0}
        >
          {enqueueing ? "Queueing…" : `Enrich up to ${ENRICH_BATCH} teams`}
        </Button>
        <span className="text-xs text-slate-500">
          {indexStatus === undefined
            ? ""
            : indexStatus.count === 0
              ? "Index is empty — refresh it first."
              : `${indexStatus.count} source pages indexed.`}
        </span>
      </div>

      {message && (
        <p className="text-sm text-slate-300" role="status">
          {message}
        </p>
      )}

      {nothingToDo ? (
        <p className="text-sm text-slate-400">
          Every team has colors or a resolved source. Nothing to review.
        </p>
      ) : (
        <>
          {review.ambiguous.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-slate-300">
                Ambiguous — pick the right team ({review.ambiguous.length})
              </h3>
              <ul className="space-y-2">
                {review.ambiguous.map((team) => (
                  <CandidateRow key={team._id} team={team} />
                ))}
              </ul>
            </div>
          )}

          {review.missing.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-slate-300">
                No colors yet ({review.missing.length})
              </h3>
              <ul className="space-y-2">
                {review.missing.map((team) => (
                  <ManualColorRow key={team._id} team={team} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Convex mutations reject an explicit `undefined` in an optional arg, so the
 * key has to be absent rather than present-and-undefined.
 */
function enrichUnenrichedTeamsArgs(
  enrich: (args: { sportId?: Id<"selectorOptions"> }) => Promise<{ enqueued: number }>,
  sportId?: Id<"selectorOptions">,
) {
  return sportId ? enrich({ sportId }) : enrich({});
}

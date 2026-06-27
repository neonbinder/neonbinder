import { useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import NeonButton from "../modules/NeonButton";

const CONFIRM_PHRASE = "RESET";

type Status =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "running" }
  | {
      kind: "success";
      selectorOptionsDeleted: number;
      cardChecklistDeleted: number;
    }
  | { kind: "error"; message: string };

type WipeBaseStatus =
  | { kind: "idle" }
  | { kind: "running" }
  | {
      kind: "success";
      baseVariantTypesScanned: number;
      insertsDeleted: number;
      parallelsDeleted: number;
      cardChecklistRowsDeleted: number;
    }
  | { kind: "error"; message: string };

type SeedTeamsStatus =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "success"; created: number; existing: number }
  | { kind: "error"; message: string };

/**
 * Admin-only section on the Set Builder page for destructive dev
 * utilities. Today: "Reset Set Builder Data" — wipes every row in
 * selectorOptions and cardChecklist so a fresh sync rebuilds the
 * legitimate marketplace-sourced rows. The underlying mutation is
 * guarded by requireAdmin; this UI is additionally hidden from
 * non-admins by AdminLayout.
 */
export default function AdminTools() {
  const resetSetBuilderData = useAction(
    api.selectorOptions.resetSetBuilderData,
  );
  const wipeLegacyBaseChildren = useMutation(
    api.selectorOptions.wipeLegacyBaseChildren,
  );
  const seedTestTeams = useMutation(api.teams.seedTestTeams);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [confirmInput, setConfirmInput] = useState("");
  const [wipeBaseStatus, setWipeBaseStatus] = useState<WipeBaseStatus>({
    kind: "idle",
  });
  const [seedTeamsStatus, setSeedTeamsStatus] = useState<SeedTeamsStatus>({
    kind: "idle",
  });

  const handleSeedTestTeams = async () => {
    setSeedTeamsStatus({ kind: "running" });
    try {
      const result = await seedTestTeams();
      setSeedTeamsStatus({ kind: "success", ...result });
    } catch (error) {
      setSeedTeamsStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  const handleWipeBase = async () => {
    setWipeBaseStatus({ kind: "running" });
    try {
      const result = await wipeLegacyBaseChildren();
      setWipeBaseStatus({ kind: "success", ...result });
    } catch (error) {
      setWipeBaseStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  const confirmMatches = confirmInput.trim().toUpperCase() === CONFIRM_PHRASE;

  const handleStart = () => {
    setConfirmInput("");
    setStatus({ kind: "confirming" });
  };

  const handleCancel = () => {
    setConfirmInput("");
    setStatus({ kind: "idle" });
  };

  const handleConfirm = async () => {
    if (!confirmMatches) return;
    setStatus({ kind: "running" });
    try {
      const result = await resetSetBuilderData();
      setConfirmInput("");
      setStatus({
        kind: "success",
        selectorOptionsDeleted: result.selectorOptionsDeleted,
        cardChecklistDeleted: result.cardChecklistDeleted,
      });
    } catch (error) {
      setStatus({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  return (
    <section className="mb-8 p-4 rounded-lg border border-neon-orange/40 bg-neon-orange/5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-neon-orange">
            Admin Tools
          </h2>
          <p className="text-sm text-gray-400 mt-1">
            Destructive utilities for development. Not visible to non-admin
            users.
          </p>
        </div>
        {status.kind !== "confirming" && status.kind !== "running" && (
          <div className="flex gap-2 flex-wrap">
            <NeonButton
              secondary
              onClick={handleSeedTestTeams}
              disabled={seedTeamsStatus.kind === "running"}
            >
              {seedTeamsStatus.kind === "running"
                ? "Seeding…"
                : "Seed Test Teams"}
            </NeonButton>
            <NeonButton
              secondary
              onClick={handleWipeBase}
              disabled={wipeBaseStatus.kind === "running"}
            >
              {wipeBaseStatus.kind === "running"
                ? "Wiping…"
                : "Wipe Legacy Base Children"}
            </NeonButton>
            <NeonButton cancel onClick={handleStart}>
              Reset Set Builder Data
            </NeonButton>
          </div>
        )}
      </div>

      {seedTeamsStatus.kind === "success" && (
        <div className="mt-4 p-3 rounded-md bg-green-950/40 border border-green-800 text-green-200 text-sm">
          Seed complete: created {seedTeamsStatus.created} new team(s),{" "}
          {seedTeamsStatus.existing} already existed.
          <button
            type="button"
            onClick={() => setSeedTeamsStatus({ kind: "idle" })}
            className="ml-3 underline text-green-300 hover:text-green-200"
          >
            Dismiss
          </button>
        </div>
      )}

      {seedTeamsStatus.kind === "error" && (
        <div className="mt-4 p-3 rounded-md bg-red-950/40 border border-red-800 text-red-200 text-sm">
          Seed failed: {seedTeamsStatus.message}
          <button
            type="button"
            onClick={() => setSeedTeamsStatus({ kind: "idle" })}
            className="ml-3 underline text-red-300 hover:text-red-200"
          >
            Dismiss
          </button>
        </div>
      )}

      {wipeBaseStatus.kind === "success" && (
        <div className="mt-4 p-3 rounded-md bg-green-950/40 border border-green-800 text-green-200 text-sm">
          Wipe complete: scanned {wipeBaseStatus.baseVariantTypesScanned} Base
          variantType row(s); deleted {wipeBaseStatus.insertsDeleted} insert(s),{" "}
          {wipeBaseStatus.parallelsDeleted} parallel(s), and{" "}
          {wipeBaseStatus.cardChecklistRowsDeleted} card checklist row(s).
          <button
            type="button"
            onClick={() => setWipeBaseStatus({ kind: "idle" })}
            className="ml-3 underline text-green-300 hover:text-green-200"
          >
            Dismiss
          </button>
        </div>
      )}

      {wipeBaseStatus.kind === "error" && (
        <div className="mt-4 p-3 rounded-md bg-red-950/40 border border-red-800 text-red-200 text-sm">
          Wipe failed: {wipeBaseStatus.message}
          <button
            type="button"
            onClick={() => setWipeBaseStatus({ kind: "idle" })}
            className="ml-3 underline text-red-300 hover:text-red-200"
          >
            Dismiss
          </button>
        </div>
      )}

      {status.kind === "confirming" && (
        <div className="mt-4 p-4 rounded-md bg-red-950/40 border border-red-800">
          <p className="text-sm text-red-200 mb-3">
            This will delete <strong>every</strong> row in{" "}
            <code>selectorOptions</code> and <code>cardChecklist</code>. The
            next Sync Sports run will rebuild the legitimate marketplace
            data. Type <code className="text-neon-orange">RESET</code> to
            confirm.
          </p>
          <input
            type="text"
            value={confirmInput}
            onChange={(e) => setConfirmInput(e.target.value)}
            placeholder="Type RESET"
            autoFocus
            className="w-full p-2 mb-3 border rounded-md bg-gray-900 border-gray-700 text-white focus:outline-none focus:border-neon-orange"
          />
          <div className="flex gap-2">
            <NeonButton
              cancel
              disabled={!confirmMatches}
              onClick={handleConfirm}
            >
              Delete Everything
            </NeonButton>
            <NeonButton secondary onClick={handleCancel}>
              Cancel
            </NeonButton>
          </div>
        </div>
      )}

      {status.kind === "running" && (
        <div className="mt-4 p-3 rounded-md bg-gray-800 text-gray-200 text-sm">
          Resetting Set Builder data…
        </div>
      )}

      {status.kind === "success" && (
        <div className="mt-4 p-3 rounded-md bg-green-950/40 border border-green-800 text-green-200 text-sm">
          Deleted {status.selectorOptionsDeleted} selector options and{" "}
          {status.cardChecklistDeleted} card checklist rows.
          <button
            type="button"
            onClick={() => setStatus({ kind: "idle" })}
            className="ml-3 underline text-green-300 hover:text-green-200"
          >
            Dismiss
          </button>
        </div>
      )}

      {status.kind === "error" && (
        <div className="mt-4 p-3 rounded-md bg-red-950/40 border border-red-800 text-red-200 text-sm">
          Reset failed: {status.message}
          <button
            type="button"
            onClick={() => setStatus({ kind: "idle" })}
            className="ml-3 underline text-red-300 hover:text-red-200"
          >
            Dismiss
          </button>
        </div>
      )}
    </section>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import NeonButton from "../modules/NeonButton";

type UnknownEntitiesDialogProps = {
  isOpen: boolean;
  unknownPlayers: string[];
  unknownTeams: string[];
  sport: string;
  /**
   * Confirmation callback. Receives only the names the user kept toggled
   * on; skipped names are dropped silently. The parent calls
   * commitCardChecklist with these arrays + the original preview cards.
   */
  onConfirm: (confirmedPlayers: string[], confirmedTeams: string[]) => void;
  onCancel: () => void;
  /**
   * Set true while commitCardChecklist is in flight. Disables the buttons
   * and shows a "Saving..." label so the user can't double-submit.
   */
  saving?: boolean;
};

/**
 * Modal that prompts the user to confirm or skip each new player and
 * team name surfaced by a checklist fetch. Per the user's requirement,
 * unknowns must be confirmed before the entities are written to the
 * `players` / `teams` tables. Skipped names stay as free-text on the
 * card (`team`) but never spawn an entity row.
 *
 * Keyboard model (per feedback_keyboard_navigation.md):
 *   Enter   — confirm-all-currently-included and submit
 *   Escape  — cancel without persisting
 *   Space   — toggle the focused row's include checkbox
 *   Tab     — cycles through rows + footer buttons
 *
 * Wikidata enrichment runs as a non-blocking follow-up scheduled by
 * commitCardChecklist; this dialog does NOT wait for SPARQL.
 */
export default function UnknownEntitiesDialog({
  isOpen,
  unknownPlayers,
  unknownTeams,
  sport,
  onConfirm,
  onCancel,
  saving,
}: UnknownEntitiesDialogProps) {
  const [includedPlayers, setIncludedPlayers] = useState<Set<string>>(new Set());
  const [includedTeams, setIncludedTeams] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  // Initialize "included" sets when dialog opens. All unknowns are
  // confirmed by default — the common case is that BSC's name strings
  // are correct and the user just clicks Enter.
  useEffect(() => {
    if (!isOpen) return;
    setIncludedPlayers(new Set(unknownPlayers));
    setIncludedTeams(new Set(unknownTeams));
  }, [isOpen, unknownPlayers, unknownTeams]);

  // Focus the primary action on open so Enter immediately works without
  // requiring the user to Tab first.
  useEffect(() => {
    if (isOpen) confirmButtonRef.current?.focus();
  }, [isOpen]);

  // Global Escape / Enter handling. Enter only triggers when focus is
  // on the dialog's confirm button or outside any text input — prevents
  // accidental submissions while editing.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!saving) onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onCancel, saving]);

  const handleConfirm = () => {
    if (saving) return;
    onConfirm(
      unknownPlayers.filter((p) => includedPlayers.has(p)),
      unknownTeams.filter((t) => includedTeams.has(t)),
    );
  };

  const togglePlayer = (name: string) => {
    setIncludedPlayers((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const toggleTeam = (name: string) => {
    setIncludedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const totalIncluded = useMemo(
    () => includedPlayers.size + includedTeams.size,
    [includedPlayers, includedTeams],
  );
  const totalUnknown = unknownPlayers.length + unknownTeams.length;

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="unknown-entities-title"
    >
      <div
        ref={containerRef}
        className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl w-full max-w-3xl max-h-[80vh] flex flex-col"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !((e.target as HTMLElement)?.tagName === "INPUT")) {
            e.preventDefault();
            handleConfirm();
          }
        }}
      >
        {/* Header */}
        <div className="px-6 py-4 border-t-0 border-x-0 border-b border-gray-700 flex items-center justify-between">
          <div>
            <h2
              id="unknown-entities-title"
              className="text-lg font-semibold text-gray-100"
            >
              Confirm New Players &amp; Teams
            </h2>
            <p className="text-xs text-gray-400 mt-0.5">
              The fetch found {totalUnknown} {totalUnknown === 1 ? "name" : "names"} we don't have yet for {sport}. Uncheck any that look wrong before confirming.
            </p>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
          <section>
            <h3 className="text-sm font-semibold text-gray-200 mb-2">
              New Players ({unknownPlayers.length})
            </h3>
            {unknownPlayers.length === 0 ? (
              <div className="text-xs text-gray-500 italic">
                No new players in this fetch.
              </div>
            ) : (
              <ul className="space-y-1">
                {unknownPlayers.map((name) => {
                  const included = includedPlayers.has(name);
                  return (
                    <li key={name}>
                      <label
                        className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm ${
                          included
                            ? "bg-gray-800 text-gray-100"
                            : "bg-gray-800/40 text-gray-500 line-through"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={included}
                          onChange={() => togglePlayer(name)}
                          className="accent-[#00D558]"
                        />
                        <span className="truncate">{name}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section>
            <h3 className="text-sm font-semibold text-gray-200 mb-2">
              New Teams ({unknownTeams.length})
            </h3>
            {unknownTeams.length === 0 ? (
              <div className="text-xs text-gray-500 italic">
                No new teams in this fetch.
              </div>
            ) : (
              <ul className="space-y-1">
                {unknownTeams.map((name) => {
                  const included = includedTeams.has(name);
                  return (
                    <li key={name}>
                      <label
                        className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm ${
                          included
                            ? "bg-gray-800 text-gray-100"
                            : "bg-gray-800/40 text-gray-500 line-through"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={included}
                          onChange={() => toggleTeam(name)}
                          className="accent-[#00D558]"
                        />
                        <span className="truncate">{name}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-700 flex items-center justify-between gap-3">
          <div className="text-xs text-gray-400">
            {totalIncluded} of {totalUnknown} will be created. Skipped names stay
            as free text on the card.
          </div>
          <div className="flex gap-3">
            <NeonButton cancel onClick={onCancel} disabled={saving}>
              Cancel (Esc)
            </NeonButton>
            <button
              ref={confirmButtonRef}
              onClick={handleConfirm}
              disabled={saving}
              className="px-4 py-2 rounded-md bg-[#00D558] text-black text-sm font-semibold hover:bg-[#00D558]/85 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00D558] focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
            >
              {saving
                ? "Saving..."
                : totalIncluded === 0
                  ? "Skip All & Save"
                  : `Confirm ${totalIncluded} & Save (Enter)`}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

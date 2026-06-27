import React, { useCallback, useEffect, useRef } from "react";
import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import NeonButton from "../modules/NeonButton";
import { useSelectorSync } from "./useSelectorSync";

export function SportForm({ onDone }: { onDone?: () => void }) {
  const fetchAggregatedOptions = useAction(
    api.selectorOptions.fetchAggregatedOptions,
  );
  const triggered = useRef(false);

  const run = useCallback(
    () =>
      fetchAggregatedOptions({
        level: "sport",
        parentFilters: {},
      }),
    [fetchAggregatedOptions],
  );

  const { loading, hasError, message, retry, start } = useSelectorSync({
    level: "sport",
    onDone,
    run,
  });

  // Autofocus the Retry control so a keyboard user can recover with Enter.
  const retryRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (hasError) retryRef.current?.focus();
  }, [hasError]);

  useEffect(() => {
    if (!triggered.current) {
      triggered.current = true;
      start();
    }
  }, [start]);

  return (
    <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
      <h2 className="text-xl font-semibold mb-4">Syncing Sport Options</h2>

      {loading && (
        <p className="text-gray-600 dark:text-gray-400 mb-4">
          Fetching the latest sport options from all connected platforms...
        </p>
      )}

      {message &&
        (hasError ? (
          <div className="p-3 mb-4 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-md text-red-800 dark:text-red-200 text-sm">
            {message}
          </div>
        ) : (
          <div className="p-3 mb-4 bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700 rounded-md text-blue-800 dark:text-blue-200 text-sm">
            {message}
          </div>
        ))}

      {!loading && (
        <div className="flex gap-2">
          {hasError && (
            <NeonButton ref={retryRef} onClick={retry}>
              Retry
            </NeonButton>
          )}
          <NeonButton cancel onClick={onDone}>
            {hasError ? "Cancel" : "Close"}
          </NeonButton>
        </div>
      )}
    </div>
  );
}

// Re-export the SportSelector for backward compatibility
export { default as SportSelector } from "./SportSelector";

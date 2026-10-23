import React, { useCallback, useEffect, useRef } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { GenericId } from "convex/values";
import NeonButton from "../modules/NeonButton";
import { useSelectorSync } from "./useSelectorSync";

export default function YearForm({
  sportId,
  onDone,
}: {
  sportId: GenericId<"selectorOptions">;
  onDone?: () => void;
}) {
  const fetchAggregatedOptions = useAction(
    api.selectorOptions.fetchAggregatedOptions,
  );
  const sportOption = useQuery(api.selectorOptions.getSelectorOptionById, {
    id: sportId,
  });
  const triggered = useRef(false);

  const run = useCallback(async () => {
    if (!sportOption) return undefined;
    return fetchAggregatedOptions({
      level: "year",
      parentId: sportId,
      parentFilters: {
        sport: sportOption.value,
      },
    });
  }, [fetchAggregatedOptions, sportOption, sportId]);

  const { loading, hasError, message, retry, start } = useSelectorSync({
    level: "year",
    onDone,
    run,
  });

  // Autofocus the Retry control so a keyboard user can recover with Enter.
  const retryRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (hasError) retryRef.current?.focus();
  }, [hasError]);

  useEffect(() => {
    if (sportOption && !triggered.current) {
      triggered.current = true;
      start();
    }
  }, [sportOption, start]);

  return (
    <div className="bg-raised p-6 rounded-lg shadow shadow-offset">
      <h2 className="text-xl font-semibold mb-4">Syncing Year Options</h2>

      {loading && (
        <p className="text-ink-3 mb-4">
          Fetching year options for{" "}
          <strong>{sportOption?.value || "..."}</strong> from all connected
          platforms...
        </p>
      )}

      {message &&
        (hasError ? (
          <div className="p-3 mb-4 bg-notice-danger-bg border border-notice-danger-rule rounded-md text-notice-danger-ink text-sm">
            {message}
          </div>
        ) : (
          <div className="p-3 mb-4 bg-notice-info-bg border border-notice-info-rule rounded-md text-notice-info-ink text-sm">
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
          <NeonButton variant="negative" onClick={onDone}>
            {hasError ? "Cancel" : "Close"}
          </NeonButton>
        </div>
      )}
    </div>
  );
}

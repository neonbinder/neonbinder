import React, { useCallback, useEffect, useRef } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { GenericId } from "convex/values";
import NeonButton from "../modules/NeonButton";
import { useSelectorSync } from "./useSelectorSync";

export default function ManufacturerForm({
  yearId,
  onDone,
}: {
  yearId: GenericId<"selectorOptions">;
  onDone?: () => void;
}) {
  const fetchAggregatedOptions = useAction(
    api.selectorOptions.fetchAggregatedOptions,
  );
  const ancestorChain = useQuery(api.selectorOptions.getAncestorChain, {
    id: yearId,
  });
  const triggered = useRef(false);

  // Extract sport and year values from the ancestor chain
  const sportValue = ancestorChain?.find((a: { level: string }) => a.level === "sport")?.value;
  const yearValue = ancestorChain?.find((a: { level: string }) => a.level === "year")?.value;

  const run = useCallback(async () => {
    if (!sportValue || !yearValue) return undefined;
    return fetchAggregatedOptions({
      level: "manufacturer",
      parentId: yearId,
      parentFilters: {
        sport: sportValue,
        year: yearValue,
      },
    });
  }, [fetchAggregatedOptions, sportValue, yearValue, yearId]);

  const { loading, hasError, message, retry, start } = useSelectorSync({
    level: "manufacturer",
    onDone,
    run,
  });

  // Autofocus the Retry control so a keyboard user can recover with Enter.
  const retryRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (hasError) retryRef.current?.focus();
  }, [hasError]);

  useEffect(() => {
    if (sportValue && yearValue && !triggered.current) {
      triggered.current = true;
      start();
    }
  }, [sportValue, yearValue, start]);

  return (
    <div className="bg-raised p-6 rounded-lg shadow">
      <h2 className="text-xl font-semibold mb-4">
        Syncing Manufacturer Options
      </h2>

      {loading && (
        <p className="text-ink-3 mb-4">
          Fetching manufacturer options for{" "}
          <strong>
            {yearValue || "..."} {sportValue || ""}
          </strong>{" "}
          from all connected platforms...
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

import React, { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { GenericId } from "convex/values";
import NeonButton from "../modules/NeonButton";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";

type VariantMetadataEditorProps = {
  optionId: GenericId<"selectorOptions">;
};

export default function VariantMetadataEditor({
  optionId,
}: VariantMetadataEditorProps) {
  const option = useQuery(api.selectorOptions.getSelectorOptionById, {
    id: optionId,
  });
  const ancestorChain = useQuery(api.selectorOptions.getAncestorChain, {
    id: optionId,
  });
  const updateMetadata = useMutation(
    api.selectorOptions.updateSelectorOptionMetadata,
  );

  // Derive isInsert/isParallel from the hierarchy — these are not user-editable.
  const variantTypeValue = ancestorChain
    ?.find((a: { level: string }) => a.level === "variantType")
    ?.value?.toLowerCase();
  const derivedIsInsert =
    option?.level === "parallel"
      ? false
      : variantTypeValue === "insert";
  const derivedIsParallel =
    option?.level === "parallel"
      ? true
      : variantTypeValue === "parallel";

  const [cardNumberPrefix, setCardNumberPrefix] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Unique per-field class so Maestro inputText targets the Prefix input rather
  // than the first input sharing the className (see useFieldTestClass).
  const fieldClass = useFieldTestClass();

  // Sync local state from query result
  useEffect(() => {
    setCardNumberPrefix(option?.metadata?.cardNumberPrefix ?? "");
    setDirty(false);
  }, [option?._id, option?.metadata?.cardNumberPrefix]);

  // Auto-persist derived insert/parallel flags if they drift from stored metadata.
  useEffect(() => {
    if (!option || !ancestorChain) return;
    const storedInsert = option.metadata?.isInsert ?? false;
    const storedParallel = option.metadata?.isParallel ?? false;
    if (storedInsert === derivedIsInsert && storedParallel === derivedIsParallel) {
      return;
    }
    void updateMetadata({
      id: optionId,
      metadata: {
        isInsert: derivedIsInsert,
        isParallel: derivedIsParallel,
        cardNumberPrefix: option.metadata?.cardNumberPrefix,
      },
    });
  }, [
    option?._id,
    option?.metadata?.isInsert,
    option?.metadata?.isParallel,
    ancestorChain,
    derivedIsInsert,
    derivedIsParallel,
  ]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await updateMetadata({
        id: optionId,
        metadata: {
          isInsert: derivedIsInsert,
          isParallel: derivedIsParallel,
          cardNumberPrefix: cardNumberPrefix || undefined,
        },
      });
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [optionId, derivedIsInsert, derivedIsParallel, cardNumberPrefix, updateMetadata]);

  if (!option) return null;

  return (
    <div className="mt-3 p-3 bg-gray-800/50 border border-gray-700 rounded-lg">
      <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
        Metadata
      </h4>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-3 items-center">
          <label
            className="flex items-center gap-1.5 text-xs text-gray-400 cursor-not-allowed"
            title="Determined by hierarchy (variant type)"
          >
            <input
              type="checkbox"
              checked={derivedIsInsert}
              disabled
              readOnly
              className="rounded border-gray-600 bg-gray-700 opacity-60"
            />
            Insert
          </label>
          <label
            className="flex items-center gap-1.5 text-xs text-gray-400 cursor-not-allowed"
            title="Determined by hierarchy (variant type)"
          >
            <input
              type="checkbox"
              checked={derivedIsParallel}
              disabled
              readOnly
              className="rounded border-gray-600 bg-gray-700 opacity-60"
            />
            Parallel
          </label>
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <label className="flex items-center gap-1.5 text-xs text-gray-300">
            Prefix:
            <input
              type="text"
              value={cardNumberPrefix}
              onChange={(e) => {
                setCardNumberPrefix(e.target.value);
                setDirty(true);
              }}
              placeholder="e.g. DK-"
              className={`${fieldClass("prefix")} w-20 px-1.5 py-0.5 text-xs bg-gray-700 border border-gray-600 rounded text-gray-200`}
            />
          </label>
          {dirty && (
            <NeonButton size="1" onClick={handleSave} disabled={saving}>
              {saving ? "..." : "Save"}
            </NeonButton>
          )}
        </div>
      </div>
    </div>
  );
}

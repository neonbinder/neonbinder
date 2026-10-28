import { useId, useRef, useState, type KeyboardEvent } from "react";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import { FOCUS, QUIET_BUTTON } from "../../prototypes/p1/ui";
import { useCollectionActions, useCommonPrices } from "../data/store";
import type { VariantId } from "../data/types";
import { usePageApi } from "../pageApi";

/** Blank is `null` (clear); anything else must be a dollar amount of zero or more, to the cent. */
export function parsePrice(text: string): number | null | "invalid" {
  const trimmed = text.trim().replace(/^\$/, "");
  if (trimmed === "") return null;
  if (!/^\d+(\.\d{0,2})?$|^\.\d{1,2}$/.test(trimmed)) return "invalid";
  return Math.round(Number(trimmed) * 100) / 100;
}

/**
 * NEO-378 — a checklist's common price on the inventory side: what a plain
 * card of this exact variant sells for at least. A for-sale copy with no
 * minimum price of its own sells at it. Manual, per collector, per variant
 * (Base has one, a Refractor parallel its own).
 *
 * Reads as one line ("Common price $0.25 · Change"). Change opens a field
 * in place: Enter saves, Escape cancels, a blank field clears it. Every save
 * goes through the status line with Undo.
 */
export default function CommonPrice({ variantId, title }: { variantId: VariantId; title: string }) {
  const api = usePageApi();
  const writes = useCollectionActions();
  const prices = useCommonPrices([variantId]);
  const price = prices === undefined ? undefined : (prices[variantId] ?? null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState(false);
  const errorId = useId();
  const helpId = useId();
  const changeRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const open = () => {
    setText(typeof price === "number" ? price.toFixed(2) : "");
    setError(false);
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  };
  const close = () => {
    setEditing(false);
    requestAnimationFrame(() => changeRef.current?.focus());
  };
  const save = () => {
    const next = parsePrice(text);
    if (next === "invalid") {
      setError(true);
      return;
    }
    if (next === (price ?? null)) {
      close();
      return;
    }
    void api
      .run(
        () => writes.setCommonPrice(variantId, next),
        () =>
          next === null
            ? `Cleared the common price for ${title}`
            : `Common price for ${title} is $${next.toFixed(2)}`,
      )
      .then((r) => {
        if (r) close();
      });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  if (price === undefined) return <p className="h-5 text-sm text-ink-3">Common price…</p>;

  if (!editing) {
    return (
      <p className="flex flex-wrap items-center gap-x-2 text-sm text-ink-2">
        {typeof price === "number" ? (
          <span>
            Common price <span className="font-semibold tabular-nums text-ink">${price.toFixed(2)}</span>
          </span>
        ) : (
          <span>No common price yet</span>
        )}
        <button
          ref={changeRef}
          type="button"
          onClick={open}
          className={`${QUIET_BUTTON} max-sm:min-h-11`}
          aria-label={typeof price === "number" ? `Change the common price for ${title}` : `Set a common price for ${title}`}
        >
          {typeof price === "number" ? "Change" : "Set common price"}
        </button>
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="w-40">
        <Input
          ref={inputRef}
          surface="dark"
          label="Common price"
          type="text"
          inputMode="decimal"
          placeholder="0.25"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(false);
          }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          aria-invalid={error || undefined}
          aria-describedby={error ? errorId : helpId}
        />
      </div>
      <NeonButton type="button" variant="primary" onClick={save} className={`${FOCUS} max-sm:min-h-11`}>
        Save price
      </NeonButton>
      <NeonButton type="button" variant="negative" outline onClick={close} className={`${FOCUS} max-sm:min-h-11`}>
        Cancel
      </NeonButton>
      <p id={helpId} className={error ? "sr-only" : "basis-full text-xs text-ink-3"}>
        Cards in this checklist with no minimum price of their own sell at this. Blank clears it.
      </p>
      {error && (
        <p id={errorId} role="alert" className="basis-full text-sm text-neon-yellow-text">
          That isn&apos;t a price. Try 0.25 or 1.50.
        </p>
      )}
    </div>
  );
}

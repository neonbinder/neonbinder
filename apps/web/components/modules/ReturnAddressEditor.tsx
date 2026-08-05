"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import NeonButton from "./NeonButton";
import { Input } from "@/components/primitives/Input";
import {
  EMPTY_ADDRESS,
  hasCompleteStreetAddress,
  type PostalAddress,
} from "@/lib/shipping/address";

/**
 * NEO-118 — the seller's return address, edited on /profile and printed in the
 * FROM block of every 4×6 label.
 *
 * Held as one `address` object rather than a state variable per field, because
 * that is the shape the mutation takes and an address is only meaningful whole.
 * Every edit still routes through {@link update} so the NEO-41 dirty guard
 * cannot be opted out of field-by-field.
 *
 * There is no Company field and Name is optional: the seller's name already
 * exists on their public profile, so the FROM line falls back to their display
 * name (then username) and the two cannot drift apart. Saving therefore only
 * requires the street half — see `hasCompleteStreetAddress`.
 */

const FIELD_CLASS = "w-full px-3 py-2";
const LABEL_CLASS = "block text-sm font-medium mb-1 text-slate-300";

export default function ReturnAddressEditor() {
  const saved = useQuery(api.shipping.getMyReturnAddress);
  const publicProfile = useQuery(api.publicProfile.getMyPublicProfile);
  const saveReturnAddress = useMutation(api.shipping.saveMyReturnAddress);

  // The stored address — NOT the resolved one. Hydrating from the resolved name
  // would put the display name into the input, and the next save would freeze
  // it there, quietly breaking the "follows your profile" behaviour.
  const savedAddress = saved?.address ?? null;

  // What a blank name would fall back to. Read from the public profile rather
  // than from `resolvedName`, for two reasons: resolvedName already folds in
  // the stored name (so it would echo the input rather than the fallback), and
  // it is null until a first address is saved — which is exactly when someone
  // most needs to be told what blank will do.
  const fallbackName =
    publicProfile?.displayName?.trim() || publicProfile?.username?.trim() || "";

  const [address, setAddress] = useState<PostalAddress>(EMPTY_ADDRESS);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveMessageType, setSaveMessageType] = useState<"success" | "error">(
    "success",
  );

  /**
   * NEO-41 — has the operator touched the form since it was hydrated?
   *
   * Same race as PublicProfileEditor: this component is simultaneously a live
   * view of `getMyReturnAddress` and an editor for it, and `useQuery` hands
   * back a fresh object on every reactive push — including the one caused by
   * this component's own save. Without the guard, that push resets whatever the
   * operator is part-way through typing. A ref rather than state because it
   * must update synchronously inside onChange without scheduling a render.
   */
  const dirtyRef = useRef(false);

  /**
   * The same fact as `dirtyRef`, but in state so it can drive rendering.
   * A ref mutation does not schedule a render, so the ref alone cannot decide
   * whether to show "Discard changes" — it would appear a render late, or not
   * at all. The ref stays because the hydration effect needs the value
   * synchronously, before any render has been scheduled.
   */
  const [hasEdited, setHasEdited] = useState(false);

  useEffect(() => {
    // NEO-41 hydration: guarded by dirtyRef so a reactive push cannot stomp an
    // edit already in progress.
    if (savedAddress && !dirtyRef.current) {
      setAddress({ ...EMPTY_ADDRESS, ...savedAddress });
    }
  }, [savedAddress]);

  /**
   * The single edit path. A setter wired straight to onChange would silently
   * opt that one field out of the dirty guard.
   */
  const update = useCallback(
    (field: keyof PostalAddress) => (value: string) => {
      dirtyRef.current = true;
      setHasEdited(true);
      setAddress((prev) => ({ ...prev, [field]: value }));
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (!hasCompleteStreetAddress(address)) {
      setSaveMessage("Fill in street, city, state, and ZIP.");
      setSaveMessageType("error");
      return;
    }

    setIsSaving(true);
    setSaveMessage("");

    try {
      await saveReturnAddress({
        address: {
          ...address,
          // A blank name is a meaningful saved state here — it means "use my
          // display name" — so it is stored as "" rather than rejected.
          name: address.name.trim(),
          // Optional fields go as undefined rather than "" so a cleared field
          // stops printing instead of emitting a blank line on the label.
          company: undefined,
          line2: address.line2?.trim() || undefined,
          country: address.country || "US",
        },
      });
      setSaveMessage("Return address saved.");
      setSaveMessageType("success");
    } catch (error) {
      setSaveMessage(
        error instanceof Error
          ? error.message
          : "Failed to save return address.",
      );
      setSaveMessageType("error");
    } finally {
      setIsSaving(false);
    }
  }, [address, saveReturnAddress]);

  /** Revert to whatever is stored, discarding in-progress edits. */
  const handleRevert = useCallback(() => {
    dirtyRef.current = false;
    setHasEdited(false);
    setAddress(
      savedAddress ? { ...EMPTY_ADDRESS, ...savedAddress } : EMPTY_ADDRESS,
    );
    setSaveMessage("");
  }, [savedAddress]);

  // Keyboard-first: Enter saves from any field, Escape discards edits.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      handleRevert();
    }
  };

  const canSave = hasCompleteStreetAddress(address) && !isSaving;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void handleSave();
      }}
      onKeyDown={handleKeyDown}
    >
      <p className="text-sm text-slate-400">
        Printed as the FROM block on your shipping labels. Only you can see it.
      </p>

      <div>
        {/* No "(optional)" chip here, unlike the other optional fields: the
            hint below already says what leaving it blank does, which is more
            useful. It also keeps the label a single text node — a trailing
            "Name " plus a separate span is not matchable by Maestro's
            whole-node text selectors. */}
        <label htmlFor="ship-name" className={LABEL_CLASS}>
          Name
        </label>
        <Input
          bare
          id="ship-name"
          type="text"
          value={address.name}
          onChange={(e) => update("name")(e.target.value)}
          className={FIELD_CLASS}
          placeholder={fallbackName || "Your name"}
          autoComplete="name"
          aria-describedby="ship-name-hint"
        />
        <p id="ship-name-hint" className="text-xs text-slate-400 mt-1">
          {fallbackName
            ? `Leave blank to use "${fallbackName}" from your public profile.`
            : "Leave blank to use your public profile display name or username."}
        </p>
      </div>

      <div>
        <label htmlFor="ship-line1" className={LABEL_CLASS}>
          Street Address
        </label>
        <Input
          bare
          id="ship-line1"
          type="text"
          value={address.line1}
          onChange={(e) => update("line1")(e.target.value)}
          className={FIELD_CLASS}
          placeholder="123 Main St"
          autoComplete="address-line1"
        />
      </div>

      <div>
        <label htmlFor="ship-line2" className={LABEL_CLASS}>
          Apt / Suite <span className="text-slate-400 text-xs">(optional)</span>
        </label>
        <Input
          bare
          id="ship-line2"
          type="text"
          value={address.line2 ?? ""}
          onChange={(e) => update("line2")(e.target.value)}
          className={FIELD_CLASS}
          placeholder="Apt 4B"
          autoComplete="address-line2"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="sm:col-span-1">
          <label htmlFor="ship-city" className={LABEL_CLASS}>
            City
          </label>
          <Input
            bare
            id="ship-city"
            type="text"
            value={address.city}
            onChange={(e) => update("city")(e.target.value)}
            className={FIELD_CLASS}
            placeholder="Dallas"
            autoComplete="address-level2"
          />
        </div>
        <div>
          <label htmlFor="ship-state" className={LABEL_CLASS}>
            State
          </label>
          <Input
            bare
            id="ship-state"
            type="text"
            value={address.state}
            onChange={(e) =>
              update("state")(e.target.value.toUpperCase().slice(0, 2))
            }
            className={FIELD_CLASS}
            placeholder="TX"
            maxLength={2}
            autoComplete="address-level1"
            aria-describedby="ship-state-hint"
          />
          {/* The field silently truncates and re-cases what you type; say so,
              since a placeholder disappears the moment you start typing. */}
          <span id="ship-state-hint" className="sr-only">
            Two-letter state abbreviation
          </span>
        </div>
        <div>
          <label htmlFor="ship-postal-code" className={LABEL_CLASS}>
            ZIP
          </label>
          <Input
            bare
            id="ship-postal-code"
            type="text"
            value={address.postalCode}
            onChange={(e) => update("postalCode")(e.target.value)}
            className={FIELD_CLASS}
            placeholder="75201"
            autoComplete="postal-code"
            inputMode="numeric"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <NeonButton
          type="submit"
          disabled={!canSave}
          aria-describedby="ship-save-requirements"
        >
          {isSaving ? "Saving…" : "Save Return Address"}
        </NeonButton>
        {hasEdited && (
          // p-2/-m-2 grows the hit target past the 24px minimum without
          // moving anything: a bare text button is only ~14px tall.
          <button
            type="button"
            onClick={handleRevert}
            className="text-sm text-slate-400 hover:text-slate-200 underline p-2 -m-2"
          >
            Discard changes
          </button>
        )}
      </div>

      {/* A natively-disabled button leaves the tab order and announces only as
          "unavailable", so the reason has to live outside it. */}
      {!canSave && !isSaving && (
        <p id="ship-save-requirements" className="text-xs text-slate-400">
          Fill in street, city, state, and ZIP to save.
        </p>
      )}

      {/* Always mounted: a live region inserted at the same moment its text
          appears is unreliably announced (notably VoiceOver). The role flips
          because a failed save should interrupt, while a success need not. */}
      <p
        role={saveMessageType === "error" ? "alert" : "status"}
        aria-live={saveMessageType === "error" ? "assertive" : "polite"}
        className={`text-sm ${
          saveMessageType === "success" ? "text-neon-green" : "text-neon-pink"
        }`}
      >
        {saveMessage}
      </p>
    </form>
  );
}

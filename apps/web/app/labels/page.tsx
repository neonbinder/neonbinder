"use client";

import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import NeonButton from "../../components/modules/NeonButton";
import { ShippingLabel } from "../../components/modules/ShippingLabel";
import { Input } from "@/components/primitives/Input";
import { Textarea } from "@/components/primitives/Textarea";
import { PrinterIcon, TagIcon } from "@heroicons/react/24/outline";
import {
  EMPTY_ADDRESS,
  isCompleteAddress,
  type PostalAddress,
} from "@/lib/shipping/address";
import { parseAddressText } from "@/lib/shipping/parse-address";
import { DEFAULT_LABEL_FORMAT } from "@/lib/shipping/label-formats";
import { printHtmlDocument } from "@/lib/print/print-html";

/**
 * NEO-118 — print a 4×6 shipping label.
 *
 * The recipient is deliberately not persisted: you address a package once, and
 * storing buyer addresses would make this a place that accumulates other
 * people's PII for no benefit. The form starts blank every visit.
 */

const FIELD_CLASS = "w-full px-3 py-2";
const LABEL_CLASS = "block text-sm font-medium mb-1 text-slate-300";

export default function LabelsPage() {
  const navigate = useNavigate();
  const saved = useQuery(api.shipping.getMyReturnAddress);
  const [to, setTo] = useState<PostalAddress>(EMPTY_ADDRESS);
  const [printError, setPrintError] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [pasteStatus, setPasteStatus] = useState("");
  const labelRef = useRef<HTMLDivElement>(null);

  const update = (field: keyof PostalAddress) => (value: string) => {
    setTo((prev) => ({ ...prev, [field]: value }));
  };

  /**
   * Fill the Ship To fields from a pasted address block.
   *
   * MERGES rather than replaces: the parser returns only what it is confident
   * about, so a partial parse must not blank a field the seller already typed.
   * Whatever it could not place is reported verbatim instead of dropped — a
   * line the seller can see is a line they can put somewhere.
   */
  const applyPaste = useCallback((text: string) => {
    const { fields, filled, unparsed } = parseAddressText(text);

    if (filled.length === 0) {
      setPasteStatus("Couldn't read an address from that — fill it in below.");
      return;
    }

    setTo((prev) => ({ ...prev, ...fields }));

    const named = filled.filter((f) => f !== "country").length;
    setPasteStatus(
      unparsed.length > 0
        ? `Filled ${named} field${named === 1 ? "" : "s"}. Couldn't place: ${unparsed.join(" · ")}`
        : `Filled ${named} field${named === 1 ? "" : "s"} — check them before printing.`,
    );
  }, []);

  const handlePrint = useCallback(async () => {
    // The label element itself is the print source — serializing the live DOM
    // is what guarantees the paper matches the preview, since every style on it
    // is inline and therefore survives into the isolated print document.
    if (!labelRef.current) return;
    setPrintError("");
    try {
      await printHtmlDocument({
        title: `Shipping label — ${to.name || "label"}`,
        bodyHtml: labelRef.current.outerHTML,
        css: "",
        page: {
          widthIn: DEFAULT_LABEL_FORMAT.widthIn,
          heightIn: DEFAULT_LABEL_FORMAT.heightIn,
        },
      });
    } catch (error) {
      setPrintError(
        error instanceof Error ? error.message : "Could not open the print dialog.",
      );
    }
  }, [to.name]);

  // Waiting on the return address query.
  if (saved === undefined) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // No return address yet — a label without a FROM block is not mailable, so
  // send them to the one place it can be set rather than printing a half label.
  if (saved === null) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center px-4">
        <TagIcon className="w-20 h-20 text-neon-teal mb-6" />
        <h1 className="text-3xl font-bold mb-3">Shipping Labels</h1>
        <p className="text-gray-400 max-w-md mb-6">
          Add your return address on your profile first — it prints as the
          return address on every label.
        </p>
        {/* A NeonButton renders a real <button>; wrapping it in an <a> would
            nest interactive content and expose an ambiguous role. */}
        <NeonButton onClick={() => navigate("/profile")}>
          Go to Profile
        </NeonButton>
      </div>
    );
  }

  // The FROM block prints the resolved name (stored name, else the seller's
  // public display name, else their username) rather than whatever is stored.
  const returnAddress: PostalAddress = {
    ...saved.address,
    name: saved.resolvedName,
  };

  // Both blocks have to be complete. The FROM half can be incomplete in one
  // real case: a seller who saved a street address but has no name anywhere —
  // no typed name and no public profile to fall back to.
  const fromIsComplete = isCompleteAddress(returnAddress);
  const canPrint = isCompleteAddress(to) && fromIsComplete;

  return (
    <div className="flex flex-col items-center gap-8 py-12 px-4">
      <div className="text-center">
        <TagIcon className="w-16 h-16 text-neon-teal mx-auto mb-4" />
        <h1 className="text-3xl font-bold mb-2">Shipping Labels</h1>
        <p className="text-gray-400 max-w-md">
          Type where it&apos;s going and print a 4&quot; × 6&quot; label. Your
          return address is filled in automatically.
        </p>
      </div>

      <form
        className="w-full max-w-md space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void handlePrint();
        }}
      >
        <h2 className="text-lg font-semibold">Ship To</h2>

        {/* Paste-to-fill. The seller has the buyer's address open on a packing
            slip in another tab; retyping six fields per package is slow and is
            the easiest place to introduce a typo that misdelivers a card.
            Filling on paste (rather than behind a button) is the whole point —
            the button below is only for text that was typed or edited here. */}
        <div className="rounded-lg border border-slate-800 p-3 space-y-2">
          <label htmlFor="to-paste" className={LABEL_CLASS}>
            Paste an address
          </label>
          <Textarea
            bare
            id="to-paste"
            rows={3}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              if (!text) return;
              // Fill from the clipboard directly: React state has not caught up
              // to the paste yet, so reading `pasteText` here would parse the
              // PREVIOUS contents.
              e.preventDefault();
              setPasteText(text);
              applyPaste(text);
            }}
            className={`${FIELD_CLASS} font-mono text-sm`}
            placeholder={"Jane Buyer\n742 Evergreen Ter\nSpringfield, IL 62704"}
            aria-describedby="to-paste-status"
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => applyPaste(pasteText)}
              disabled={pasteText.trim() === ""}
              className="text-sm text-neon-teal hover:text-neon-teal/80 underline disabled:opacity-40 disabled:no-underline p-2 -m-2"
            >
              Fill fields
            </button>
            {pasteText !== "" && (
              <button
                type="button"
                onClick={() => {
                  setPasteText("");
                  setPasteStatus("");
                }}
                className="text-sm text-slate-400 hover:text-slate-200 underline p-2 -m-2"
              >
                Clear
              </button>
            )}
          </div>
          {/* Always mounted so the announcement is reliable. */}
          <p
            id="to-paste-status"
            role="status"
            aria-live="polite"
            className="text-xs text-slate-400"
          >
            {pasteStatus}
          </p>
        </div>

        <div>
          <label htmlFor="to-name" className={LABEL_CLASS}>
            Name
          </label>
          <Input
            bare
            id="to-name"
            type="text"
            value={to.name}
            onChange={(e) => update("name")(e.target.value)}
            className={FIELD_CLASS}
            placeholder="Recipient name"
          />
        </div>

        <div>
          <label htmlFor="to-company" className={LABEL_CLASS}>
            Company <span className="text-slate-400 text-xs">(optional)</span>
          </label>
          <Input
            bare
            id="to-company"
            type="text"
            value={to.company ?? ""}
            onChange={(e) => update("company")(e.target.value)}
            className={FIELD_CLASS}
            placeholder="Business name"
          />
        </div>

        <div>
          <label htmlFor="to-line1" className={LABEL_CLASS}>
            Street Address
          </label>
          <Input
            bare
            id="to-line1"
            type="text"
            value={to.line1}
            onChange={(e) => update("line1")(e.target.value)}
            className={FIELD_CLASS}
            placeholder="123 Main St"
          />
        </div>

        <div>
          <label htmlFor="to-line2" className={LABEL_CLASS}>
            Apt / Suite{" "}
            <span className="text-slate-400 text-xs">(optional)</span>
          </label>
          <Input
            bare
            id="to-line2"
            type="text"
            value={to.line2 ?? ""}
            onChange={(e) => update("line2")(e.target.value)}
            className={FIELD_CLASS}
            placeholder="Apt 4B"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label htmlFor="to-city" className={LABEL_CLASS}>
              City
            </label>
            <Input
              bare
              id="to-city"
              type="text"
              value={to.city}
              onChange={(e) => update("city")(e.target.value)}
              className={FIELD_CLASS}
              placeholder="Dallas"
            />
          </div>
          <div>
            <label htmlFor="to-state" className={LABEL_CLASS}>
              State
            </label>
            <Input
              bare
              id="to-state"
              type="text"
              value={to.state}
              onChange={(e) =>
                update("state")(e.target.value.toUpperCase().slice(0, 2))
              }
              className={FIELD_CLASS}
              placeholder="TX"
              maxLength={2}
              aria-describedby="to-state-hint"
            />
            {/* The field silently truncates and re-cases what you type; say so,
                since a placeholder disappears the moment you start typing. */}
            <span id="to-state-hint" className="sr-only">
              Two-letter state abbreviation
            </span>
          </div>
          <div>
            <label htmlFor="to-postal-code" className={LABEL_CLASS}>
              ZIP
            </label>
            <Input
              bare
              id="to-postal-code"
              type="text"
              value={to.postalCode}
              onChange={(e) => update("postalCode")(e.target.value)}
              className={FIELD_CLASS}
              placeholder="75201"
              inputMode="numeric"
            />
          </div>
        </div>

        <div className="flex flex-col items-center pt-2">
          <NeonButton
            type="submit"
            disabled={!canPrint}
            size="3"
            aria-describedby="print-requirements"
          >
            <PrinterIcon className="w-5 h-5 mr-2" />
            Print Label
          </NeonButton>
          {/* A natively-disabled button drops out of the tab order and
              announces only as "unavailable", with no clue what is missing. */}
          {!canPrint && (
            <p
              id="print-requirements"
              className="text-xs text-slate-400 text-center mt-2"
            >
              {fromIsComplete
                ? "Fill in name, street, city, state, and ZIP to enable printing."
                : "Add a name to your return address, or set a display name on your public profile."}
            </p>
          )}
        </div>

        {/* Always mounted: a live region inserted at the same moment its text
            appears is unreliably announced (notably VoiceOver). */}
        <p role="alert" className="text-sm text-neon-pink text-center">
          {printError}
        </p>
      </form>

      {/* Live preview. At 96dpi a 6in label is 576px, so it fits a desktop
          column at 1:1 — no scaling maths, and the preview is literally the
          element that gets printed. Narrower screens scroll it rather than
          shrinking it, so what you see stays true to size. */}
      <div className="w-full max-w-full flex flex-col items-center gap-3">
        <h2 id="label-preview-heading" className="text-lg font-semibold">
          Preview
        </h2>
        {/* tabIndex makes the scroll container reachable: on a narrow viewport
            the 6in label overflows, and without it only a pointer could pan. */}
        <div
          role="group"
          aria-labelledby="label-preview-heading"
          tabIndex={0}
          className="max-w-full overflow-x-auto"
        >
          <div className="border border-neon-teal/30 rounded-lg p-2 bg-white/5 w-fit">
            <ShippingLabel
              ref={labelRef}
              from={returnAddress}
              to={to}
              toPlaceholder="Recipient address appears here"
            />
          </div>
        </div>
        <p className="text-xs text-gray-500 text-center max-w-md">
          Shown at actual size. Print at 100% scale — not &quot;fit to
          page&quot; — so the label lands square on the media.
        </p>
      </div>
    </div>
  );
}

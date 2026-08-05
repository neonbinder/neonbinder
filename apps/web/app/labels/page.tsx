"use client";

import { useCallback, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import NeonButton from "../../components/modules/NeonButton";
import { ShippingLabel } from "../../components/modules/ShippingLabel";
import { Input } from "@/components/primitives/Input";
import { PrinterIcon, TagIcon } from "@heroicons/react/24/outline";
import {
  EMPTY_ADDRESS,
  isCompleteAddress,
  type PostalAddress,
} from "@/lib/shipping/address";
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
  const returnAddress = useQuery(api.shipping.getMyReturnAddress);
  const [to, setTo] = useState<PostalAddress>(EMPTY_ADDRESS);
  const [printError, setPrintError] = useState("");
  const labelRef = useRef<HTMLDivElement>(null);

  const update = (field: keyof PostalAddress) => (value: string) => {
    setTo((prev) => ({ ...prev, [field]: value }));
  };

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
  if (returnAddress === undefined) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // No return address yet — a label without a FROM block is not mailable, so
  // send them to the one place it can be set rather than printing a half label.
  if (returnAddress === null) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center px-4">
        <TagIcon className="w-20 h-20 text-neon-teal mb-6" />
        <h1 className="text-3xl font-bold mb-3">Shipping Labels</h1>
        <p className="text-gray-400 max-w-md mb-6">
          Add your return address on your profile first — it prints in the FROM
          block of every label.
        </p>
        <a href="/profile">
          <NeonButton>Go to Profile</NeonButton>
        </a>
      </div>
    );
  }

  const canPrint = isCompleteAddress(to);

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
            Company <span className="text-slate-500 text-xs">(optional)</span>
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
            <span className="text-slate-500 text-xs">(optional)</span>
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
            />
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

        <div className="flex justify-center pt-2">
          <NeonButton type="submit" disabled={!canPrint} size="3">
            <PrinterIcon className="w-5 h-5 mr-2" />
            Print Label
          </NeonButton>
        </div>

        {printError && (
          <p role="alert" className="text-sm text-neon-pink text-center">
            {printError}
          </p>
        )}
      </form>

      {/* Live preview. At 96dpi a 6in label is 576px, so it fits a desktop
          column at 1:1 — no scaling maths, and the preview is literally the
          element that gets printed. Narrower screens scroll it rather than
          shrinking it, so what you see stays true to size. */}
      <div className="w-full max-w-full flex flex-col items-center gap-3">
        <h2 className="text-lg font-semibold">Preview</h2>
        <div className="max-w-full overflow-x-auto">
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

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import NeonButton from "@/components/modules/NeonButton";
import { ShippingLabel } from "@/components/modules/ShippingLabel";
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
import { formatUsd } from "@/lib/format/money";
import { sellerMessage } from "@/lib/shipping/postage-error";
import PurchasedTracking from "@/components/modules/PurchasedTracking";

/**
 * NEO-118 / NEO-120 — address a 4×6 label and buy the postage for it.
 *
 * The recipient is deliberately not persisted: you address a package once, and
 * storing buyer addresses would make this a place that accumulates other
 * people's PII for no benefit. The form starts blank every visit.
 *
 * ## Why the price is on the button
 * NEO-118's "Print Label" is free and repeatable. Buying postage is neither.
 * The first cut made purchasing two steps (Get rate → Buy & print) so money
 * was never one tap away from a free control; PO feedback on the PR preview
 * traded that for pricing everything up front: rates for every letter weight
 * fetch automatically once the address is complete (which is also where an
 * undeliverable address is caught — before any money moves), the weight
 * selector shows the real prices, and the single **Buy postage — $X** button
 * never renders without the amount it will charge. Same
 * price-before-the-irreversible-action property, fewer taps.
 */

const FIELD_CLASS = "w-full px-3 py-2";
const LABEL_CLASS = "block text-sm font-medium mb-1 text-slate-300";

/**
 * First-Class letter rates tier at 1/2/3oz, so the seller has to tell us which.
 * Card counts are rough guidance, not a promise — a scale is the real answer,
 * and underpaying gets mail returned.
 */
const WEIGHT_OPTIONS = [
  { oz: 1, hint: "~1–4 cards in a PWE" },
  { oz: 2, hint: "~5–10 cards, or a toploader" },
  { oz: 3, hint: "a thicker envelope" },
] as const;

/** What quoteLetterRate returns; buying uses the quoted ids, never a re-rate. */
type LetterQuote = FunctionReturnType<typeof api.postage.quoteLetterRate>;

export default function ShippingLabelsPage() {
  const navigate = useNavigate();
  const saved = useQuery(api.shipping.getMyReturnAddress);
  const [to, setTo] = useState<PostalAddress>(EMPTY_ADDRESS);
  const [printError, setPrintError] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [pasteStatus, setPasteStatus] = useState("");
  const labelRef = useRef<HTMLDivElement>(null);

  // NEO-120 — postage
  const quoteLetterRate = useAction(api.postage.quoteLetterRate);
  const buyLetterLabel = useAction(api.postage.buyLetterLabel);
  const hasEasypostKey = useAction(api.postage.hasEasypostKey);
  const [weightOz, setWeightOz] = useState(1);
  /**
   * Rates for every letter weight, keyed by oz — fetched together once the
   * address is complete, so switching weight is instant and never re-rates.
   */
  const [quotes, setQuotes] = useState<Partial<Record<number, LetterQuote>>>({});
  const [rating, setRating] = useState(false);
  const [buying, setBuying] = useState(false);
  /**
   * True after a purchase whose print dialog failed. Blocks auto-rating so the
   * page cannot cheerfully re-price and offer to buy a SECOND label for a
   * recipient who already has one — the double-charge guard the two-step flow
   * kept by reverting its button to "Get rate". Any address edit clears it.
   */
  const [boughtAwaitingEdit, setBoughtAwaitingEdit] = useState(false);
  /**
   * NEO-182 — the last purchase's tracking number, displayed with a copy
   * button. Deliberately NOT reset by clearForm(): a successful buy clears the
   * form for the next package, and the tracking number must outlive that —
   * it is what the seller pastes into SportLots. Replaced on the next buy.
   */
  const [lastPurchase, setLastPurchase] = useState<{
    name: string;
    trackingCode: string;
    /**
     * NEO-213 — whether the purchase made it into Label History. False means
     * the money moved and the record write did not land, so this label is NOT
     * reprintable later: the page has to say so while the seller is still
     * looking at it, rather than promise a history entry that isn't there.
     */
    historySaved: boolean;
  } | null>(null);
  /**
   * Staleness token for in-flight rate requests. Bumped whenever the address
   * inputs are invalidated (edit / paste / clear); a rating round that comes
   * back to find the token moved discards itself instead of reinstating
   * quotes — and a USPS-corrected address — for a form the seller has since
   * changed or emptied.
   */
  const rateRequestRef = useRef(0);
  /**
   * Whether the seller has an EasyPost key on file — gates the postage block.
   * null while the check is in flight; a FAILED check reads as false, because
   * the safe fallback here is the "add your key" pointer, not a purchase
   * button that can only fail. (EasypostKeyEditor maps failure to "unknown"
   * instead — there, false would invite re-pasting an already-stored key.)
   */
  const [easypostKeySaved, setEasypostKeySaved] = useState<boolean | null>(null);

  /**
   * Mount-only read of remote state. Cannot be a useQuery — knowing whether a
   * key exists means asking the browser service, and only Convex actions may
   * call out. Depending on the action identity re-runs the effect every
   * render and loops; see the write-up in EasypostKeyEditor.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await hasEasypostKey({});
        if (!cancelled) setEasypostKeySaved(result);
      } catch {
        if (!cancelled) setEasypostKeySaved(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only by design; see above.
  }, []);
  const [postageError, setPostageError] = useState("");

  const update = (field: keyof PostalAddress) => (value: string) => {
    setTo((prev) => ({ ...prev, [field]: value }));
    // Any edit invalidates the quotes: they were priced for a specific
    // address, and silently buying a stale rate would ship to the old one.
    rateRequestRef.current += 1;
    setQuotes({});
    setBoughtAwaitingEdit(false);
    setPostageError("");
  };

  // No invalidation here — every weight was priced in the same round, so
  // switching is a lookup, not a re-rate. That instant answer is the whole
  // point of quoting 1/2/3oz together.
  const changeWeight = (oz: number) => {
    setWeightOz(oz);
  };

  /**
   * Reset the whole Ship To form — fields, paste box and every status line.
   *
   * Scoped to the form rather than to the paste box: the moment you want a
   * clean slate is between two packages, and clearing only the pasted text
   * would leave the previous buyer's address sitting in the fields and on the
   * label preview — the worst possible thing to still be there when you print
   * the next one.
   */
  const clearForm = useCallback(() => {
    setTo(EMPTY_ADDRESS);
    setPasteText("");
    setPasteStatus("");
    setPrintError("");
    rateRequestRef.current += 1;
    setQuotes({});
    setBoughtAwaitingEdit(false);
    setPostageError("");
    setWeightOz(1);
  }, []);

  /** True when there is anything to clear — drives showing the control at all. */
  const hasAnyInput =
    pasteText.trim() !== "" ||
    (Object.keys(to) as (keyof PostalAddress)[]).some(
      (k) => k !== "country" && (to[k] ?? "").trim() !== "",
    );

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

    rateRequestRef.current += 1;
    setQuotes({});
    setBoughtAwaitingEdit(false);
    setPostageError("");
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

  /**
   * Price every letter weight as soon as the address is complete. Charges
   * nothing. Debounced past the last keystroke; address verification runs
   * inside the rating call, so an undeliverable address fails here — before
   * any money moves — and the corrected, ZIP+4'd address replaces what was
   * typed (USPS's version is the one being shipped to, so it is the one that
   * should be on screen).
   *
   * The quotes land BEFORE the corrected address is applied, so the `to`
   * change this causes re-runs the effect into its "already quoted" bail-out
   * rather than a rating loop. The staleness token covers the other race: an
   * edit mid-flight bumps it, and this round throws its results away instead
   * of reinstating prices for an address the seller has changed.
   */
  useEffect(() => {
    if (
      easypostKeySaved !== true ||
      !isCompleteAddress(to) ||
      boughtAwaitingEdit ||
      rating ||
      Object.keys(quotes).length > 0
    ) {
      return;
    }
    const requestToken = rateRequestRef.current;
    const timer = setTimeout(() => {
      void (async () => {
        setRating(true);
        setPostageError("");
        const results = await Promise.allSettled(
          WEIGHT_OPTIONS.map((opt) => quoteLetterRate({ to, weightOz: opt.oz })),
        );
        if (rateRequestRef.current !== requestToken) return; // stale — discard
        const next: Partial<Record<number, LetterQuote>> = {};
        results.forEach((result, i) => {
          if (result.status === "fulfilled") next[WEIGHT_OPTIONS[i].oz] = result.value;
        });
        setQuotes(next);
        const firstOk = results.find(
          (result): result is PromiseFulfilledResult<LetterQuote> =>
            result.status === "fulfilled",
        );
        if (firstOk) {
          setTo((prev) => ({ ...prev, ...firstOk.value.verifiedTo }));
        } else {
          // All three failed — almost always the address, and EasyPost's
          // message is seller-actionable, so surface it rather than a shrug.
          const firstErr = results[0];
          setPostageError(
            sellerMessage(
              firstErr.status === "rejected" ? firstErr.reason : undefined,
              "Could not get postage prices.",
            ),
          );
        }
        setRating(false);
      })();
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- quoteLetterRate's identity is unstable (see the key-check effect); the real inputs are listed.
  }, [to, easypostKeySaved, boughtAwaitingEdit, rating, quotes]);

  /**
   * Buy the selected weight's quoted rate, then print the label EasyPost
   * returns.
   *
   * The only irreversible action on this page. Printing uses the purchased
   * artwork rather than our own render: that PNG carries the postage indicia
   * and the barcode, and it is what makes the envelope mailable.
   *
   * If the purchase succeeds but printing fails, the label is still bought —
   * so that case says so instead of implying the money came back, and points
   * at Label History when the purchase actually landed there. `historySaved`
   * is what decides that: a history write that failed must not be advertised
   * as a reprint the seller can come back for (NEO-213).
   */
  const handleBuyPostage = useCallback(async () => {
    const quote = quotes[weightOz];
    if (!quote) return;
    setBuying(true);
    setPostageError("");
    try {
      const bought = await buyLetterLabel({
        shipmentId: quote.shipmentId,
        rateId: quote.rateId,
        weightOz,
        to,
      });
      // The purchase exists from here on, whatever printing does next — the
      // tracking note must show on the print-failure path too.
      setLastPurchase({
        name: to.name,
        trackingCode: bought.trackingCode,
        historySaved: bought.historySaved,
      });

      try {
        await printHtmlDocument({
          title: `Postage label — ${to.name || "label"}`,
          // Sized to the page rather than left at natural size: EasyPost's 6x4
          // PNG is a known aspect ratio, and letting it overflow would clip the
          // barcode a carrier has to scan.
          bodyHtml: `<img src="${bought.labelUrl}" alt="" style="width:${DEFAULT_LABEL_FORMAT.widthIn}in;height:${DEFAULT_LABEL_FORMAT.heightIn}in;display:block">`,
          css: "",
          page: {
            widthIn: DEFAULT_LABEL_FORMAT.widthIn,
            heightIn: DEFAULT_LABEL_FORMAT.heightIn,
          },
        });
      } catch {
        // The label IS bought. Dropping the quotes AND setting the flag is the
        // important part: without the flag, auto-rating would immediately
        // re-price this same recipient and hand back a live purchase button —
        // a double-charge waiting for an impatient click.
        rateRequestRef.current += 1;
        setQuotes({});
        setBoughtAwaitingEdit(true);
        // Two different situations, and only one of them has a second chance
        // in it (NEO-213). Promising "reprint it from Label History" for a
        // purchase whose history write failed sends the seller to an empty
        // page days later, by which time the label URL is gone too.
        setPostageError(
          bought.historySaved
            ? "The label was bought but the print dialog didn't open. It's saved to your Label History — reprint it from there."
            : "The label was bought but the print dialog didn't open, and it couldn't be saved to your Label History. The postage is real — copy the tracking number below and print the label from your EasyPost account.",
        );
        return;
      }

      // Bought and printed: clear so the next package starts clean and nobody
      // accidentally buys a second label for the same recipient.
      clearForm();
    } catch (error) {
      setPostageError(sellerMessage(error, "Could not buy the label."));
    } finally {
      setBuying(false);
    }
  }, [buyLetterLabel, clearForm, quotes, to, weightOz]);

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
        {/* h2, not h1: the "Print Shop" h1 lives in PrintLayout (NEO-145). */}
        <h2 className="text-3xl font-bold mb-3">Shipping Labels</h2>
        <p className="text-gray-400 max-w-md mb-6">
          Add your return address on your profile first — it prints as the
          return address on every label.
        </p>
        {/* A NeonButton renders a real <button>; wrapping it in an <a> would
            nest interactive content and expose an ambiguous role. */}
        <NeonButton onClick={() => navigate("/profile/shipping")}>
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
        <h2 className="text-3xl font-bold mb-2">Shipping Labels</h2>
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
        <h3 className="text-lg font-semibold">Ship To</h3>

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

        {/* NEO-118 — the free path: print the addressed 4×6 label, no postage.
            Restored after NEO-120's first cut replaced it with the postage
            flow. Buying postage is ADDITIVE — a seller with no EasyPost key,
            or who just wants a stamp today, still addresses envelopes here. */}
        <div className="flex flex-col items-center pt-2">
          <div className="flex items-center gap-4">
            <NeonButton
              type="submit"
              disabled={!canPrint || buying}
              size="3"
              aria-describedby="print-requirements"
            >
              <PrinterIcon className="w-5 h-5 mr-2" />
              Print Label
            </NeonButton>
            {/* Clears the FORM, not just the paste box — the point is a clean
                slate between packages. Rendered only when there is something to
                clear so it never sits there as a no-op. */}
            {hasAnyInput && (
              <button
                type="button"
                onClick={clearForm}
                className="text-sm text-slate-400 hover:text-slate-200 underline p-2 -m-2"
              >
                Clear form
              </button>
            )}
          </div>
          {/* A natively-disabled button drops out of the tab order and
              announces only as "unavailable", with no clue what is missing. */}
          {!canPrint && (
            <p
              id="print-requirements"
              className="text-xs text-slate-400 text-center mt-2"
            >
              {fromIsComplete
                ? "Fill in name, street, city, state, and ZIP to print a label."
                : "Add a name to your return address, or set a display name on your public profile."}
            </p>
          )}
        </div>

        {/* NEO-120 — postage, additive to the free label above and rendered
            only once the seller has connected EasyPost. Everyone else gets the
            pointer to where the key is entered, instead of a "Get rate" that
            can only fail for them. While the key check is in flight nothing
            renders here — the free print path is never held hostage to it. */}
        {easypostKeySaved === true && (
          <div className="space-y-4">
            {/* Weight — required to rate a letter, and the seller is the only
                one who knows it. Card counts are guidance, not a promise. */}
            <fieldset className="border border-slate-800 rounded-lg p-3">
              <legend className="text-sm font-medium text-slate-300 px-1">
                Envelope weight
              </legend>
              <div className="flex flex-wrap gap-2 mt-1">
                {WEIGHT_OPTIONS.map((opt) => (
                  <label
                    key={opt.oz}
                    className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer transition-colors ${
                      weightOz === opt.oz
                        ? "border-neon-teal text-neon-teal"
                        : "border-slate-700 text-slate-300 hover:border-slate-500"
                    }`}
                  >
                    <input
                      type="radio"
                      name="weight-oz"
                      value={opt.oz}
                      checked={weightOz === opt.oz}
                      onChange={() => changeWeight(opt.oz)}
                      className="accent-[#00E5C0]"
                    />
                    <span className="font-medium">{opt.oz} oz</span>
                    {/* The price IS the selector's payload: every weight was
                        rated in one round, so choosing is comparing, not
                        requesting. An ellipsis while rating; blank when a
                        weight came back unrateable (its Buy stays disabled). */}
                    <span className="text-xs font-medium">
                      {quotes[opt.oz]
                        ? formatUsd(quotes[opt.oz]!.amountCents)
                        : rating
                          ? "…"
                          : ""}
                    </span>
                    <span className="text-slate-400 text-xs">{opt.hint}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-slate-400 mt-2">
                Weigh it if you can — underpaid mail comes back.
              </p>
            </fieldset>

            <div className="flex flex-col items-center">
              {/* One button, and it never shows without its price: it is inert
                  until the selected weight's quote is in hand, so the money is
                  on screen before the only irreversible tap on this page. */}
              <NeonButton
                type="button"
                onClick={() => void handleBuyPostage()}
                disabled={!quotes[weightOz] || buying}
                size="3"
                aria-describedby="print-requirements"
              >
                <PrinterIcon className="w-5 h-5 mr-2" />
                {buying
                  ? "Buying…"
                  : quotes[weightOz]
                    ? `Buy postage — ${formatUsd(quotes[weightOz]!.amountCents)}`
                    : rating
                      ? "Getting prices…"
                      : "Buy postage"}
              </NeonButton>
              {quotes[weightOz] && (
                <p className="text-xs text-slate-400 text-center mt-2 max-w-sm">
                  USPS verified this address — {weightOz}oz First-Class letter.
                  Buying charges your EasyPost account.
                </p>
              )}
            </div>
          </div>
        )}
        {easypostKeySaved === false && (
          <p className="text-sm text-slate-400 text-center">
            Want to buy the postage too?{" "}
            <Link
              to="/profile/postage"
              className="text-neon-teal hover:text-neon-teal/80 underline focus:outline-none focus:ring-2 focus:ring-green-500 rounded-sm"
            >
              Add your EasyPost key
            </Link>{" "}
            — about $0.80 for a 1oz letter, a little less than a stamp.
          </p>
        )}

        {lastPurchase && (
          <PurchasedTracking
            name={lastPurchase.name}
            trackingCode={lastPurchase.trackingCode}
          />
        )}

        {/* NEO-213 — the label printed but never reached Label History, so this
            is the last moment it can be recovered. Always mounted so the
            announcement is reliable; empty in the normal case.

            Suppressed while `boughtAwaitingEdit` is set, because that is the
            print-FAILURE path and the alert below already carries the same news
            with the right framing — two messages saying "not saved" would read
            as two separate problems. */}
        <p
          role="status"
          aria-live="polite"
          className="text-sm text-neon-yellow text-center"
        >
          {lastPurchase && !lastPurchase.historySaved && !boughtAwaitingEdit
            ? "Heads up — the label's ready, but it couldn't be saved to your Label History. Print or save it now; it won't be reprintable from here."
            : ""}
        </p>

        {/* Always mounted so the announcement is reliable. Postage failures are
            seller-actionable ("address not found", "insufficient funds"), so the
            message from EasyPost is surfaced rather than flattened. */}
        <p role="alert" className="text-sm text-neon-pink text-center">
          {postageError}
        </p>

        {/* The alert above is a string, and a link inside a live region is not
            reachable as one anyway — a screen reader announces its text, not
            its role. So the route out is a static link beside it, rendered only
            when the message actually names Label History. */}
        {boughtAwaitingEdit && lastPurchase?.historySaved && (
          <p className="text-sm text-center">
            <Link
              to="/print/labels"
              className="text-neon-teal hover:text-neon-teal/80 underline focus:outline-none focus:ring-2 focus:ring-green-500 rounded-sm"
            >
              Go to Label History
            </Link>
          </p>
        )}

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
        <h3 id="label-preview-heading" className="text-lg font-semibold">
          Preview
        </h3>
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

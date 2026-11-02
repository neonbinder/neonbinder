import { useEffect, useId, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import { Switch } from "@/components/primitives/Switch";
import { RunGlyph, type RunLineKind } from "@/components/modules/RunLedger";
import {
  hiddenFrom20Plus,
  isZip,
  needsStandardPolicies,
  over20Options,
  paymentOptions,
  returnOptions,
  setupChecklist,
  standardPicks,
  under20Options,
  type EbayConnectionState,
  type EbayLocation,
  type EbayPolicies,
  type EbayPolicyPicks,
  type EbaySetupGap,
} from "@/lib/marketplace/ebay-setup";
import { EBAY_NAME } from "@/lib/marketplace/listing-copy";
import PolicyPicker, { type SaveAnswer } from "./PolicyPicker";

/**
 * NEO-415 — Profile → eBay's setup, shown while eBay is connected: the
 * seller's own shipping, payment and returns policies (read live from eBay
 * when the page opens, never subscribed), where cards ship from, Best Offer,
 * and the checklist that says what still stands between their boxes and
 * eBay. Every save is the server's: a refusal comes back as NB's sentence
 * and is said in an alert.
 */

export const SECTION = "space-y-5 rounded-lg border border-rule p-6";
const NOTE = "text-sm text-ink-3";

type SetupLine = { kind: "ok" | "error"; text: string } | null;

type Loaded = { state: "loading" } | { state: "error"; error: string } | { state: "ready"; policies: EbayPolicies };

const READ_FAILED = `Couldn't reach ${EBAY_NAME} for your policies. Give it another try.`;

export default function SetupSections({ connection }: { connection: EbayConnectionState }) {
  const readPolicies = useAction(api.ebayConnect.readPolicies);
  const savePolicies = useAction(api.ebayConnect.savePolicies);
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [reads, setReads] = useState(0);

  // Read once on open, and again after "Set me up" or a retry: an action,
  // not a subscription (eBay owns the answer).
  useEffect(() => {
    let live = true;
    readPolicies({}).then(
      (answer) => {
        if (!live) return;
        setLoaded(answer.ok ? { state: "ready", policies: answer } : { state: "error", error: answer.error });
      },
      () => live && setLoaded({ state: "error", error: READ_FAILED }),
    );
    return () => {
      live = false;
    };
  }, [readPolicies, reads]);

  const reread = () => {
    setLoaded({ state: "loading" });
    setReads((n) => n + 1);
  };

  const save = async (picks: EbayPolicyPicks): Promise<SaveAnswer> => savePolicies(picks);

  return (
    <>
      <PoliciesBody
        loaded={loaded}
        connection={connection}
        save={save}
        reread={reread}
        setLoaded={setLoaded}
      />
      <LocationSection saved={connection.settings.location} />
      <OffersSection connection={connection} />
      <SetupChecklist missing={connection.missing} complete={connection.setupComplete} />
    </>
  );
}

function PoliciesBody({
  loaded,
  connection,
  save,
  reread,
  setLoaded,
}: {
  loaded: Loaded;
  connection: EbayConnectionState;
  save: (picks: EbayPolicyPicks) => Promise<SaveAnswer>;
  reread: () => void;
  setLoaded: (next: Loaded) => void;
}) {
  const shippingId = useId();
  const moneyId = useId();
  const settings = connection.settings;
  // Set me up's answer lives here, not in its box: the box goes once nothing
  // is missing, and its answer must outlive it.
  const [setupLine, setSetupLine] = useState<SetupLine>(null);
  const shippingHeading = useRef<HTMLHeadingElement>(null);
  const [focusShipping, setFocusShipping] = useState(0);
  useEffect(() => {
    // The Set me up button may be gone: land on Shipping, where the picks now show.
    if (focusShipping > 0) shippingHeading.current?.focus();
  }, [focusShipping]);

  if (loaded.state !== "ready") {
    return (
      <section aria-labelledby={shippingId} className={SECTION}>
        <h2 id={shippingId} className="text-xl font-semibold text-ink">
          Shipping, payment and returns
        </h2>
        {loaded.state === "loading" ? (
          <p role="status" className={NOTE} aria-busy="true">
            Pulling your policies from {EBAY_NAME}…
          </p>
        ) : (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-neon-pink-text">
              {loaded.error}
            </p>
            <NeonButton type="button" variant="secondary" outline onClick={reread} className="max-sm:min-h-11">
              Try {EBAY_NAME} again
            </NeonButton>
          </div>
        )}
      </section>
    );
  }

  const policies = loaded.policies;
  const hidden = hiddenFrom20Plus(policies);

  return (
    <>
      <section aria-labelledby={shippingId} className={SECTION}>
        <div>
          <h2
            ref={shippingHeading}
            id={shippingId}
            tabIndex={-1}
            className="rounded-sm text-xl font-semibold text-ink focus-outline"
          >
            Shipping
          </h2>
          <p className={`${NOTE} mt-1`}>
            Pick from your own {EBAY_NAME} shipping policies. Cards under $20 can ride Standard Envelope; $20 and up
            need a tracked service.
          </p>
        </div>
        <PolicyPicker
          label="Cards under $20"
          options={under20Options(policies)}
          saved={settings.fulfillmentPolicyUnder20Id}
          onSave={(id) => save({ fulfillmentPolicyUnder20Id: id })}
          emptyLine={`No shipping policies on your ${EBAY_NAME} account yet.`}
        />
        <PolicyPicker
          label="$20 and up"
          options={over20Options(policies)}
          saved={settings.fulfillmentPolicy20PlusId}
          onSave={(id) => save({ fulfillmentPolicy20PlusId: id })}
          emptyLine={`Nothing here can ship a $20 card yet. Standard Envelope only covers cards under $20.`}
        >
          {hidden > 0 && policies.fulfillment.length > hidden && (
            <p className={NOTE}>
              {hidden === 1 ? "One Standard Envelope policy sits" : `${hidden} Standard Envelope policies sit`} this one
              out: Standard Envelope only covers cards under $20.
            </p>
          )}
        </PolicyPicker>
        {needsStandardPolicies(policies) && (
          <SetMeUp
            connection={connection}
            save={save}
            setLoaded={setLoaded}
            reread={reread}
            setLine={setSetupLine}
            onDone={() => setFocusShipping((n) => n + 1)}
          />
        )}
        {setupLine && (
          <p
            key={setupLine.kind}
            role={setupLine.kind === "error" ? "alert" : "status"}
            aria-live={setupLine.kind === "error" ? undefined : "polite"}
            className={`text-sm ${setupLine.kind === "error" ? "text-neon-pink-text" : "text-notice-success-ink"}`}
          >
            {setupLine.text}
          </p>
        )}
      </section>

      <section aria-labelledby={moneyId} className={SECTION}>
        <div>
          <h2 id={moneyId} className="text-xl font-semibold text-ink">
            Payment and returns
          </h2>
          <p className={`${NOTE} mt-1`}>Your {EBAY_NAME} policies again. Every card NeonBinder lists uses these.</p>
        </div>
        <PolicyPicker
          label="Payment"
          options={paymentOptions(policies)}
          saved={settings.paymentPolicyId}
          onSave={(id) => save({ paymentPolicyId: id })}
          emptyLine={`No payment policy on your ${EBAY_NAME} account yet. Set me up, under Shipping, makes one.`}
        />
        <PolicyPicker
          label="Returns"
          options={returnOptions(policies)}
          saved={settings.returnPolicyId}
          onSave={(id) => save({ returnPolicyId: id })}
          emptyLine={`No returns policy on your ${EBAY_NAME} account yet. Set me up, under Shipping, makes one.`}
        />
      </section>
    </>
  );
}

/**
 * "Set me up": makes NB's standard policies on the seller's eBay account
 * (Standard Envelope under $20, tracked Ground Advantage, free shipping, and
 * payment and returns only where there are none), reads them back, and
 * picks them for any slot still empty. A slot already picked stays put.
 */
function SetMeUp({
  connection,
  save,
  setLoaded,
  reread,
  setLine,
  onDone,
}: {
  connection: EbayConnectionState;
  save: (picks: EbayPolicyPicks) => Promise<SaveAnswer>;
  setLoaded: (next: Loaded) => void;
  reread: () => void;
  setLine: (line: SetupLine) => void;
  onDone: () => void;
}) {
  const create = useAction(api.ebayConnect.createStandardPolicies);
  const readPolicies = useAction(api.ebayConnect.readPolicies);
  const [busy, setBusy] = useState(false);
  const describeId = useId();

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setLine(null);
    try {
      const made = await create({});
      if (!made.ok) {
        setLine({ kind: "error", text: made.error });
        return;
      }
      const read = await readPolicies({});
      if (!read.ok) {
        // Made, but the read back failed: show what we have and let a retry pick up the rest.
        setLine({ kind: "error", text: read.error });
        reread();
        return;
      }
      const picks = standardPicks(connection.settings, read, made.created);
      const saved = Object.keys(picks).length > 0 ? await save(picks) : ({ ok: true } as const);
      setLoaded({ state: "ready", policies: read });
      const names = made.created.length > 0 ? `: ${made.created.join(", ")}` : "";
      setLine(
        saved.ok
          ? {
              kind: "ok",
              text: made.created.length > 0 ? `Made ${made.created.length} on your ${EBAY_NAME} account${names}. Picked where you had nothing yet.` : "You already had everything. Pick away.",
            }
          : { kind: "error", text: saved.error },
      );
      onDone();
    } catch {
      setLine({ kind: "error", text: `Couldn't set up your ${EBAY_NAME} policies. Give it another try.` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-dashed border-rule-strong p-4">
      <p id={describeId} className="text-sm text-ink-2">
        Nothing here fits? Set me up makes three shipping policies on your {EBAY_NAME} account: Standard Envelope for
        cards under $20, tracked USPS Ground Advantage, and free shipping. It adds payment and returns too if you have
        none. Then it picks them for you.
      </p>
      <NeonButton
        type="button"
        onClick={() => void run()}
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        aria-describedby={describeId}
        className="max-sm:min-h-11"
      >
        {busy ? "Setting you up…" : "Set me up"}
      </NeonButton>
    </div>
  );
}

type FormLine = { kind: "saving" | "saved" | "error"; text: string } | null;

/**
 * Where cards ship from: eBay shows it on every listing and needs it before
 * one goes up. Prefilled with what's saved; Enter in any field saves.
 */
function LocationSection({ saved }: { saved: EbayLocation | null }) {
  const headingId = useId();
  // Keyed by what's saved, so a save from elsewhere refills the fields.
  return (
    <section aria-labelledby={headingId} className={SECTION}>
      <div>
        <h2 id={headingId} className="text-xl font-semibold text-ink">
          Ships from
        </h2>
        <p className={`${NOTE} mt-1`}>{EBAY_NAME} shows buyers where a card ships from. US addresses only for now.</p>
      </div>
      <LocationForm key={saved ? `${saved.postalCode}|${saved.city}|${saved.stateOrProvince}` : "none"} saved={saved} />
    </section>
  );
}

function LocationForm({ saved }: { saved: EbayLocation | null }) {
  const saveLocation = useAction(api.ebayConnect.saveLocation);
  const [postalCode, setPostalCode] = useState(saved?.postalCode ?? "");
  const [city, setCity] = useState(saved?.city ?? "");
  const [stateOrProvince, setStateOrProvince] = useState(saved?.stateOrProvince ?? "");
  const [zipError, setZipError] = useState("");
  const [line, setLine] = useState<FormLine>(null);
  const busy = line?.kind === "saving";

  const submit = async () => {
    if (busy) return;
    const zip = postalCode.trim();
    if (!isZip(zip)) {
      setZipError("A five-digit ZIP code, like 53703.");
      return;
    }
    setZipError("");
    if (!city.trim() || !stateOrProvince.trim()) {
      setLine({ kind: "error", text: "Fill in the city and state too." });
      return;
    }
    setLine({ kind: "saving", text: "Saving…" });
    try {
      const answer = await saveLocation({
        postalCode: zip,
        city: city.trim(),
        stateOrProvince: stateOrProvince.trim().toUpperCase(),
      });
      setLine(answer.ok ? { kind: "saved", text: "Saved. Your cards ship from here." } : { kind: "error", text: answer.error });
    } catch {
      setLine({ kind: "error", text: `That didn't save to ${EBAY_NAME}. Give it another try.` });
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,8rem)_minmax(0,1fr)_minmax(0,6rem)]">
        <Input
          label="ZIP code"
          className="min-h-11"
          value={postalCode}
          onChange={(e) => setPostalCode(e.target.value)}
          inputMode="numeric"
          autoComplete="postal-code"
          error={zipError || undefined}
        />
        <Input label="City" className="min-h-11" value={city} onChange={(e) => setCity(e.target.value)} autoComplete="address-level2" />
        <Input
          label="State"
          className="min-h-11"
          value={stateOrProvince}
          onChange={(e) => setStateOrProvince(e.target.value)}
          autoComplete="address-level1"
          maxLength={2}
          placeholder="WI"
        />
      </div>
      <NeonButton
        type="submit"
        variant="secondary"
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        className="max-sm:min-h-11"
      >
        {busy ? "Saving…" : "Save ships-from"}
      </NeonButton>
      <p
        key={line?.kind === "error" ? "error" : "ok"}
        role={line?.kind === "error" ? "alert" : "status"}
        aria-live={line?.kind === "error" ? undefined : "polite"}
        className={`text-sm ${line?.kind === "error" ? "text-neon-pink-text" : "text-ink-3"}`}
      >
        {line?.kind === "saving" ? "" : (line?.text ?? "")}
      </p>
    </form>
  );
}

/**
 * Best Offer on every card NB lists (on by default). The switch flips at
 * once (an optimistic update on the connection state); a failed save is
 * rolled back by Convex and an alert says so.
 */
function OffersSection({ connection }: { connection: EbayConnectionState }) {
  const headingId = useId();
  const describeId = useId();
  const switchId = useId();
  const [failed, setFailed] = useState(false);
  const setBestOffer = useMutation(api.ebayConnect.setBestOffer).withOptimisticUpdate((local, args) => {
    const current = local.getQuery(api.ebayConnect.connectionState, {});
    if (!current) return;
    local.setQuery(api.ebayConnect.connectionState, {}, {
      ...current,
      settings: { ...current.settings, bestOffer: args.on },
    });
  });
  const on = connection.settings.bestOffer;

  const flip = async (next: boolean) => {
    setFailed(false);
    try {
      await setBestOffer({ on: next });
    } catch {
      setFailed(true);
    }
  };

  return (
    <section aria-labelledby={headingId} className={SECTION}>
      <h2 id={headingId} className="text-xl font-semibold text-ink">
        Offers
      </h2>
      <div className="space-y-1">
        {/* The whole row is the label: a 44px target, and the switch's name. */}
        <label htmlFor={switchId} className="flex min-h-11 cursor-pointer items-center gap-3">
          <Switch id={switchId} checked={on} onCheckedChange={(next) => void flip(next)} aria-describedby={describeId} />
          <span className="text-sm font-medium text-ink">Take Best Offers</span>
        </label>
        <p id={describeId} className={NOTE}>
          Buyers can send an offer on any card NeonBinder lists. You take it or leave it on {EBAY_NAME}.
        </p>
      </div>
      <p
        key={failed ? "failed" : "ok"}
        role={failed ? "alert" : "status"}
        aria-live={failed ? undefined : "polite"}
        className={`text-sm ${failed ? "text-neon-pink-text" : "text-ink-3"}`}
      >
        {failed ? "That didn't save, so Best Offer is back how it was. Give it another try." : ""}
      </p>
    </section>
  );
}

const STEP_TONES: Record<RunLineKind, string> = {
  waiting: "text-ink-3",
  building: "text-neon-blue-text motion-safe:animate-spin",
  built: "text-neon-green-text",
  skipped: "text-ink-3",
  blocked: "text-neon-yellow-text",
  stopped: "text-ink-3",
  failed: "text-neon-pink-text",
  unfinished: "text-neon-yellow-text",
};

/**
 * What still stands between the collector's boxes and eBay, one line a
 * step, ticking off as each saves (the run ledger's glyphs). Done, it folds
 * to one line. That line is a polite live region, so finishing the last step
 * is announced.
 */
export function SetupChecklist({ missing, complete }: { missing: EbaySetupGap[]; complete: boolean }) {
  const headingId = useId();
  const steps = setupChecklist(missing);
  return (
    <section
      aria-labelledby={headingId}
      className={`space-y-3 rounded-lg p-6 ${complete ? "border border-notice-success-rule bg-notice-success-bg" : "bg-raised shadow-offset"}`}
    >
      <h2 id={headingId} className={`text-xl font-semibold ${complete ? "text-notice-success-ink" : "text-ink"}`}>
        {complete ? "You're all set" : "Finish these and your boxes go up"}
      </h2>
      {!complete && (
        <ul className="space-y-1.5">
          {steps.map((step) => (
            <li key={step.gap} className="flex items-start gap-2 text-sm">
              <RunGlyph kind={step.done ? "built" : "waiting"} tones={STEP_TONES} />
              <span className={step.done ? "text-ink-3" : "text-ink"}>
                {step.label}
                <span className="sr-only">{step.done ? ", done" : ", still to do"}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p role="status" aria-live="polite" className={`text-sm ${complete ? "text-notice-success-ink" : "text-ink-3"}`}>
        {complete
          ? `Everything in a listed box lists on ${EBAY_NAME} at your count.`
          : `${steps.filter((s) => !s.done).length} to go. Nothing lists on ${EBAY_NAME} until they're done.`}
      </p>
    </section>
  );
}

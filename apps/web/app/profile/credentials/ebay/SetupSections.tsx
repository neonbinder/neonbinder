import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
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
  SET_ME_UP_STEPS_NAME,
  SETUP_STEP_WORD,
  setupChecklist,
  setupLandedLine,
  setupStepName,
  shownSetupStatus,
  standardPicks,
  under20Options,
  type EbayConnectionState,
  type EbayLocation,
  type EbayPolicies,
  type EbayPolicyPicks,
  type EbaySetupGap,
  type EbaySetupStep,
  type EbaySetupStepStatus,
} from "@/lib/marketplace/ebay-setup";
import { EBAY_NAME } from "@/lib/marketplace/listing-copy";
import PolicyPicker, { type SaveAnswer } from "./PolicyPicker";

/**
 * NEO-415 — the eBay tab's setup on Profile → Credentials, shown while eBay
 * is connected: the
 * seller's own shipping, payment and returns policies (read live from eBay
 * when the page opens, never subscribed), where cards ship from, Best Offer,
 * and the checklist that says what still stands between their boxes and
 * eBay. Every save is the server's: a refusal comes back as NB's sentence
 * and is said in an alert.
 *
 * Ships from comes first: eBay prices each buyer's shipping from its ZIP, so
 * "Set me up" waits for it (the server refuses until it's saved).
 *
 * Until the setup is done the checklist leads, right under the connection,
 * and each step is a link that focuses its section's heading; done, it folds
 * to one line at the foot.
 *
 * A card is a flex column with a gap, not `space-y`: its live lines sit
 * `empty:absolute`, so an empty one leaves no phantom gap at the foot and
 * still speaks when it fills.
 */

/**
 * A setup card. It sits inside the Credentials box, so it is the inner box
 * BuySportsCards' listing section uses (rounded-md, p-4), not a page card,
 * and its heading is an h3 under the panel's "eBay".
 */
const SECTION = "flex flex-col gap-4 rounded-md border border-rule p-4 sm:p-5";
const NOTE = "text-sm text-ink-3";
/** A section heading a checklist step can land on. */
const LANDING = "rounded-sm text-lg font-semibold text-ink focus-outline";
/** A live line: out of the flow while empty, in the accessibility tree always. */
const LIVE = "text-sm empty:absolute";

type SetupLine = { kind: "progress" | "ok" | "error"; text: string } | null;

type Loaded = { state: "loading" } | { state: "error"; error: string } | { state: "ready"; policies: EbayPolicies };

const READ_FAILED = `Couldn't reach ${EBAY_NAME} for your policies. Give it another try.`;
/**
 * Set me up made the policies, but reading them back to pick them failed: Try
 * again picks, and makes nothing. The read's cause isn't always eBay, so the
 * line never blames it.
 */
const MADE_NOT_PICKED =
  "Your new policies are made, but we couldn't read them back just now, so nothing's picked yet. Give it a bit, then press Try again to pick them. It won't make them twice.";

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

  const shippingId = useId();
  const moneyId = useId();
  const locationId = useId();
  const landings: Record<EbaySetupGap, string> = {
    shippingUnder20: shippingId,
    shipping20Plus: shippingId,
    payment: moneyId,
    returns: moneyId,
    location: locationId,
  };

  // Finishing the last step in this visit is announced; arriving already set up is not.
  const complete = connection.setupComplete;
  const [sawUnfinished, setSawUnfinished] = useState(!complete);
  if (!complete && !sawUnfinished) setSawUnfinished(true);

  return (
    <>
      {!complete && <SetupChecklist missing={connection.missing} complete={false} landings={landings} />}
      <LocationSection saved={connection.settings.location} headingId={locationId} />
      <PoliciesBody
        loaded={loaded}
        connection={connection}
        save={save}
        reread={reread}
        setLoaded={setLoaded}
        shippingId={shippingId}
        moneyId={moneyId}
      />
      <OffersSection connection={connection} />
      {complete && <SetupChecklist missing={connection.missing} complete announce={sawUnfinished} />}
    </>
  );
}

/**
 * Shipping, then Payment and returns: both cards with their final headings
 * from the start, so the page never changes shape when eBay answers. The
 * read's progress or failure sits in the first.
 */
function PoliciesBody({
  loaded,
  connection,
  save,
  reread,
  setLoaded,
  shippingId,
  moneyId,
}: {
  loaded: Loaded;
  connection: EbayConnectionState;
  save: (picks: EbayPolicyPicks) => Promise<SaveAnswer>;
  reread: () => void;
  setLoaded: (next: Loaded) => void;
  shippingId: string;
  moneyId: string;
}) {
  const settings = connection.settings;
  // Set me up's answer lives here, not in its box: the box goes once nothing
  // is missing, and its answer must outlive it.
  const [setupLine, setSetupLine] = useState<SetupLine>(null);
  // Set me up's ledger is the run THIS press started: the stored run's start
  // as the press saw it (null: none yet), so an earlier run's finished ledger
  // never stands in while the new one begins. Unset until a press.
  const [pressedOver, setPressedOver] = useState<number | null | undefined>(undefined);
  const progress = connection.setupProgress ?? null;
  const run = pressedOver !== undefined && progress && progress.startedAt !== pressedOver ? progress : null;
  const running = setupLine?.kind === "progress";
  const landed = useLandedLine(run);
  const shippingHeading = useRef<HTMLHeadingElement>(null);
  const [focusShipping, setFocusShipping] = useState(0);
  useEffect(() => {
    // The Set me up button may be gone: land on Shipping, where the picks now show.
    if (focusShipping > 0) shippingHeading.current?.focus();
  }, [focusShipping]);

  const policies = loaded.state === "ready" ? loaded.policies : null;
  const hidden = policies ? hiddenFrom20Plus(policies) : 0;

  return (
    <>
      <section aria-labelledby={shippingId} className={SECTION}>
        <div>
          <h3 ref={shippingHeading} id={shippingId} tabIndex={-1} className={LANDING}>
            Shipping
          </h3>
          <p className={`${NOTE} mt-1`}>
            Pick from your own {EBAY_NAME} shipping policies. Cards under $20 can ride Standard Envelope; $20 and up
            need a tracked service.
          </p>
        </div>
        {loaded.state === "loading" && (
          <p role="status" className={NOTE}>
            Pulling your policies from {EBAY_NAME}…
          </p>
        )}
        {loaded.state === "error" && (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-neon-pink-text">
              {loaded.error}
            </p>
            <NeonButton type="button" variant="secondary" outline onClick={reread} className="max-sm:min-h-11">
              Try {EBAY_NAME} again
            </NeonButton>
          </div>
        )}
        {policies && (
          <>
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
            setLine={setSetupLine}
            onStart={() => setPressedOver(connection.setupProgress?.startedAt ?? null)}
            onDone={() => setFocusShipping((n) => n + 1)}
          />
        )}
          </>
        )}
        {/* Outside the Set me up box, so the run's ledger outlives the box once nothing is missing. */}
        {run && <SetupLedger steps={run.steps} running={running} />}
        {/*
          Both always mounted, empty until they speak, so each says what fills
          it (a node that mounts already holding text is often not announced,
          and a press after an error must not swap the status for a new one).
          The polite line covers the whole run: while it goes it says each step
          as it lands (visually hidden, since the ledger and the button show the
          same), then the answer replaces it. A refusal goes in the alert.
        */}
        <p
          role="status"
          aria-live="polite"
          className={`${LIVE} ${setupLine?.kind === "ok" ? "text-neon-green-text" : "sr-only"}`}
        >
          {setupLine?.kind === "error" ? "" : (running && landed) || (setupLine?.text ?? "")}
        </p>
        <p role="alert" className={`${LIVE} text-neon-pink-text`}>
          {setupLine?.kind === "error" ? setupLine.text : ""}
        </p>
      </section>

      <section aria-labelledby={moneyId} className={SECTION}>
        <div>
          <h3 id={moneyId} tabIndex={-1} className={LANDING}>
            Payment and returns
          </h3>
          <p className={`${NOTE} mt-1`}>Your {EBAY_NAME} policies again. Every card NeonBinder lists uses these.</p>
        </div>
        {policies && (
          <>
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
          </>
        )}
      </section>
    </>
  );
}

/**
 * "Set me up": makes NB's standard policies on the seller's eBay account
 * (Standard Envelope under $20 and tracked Ground Advantage, both priced by
 * eBay for the card's weight, free shipping, and payment and returns only
 * where there are none), reads them back, and picks them for any slot still
 * empty. A slot already picked stays put.
 *
 * Waits for Ships from: eBay prices each buyer's shipping from that ZIP, so
 * until it's saved the button stays (reachable, `aria-disabled`, never
 * hidden) and a line beside it, which describes it, says to save that first.
 *
 * Made but not read back: the box stays, says so, and its button becomes
 * "Try again", which reads and picks without making anything twice. Focus
 * stays on that button; on success it moves to the Shipping heading.
 */
/** eBay turned down the Standard Envelope policy; everything else Set me up does still happened. */
const NO_ENVELOPE = `${EBAY_NAME} wouldn't make a Standard Envelope policy, so pick one of yours for cards under $20.`;

/** What Set me up says when it's done: what it made, and whether cards under $20 are still the collector's pick. */
function setMeUpDone(created: readonly string[], envelopeRefused: boolean): string {
  if (created.length === 0) return envelopeRefused ? `You already had the rest. ${NO_ENVELOPE}` : "You already had everything. Pick away.";
  const made = `Made ${created.length} on your ${EBAY_NAME} account: ${created.join(", ")}. Picked where you had nothing yet.`;
  return envelopeRefused ? `${made} ${NO_ENVELOPE}` : made;
}

function SetMeUp({
  connection,
  save,
  setLoaded,
  setLine,
  onStart,
  onDone,
}: {
  connection: EbayConnectionState;
  save: (picks: EbayPolicyPicks) => Promise<SaveAnswer>;
  setLoaded: (next: Loaded) => void;
  setLine: (line: SetupLine) => void;
  /** A run on eBay is about to start (not a Try again, which only reads): its ledger is the one to show. */
  onStart: () => void;
  onDone: () => void;
}) {
  const create = useAction(api.ebayConnect.createStandardPolicies);
  const readPolicies = useAction(api.ebayConnect.readPolicies);
  const [busy, setBusy] = useState(false);
  /** What the last run made, when reading it back failed: a retry picks from these. */
  const [made, setMade] = useState<string[] | null>(null);
  /** The last run's eBay turned the Standard Envelope policy down (kept for a retry of the read). */
  const [envelopeRefused, setEnvelopeRefused] = useState(false);
  const describeId = useId();
  const waitId = useId();
  // Matches the server's own gate (`ebaySetupMissing`): no saved ship-from, no Set me up.
  const needsLocation = connection.missing.includes("location");

  const run = async () => {
    if (busy || needsLocation) return;
    setBusy(true);
    setLine({ kind: "progress", text: "Setting you up…" });
    let created = made;
    let noEnvelope = envelopeRefused;
    try {
      if (created === null) {
        onStart();
        const answer = await create({});
        if (!answer.ok) {
          setLine({ kind: "error", text: answer.error });
          return;
        }
        created = answer.created;
        noEnvelope = answer.envelopeRefused === true;
        setEnvelopeRefused(noEnvelope);
      }
      const read = await readPolicies({});
      if (!read.ok) {
        setMade(created);
        // One message of our own, not the read's sentence with ours stuck on (both said "Try again"): what's
        // done, what isn't, and what the button does now. The connection's own state says any lost sign-in.
        setLine({ kind: "error", text: MADE_NOT_PICKED });
        return;
      }
      const picks = standardPicks(connection.settings, read, created);
      const saved = Object.keys(picks).length > 0 ? await save(picks) : ({ ok: true } as const);
      setMade(null);
      setLoaded({ state: "ready", policies: read });
      setLine(saved.ok ? { kind: "ok", text: setMeUpDone(created, noEnvelope) } : { kind: "error", text: saved.error });
      onDone();
    } catch {
      if (created !== null) setMade(created);
      setLine({ kind: "error", text: `Couldn't set up your ${EBAY_NAME} policies. Give it another try.` });
    } finally {
      setBusy(false);
    }
  };

  const label = made !== null ? "Try again" : "Set me up";
  return (
    <div className="space-y-3 rounded-md border border-dashed border-rule-strong p-4">
      <p id={describeId} className="text-sm text-ink-2">
        Nothing here fits? Set me up makes three shipping policies on your {EBAY_NAME} account: Standard Envelope for
        cards under $20, tracked USPS Ground Advantage, and free shipping. On the first two, buyers pay
        {` ${EBAY_NAME}'s `}own rate for the card&apos;s weight. It adds payment and returns too if you have none.
        Then it picks them for you.
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <NeonButton
          type="button"
          onClick={() => void run()}
          aria-disabled={busy || needsLocation || undefined}
          aria-busy={busy || undefined}
          aria-describedby={needsLocation ? `${waitId} ${describeId}` : describeId}
          className="max-sm:min-h-11"
        >
          {busy ? "Setting you up…" : label}
        </NeonButton>
        {needsLocation && (
          <p id={waitId} className="text-sm text-ink-2">
            Save where you ship from first, up in Ships from. {EBAY_NAME} prices each buyer&apos;s shipping from your
            ZIP.
          </p>
        )}
      </div>
    </div>
  );
}

/** Which ledger glyph a Set me up step wears (the run ledger's clock, spinner, check and snag). */
const STEP_GLYPH: Record<EbaySetupStepStatus, RunLineKind> = {
  waiting: "waiting",
  working: "building",
  done: "built",
  failed: "failed",
  had: "skipped",
  stopped: "stopped",
};

/** The step's words: settled ink once it lands, quiet while it waits or when there was nothing to do. */
const STEP_TEXT: Record<EbaySetupStepStatus, string> = {
  waiting: "text-ink-3",
  working: "font-medium text-ink",
  done: "text-ink",
  failed: "font-medium text-neon-pink-text",
  had: "text-ink-2",
  stopped: "text-ink-3",
};

/** States a sighted reader can't tell from the glyph alone say their word on screen too. */
const SAYS_STATE: ReadonlySet<EbaySetupStepStatus> = new Set(["failed", "had", "stopped"]);

/**
 * Set me up's run, one line a step, as the listing sync's ledger (Jason's
 * per-step pattern): clock → spinner → green check, a pink warning where eBay
 * said no. Each list item is named "label, state" and its own words say the
 * same, so a reader in browse mode and a spec's `getByRole` agree.
 */
function SetupLedger({ steps, running }: { steps: ReadonlyArray<EbaySetupStep>; running: boolean }) {
  return (
    // role="list": Safari/VoiceOver drops a list's semantics under list-style: none unless it is said outright.
    <ol role="list" aria-label={SET_ME_UP_STEPS_NAME} className="space-y-0.5 border-l-2 border-rule pl-3 text-sm">
      {steps.map((step) => {
        const status = shownSetupStatus(step.status, running);
        const word = SETUP_STEP_WORD[status];
        return (
          <li key={step.step} aria-label={setupStepName(step.label, status)} className="flex items-start gap-1.5 py-0.5 leading-5">
            <RunGlyph kind={STEP_GLYPH[status]} tones={STEP_TONES} />
            <span className={STEP_TEXT[status]}>
              {step.label}
              {SAYS_STATE.has(status) ? <span>, {word}</span> : <span className="sr-only">, {word}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The live line's sentence for a Set me up run, from each read compared with
 * the last, during render (by value, so a fresh array holding the same ledger
 * changes nothing). A step landing is said once and stays until the next one
 * lands; a new run starts silent.
 */
function useLandedLine(run: { startedAt: number; steps: ReadonlyArray<EbaySetupStep> } | null): string {
  const key = run ? `${run.startedAt}#${run.steps.map((s) => `${s.step}:${s.status}`).join("|")}` : "";
  const [seen, setSeen] = useState(() => ({ key, run, line: "" }));
  if (seen.key !== key) {
    const sameRun = seen.run !== null && run !== null && seen.run.startedAt === run.startedAt;
    // A run's first read may already be under way (the check landed before the
    // page heard): compare it with the same steps all still waiting, so that
    // landing is said too.
    const before = sameRun && seen.run ? seen.run.steps : run ? run.steps.map((s) => ({ ...s, status: "waiting" as const })) : [];
    const said = run ? setupLandedLine(before, run.steps) : "";
    setSeen({ key, run, line: said || (sameRun ? seen.line : "") });
  }
  return seen.line;
}

type FormLine = { kind: "saving" | "saved" | "error"; text: string } | null;

type FieldErrors = { postalCode?: string; city?: string; stateOrProvince?: string };

const ZIP_HINT = "A ZIP code, like 53703 or 53703-1234.";

const locationKey = (l: EbayLocation | null) => (l ? `${l.postalCode}|${l.city}|${l.stateOrProvince}` : "none");

/**
 * Where cards ship from: eBay shows it on every listing and needs it before
 * one goes up. Prefilled with what's saved; Enter in any field saves.
 */
function LocationSection({ saved, headingId }: { saved: EbayLocation | null; headingId: string }) {
  return (
    <section aria-labelledby={headingId} className={SECTION}>
      <div>
        <h3 id={headingId} tabIndex={-1} className={LANDING}>
          Ships from
        </h3>
        <p className={`${NOTE} mt-1`}>{EBAY_NAME} shows buyers where a card ships from. US addresses only for now.</p>
      </div>
      <LocationForm saved={saved} />
    </section>
  );
}

/**
 * Stays mounted through a save, so focus and the "Saved." line survive the
 * query catching up. A save from elsewhere refills the fields, unless the
 * collector has typed since. A refused submit marks every field it needs
 * and moves focus to the first, once its error is on it.
 */
function LocationForm({ saved }: { saved: EbayLocation | null }) {
  const saveLocation = useAction(api.ebayConnect.saveLocation);
  const [postalCode, setPostalCode] = useState(saved?.postalCode ?? "");
  const [city, setCity] = useState(saved?.city ?? "");
  const [stateOrProvince, setStateOrProvince] = useState(saved?.stateOrProvince ?? "");
  const [dirty, setDirty] = useState(false);
  const [seen, setSeen] = useState(() => locationKey(saved));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [line, setLine] = useState<FormLine>(null);
  const busy = line?.kind === "saving";
  const zipRef = useRef<HTMLInputElement>(null);
  const cityRef = useRef<HTMLInputElement>(null);
  const stateRef = useRef<HTMLInputElement>(null);
  const focusField = useRef<HTMLInputElement | null>(null);

  // What's saved changed: refill, unless the collector is mid-edit.
  const key = locationKey(saved);
  if (key !== seen) {
    setSeen(key);
    if (!dirty) {
      setPostalCode(saved?.postalCode ?? "");
      setCity(saved?.city ?? "");
      setStateOrProvince(saved?.stateOrProvince ?? "");
    }
  }

  // After the errors render (aria-invalid and the message on the field), focus the first.
  useEffect(() => {
    focusField.current?.focus();
    focusField.current = null;
  }, [errors]);

  const edit = (field: keyof FieldErrors, set: (v: string) => void) => (e: ChangeEvent<HTMLInputElement>) => {
    set(e.target.value);
    setDirty(true);
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const submit = async () => {
    if (busy) return;
    const zip = postalCode.trim();
    const next: FieldErrors = {};
    if (!isZip(zip)) next.postalCode = ZIP_HINT;
    if (!city.trim()) next.city = "Add the city your cards ship from.";
    if (!stateOrProvince.trim()) next.stateOrProvince = "Add the state, like WI.";
    if (next.postalCode || next.city || next.stateOrProvince) {
      focusField.current = next.postalCode ? zipRef.current : next.city ? cityRef.current : stateRef.current;
      setErrors(next);
      setLine(null);
      return;
    }
    setErrors({});
    const sent = { postalCode: zip, city: city.trim(), stateOrProvince: stateOrProvince.trim().toUpperCase() };
    setLine({ kind: "saving", text: "Saving…" });
    try {
      const answer = await saveLocation(sent);
      if (answer.ok) {
        setPostalCode(sent.postalCode);
        setCity(sent.city);
        setStateOrProvince(sent.stateOrProvince);
        setDirty(false);
        setLine({ kind: "saved", text: "Saved. Your cards ship from here." });
      } else {
        setLine({ kind: "error", text: answer.error });
      }
    } catch {
      setLine({ kind: "error", text: `That didn't save to ${EBAY_NAME}. Give it another try.` });
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,8rem)_minmax(0,1fr)_minmax(0,6rem)]">
        <Input
          ref={zipRef}
          label="ZIP code"
          className="min-h-11"
          value={postalCode}
          onChange={edit("postalCode", setPostalCode)}
          inputMode="numeric"
          autoComplete="postal-code"
          aria-required="true"
          error={errors.postalCode}
        />
        <Input
          ref={cityRef}
          label="City"
          className="min-h-11"
          value={city}
          onChange={edit("city", setCity)}
          autoComplete="address-level2"
          aria-required="true"
          error={errors.city}
        />
        <Input
          ref={stateRef}
          label="State"
          className="min-h-11"
          value={stateOrProvince}
          onChange={edit("stateOrProvince", setStateOrProvince)}
          autoComplete="address-level1"
          aria-required="true"
          maxLength={2}
          helperText="Two letters, like WI."
          error={errors.stateOrProvince}
        />
      </div>
      <NeonButton
        type="submit"
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        className="self-start max-sm:min-h-11"
      >
        {busy ? "Saving…" : "Save location"}
      </NeonButton>
      <p
        key={line?.kind === "error" ? "error" : "ok"}
        role={line?.kind === "error" ? "alert" : "status"}
        aria-live={line?.kind === "error" ? undefined : "polite"}
        className={`${LIVE} ${line?.kind === "error" ? "text-neon-pink-text" : "text-ink-3"}`}
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
      <h3 id={headingId} className="text-lg font-semibold text-ink">
        Offers
      </h3>
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
        className={`${LIVE} ${failed ? "text-neon-pink-text" : "text-ink-3"}`}
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
 * step, ticking off as each saves (the run ledger's glyphs). Each step is a
 * link that focuses its section's heading: an in-page jump, so it stays out
 * of history (no hash in the URL, nothing for Back to step through).
 *
 * Done, it folds to one line at the foot. That line is a polite live region;
 * when the last step was finished in this visit (`announce`) it mounts empty
 * and fills, so finishing is announced rather than present on arrival.
 */
export function SetupChecklist(
  props:
    | { missing: EbaySetupGap[]; complete: false; landings: Record<EbaySetupGap, string> }
    | { missing: EbaySetupGap[]; complete: true; announce?: boolean },
) {
  const headingId = useId();
  if (props.complete) return <SetupDone headingId={headingId} announce={props.announce ?? false} />;
  const steps = setupChecklist(props.missing);
  const { landings } = props;
  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-md bg-raised p-4 shadow-offset sm:p-5">
      <h3 id={headingId} className="text-lg font-semibold text-ink">
        Finish these and your boxes go up
      </h3>
      <ul className="space-y-1">
        {steps.map((step) => (
          <li key={step.gap} className="flex items-center gap-2 text-sm">
            <RunGlyph kind={step.done ? "built" : "waiting"} tones={STEP_TONES} />
            <a
              href={`#${landings[step.gap]}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(landings[step.gap])?.focus();
              }}
              className={`inline-flex min-h-6 items-center rounded-sm underline decoration-rule-strong underline-offset-4 hover:decoration-current focus-outline max-sm:min-h-11 ${
                step.done ? "text-ink-3" : "text-ink"
              }`}
            >
              {step.label}
              <span className="sr-only">{step.done ? ", done" : ", still to do"}</span>
            </a>
          </li>
        ))}
      </ul>
      <p role="status" aria-live="polite" className="text-sm text-ink-3">
        {`${steps.filter((s) => !s.done).length} to go. Nothing lists on ${EBAY_NAME} until they're done.`}
      </p>
    </section>
  );
}

const DONE_LINE = `Everything in a listed box lists on ${EBAY_NAME} at your count.`;

function SetupDone({ headingId, announce }: { headingId: string; announce: boolean }) {
  const [said, setSaid] = useState(!announce);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate second commit: the line mounts empty, so filling it is announced
    setSaid(true);
  }, []);
  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded-md border border-notice-success-rule bg-notice-success-bg p-4 sm:p-5"
    >
      <h3 id={headingId} className="text-lg font-semibold text-notice-success-ink">
        You&apos;re all set
      </h3>
      <p role="status" aria-live="polite" className="text-sm text-notice-success-ink">
        {said ? DONE_LINE : ""}
      </p>
    </section>
  );
}

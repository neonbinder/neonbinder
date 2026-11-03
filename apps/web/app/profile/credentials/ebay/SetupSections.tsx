import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ChangeEvent, type Ref } from "react";
import { useAction, useMutation } from "convex/react";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { api } from "@/convex/_generated/api";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import { Switch } from "@/components/primitives/Switch";
import ModeRadioGroup from "@/components/primitives/ModeRadioGroup";
import { RunGlyph, type RunLineKind } from "@/components/modules/RunLedger";
import {
  hiddenFrom20Plus,
  isZip,
  over20Options,
  paymentOptions,
  returnOptions,
  SET_ME_UP_STEPS_NAME,
  SETUP_STEP_WORD,
  setupChecklist,
  setupLandedLine,
  setupStepName,
  shownSetupStatus,
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
import { EBAY_MAX_CARD_WEIGHT_OZ, isValidCardWeightOz } from "@/convex/lib/ebayListing";
import PolicyPicker, { type SaveAnswer } from "./PolicyPicker";
import { refusalSentence } from "./refusal";

/**
 * NEO-415 — the eBay tab's setup on Profile → Credentials, shown while eBay
 * is connected: the
 * seller's own shipping, payment and returns policies (read live from eBay
 * when the page opens, never subscribed), where cards ship from, the weight of a single card, Best Offer,
 * and the checklist that says what still stands between their boxes and
 * eBay. Every save is the server's: a refusal comes back as NB's sentence
 * and is said in an alert.
 *
 * Ships from comes first: eBay shows it on every listing. Shipping is always
 * the seller's own pick from their own eBay policies; Set me up makes only
 * payment and returns (NEO-423 tracks NB making shipping policies).
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
/** The connection as `ebayConnect.connectionState` answers it: the setup, plus the weight of a single card. */
export type EbayConnection = EbayConnectionState & { cardWeightOz: number };

export default function SetupSections({ connection }: { connection: EbayConnection }) {
  const readPolicies = useAction(api.ebayConnect.readPolicies);
  const savePolicies = useAction(api.ebayConnect.savePolicies);
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  // Only the newest read lands: an older one answering late never overwrites it.
  const latestRead = useRef(0);

  // An action, not a subscription (eBay owns the answer). The answer is
  // returned too, so a press can say what came back.
  const read = useCallback(async (): Promise<Loaded> => {
    const mine = ++latestRead.current;
    let next: Loaded;
    try {
      const answer = await readPolicies({});
      next = answer.ok ? { state: "ready", policies: answer } : { state: "error", error: answer.error };
    } catch {
      next = { state: "error", error: READ_FAILED };
    }
    if (mine === latestRead.current) setLoaded(next);
    return next;
  }, [readPolicies]);

  // Read once on open.
  useEffect(() => {
    void read();
  }, [read]);

  /** Read again ("Try eBay again", "Check eBay again"). */
  const reread = (): Promise<Loaded> => {
    setLoaded({ state: "loading" });
    return read();
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
      <PackingSection saved={connection.cardWeightOz} />
      <OffersSection connection={connection} />
      {complete && <SetupChecklist missing={connection.missing} complete announce={sawUnfinished} />}
    </>
  );
}

/**
 * Shipping, then Payment and returns: both cards with their final headings
 * from the start, so the page never changes shape when eBay answers. The
 * read's progress or failure sits in the first.
 *
 * Shipping is always the seller's own pick from their own eBay shipping
 * policies (NB makes none: NEO-423). With none on the account at all, the
 * card says so, links out to make one on eBay, and offers a fresh read for
 * when they're back.
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
  reread: () => Promise<Loaded>;
  setLoaded: (next: Loaded) => void;
  shippingId: string;
  moneyId: string;
}) {
  const settings = connection.settings;
  const shippingHeading = useRef<HTMLHeadingElement>(null);
  const checkAgain = useRef<HTMLButtonElement>(null);
  // What the last re-read found, said in a line that is always mounted (the
  // buttons that asked unmount while it reads, so they can't say it).
  const [readLine, setReadLine] = useState("");
  // Where focus goes once a re-read's answer is on screen: a count, so the same place twice still moves it.
  const [refocus, setRefocus] = useState<{ n: number; to: "heading" | "check" }>({ n: 0, to: "heading" });
  useEffect(() => {
    if (refocus.n === 0) return;
    (refocus.to === "check" ? checkAgain.current : shippingHeading.current)?.focus();
  }, [refocus]);

  /**
   * The button pressed unmounts while eBay is read, so focus parks on the
   * Shipping heading first. Pickers back: it stays there and the line says
   * so. Still nothing to pick: back to "Check eBay again", and the line says
   * that too. A failed read says itself in its alert.
   */
  const recheck = async () => {
    shippingHeading.current?.focus();
    setReadLine("");
    const next = await reread();
    if (next.state !== "ready") return;
    const still =
      next.policies.fulfillment.length === 0
        ? STILL_NO_SHIPPING
        : over20Options(next.policies).length === 0
          ? STILL_NO_TRACKED
          : null;
    setReadLine(still ?? SHIPPING_IN);
    setRefocus((r) => ({ n: r.n + 1, to: still ? "check" : "heading" }));
  };
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
  const moneyHeading = useRef<HTMLHeadingElement>(null);
  const [focusMoney, setFocusMoney] = useState(0);
  useEffect(() => {
    // The Set me up button may be gone: land on Payment and returns, where the picks now show.
    if (focusMoney > 0) moneyHeading.current?.focus();
  }, [focusMoney]);

  const policies = loaded.state === "ready" ? loaded.policies : null;
  const hidden = policies ? hiddenFrom20Plus(policies) : 0;
  const sandbox = connection.environment === "sandbox";

  return (
    <>
      <section aria-labelledby={shippingId} className={SECTION}>
        <div>
          <h3 ref={shippingHeading} id={shippingId} tabIndex={-1} className={LANDING}>
            Shipping
          </h3>
          <p className={`${NOTE} mt-1`}>
            Pick two of your own {EBAY_NAME} shipping policies: one for cards under $20, one for $20 and up.
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
            <NeonButton type="button" variant="secondary" outline onClick={() => void recheck()} className="max-sm:min-h-11">
              Try {EBAY_NAME} again
            </NeonButton>
          </div>
        )}
        {policies && policies.fulfillment.length === 0 && (
          <NoShippingPolicies sandbox={sandbox} onCheck={() => void recheck()} checkRef={checkAgain} />
        )}
        {policies && policies.fulfillment.length > 0 && (
          <>
            <PolicyPicker
              label="Cards under $20"
              options={under20Options(policies)}
              saved={settings.fulfillmentPolicyUnder20Id}
              onSave={(id) => save({ fulfillmentPolicyUnder20Id: id })}
              emptyLine={`No shipping policies on your ${EBAY_NAME} account yet.`}
              hint={UNDER_20_HINT}
            />
            <PolicyPicker
              label="$20 and up"
              options={over20Options(policies)}
              saved={settings.fulfillmentPolicy20PlusId}
              onSave={(id) => save({ fulfillmentPolicy20PlusId: id })}
              emptyLine={`Nothing here can ship a $20 card yet. Standard Envelope only covers cards under $20.`}
              hint={OVER_20_HINT}
            >
              {hidden > 0 && policies.fulfillment.length > hidden && (
                <p className={NOTE}>
                  {hidden === 1 ? "One Standard Envelope policy sits" : `${hidden} Standard Envelope policies sit`} this
                  one out: Standard Envelope only covers cards under $20.
                </p>
              )}
              {policies.fulfillment.length === hidden && (
                <MakeOnEbay sandbox={sandbox} onCheck={() => void recheck()} checkRef={checkAgain} what="tracked" />
              )}
            </PolicyPicker>
          </>
        )}
        <p role="status" aria-live="polite" className={`${LIVE} text-ink-2`}>
          {readLine}
        </p>
      </section>

      <section aria-labelledby={moneyId} className={SECTION}>
        <div>
          <h3 ref={moneyHeading} id={moneyId} tabIndex={-1} className={LANDING}>
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
              emptyLine={`No payment policy on your ${EBAY_NAME} account yet. Set me up, just below, makes one.`}
            />
            <PolicyPicker
              label="Returns"
              options={returnOptions(policies)}
              saved={settings.returnPolicyId}
              onSave={(id) => save({ returnPolicyId: id })}
              emptyLine={`No returns policy on your ${EBAY_NAME} account yet. Set me up, just below, makes one.`}
            />
            {needsSetMeUp(policies) && (
              <SetMeUp
                setLoaded={setLoaded}
                setLine={setSetupLine}
                onStart={() => setPressedOver(connection.setupProgress?.startedAt ?? null)}
                onDone={() => setFocusMoney((n) => n + 1)}
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
    </>
  );
}

/** What fits each shipping slot, said under its cards. */
const UNDER_20_HINT = "A policy with Standard Envelope or tracked shipping fits here.";
const OVER_20_HINT = "Ship these tracked: pick a policy with a tracked service.";

/** eBay's business policies page, where a seller makes shipping policies (the sandbox's own on a sandbox connection). */
function ebayPoliciesUrl(sandbox: boolean): string {
  return `${sandbox ? "https://www.sandbox.ebay.com" : "https://www.ebay.com"}/bp/manage`;
}

/** What a re-read found, said in the Shipping card's live line. */
const STILL_NO_SHIPPING = `Still no shipping policies on ${EBAY_NAME}. Make one there, then check again.`;
const STILL_NO_TRACKED = `Still nothing on ${EBAY_NAME} that can ship a $20 card. Make a tracked policy, then check again.`;
const SHIPPING_IN = "Your shipping policies are in. Pick away.";

type CheckProps = { sandbox: boolean; onCheck: () => void; checkRef: Ref<HTMLButtonElement> };

/**
 * The way out to eBay to make a shipping policy, and back: a link that opens
 * eBay's business policies in a new tab, and a fresh read of the account for
 * when the new policy is made (or was there all along).
 */
function MakeOnEbay({ sandbox, onCheck, checkRef, what }: CheckProps & { what: "shipping" | "tracked" }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <a
        href={ebayPoliciesUrl(sandbox)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-6 items-center gap-1 rounded-sm py-0.5 text-sm font-medium text-neon-blue-text underline focus-outline max-sm:min-h-11"
      >
        Make a {what} policy on {EBAY_NAME}
        <ArrowTopRightOnSquareIcon aria-hidden="true" className="h-4 w-4" />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
      <NeonButton ref={checkRef} type="button" variant="secondary" outline onClick={onCheck} className="max-sm:min-h-11">
        Check {EBAY_NAME} again
      </NeonButton>
    </div>
  );
}

/** The account holds no shipping policy at all: nothing to pick until the seller makes one on eBay. */
function NoShippingPolicies({ sandbox, onCheck, checkRef }: CheckProps) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-dashed border-rule-strong p-4">
      <p className="text-sm text-ink">No shipping policies on your {EBAY_NAME} account yet.</p>
      <p className={NOTE}>
        Make one on {EBAY_NAME}, then check again here. Under $20, Standard Envelope or tracked fits; $20 and up
        should ship tracked. One tracked policy can cover both.
      </p>
      <MakeOnEbay sandbox={sandbox} onCheck={onCheck} checkRef={checkRef} what="shipping" />
    </div>
  );
}

/** Set me up is offered while the account has no payment policy or no returns policy. */
function needsSetMeUp(policies: EbayPolicies): boolean {
  return policies.payment.length === 0 || policies.returns.length === 0;
}

/**
 * "Set me up": makes NB's standard payment and returns policies on the
 * seller's eBay account, only where there are none (never shipping: the
 * seller picks their own, NEO-423). The server fills any payment or returns
 * slot still empty as part of the run (a slot already picked stays put), so
 * the pickers show the picks as soon as the connection state catches up; the
 * page saves nothing itself. The run hands back the account's policy lists,
 * so the pickers offer what it made without a second read of eBay.
 *
 * Offered whenever payment or returns is missing; it waits for nothing else.
 * On success focus moves to the Payment and returns heading (the box may be
 * gone); on a refusal or a failure it stays on the button.
 */
/** What Set me up says when it's done: what it made, if anything. */
function setMeUpDone(created: readonly string[]): string {
  if (created.length === 0) return "You already had everything. Pick away.";
  return `Made ${created.length} on your ${EBAY_NAME} account: ${created.join(", ")}. Picked where you had nothing yet.`;
}

function SetMeUp({
  setLoaded,
  setLine,
  onStart,
  onDone,
}: {
  setLoaded: (next: Loaded) => void;
  setLine: (line: SetupLine) => void;
  /** A run on eBay is about to start: its ledger is the one to show. */
  onStart: () => void;
  onDone: () => void;
}) {
  const create = useAction(api.ebayConnect.createStandardPolicies);
  const [busy, setBusy] = useState(false);
  const describeId = useId();

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setLine({ kind: "progress", text: "Setting you up…" });
    try {
      onStart();
      const answer = await create({});
      if (!answer.ok) {
        setLine({ kind: "error", text: answer.error });
        return;
      }
      // The run hands back the account's policies, made ones included: no second trip to eBay.
      setLoaded({ state: "ready", policies: answer.policies });
      setLine({ kind: "ok", text: setMeUpDone(answer.created) });
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
        Missing one? Set me up makes NeonBinder&apos;s standard payment and returns policies on your {EBAY_NAME}{" "}
        account, only the ones you don&apos;t have, then picks them for you. Shipping stays your pick.
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

/** Every weight the server takes (whole ounces, 1 up to the Standard Envelope's limit), as choice cards. */
const WEIGHT_OPTIONS = Array.from({ length: EBAY_MAX_CARD_WEIGHT_OZ }, (_, i) => i + 1)
  .filter(isValidCardWeightOz)
  .map((ounces) => ({ value: String(ounces), label: `${ounces} oz` }));

const WEIGHT_HINT = `Weigh one card packed to mail: sleeve, toploader, envelope and all. ${EBAY_NAME} charges buyers shipping by it, and Standard Envelope tops out at ${EBAY_MAX_CARD_WEIGHT_OZ} oz.`;

/**
 * The weight of a single card, packed (1 oz by default): eBay's calculated
 * shipping charges the buyer by it, and plenty of sellers' envelopes go out
 * heavier than a bare card. Saved like Best Offer: a pick shows at once (an
 * optimistic update on the connection state) and saves; Enter, Space or an
 * arrow picks (the radio group pattern). A refusal is rolled back by Convex,
 * the server's own sentence is said in an alert that describes the group,
 * and focus lands on the weight that's back while it is still in the group.
 * Picks can overlap as arrows move, so only the latest reports.
 */
function PackingSection({ saved }: { saved: number }) {
  const headingId = useId();
  const hintId = useId();
  const lineId = useId();
  const groupRef = useRef<HTMLDivElement>(null);
  const latestPick = useRef(0);
  const [line, setLine] = useState<FormLine>(null);
  const [rollbacks, setRollbacks] = useState(0);
  const setCardWeight = useMutation(api.ebayConnect.setCardWeight).withOptimisticUpdate((local, args) => {
    const current = local.getQuery(api.ebayConnect.connectionState, {});
    if (!current) return;
    local.setQuery(api.ebayConnect.connectionState, {}, { ...current, cardWeightOz: args.ounces });
  });

  useLayoutEffect(() => {
    if (rollbacks === 0) return;
    const group = groupRef.current;
    // Only while focus is still in the group; never pull it back from elsewhere.
    if (!group || !group.contains(document.activeElement)) return;
    group.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
  }, [rollbacks]);

  const choose = async (next: string) => {
    const ounces = Number(next);
    if (!isValidCardWeightOz(ounces) || ounces === saved) return;
    const pick = ++latestPick.current;
    setLine({ kind: "saving", text: "Saving…" });
    try {
      await setCardWeight({ ounces });
      if (pick === latestPick.current) setLine({ kind: "saved", text: `Saved. Each card weighs in at ${ounces} oz.` });
    } catch (error) {
      if (pick !== latestPick.current) return;
      setLine({ kind: "error", text: `${refusalSentence(error) ?? "That didn't save."} Your old weight is back.` });
      setRollbacks((n) => n + 1);
    }
  };

  const failed = line?.kind === "error";
  return (
    <section aria-labelledby={headingId} className={SECTION}>
      <h3 id={headingId} className="text-lg font-semibold text-ink">
        Packing
      </h3>
      <div className="flex flex-col gap-2">
        <div ref={groupRef}>
          <ModeRadioGroup
            label="Weight of a single card"
            value={String(saved)}
            options={WEIGHT_OPTIONS}
            onChange={(next) => void choose(next)}
            describedBy={failed ? `${lineId} ${hintId}` : hintId}
            className="max-w-md"
          />
        </div>
        <p id={hintId} className={NOTE}>
          {WEIGHT_HINT}
        </p>
        {/* One live line holding a line's room, remounted as an alert on a refusal. */}
        <p
          id={lineId}
          key={failed ? "failed" : "ok"}
          role={failed ? "alert" : "status"}
          aria-live={failed ? undefined : "polite"}
          className={`min-h-5 text-sm ${failed ? "text-neon-pink-text" : "text-ink-3"}`}
        >
          {line?.text ?? ""}
        </p>
      </div>
    </section>
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

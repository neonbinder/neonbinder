/**
 * NEO-415 — the pure half of Profile → Credentials → eBay: the shapes the
 * panel reads from `convex/ebayConnect.ts` (mirroring its validators, so it compiles
 * against NB's words for them), which policies each picker offers, what
 * "Set me up" picks for an empty slot, and the setup checklist's lines.
 *
 * No Convex at run time, so the unit tests pin it without a deployment.
 * Nothing here keys on an eBay policy's NAME except `standardPicks`, which
 * matches the names `createStandardPolicies` just reported making: those are
 * NB's own names for NB's own policies, read back to pick them, never a
 * marketplace value NB behaviour depends on.
 */

import { EBAY_NAME } from "./listing-copy";

/** Where the collector's eBay connection stands (`ebayConnect.connectionState`). */
export type EbayStatus = "notConnected" | "connected" | "needsReauth" | "paused" | "sellerConflict";

/** A setup step not done yet: what blocks listing until it is. */
export type EbaySetupGap = "shippingUnder20" | "shipping20Plus" | "payment" | "returns" | "location";

export interface EbayLocation {
  postalCode: string;
  city: string;
  stateOrProvince: string;
}

export interface EbaySettings {
  fulfillmentPolicyUnder20Id: string | null;
  fulfillmentPolicy20PlusId: string | null;
  paymentPolicyId: string | null;
  returnPolicyId: string | null;
  location: EbayLocation | null;
  bestOffer: boolean;
}

export interface EbayConnectionState {
  configured: boolean;
  environment: "sandbox" | "production" | null;
  status: EbayStatus;
  ebayUsername: string | null;
  since: number | null;
  settings: EbaySettings;
  setupComplete: boolean;
  missing: EbaySetupGap[];
  /** The latest Set me up run, step by step (absent in fixtures that predate it). */
  setupProgress?: EbaySetupProgress | null;
}

/** One step of Set me up's run: the account check, or one of NB's policies. */
export type EbaySetupStepKey = "check" | "tracked" | "free" | "payment" | "returns" | "ese";
/** `had`: already on the account, so nothing made; `stopped`: an earlier step stopped the run first. */
export type EbaySetupStepStatus = "waiting" | "working" | "done" | "failed" | "had" | "stopped";

export interface EbaySetupStep {
  step: EbaySetupStepKey;
  /** NB's words for it (the policy's NB name), from the server. */
  label: string;
  status: EbaySetupStepStatus;
}

/** `ebayConnect.connectionState.setupProgress`: one run, from its start. */
export interface EbaySetupProgress {
  startedAt: number;
  steps: EbaySetupStep[];
}

export interface EbayFulfillmentPolicy {
  id: string;
  name: string;
  /** Offers eBay Standard Envelope (fits a card under $20). */
  eseFit: boolean;
  /** Standard Envelope is its only domestic service: under $20 only. */
  eseOnly: boolean;
  freeShipping: boolean;
  summary: string;
}

export interface EbayPolicies {
  fulfillment: EbayFulfillmentPolicy[];
  payment: Array<{ id: string; name: string }>;
  returns: Array<{ id: string; name: string; summary: string }>;
}

/** The four policy slots, as `ebayConnect.savePolicies` names them. */
export type EbayPolicySlot = "fulfillmentPolicyUnder20Id" | "fulfillmentPolicy20PlusId" | "paymentPolicyId" | "returnPolicyId";

export type EbayPolicyPicks = Partial<Record<EbayPolicySlot, string>>;

/** One choice in a picker. */
export interface PolicyOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * Every policy fits a card under $20; one that takes Standard Envelope says
 * so first, unless the server's summary already names it (said once, never
 * twice).
 */
export function under20Options(policies: EbayPolicies): PolicyOption[] {
  return policies.fulfillment.map((p) => ({
    value: p.id,
    label: p.name,
    description:
      p.eseFit && !/standard envelope/i.test(p.summary)
        ? joinLines("Takes Standard Envelope.", p.summary)
        : p.summary || undefined,
  }));
}

/**
 * $20 and up: Standard Envelope only covers cards under $20, so a policy
 * whose only service is Standard Envelope is not offered (the server refuses
 * it too).
 */
export function over20Options(policies: EbayPolicies): PolicyOption[] {
  return policies.fulfillment
    .filter((p) => !p.eseOnly)
    .map((p) => ({ value: p.id, label: p.name, description: p.summary || undefined }));
}

/** How many policies the $20-and-up picker leaves out. */
export function hiddenFrom20Plus(policies: EbayPolicies): number {
  return policies.fulfillment.filter((p) => p.eseOnly).length;
}

export function paymentOptions(policies: EbayPolicies): PolicyOption[] {
  return policies.payment.map((p) => ({ value: p.id, label: p.name }));
}

export function returnOptions(policies: EbayPolicies): PolicyOption[] {
  return policies.returns.map((p) => ({ value: p.id, label: p.name, description: p.summary || undefined }));
}

/**
 * "Set me up" is offered when the account has nothing that fits a slot: no
 * Standard Envelope policy for cheap cards, nothing that may ship a $20 card,
 * or no payment or returns policy at all.
 */
export function needsStandardPolicies(policies: EbayPolicies): boolean {
  return (
    !policies.fulfillment.some((p) => p.eseFit) ||
    !policies.fulfillment.some((p) => !p.eseOnly) ||
    policies.payment.length === 0 ||
    policies.returns.length === 0
  );
}

/**
 * After "Set me up": for each slot still empty, the policy it just made that
 * fits it. Under $20 takes the Standard Envelope one; $20 and up the tracked
 * one (not the free-shipping one, which gives postage away); payment and
 * returns the one it made, or the only one there is. A slot already picked
 * is never changed.
 */
export function standardPicks(settings: EbaySettings, policies: EbayPolicies, created: string[]): EbayPolicyPicks {
  const made = new Set(created);
  const picks: EbayPolicyPicks = {};
  const fresh = policies.fulfillment.filter((p) => made.has(p.name));
  if (!settings.fulfillmentPolicyUnder20Id) {
    const pick = fresh.find((p) => p.eseFit);
    if (pick) picks.fulfillmentPolicyUnder20Id = pick.id;
  }
  if (!settings.fulfillmentPolicy20PlusId) {
    const pick = fresh.find((p) => !p.eseOnly && !p.eseFit && !p.freeShipping) ?? fresh.find((p) => !p.eseOnly);
    if (pick) picks.fulfillmentPolicy20PlusId = pick.id;
  }
  if (!settings.paymentPolicyId) {
    const pick = policies.payment.find((p) => made.has(p.name)) ?? (policies.payment.length === 1 ? policies.payment[0] : undefined);
    if (pick) picks.paymentPolicyId = pick.id;
  }
  if (!settings.returnPolicyId) {
    const pick = policies.returns.find((p) => made.has(p.name)) ?? (policies.returns.length === 1 ? policies.returns[0] : undefined);
    if (pick) picks.returnPolicyId = pick.id;
  }
  return picks;
}

/**
 * The setup checklist, in the page's order: each step and whether it's done.
 * Where cards ship from leads: eBay prices each buyer's shipping from that
 * ZIP, so "Set me up" waits for it.
 */
export const SETUP_STEPS: ReadonlyArray<{ gap: EbaySetupGap; label: string }> = [
  { gap: "location", label: "Where your cards ship from" },
  { gap: "shippingUnder20", label: "Shipping for cards under $20" },
  { gap: "shipping20Plus", label: "Shipping for cards $20 and up" },
  { gap: "payment", label: "Payment" },
  { gap: "returns", label: "Returns" },
];

export function setupChecklist(missing: ReadonlyArray<EbaySetupGap>): Array<{ gap: EbaySetupGap; label: string; done: boolean }> {
  const open = new Set(missing);
  return SETUP_STEPS.map((step) => ({ ...step, done: !open.has(step.gap) }));
}

/** The Set me up ledger's list name. */
export const SET_ME_UP_STEPS_NAME = "Set me up, step by step";

/** A Set me up step's state, as its list item says it. */
export const SETUP_STEP_WORD: Record<EbaySetupStepStatus, string> = {
  waiting: "waiting",
  working: "working",
  done: "done",
  failed: `${EBAY_NAME} said no`,
  had: `already on ${EBAY_NAME}`,
  stopped: "not made",
};

/** A Set me up step's accessible name: "NB Free Shipping, done". */
export function setupStepName(label: string, status: EbaySetupStepStatus): string {
  return `${label}, ${SETUP_STEP_WORD[status]}`;
}

/**
 * How a step shows. While the run goes, as stored; once the page's run is
 * over, a step the server never settled (the run died under it) is not left
 * spinning: working reads failed, and waiting reads not made.
 */
export function shownSetupStatus(status: EbaySetupStepStatus, running: boolean): EbaySetupStepStatus {
  if (running) return status;
  if (status === "working") return "failed";
  if (status === "waiting") return "stopped";
  return status;
}

/** The policies the run makes (not the account check, not one already there). */
function toMake(steps: ReadonlyArray<EbaySetupStep>): EbaySetupStep[] {
  return steps.filter((s) => s.step !== "check" && s.status !== "had");
}

/**
 * The newest step to land between two reads of one run, as the live line's
 * one sentence; "" when none did. A snag outranks a check mark; otherwise the
 * latest in run order. The account check landing says how many are to make.
 */
export function setupLandedLine(before: ReadonlyArray<EbaySetupStep>, now: ReadonlyArray<EbaySetupStep>): string {
  const was = new Map(before.map((s) => [s.step, s.status]));
  let landed: EbaySetupStep | null = null;
  for (const step of now) {
    if (step.status !== "done" && step.status !== "failed") continue;
    if (was.get(step.step) === step.status) continue;
    landed = step;
    if (step.status === "failed") break;
  }
  if (!landed) return "";
  const making = toMake(now);
  if (landed.step === "check") {
    if (landed.status === "failed") return "";
    return making.length === 0
      ? `Checked your ${EBAY_NAME} account. You've got them all.`
      : `Checked your ${EBAY_NAME} account. ${making.length} to make.`;
  }
  if (landed.status === "failed") return `${EBAY_NAME} said no to ${landed.label}.`;
  const made = making.filter((s) => s.status === "done").length;
  return `Made ${landed.label}. ${made} of ${making.length} made.`;
}

/** A US ZIP, five digits or ZIP+4. */
export function isZip(value: string): boolean {
  return /^\d{5}(-\d{4})?$/.test(value.trim());
}

function joinLines(...parts: Array<string | undefined>): string {
  return parts
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(" ");
}

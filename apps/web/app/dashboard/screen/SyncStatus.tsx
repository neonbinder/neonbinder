import { ArrowPathIcon, CheckCircleIcon, ChevronDownIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, useLocation } from "react-router";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import { isReportableSyncReason, MAX_SYNC_REPORT_NOTE } from "@/lib/collection/sync-report";
import type { HeldBackCard, SyncProblemSet, SyncStatusData } from "../fake-data";
import { MARKETPLACES } from "../dash-labels";
import { CardTitle, count, MarketBadge, sideHref, Thumb } from "./bits";
import { useCrew, type Crew } from "./crew";
import { heldOf, PanelLink } from "./panelLink";
import { useOpen } from "./useOpen";

/**
 * NEO-464 review round 4 — the sync status, at the top of the dashboard
 * (Jason, 2026-11-10: "any sync errors that have not self corrected, ie only
 * show errors that have not had a successful sync of that card/set later.
 * Also show pending syncs there if there are any pending").
 *
 * Read from NB's own records of its syncs (`dashboard.syncAlerts`): each set
 * whose LATEST sync failed or held cards back, then the cards waiting for the
 * next sync, per marketplace. A set a later clean sync put right is not here.
 *
 * Held-back cards lead (Jason, 2026-11-11: "very important, probably more
 * important than other things within sync... each one should open the card
 * panel where they could fix it"): the sets holding cards back come first,
 * and within a set its cards come before the failure sentence. Each card,
 * with its reason, opens its card panel over the dashboard (`./panelLink`),
 * as stock for sale, where its price, photo or copy is fixed. The first `HELD_PREVIEW` show; "Show all N" opens
 * every card the read named (an in-view tweak, `useOpen`); cards past what
 * the read names open on Sync status. The link at the top opens Inventory's
 * Sync status tab. Nothing waiting and nothing wrong: no section (the caller
 * passes null).
 */

/** Held-back cards a set shows before "Show all". */
export const HELD_PREVIEW = 6;

/**
 * The frame says how bad it is: a set whose last sync failed is the danger
 * rule; only cards held back (each one a fix the collector can make) is the
 * warning rule; only cards waiting for the next sync is the plain rule.
 */
export function syncFrame(status: SyncStatusData): "danger" | "warn" | "plain" {
  if (status.problems.some((p) => p.failure)) return "danger";
  if (status.problems.length > 0) return "warn";
  return "plain";
}

const FRAME_RULE = {
  danger: "border-notice-danger-rule",
  warn: "border-notice-warn-rule",
  plain: "border-rule",
} as const;

/** A link on its own line: a 44px target on a phone, its text height beside the heading on wider screens. */
const SYNC_LINK =
  "inline-flex min-h-11 items-center rounded-sm text-sm font-semibold text-neon-blue-text underline-offset-2 hover:underline focus-outline sm:min-h-0";

export default function SyncStatus({ status }: { status: SyncStatusData }) {
  const { pathname } = useLocation();
  const trouble = status.problems.length > 0;
  return (
    <section
      aria-labelledby="cb-sync-heading"
      className={`shadow-offset min-w-0 rounded-2xl border bg-raised p-4 sm:p-5 ${FRAME_RULE[syncFrame(status)]}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="cb-sync-heading" tabIndex={-1} className="rounded-sm text-lg font-bold text-ink focus-outline">
          Sync status
        </h2>
        <Link to={sideHref(pathname, "inventory", { tab: "sync" })} className={SYNC_LINK}>
          Open Sync status
        </Link>
      </div>

      {trouble && (
        <ul className="mt-4 flex flex-col gap-5">
          {status.problems.map((set) => (
            <li key={set.id}>
              <ProblemSet set={set} pathname={pathname} />
            </li>
          ))}
        </ul>
      )}
      {status.more && <p className="mt-3 text-sm text-ink-3">More sets need a look on Sync status.</p>}

      {status.pending.length > 0 && (
        <ul className={`flex flex-col gap-2 ${trouble ? "mt-4 border-t border-rule pt-3" : "mt-3"}`}>
          {status.pending.map((p) => (
            <li key={p.marketplace} className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
              <ArrowPathIcon aria-hidden="true" className="size-4 shrink-0 text-neon-blue-text" />
              <MarketBadge marketplace={p.marketplace} />
              <span>{p.more ? `${p.cards}+ cards` : count(p.cards, "card")} waiting for the next sync.</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The line over a set's held-back cards. Who fixes them decides it: the
 * collector (each card's own fix), the crew (NEO-536: report it), or both.
 */
export function heldLead(set: Pick<SyncProblemSet, "heldBack" | "marketplace" | "crewFix">): string {
  const lead = `${count(set.heldBack, "card")} held back from ${MARKETPLACES[set.marketplace].name}.`;
  const one = set.heldBack === 1;
  // The crew's cases end on a full stop: the action is the Report button under the tiles.
  if (set.crewFix === "all") return `${lead} On our crew, not you.`;
  if (set.crewFix === "some") return `${lead} Fix yours on the card. The rest are on us.`;
  return `${lead} ${one ? "Fix it on the card and it goes up next sync:" : "Fix each one on its card and it goes up next sync:"}`;
}

/** A held-back card only the crew can fix (NEO-536): its reason's code says so. */
export function isCrewCard(card: Pick<HeldBackCard, "code">): boolean {
  return card.code !== undefined && isReportableSyncReason(card.code);
}

/**
 * A set's held-back cards in the order they show: the collector's own fixes
 * first, the crew's after them, each kind in the read's order. In a mixed
 * set the crew's tiles say so ("On our crew"), so the ones to act on lead.
 */
export function heldOrder<C extends Pick<HeldBackCard, "code">>(cards: readonly C[]): C[] {
  return [...cards.filter((c) => !isCrewCard(c)), ...cards.filter(isCrewCard)];
}

function ProblemSet({ set, pathname }: { set: SyncProblemSet; pathname: string }) {
  const crew = useCrew();
  const market = MARKETPLACES[set.marketplace].name;
  const headingId = `${set.id}-heading`;
  const [all, toggle] = useOpen(set.id);
  const cards = heldOrder(set.cards);
  // Only a mixed set tags the crew's tiles; where every card is the crew's, the lead says so once.
  const tagCrew = set.crewFix === "some";
  const shown = all ? cards : cards.slice(0, HELD_PREVIEW);
  const folded = cards.length - HELD_PREVIEW;
  const unnamed = set.heldBack - cards.length;
  // ↑ ↓ in a held-back card's panel walk the set's held-back cards in the order they show, the folded ones too, each with its reason.
  const heldIds = cards.map((c) => c.card.id);
  const heldList = new Map(
    cards.flatMap((c) => {
      const held = heldOf(set.marketplace, c.code);
      return held ? [[c.card.id, held] as const] : [];
    }),
  );
  return (
    <article aria-labelledby={headingId} className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <MarketBadge marketplace={set.marketplace} />
        <h3 id={headingId} tabIndex={-1} className="rounded-sm text-sm font-bold text-ink focus-outline">
          {set.setLabel}
          <span className="sr-only"> on {market}</span>
        </h3>
      </div>
      {set.heldBack > 0 && (
        <>
          <p className="mt-2 text-sm font-semibold text-ink">{heldLead(set)}</p>
          {shown.length > 0 && (
            <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {shown.map(({ card, reason, code }) => (
                <li key={card.id} className="min-w-0">
                  <PanelLink
                    cardId={card.id}
                    side="inventory"
                    list={heldIds}
                    held={heldOf(set.marketplace, code)}
                    heldList={heldList}
                    // The warn tint stays under the pointer: the rule darkens and the title underlines.
                    className="group flex h-full min-w-0 items-start gap-2.5 rounded-md border border-notice-warn-rule bg-notice-warn-bg p-2 hover:border-notice-warn-ink focus-outline"
                  >
                    <Thumb card={card} className="w-10" />
                    <span className="min-w-0 flex-1 text-xs leading-snug">
                      <CardTitle
                        card={card}
                        className="font-semibold text-ink underline-offset-2 group-hover:underline"
                      />
                      <span className="mt-1 block text-notice-warn-ink">{reason}</span>
                      {tagCrew && isCrewCard({ code }) && (
                        // Words, not only a colour: the crew's blue, on the card's own ground, off the warn tint.
                        <span className="mt-1.5 block">
                          <span className="inline-flex items-center rounded-full border border-neon-blue/60 bg-raised px-2 py-0.5 font-semibold text-neon-blue-text">
                            On our crew
                          </span>
                        </span>
                      )}
                    </span>
                  </PanelLink>
                </li>
              ))}
            </ul>
          )}
          {(folded > 0 || unnamed > 0) && (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
              {folded > 0 && (
                <button
                  type="button"
                  aria-expanded={all}
                  onClick={toggle}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-control px-3 text-sm text-ink-2 hover:border-neon-blue hover:text-ink focus-outline sm:min-h-9"
                >
                  <ChevronDownIcon
                    aria-hidden="true"
                    className={`size-4 transition-transform motion-reduce:transition-none ${all ? "rotate-180" : ""}`}
                  />
                  {/* The words on it lead its name (WCAG 2.5.3): the count it adds is seen, the set it is in is read, last. */}
                  {all ? "Show fewer" : `Show all ${cards.length}`}
                  {!all && (
                    <span aria-hidden="true" className="text-ink-3">
                      {" "}
                      (+{folded})
                    </span>
                  )}
                  <span className="sr-only">
                    {" "}
                    held back in {set.setLabel} on {market}
                  </span>
                </button>
              )}
              {unnamed > 0 && (
                <Link
                  to={sideHref(pathname, "inventory", { tab: "sync" })}
                  aria-label={`${count(unnamed, "more card")} on Sync status, held back in ${set.setLabel} on ${market}`}
                  className={SYNC_LINK}
                >
                  {count(unnamed, "more card")} on Sync status
                </Link>
              )}
            </div>
          )}
        </>
      )}
      {crew && set.crewFix && set.variantId && !set.failure && (
        <ReportToCrew crew={crew} set={set} variantId={set.variantId} />
      )}
      {set.failure && (
        <p className="mt-2 flex items-start gap-2 rounded-md border border-notice-danger-rule bg-notice-danger-bg px-2 py-1.5 text-sm text-notice-danger-ink">
          <ExclamationTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{set.failure}</span>
        </p>
      )}
    </article>
  );
}

/**
 * NEO-536 — "Report to our crew", under a set holding back cards only the
 * crew can fix. Opens a short form in place (a note is optional): Enter
 * sends, Escape backs out. Sent, the set reads "Reported" for as long as the
 * report is open: that comes from the collector's open reports, not from
 * this form, so it holds on a reload and clears when the crew closes it or
 * the collector withdraws it. Focus follows: into the note on open, onto the
 * "Reported" line once sent (or, should the read not say "Reported" by the
 * render after the send, the button, so focus never sits nowhere waiting to
 * jump later), back to the button on Cancel.
 */
function ReportToCrew({ crew, set, variantId }: { crew: Crew; set: SyncProblemSet; variantId: string }) {
  const market = MARKETPLACES[set.marketplace].name;
  const reported = crew.isReported(variantId, set.marketplace);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const errorId = useId();
  /**
   * Where focus goes on the next render: set by an open, a send or a cancel,
   * never on a fresh load. Spent by that render, whether its target is there
   * or not: a target that is missing falls back to the button.
   */
  const focusNext = useRef<"note" | "status" | "button" | null>(null);

  useEffect(() => {
    const want = focusNext.current;
    if (!want) return;
    focusNext.current = null;
    const el = want === "note" ? noteRef.current : want === "status" ? statusRef.current : buttonRef.current;
    (el ?? buttonRef.current)?.focus();
  });

  function cancel() {
    if (busy) return;
    setOpen(false);
    setNote("");
    setError(null);
    focusNext.current = "button";
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const why = await crew.report({ variantId, platform: set.marketplace, note });
    setBusy(false);
    if (why) {
      setError(why);
      return;
    }
    setOpen(false);
    setNote("");
    focusNext.current = "status";
  }

  if (reported && !open) {
    return (
      <p
        ref={statusRef}
        tabIndex={-1}
        className="mt-3 flex items-center gap-2 rounded-sm text-sm font-semibold text-neon-green-text focus-outline"
      >
        <CheckCircleIcon aria-hidden="true" className="size-5 shrink-0" />
        <span>
          Reported. Our crew&apos;s on it.
          <span className="sr-only">
            {" "}
            {set.setLabel} on {market}
          </span>
        </span>
      </p>
    );
  }

  if (!open) {
    return (
      <div className="mt-3">
        <NeonButton
          ref={buttonRef}
          variant="secondary"
          outline
          size="2"
          className="max-sm:min-h-11"
          onClick={() => {
            setOpen(true);
            focusNext.current = "note";
          }}
        >
          Report to our crew
          <span className="sr-only">
            {" "}
            about {set.setLabel} on {market}
          </span>
        </NeonButton>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => void send(e)}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cancel();
        }
      }}
      className="mt-3 flex max-w-xl flex-col gap-2 rounded-md border border-rule bg-raised-deep p-3"
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-ink-2">
          Note for our crew (optional)
          <span className="sr-only">
            {" "}
            about {set.setLabel} on {market}
          </span>
        </span>
        <Input
          bare
          ref={noteRef}
          value={note}
          maxLength={MAX_SYNC_REPORT_NOTE}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Anything we should know?"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="w-full px-3 py-2 text-base sm:text-sm"
        />
      </label>
      {/* Mounted with the form, so a refusal is announced; empty, it cancels its own gap. */}
      <p id={errorId} role="alert" className="text-sm text-neon-pink-text empty:-mt-2">
        {error}
      </p>
      <div className="flex flex-wrap gap-2">
        <NeonButton type="submit" variant="primary" size="2" aria-disabled={busy || undefined} className="max-sm:min-h-11">
          {busy ? "Sending" : "Send"}
          <span className="sr-only"> report on {set.setLabel} on {market}</span>
        </NeonButton>
        <NeonButton type="button" variant="negative" outline size="2" onClick={cancel} className="max-sm:min-h-11">
          Cancel
          <span className="sr-only"> report on {set.setLabel} on {market}</span>
        </NeonButton>
      </div>
    </form>
  );
}

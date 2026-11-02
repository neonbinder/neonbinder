import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { useSearchParams } from "react-router";
import { api } from "@/convex/_generated/api";
import NeonButton from "@/components/modules/NeonButton";
import { ConfirmDialog } from "@/components/modules/confirm-dialog";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import type { EbayConnectionState } from "@/lib/marketplace/ebay-setup";
import {
  CONSENT_HEADING,
  EBAY_CONSENT_LINE,
  EBAY_NAME,
  listingDay,
  pausedLine,
  sellerConflictLine,
} from "@/lib/marketplace/listing-copy";
import SetupSections, { SECTION } from "./SetupSections";

/**
 * Profile → eBay — NEO-415. eBay is NB's first card-level listing platform:
 * the collector connects their eBay seller account through eBay's own
 * consent screen (no password ever reaches NB), then picks their own
 * shipping, payment and returns policies, where cards ship from and Best
 * Offer. Connected IS listing (NEO-370 Rev 5), but nothing goes up until the
 * setup is finished; the checklist under the connection says what's left,
 * each step a link to its section, and folds to one line at the foot once
 * it's done.
 *
 * The round trip: Connect asks the server for eBay's consent URL
 * (`beginConnect`, which keeps a one-time `state`) and leaves for it; eBay
 * sends the collector back here with `?code=&state=`. The page hands those
 * to `completeConnect` once, then replaces the URL clean (the code is single
 * use, and a refresh or Back must not replay it; `replace`, so Back never
 * lands on it). eBay's "declined" return (`?error=`) is said and cleaned up
 * the same way.
 *
 * Connection states, in the order the server decides them: not configured
 * on this NeonBinder (Connect disabled with the reason), not connected (the
 * consent heading and line beside Connect), connected, the consent ran out,
 * eBay paused for everyone, and the seller account in use by another NB
 * account. Every refusal is an alert, the server's own sentence when it
 * sent one (Connect's start refusing, a return from a different seller
 * account); progress is a polite status. A disconnect that couldn't take
 * every NB listing down says how many are still up, in an alert.
 *
 * Focus: after connecting, or coming back having said no, the Connection
 * heading (the button that started it is a page load ago); after
 * disconnecting, Connect (Disconnect is gone); after backing out of the
 * Disconnect confirm, Disconnect. While the confirm is up, the page behind it
 * is inert.
 *
 * The phase line mounts empty and the return's phase is set after mount, so
 * "Hooking up…" is announced rather than present on arrival.
 */

/** Codes already handed to the server: StrictMode's second effect run, or a remount, must not spend one twice. */
const spentCodes = new Set<string>();

type Phase =
  | { kind: "idle" }
  | { kind: "completing" }
  | { kind: "connected"; username: string }
  | { kind: "declined" }
  | { kind: "error"; error: string }
  | { kind: "leaving" }
  /** Disconnected; `notEnded` of NB's eBay listings couldn't be taken down. */
  | { kind: "disconnected"; notEnded: number };

const NOT_CONFIGURED_LINE = `${EBAY_NAME} isn't hooked up on this NeonBinder yet.`;
const CONNECT_FAILED = `Couldn't reach ${EBAY_NAME} to connect. Give it another try.`;

/** What Connect's start said back: the consent URL, or the server's refusal. */
type BeginAnswer = { authorizeUrl: string } | { ok: false; error: string };

/** The server's own sentence from a refusal thrown as a ConvexError, if it sent one. */
function refusalSentence(error: unknown): string | null {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "string" && data.trim()) return data;
  if (data && typeof data === "object") {
    const message = (data as { message?: unknown; error?: unknown }).message ?? (data as { error?: unknown }).error;
    if (typeof message === "string" && message.trim()) return message;
  }
  return null;
}

/** The alert after a disconnect that couldn't take every NB listing down. */
function notEndedLine(n: number): string {
  const listings = n === 1 ? "1 NeonBinder listing is" : `${n} NeonBinder listings are`;
  const them = n === 1 ? "it" : "them";
  return `Disconnected, but ${listings} still up on ${EBAY_NAME} and we couldn't take ${them} down. End ${them} on ${EBAY_NAME} so nothing sells that you no longer have.`;
}

export default function EbayPanel() {
  useDocumentTitle("eBay | Neon Binder");
  const raw = useQuery(api.ebayConnect.connectionState, {});
  const connection: EbayConnectionState | undefined = raw;
  const beginConnect = useMutation(api.ebayConnect.beginConnect);
  const completeConnect = useAction(api.ebayConnect.completeConnect);
  const disconnect = useAction(api.ebayConnect.disconnect);
  const [params, setParams] = useSearchParams();
  const code = params.get("code");
  const oauthState = params.get("state");
  const declinedParam = params.get("error");

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const headingId = useId();
  const reasonId = useId();
  const consentId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const connectRef = useRef<HTMLButtonElement>(null);
  const disconnectRef = useRef<HTMLButtonElement>(null);
  /** Backed out of the confirm: Disconnect gets focus back once the page is live again. */
  const restoreDisconnect = useRef(false);
  /** Where focus goes once the server's state catches up with what just happened. */
  const focusNext = useRef<null | "heading" | "connect">(null);

  // eBay's return: spend the code once, then clean the URL (replace: no Back step).
  useEffect(() => {
    if (!code || !oauthState) {
      if (declinedParam) {
        setParams({}, { replace: true });
        focusNext.current = "heading";
        // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate second commit: the phase line mounts empty, so filling it is announced
        setPhase({ kind: "declined" });
      }
      return;
    }
    setParams({}, { replace: true });
    if (spentCodes.has(code)) return;
    spentCodes.add(code);
    setPhase({ kind: "completing" });
    completeConnect({ code, state: oauthState }).then(
      (answer) => {
        if (answer.ok) {
          focusNext.current = "heading";
          setPhase({ kind: "connected", username: answer.ebayUsername });
        } else {
          focusNext.current = "connect";
          setPhase({ kind: "error", error: answer.error });
        }
      },
      (error: unknown) => {
        focusNext.current = "connect";
        setPhase({ kind: "error", error: refusalSentence(error) ?? CONNECT_FAILED });
      },
    );
  }, [code, oauthState, declinedParam, completeConnect, setParams]);

  const status = connection?.status;
  useEffect(() => {
    if (focusNext.current === "heading" && status && (status !== "notConnected" || phase.kind === "declined")) {
      focusNext.current = null;
      headingRef.current?.focus();
    } else if (focusNext.current === "connect" && (status === "notConnected" || status === "needsReauth")) {
      focusNext.current = null;
      connectRef.current?.focus();
    }
  }, [status, phase]);

  useEffect(() => {
    if (!confirming && restoreDisconnect.current) {
      restoreDisconnect.current = false;
      disconnectRef.current?.focus();
    }
  }, [confirming]);

  const connect = async () => {
    if (phase.kind === "leaving" || phase.kind === "completing" || !connection?.configured) return;
    setPhase({ kind: "leaving" });
    try {
      const answer = (await beginConnect({})) as BeginAnswer;
      if ("authorizeUrl" in answer) {
        window.location.assign(answer.authorizeUrl);
        return;
      }
      setPhase({ kind: "error", error: answer.error || CONNECT_FAILED });
    } catch (error) {
      // A refusal ("Disconnect eBay first…") arrives as the server's sentence.
      setPhase({ kind: "error", error: refusalSentence(error) ?? CONNECT_FAILED });
    }
  };

  const confirmDisconnect = async () => {
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      const answer = await disconnect({});
      if (!answer.ok) {
        setDisconnectError(`Couldn't disconnect from ${EBAY_NAME}. Give it another try.`);
        return;
      }
      // Not every server answers with a count yet; none means none left up.
      const notEnded = "notEnded" in answer && typeof answer.notEnded === "number" ? answer.notEnded : 0;
      focusNext.current = "connect";
      setConfirming(false);
      setPhase({ kind: "disconnected", notEnded });
    } catch {
      setDisconnectError(`Couldn't disconnect from ${EBAY_NAME}. Give it another try.`);
    } finally {
      setDisconnecting(false);
    }
  };

  const sandbox = connection?.environment === "sandbox";

  return (
    <div className="space-y-6">
      {/* Inert while the confirm is up: only the dialog can be reached. */}
      <div className="space-y-6" inert={confirming || undefined}>
        <section aria-labelledby={headingId} className={SECTION}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2
              ref={headingRef}
              id={headingId}
              tabIndex={-1}
              className="rounded-sm text-xl font-semibold text-ink focus-outline"
            >
              {EBAY_NAME}
            </h2>
            {sandbox && (
              <span className="rounded-full border border-pick-purple-rule bg-pick-purple px-2 py-0.5 text-xs font-medium text-pick-purple-ink">
                Sandbox
              </span>
            )}
          </div>
          {sandbox && (
            <p className="text-sm text-ink-3">
              Test mode: this NeonBinder talks to {EBAY_NAME}&apos;s sandbox, so nothing lists for real.
            </p>
          )}

          {connection === undefined ? (
            <p role="status" className="text-sm text-ink-3">
              Checking your {EBAY_NAME} connection…
            </p>
          ) : (
            <ConnectionBody
              connection={connection}
              phase={phase}
              reasonId={reasonId}
              consentId={consentId}
              connectRef={connectRef}
              disconnectRef={disconnectRef}
              onConnect={() => void connect()}
              onDisconnect={() => {
                setDisconnectError(null);
                setConfirming(true);
              }}
            />
          )}

          {/* What just happened: always mounted, so it speaks when it fills. */}
          <PhaseLine phase={phase} />
        </section>

        {connection?.status === "connected" && <SetupSections connection={connection} />}
      </div>

      {confirming && (
        <ConfirmDialog
          title={`Disconnect ${EBAY_NAME}?`}
          description={`We take down every ${EBAY_NAME} listing NeonBinder put up and stop bringing sales in. Listings you made on ${EBAY_NAME} yourself stay untouched. Your cards and boxes stay right here.`}
          confirmLabel="Yes, disconnect"
          busyLabel="Disconnecting…"
          busy={disconnecting}
          error={disconnectError}
          onConfirm={() => void confirmDisconnect()}
          onCancel={() => {
            restoreDisconnect.current = true;
            setConfirming(false);
          }}
        />
      )}
    </div>
  );
}

function PhaseLine({ phase }: { phase: Phase }) {
  const error = phase.kind === "error" || (phase.kind === "disconnected" && phase.notEnded > 0);
  let text = "";
  if (phase.kind === "completing") text = `Hooking up your ${EBAY_NAME} account…`;
  else if (phase.kind === "leaving") text = `Off to ${EBAY_NAME} to say yes…`;
  else if (phase.kind === "connected") text = `Connected to ${EBAY_NAME} as ${phase.username}. Start with where you ship from, below.`;
  else if (phase.kind === "declined") text = `No worries, ${EBAY_NAME} isn't connected. Connect whenever you're ready.`;
  else if (phase.kind === "disconnected")
    text =
      phase.notEnded > 0
        ? notEndedLine(phase.notEnded)
        : `Disconnected from ${EBAY_NAME}. Every listing NeonBinder put up there is down.`;
  else if (phase.kind === "error") text = phase.error;
  // `empty:absolute`: out of the flow while empty (still in the tree, so it
  // speaks when it fills), so it leaves no phantom gap at the card's foot.
  return (
    <p
      key={error ? "error" : "ok"}
      role={error ? "alert" : "status"}
      aria-live={error ? undefined : "polite"}
      className={`text-sm empty:absolute ${error ? "text-neon-pink-text" : phase.kind === "connected" ? "text-neon-green-text" : "text-ink-3"}`}
    >
      {text}
    </p>
  );
}

function ConnectionBody({
  connection,
  phase,
  reasonId,
  consentId,
  connectRef,
  disconnectRef,
  onConnect,
  onDisconnect,
}: {
  connection: EbayConnectionState;
  phase: Phase;
  reasonId: string;
  consentId: string;
  connectRef: RefObject<HTMLButtonElement | null>;
  disconnectRef: RefObject<HTMLButtonElement | null>;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const busy = phase.kind === "leaving" || phase.kind === "completing";
  const connectButton = (label: string, describedBy?: string) => (
    <NeonButton
      ref={connectRef}
      type="button"
      onClick={onConnect}
      aria-disabled={busy || !connection.configured || undefined}
      aria-busy={busy || undefined}
      aria-describedby={describedBy}
      className="max-sm:min-h-11"
    >
      {phase.kind === "leaving" ? `Heading to ${EBAY_NAME}…` : phase.kind === "completing" ? "Connecting…" : label}
    </NeonButton>
  );
  const disconnectButton = (
    <NeonButton
      ref={disconnectRef}
      type="button"
      variant="negative"
      outline
      onClick={onDisconnect}
      className="max-sm:min-h-11"
    >
      Disconnect {EBAY_NAME}
    </NeonButton>
  );

  if (!connection.configured) {
    return (
      <div className="space-y-3">
        <p id={reasonId} className="text-sm text-ink-2">
          {NOT_CONFIGURED_LINE}
        </p>
        {connectButton(`Connect ${EBAY_NAME}`, reasonId)}
      </div>
    );
  }

  switch (connection.status) {
    case "notConnected":
      return (
        <div className="space-y-4">
          <p className="text-base text-ink">Connect your {EBAY_NAME} seller account.</p>
          <p
            id={consentId}
            className="rounded-md border border-notice-warn-rule bg-notice-warn-bg p-3 text-sm text-notice-warn-ink"
          >
            <strong className="block">{CONSENT_HEADING}</strong>
            {EBAY_CONSENT_LINE}
          </p>
          <p className="text-sm text-ink-3">
            You say yes on {EBAY_NAME}&apos;s own page. Your {EBAY_NAME} password never comes near NeonBinder.
          </p>
          {connectButton(`Connect ${EBAY_NAME}`, consentId)}
        </div>
      );
    case "connected":
      return (
        <div className="space-y-4">
          <p className="text-lg text-ink">
            Rockin&apos; on {EBAY_NAME} as{" "}
            <span className="font-semibold text-neon-purple-text">{connection.ebayUsername ?? "your seller account"}</span>
            {connection.since ? ` since ${listingDay(connection.since)}` : ""}.
          </p>
          <p className="text-sm text-ink-2">
            {connection.setupComplete
              ? `Every raw card in a listed box goes up at its box count, and sales land in Inventory, under Sales. Disconnecting stops both.`
              : `Nothing goes up until your setup below is done. Then every raw card in a listed box lists at its box count.`}
          </p>
          {disconnectButton}
        </div>
      );
    case "needsReauth":
      return (
        <div className="space-y-4">
          <p className="rounded-md border border-notice-warn-rule bg-notice-warn-bg p-3 text-sm text-notice-warn-ink">
            <strong className="block">Your {EBAY_NAME} connection ran out.</strong>
            Nothing goes up or comes in until you connect again. Your setup stays saved.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            {connectButton(`Connect ${EBAY_NAME} again`)}
            {disconnectButton}
          </div>
        </div>
      );
    case "paused":
      return (
        <div className="space-y-4">
          <p className="rounded-md border border-notice-warn-rule bg-notice-warn-bg p-3 text-sm text-notice-warn-ink">
            {pausedLine(EBAY_NAME)}
          </p>
          {disconnectButton}
        </div>
      );
    case "sellerConflict":
      return (
        <div className="space-y-4">
          <p className="rounded-md border border-notice-warn-rule bg-notice-warn-bg p-3 text-sm text-notice-warn-ink">
            {sellerConflictLine(EBAY_NAME, connection.ebayUsername)}
          </p>
          <p className="text-sm text-ink-2">Disconnect it here, then connect the seller account that belongs to you.</p>
          {disconnectButton}
        </div>
      );
  }
}

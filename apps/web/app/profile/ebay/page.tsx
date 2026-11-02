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
 * setup is finished; the checklist at the foot says what's left.
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
 * account. Every refusal is an alert; progress is a polite status.
 *
 * Focus: after connecting, the Connection heading (the button that started
 * it is a page load ago); after disconnecting, Connect (Disconnect is gone).
 */

/** Codes already handed to the server: StrictMode's second effect run, or a remount, must not spend one twice. */
const spentCodes = new Set<string>();

type Phase =
  | { kind: "idle" }
  | { kind: "completing" }
  | { kind: "connected"; username: string }
  | { kind: "declined" }
  | { kind: "error"; error: string }
  | { kind: "leaving" };

const NOT_CONFIGURED_LINE = `${EBAY_NAME} isn't hooked up on this NeonBinder yet.`;
const CONNECT_FAILED = `Couldn't reach ${EBAY_NAME} to connect. Give it another try.`;

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

  const [phase, setPhase] = useState<Phase>(() =>
    code && oauthState ? { kind: "completing" } : declinedParam ? { kind: "declined" } : { kind: "idle" },
  );
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const headingId = useId();
  const reasonId = useId();
  const consentId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const connectRef = useRef<HTMLButtonElement>(null);
  /** Where focus goes once the server's state catches up with what just happened. */
  const focusNext = useRef<null | "heading" | "connect">(null);

  // eBay's return: spend the code once, then clean the URL (replace: no Back step).
  useEffect(() => {
    if (!code || !oauthState) {
      if (declinedParam) setParams({}, { replace: true });
      return;
    }
    setParams({}, { replace: true });
    if (spentCodes.has(code)) return;
    spentCodes.add(code);
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
      () => {
        focusNext.current = "connect";
        setPhase({ kind: "error", error: CONNECT_FAILED });
      },
    );
  }, [code, oauthState, declinedParam, completeConnect, setParams]);

  const status = connection?.status;
  useEffect(() => {
    if (focusNext.current === "heading" && status && status !== "notConnected") {
      focusNext.current = null;
      headingRef.current?.focus();
    } else if (focusNext.current === "connect" && (status === "notConnected" || status === "needsReauth")) {
      focusNext.current = null;
      connectRef.current?.focus();
    }
  }, [status, phase]);

  const connect = async () => {
    if (phase.kind === "leaving" || phase.kind === "completing" || !connection?.configured) return;
    setPhase({ kind: "leaving" });
    try {
      const { authorizeUrl } = await beginConnect({});
      window.location.assign(authorizeUrl);
    } catch {
      setPhase({ kind: "error", error: CONNECT_FAILED });
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
      focusNext.current = "connect";
      setConfirming(false);
      setPhase({ kind: "idle" });
    } catch {
      setDisconnectError(`Couldn't disconnect from ${EBAY_NAME}. Give it another try.`);
    } finally {
      setDisconnecting(false);
    }
  };

  const sandbox = connection?.environment === "sandbox";

  return (
    <div className="space-y-6">
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
            <span className="rounded-full border border-pick-teal-rule bg-pick-teal px-2 py-0.5 text-xs font-medium text-pick-teal-ink">
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
          <p role="status" className="text-sm text-ink-3" aria-busy="true">
            Checking your {EBAY_NAME} connection…
          </p>
        ) : (
          <ConnectionBody
            connection={connection}
            phase={phase}
            reasonId={reasonId}
            consentId={consentId}
            connectRef={connectRef}
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

      {confirming && (
        <ConfirmDialog
          title={`Disconnect ${EBAY_NAME}?`}
          description={`We take down every ${EBAY_NAME} listing NeonBinder put up and stop bringing sales in. Listings you made on ${EBAY_NAME} yourself stay untouched. Your cards and boxes stay right here.`}
          confirmLabel="Yes, disconnect"
          busyLabel="Disconnecting…"
          busy={disconnecting}
          error={disconnectError}
          onConfirm={() => void confirmDisconnect()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

function PhaseLine({ phase }: { phase: Phase }) {
  const error = phase.kind === "error";
  let text = "";
  if (phase.kind === "completing") text = `Hooking up your ${EBAY_NAME} account…`;
  else if (phase.kind === "leaving") text = `Off to ${EBAY_NAME} to say yes…`;
  else if (phase.kind === "connected") text = `Connected to ${EBAY_NAME} as ${phase.username}. Now pick your shipping below.`;
  else if (phase.kind === "declined") text = `No worries, ${EBAY_NAME} isn't connected. Connect whenever you're ready.`;
  else if (error) text = phase.error;
  return (
    <p
      key={error ? "error" : "ok"}
      role={error ? "alert" : "status"}
      aria-live={error ? undefined : "polite"}
      className={`text-sm ${error ? "text-neon-pink-text" : phase.kind === "connected" ? "text-notice-success-ink" : "text-ink-3"}`}
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
  onConnect,
  onDisconnect,
}: {
  connection: EbayConnectionState;
  phase: Phase;
  reasonId: string;
  consentId: string;
  connectRef: RefObject<HTMLButtonElement | null>;
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
    <NeonButton type="button" variant="negative" outline onClick={onDisconnect} className="max-sm:min-h-11">
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
            <strong className="block">Your {EBAY_NAME} pass ran out.</strong>
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
            {sellerConflictLine(EBAY_NAME)}
            {connection.ebayUsername ? ` (${connection.ebayUsername})` : ""}
          </p>
          <p className="text-sm text-ink-2">Disconnect it here, then connect the seller account that belongs to you.</p>
          {disconnectButton}
        </div>
      );
  }
}

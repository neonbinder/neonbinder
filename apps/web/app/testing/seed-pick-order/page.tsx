import { useConvexAuth, useMutation } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "@/convex/_generated/api";

// Test-only seed hop (NEO-500). An E2E spec visits
//   /testing/seed-pick-order?order=<orderNo>&box=<box name>&cards=<no>:<qty>,<no>:<qty>[&bad=1][&listed=<no>:<players>]&redirect=<final>
// to record and apply a BuySportsCards order over the caller's named box
// (`listed` adds one line NB cannot match that describes card <no> by
// <players> in the first card's set, NEO-509), or
//   /testing/seed-pick-order?order=<orderNo>&ship=1&redirect=<final>
// to mark that order shipped. This page waits for the Convex client to pick
// up the Clerk session, calls the auth-scoped seedMyTestPickOrder mutation
// (the caller's own rows only; no marketplace is called), then forwards.
//
// It exists because a sale cannot be made on cue: the seller accounts are
// shared, and a real order needs a real buyer.
//
// Only functional when VITE_CLERK_TESTING_ENABLED=true; the mutation itself
// also fails closed on production Convex (no TESTING_RESET_SECRET there).

/** `"12:2,7:1"` → `[{cardNumber:"12",quantity:2},{cardNumber:"7",quantity:1}]`; null when malformed. */
function parseCards(raw: string | null): Array<{ cardNumber: string; quantity: number }> | null {
  if (!raw) return null;
  const out: Array<{ cardNumber: string; quantity: number }> = [];
  for (const part of raw.split(",")) {
    const at = part.lastIndexOf(":");
    if (at <= 0) return null;
    const cardNumber = part.slice(0, at).trim();
    const quantity = Number(part.slice(at + 1));
    if (!cardNumber || !Number.isInteger(quantity)) return null;
    out.push({ cardNumber, quantity });
  }
  return out.length > 0 ? out : null;
}

/** `"208:Listed Player"` → `{cardNumber:"208",players:"Listed Player"}`; null when absent or malformed. */
function parseListed(raw: string | null): { cardNumber: string; players: string } | null {
  if (!raw) return null;
  const at = raw.indexOf(":");
  if (at <= 0) return null;
  const cardNumber = raw.slice(0, at).trim();
  const players = raw.slice(at + 1).trim();
  return cardNumber && players ? { cardNumber, players } : null;
}

export default function TestingSeedPickOrderPage() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const seed = useMutation(api.testing.seedMyTestPickOrder);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get("redirect") || "/dashboard";
  // Required and not defaulted: a typo'd param must not seed an order the spec never meant.
  const orderNo = searchParams.get("order");
  const ship = searchParams.get("ship") === "1";
  const boxName = searchParams.get("box");
  const cardsParam = searchParams.get("cards");
  const badLine = searchParams.get("bad") === "1";
  const listedParam = searchParams.get("listed");
  const [status, setStatus] = useState("Initializing...");
  const ranRef = useRef(false);

  useEffect(() => {
    if (import.meta.env.VITE_CLERK_TESTING_ENABLED !== "true") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- status readout of an async driver effect; test-only page
      setStatus("Testing mode is not enabled in this environment.");
      return;
    }
    if (!orderNo) {
      setStatus("Missing ?order= parameter.");
      return;
    }
    const cards = parseCards(cardsParam);
    if (!ship && (!boxName || !cards)) {
      setStatus("Missing or malformed ?box= / ?cards= parameter.");
      return;
    }
    const listedLine = parseListed(listedParam);
    if (listedParam !== null && !listedLine) {
      setStatus("Malformed ?listed= parameter (want <no>:<players>).");
      return;
    }
    if (isLoading) return;
    if (!isAuthenticated) {
      setStatus("Waiting for authentication...");
      return;
    }
    if (ranRef.current) return;
    ranRef.current = true;
    (async () => {
      try {
        if (ship) {
          setStatus(`Shipping order ${orderNo}...`);
          await seed({ orderNo, ship: true });
        } else {
          setStatus(`Seeding order ${orderNo}...`);
          const result = await seed({
            orderNo,
            boxName: boxName ?? "",
            cards: cards ?? [],
            badLine,
            ...(listedLine ? { listedLine } : {}),
          });
          setStatus(`Seeded order ${orderNo}: ${result.applied} of ${result.lines} lines applied.`);
        }
        navigate(redirect);
      } catch (e: unknown) {
        setStatus(`Error: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
      }
    })();
  }, [badLine, boxName, cardsParam, isAuthenticated, isLoading, listedParam, navigate, orderNo, redirect, seed, ship]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-surface">
      <p className="text-ink-3 font-mono text-sm">[testing-seed-pick-order] {status}</p>
    </div>
  );
}

import { useState } from "react";
import { Link } from "react-router";
import { ChevronDownIcon } from "@heroicons/react/24/solid";
import { describeRule, type Binder, type BinderRule } from "../_shared/data";
import { useP5 } from "./context";
import CardTile from "./CardTile";
import { countOwned, pcKey, type PcRef, type TeamMode } from "./model";

const PREVIEW = 18;

/** A smart binder whose rule IS a PC opens as that PC. */
function pcFor(rule: BinderRule): { ref: PcRef; mode: TeamMode } | null {
  if (rule.kind === "player")
    return { ref: { kind: "player", id: rule.playerId }, mode: "onCard" };
  if (rule.kind === "teamOnCard")
    return { ref: { kind: "team", id: rule.teamId }, mode: "onCard" };
  if (rule.kind === "playedFor")
    return { ref: { kind: "team", id: rule.teamId }, mode: "playedFor" };
  return null;
}

export default function BindersView() {
  const { store } = useP5();
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div>
      <p className="max-w-prose text-slate-300">
        Every PC is already a smart binder in disguise. Save one from its page
        and it lands here, filling itself as new cards hit the catalog. A card
        can sit in as many binders as you like.
      </p>
      <ul className="mt-6 flex flex-col gap-3">
        {store.state.binders.map((b) => (
          <BinderRow
            key={b.id}
            binder={b}
            open={open === b.id}
            onToggle={() => setOpen(open === b.id ? null : b.id)}
          />
        ))}
      </ul>
    </div>
  );
}

function BinderRow({
  binder,
  open,
  onToggle,
}: {
  binder: Binder;
  open: boolean;
  onToggle: () => void;
}) {
  const { store, owned } = useP5();
  const cards = store.binderCards(binder);
  const smart = binder.kind === "smart";
  const have = smart
    ? countOwned(cards, owned)
    : store.binderCopies(binder).length;
  const pc = smart ? pcFor(binder.rule) : null;
  const panelId = `p5-binder-${binder.id}`;

  return (
    <li className="rounded-xl border border-slate-700 bg-slate-950">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-bold text-white">{binder.name}</h2>
          <p className="text-sm text-slate-300">
            {smart ? `Smart: ${describeRule(binder.rule)}` : "Hand-picked"}
            {binder.description ? `. ${binder.description}` : ""}
          </p>
        </div>
        <p className="text-sm tabular-nums text-slate-200">
          {smart ? (
            <>
              <span className="text-lg font-bold text-white">{have}</span> of{" "}
              {cards.length}
            </>
          ) : (
            <>
              <span className="text-lg font-bold text-white">{have}</span>{" "}
              {have === 1 ? "copy" : "copies"}
            </>
          )}
        </p>
        {pc && (
          <Link
            to={`?pc=${pcKey(pc.ref)}&mode=${pc.mode}`}
            className="inline-flex min-h-11 items-center rounded-md border border-slate-600 px-3 text-sm text-slate-200 hover:border-slate-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] sm:min-h-8"
            aria-label={`Open ${binder.name} as a PC`}
          >
            Open as PC
          </Link>
        )}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
          aria-label={`${open ? "Hide" : "Show"} cards in ${binder.name}`}
          className="inline-flex min-h-11 items-center gap-1 rounded-md border border-slate-600 px-3 text-sm text-slate-200 hover:border-slate-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] sm:min-h-8"
        >
          {open ? "Hide" : "Show"}
          <ChevronDownIcon
            aria-hidden="true"
            className={`h-4 w-4 ${open ? "rotate-180" : ""}`}
          />
        </button>
      </div>
      {open && (
        <div id={panelId} className="border-t border-slate-800 p-4">
          {cards.length === 0 ? (
            <p className="text-sm text-slate-300">Empty for now.</p>
          ) : (
            <ul className="flex flex-wrap gap-x-3 gap-y-4">
              {cards.slice(0, PREVIEW).map((c) => (
                <li key={c.id}>
                  <CardTile card={c} size="sm" />
                </li>
              ))}
            </ul>
          )}
          {cards.length > PREVIEW && (
            <p className="mt-3 text-sm text-slate-300">
              And {cards.length - PREVIEW} more
              {pc ? ". Open it as a PC to see them all." : "."}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

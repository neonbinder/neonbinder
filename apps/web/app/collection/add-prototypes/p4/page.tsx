import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import Overlay from "../../prototypes/p1/Overlay";
import LoosePile from "../_shared/loose";
import {
  BINDERS,
  BOXES,
  bandOf,
  cardTitle,
  money,
  useIntakeSim,
  variantNames,
  type Item,
} from "../_shared/sim";
import {
  AddSources,
  BandBadge,
  CardPicker,
  DetailsFields,
  FIX_TOOLS,
  IntakeBanner,
  NeedsYou,
  RING,
  ScanImage,
  StageCounters,
  effectiveDetails,
  homeName,
  homesFor,
  initialSetup,
  type Setup,
} from "../_shared/ui";
import PublicFrame from "../_shared/PublicFrame";
import "../_shared/intake.css";

/**
 * NEO-369 — add-cards prototype 4, "Keyboard Counter".
 *
 * As fast as the CLI: the hands never leave the keyboard. Setup is three
 * prompts answered with type-ahead and Enter. Then one card at a time, large,
 * with the CLI's own keys (Enter accepts, digits set the quantity, M picks by
 * hand, V switches variation, R/C/S/X/U fix the scan) and a status line that
 * always says what the pipeline is doing. Minimal motion: nothing moves that
 * the eye has to follow.
 */

type Prompt = "kind" | "home" | "variant" | "condition" | "done";

const KIND_OPTIONS = [
  { value: "binder", label: "Collection: a binder" },
  { value: "box", label: "Inventory: a box" },
];

export default function AddCardsPrototype4() {
  useDocumentTitle("Keyboard Counter · Add cards prototype");
  const [setup, setSetup] = useState<Setup>(initialSetup("binder"));
  const [prompt, setPrompt] = useState<Prompt>("kind");
  const sim = useIntakeSim({
    setChosen: setup.variant !== null,
    homeId: setup.homeId,
    running: prompt === "done",
  });

  return (
    <PublicFrame>
      <div data-motion="low">
        <IntakeBanner
          current={4}
          note="keyboard-first like the CLI, low motion"
        />
        {prompt !== "done" ? (
          <SetupPrompts
            setup={setup}
            setSetup={setSetup}
            prompt={prompt}
            setPrompt={setPrompt}
          />
        ) : (
          <Counter sim={sim} setup={setup} onSetup={() => setPrompt("kind")} />
        )}
      </div>
    </PublicFrame>
  );
}

/* ------------------------------------------------------------------ */
/* Setup: three prompts, type-ahead, Enter                             */
/* ------------------------------------------------------------------ */

function SetupPrompts({
  setup,
  setSetup,
  prompt,
  setPrompt,
}: {
  setup: Setup;
  setSetup: (s: Setup) => void;
  prompt: Prompt;
  setPrompt: (p: Prompt) => void;
}) {
  const answered: { q: string; a: string }[] = [];
  if (prompt !== "kind")
    answered.push({
      q: "Adding to",
      a: setup.kind === "binder" ? "Collection" : "Inventory",
    });
  if (prompt === "variant" || prompt === "condition")
    answered.push({ q: "Put them in", a: homeName(setup.homeId) });
  if (prompt === "condition")
    answered.push({
      q: "Set",
      a: setup.variant
        ? `2024 Topps Chrome ${setup.variant}`
        : "find from photos",
    });
  return (
    <section
      className="max-w-2xl space-y-3 rounded-lg border border-panel-rule bg-panel p-5 font-mono shadow-offset"
      aria-label="Set up the run"
    >
      {answered.map((x) => (
        <p key={x.q} className="m-0 text-sm text-ink-3">
          <span className="text-neon-green-text">✔</span> {x.q}:{" "}
          <span className="text-ink-2">{x.a}</span>
        </p>
      ))}
      {prompt === "kind" && (
        <TypeAhead
          question="Adding to?"
          options={KIND_OPTIONS}
          onPick={(v) => {
            setSetup(initialSetup(v as "binder" | "box"));
            setPrompt("home");
          }}
        />
      )}
      {prompt === "home" && (
        <TypeAhead
          question={setup.kind === "binder" ? "Which binder?" : "Which box?"}
          options={(setup.kind === "binder" ? BINDERS : BOXES).map((h) => ({
            value: h.id,
            label: h.name,
          }))}
          onPick={(v) => {
            setSetup({ ...setup, homeId: v });
            setPrompt("variant");
          }}
        />
      )}
      {prompt === "variant" && (
        <TypeAhead
          question="Which set? (Baseball › 2024 › Topps › Topps Chrome ›)"
          options={[
            ...variantNames().map((v) => ({ value: v, label: v })),
            { value: "", label: "Skip: find the set from the photos" },
          ]}
          onPick={(v) => {
            const variant = v || null;
            setSetup({
              ...setup,
              variant,
              defaults: {
                ...setup.defaults,
                priceCents: variant
                  ? (setup.commonPrices[variant] ?? null)
                  : null,
              },
            });
            setPrompt("condition");
          }}
        />
      )}
      {prompt === "condition" && (
        <TypeAhead
          question={`Condition for every card?${setup.kind === "box" ? ` (min price ${money(setup.defaults.priceCents)}; D changes it later)` : ""}`}
          options={[
            "Near Mint",
            "Mint",
            "Excellent",
            "Very Good",
            "Good",
            "Poor",
          ].map((c) => ({ value: c, label: c }))}
          onPick={(v) => {
            setSetup({
              ...setup,
              defaults: { ...setup.defaults, condition: v },
            });
            setPrompt("done");
          }}
        />
      )}
    </section>
  );
}

function TypeAhead({
  question,
  options,
  onPick,
}: {
  question: string;
  options: { value: string; label: string }[];
  onPick: (v: string) => void;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const hits = options.filter((o) =>
    o.label.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <div className="space-y-1">
      <label className="block text-sm text-ink">
        <span className="text-neon-blue-text">?</span> {question}
        <Input
          bare
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="p4-options"
          aria-activedescendant={hits[active] ? `p4-opt-${active}` : undefined}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(hits.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter" && hits[active]) {
              e.preventDefault();
              onPick(hits[active].value);
            }
          }}
          className={`ml-2 w-64 rounded-md border border-field-rule bg-field px-2 py-1 text-sm text-ink ${RING}`}
        />
      </label>
      <ul
        id="p4-options"
        role="listbox"
        aria-label={question}
        className="m-0 list-none space-y-0.5 p-0 pl-4 text-sm"
      >
        {hits.map((o, n) => (
          <li
            key={o.value || "skip"}
            id={`p4-opt-${n}`}
            role="option"
            aria-selected={n === active}
            onClick={() => onPick(o.value)}
            className={n === active ? "text-neon-green-text" : "text-ink-3"}
          >
            {n === active ? "❯ " : "  "}
            {o.label}
          </li>
        ))}
      </ul>
      <p className="m-0 text-xs text-ink-3">
        ↑↓ to move, type to filter, Enter to choose
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The counter                                                         */
/* ------------------------------------------------------------------ */

type Panel = null | "pick" | "details" | "help";

const BAND_ORDER = { none: 0, check: 1, matched: 2 } as const;

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" ||
      el.tagName === "SELECT" ||
      el.tagName === "TEXTAREA")
  );
}

function Counter({
  sim,
  setup,
  onSetup,
}: {
  sim: ReturnType<typeof useIntakeSim>;
  setup: Setup;
  onSetup: () => void;
}) {
  const queue = useMemo(
    () =>
      sim.items
        .filter((i) => i.stage === "review")
        .sort((a, b) => BAND_ORDER[bandOf(a)] - BAND_ORDER[bandOf(b)]),
    [sim.items],
  );
  const [index, setIndex] = useState(0);
  const item: Item | undefined = queue[Math.min(index, queue.length - 1)];
  // The typed quantity belongs to one card; moving to another card drops it.
  const [typed, setTyped] = useState<{ id: string; value: string } | null>(
    null,
  );
  const qtyBuffer = typed && typed.id === item?.id ? typed.value : null;
  const setQtyBuffer = useCallback(
    (next: string | null | ((b: string | null) => string | null)) =>
      setTyped((t) => {
        const prev = t && t.id === item?.id ? t.value : null;
        const value = typeof next === "function" ? next(prev) : next;
        return value === null || !item ? null : { id: item.id, value };
      }),
    [item],
  );
  const [panel, setPanel] = useState<Panel>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const variationIdx = useRef(0);

  const say = useCallback((text: string) => {
    setFlash(text);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (panel && e.key === "Escape") {
        setPanel(null);
        return;
      }
      if (isTyping(e.target) || panel || e.metaKey || e.ctrlKey || e.altKey)
        return;
      if (e.key === "?") {
        setPanel("help");
        return;
      }
      if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        say(`Saved ${sim.counts.matched} matched cards`);
        sim.actions.saveAllConfident();
        return;
      }
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((n) => Math.min(queue.length - 1, n + 1));
        return;
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((n) => Math.max(0, n - 1));
        return;
      }
      if (!item) return;
      if (/^[0-9]$/.test(e.key)) {
        setQtyBuffer((b) => (b ?? "") + e.key);
        return;
      }
      if (e.key === "Backspace" && qtyBuffer !== null) {
        setQtyBuffer((b) => (b && b.length > 1 ? b.slice(0, -1) : null));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (!item.match.cardId) {
          say("No card picked yet: press M to find it");
          return;
        }
        if (qtyBuffer !== null) {
          sim.actions.setQty(item.id, Number(qtyBuffer));
          say(`Saved ${cardTitle(item.match.cardId)} × ${qtyBuffer}`);
        } else {
          sim.actions.confirm(item.id);
          say(`Saved ${cardTitle(item.match.cardId)} × ${item.qty}`);
        }
        return;
      }
      if (e.key === "+") {
        setQtyBuffer(
          String((qtyBuffer !== null ? Number(qtyBuffer) : item.qty) + 1),
        );
        return;
      }
      if (e.key === "Escape") {
        setQtyBuffer(null);
        return;
      }
      const lower = e.key.toLowerCase();
      if (lower === "m") {
        e.preventDefault();
        setPanel("pick");
        return;
      }
      if (lower === "d") {
        e.preventDefault();
        setPanel("details");
        return;
      }
      if (lower === "v") {
        const options = item.match.candidates.length
          ? item.match.candidates
          : item.match.suggestion
            ? [item.match.suggestion]
            : [];
        if (options.length === 0) {
          say("No other variation for this card");
          return;
        }
        variationIdx.current = (variationIdx.current + 1) % options.length;
        sim.actions.pick(item.id, options[variationIdx.current]);
        say(`Now ${cardTitle(options[variationIdx.current])}`);
        return;
      }
      if (lower === "y" && item.match.suggestion) {
        sim.actions.suggestion(item.id, true);
        return;
      }
      if (lower === "n" && item.match.suggestion) {
        sim.actions.suggestion(item.id, false);
        return;
      }
      if (lower === "b") {
        const homes = homesFor(setup.kind);
        const next =
          homes[
            (homes.findIndex((h) => h.id === item.homeId) + 1) % homes.length
          ];
        sim.actions.moveHome(item.id, next.id);
        say(`This card goes to ${next.name}`);
        return;
      }
      if (lower === "p" && item.setGuess) {
        sim.actions.pinSet();
        say(`Every card is now ${item.setGuess}`);
        return;
      }
      const tool = FIX_TOOLS.find((t) => t.key === e.key);
      if (tool) {
        tool.run(sim, item);
        say(tool.label);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    item,
    panel,
    qtyBuffer,
    queue.length,
    say,
    setQtyBuffer,
    setup.kind,
    sim,
  ]);

  const details = item ? effectiveDetails(item, setup.defaults) : null;
  const band = item ? bandOf(item) : null;
  const working = sim.items.filter(
    (i) => i.stage !== "review" && i.stage !== "saved",
  );

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <section
        className="min-w-0 space-y-4 rounded-lg border border-panel-rule bg-panel p-5 shadow-offset"
        aria-labelledby="p4-card"
      >
        {!item ? (
          <div className="py-16 text-center">
            <h3 id="p4-card" className="m-0 text-lg font-semibold text-ink">
              Waiting for cards
            </h3>
            <p className="text-sm text-ink-3">
              {working.length > 0
                ? `${working.length} in the pipeline. The next one lands here.`
                : "Scan or drop cards to start."}
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-3">
              <h3
                id="p4-card"
                className={`m-0 text-2xl font-bold ${band === "matched" ? "text-neon-green-text" : band === "check" ? "text-notice-warn-ink" : "text-neon-pink-text"}`}
              >
                {cardTitle(item.match.cardId)}
              </h3>
              <BandBadge item={item} />
              <span className="text-xs text-ink-3">
                {index + 1} of {queue.length} needing you · j/k to move
              </span>
            </div>
            <div className="flex flex-wrap gap-6">
              <div className="flex gap-3">
                <ScanImage item={item} side="front" size="lg" />
                <ScanImage item={item} side="back" size="lg" />
              </div>
              <div className="min-w-[16rem] flex-1 space-y-3">
                <NeedsYou
                  item={item}
                  sim={sim}
                  onPick={() => setPanel("pick")}
                />
                <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-sm">
                  <Key k="Q">Quantity</Key>
                  <dd className="m-0 text-ink">
                    {qtyBuffer !== null ? (
                      <span className="rounded bg-neon-green px-1.5 text-on-neon-green">
                        {qtyBuffer}▏
                      </span>
                    ) : (
                      <span>{item.qty}</span>
                    )}
                    <span className="ml-2 text-ink-3">
                      {item.newLine
                        ? "new line (yours already has a photo)"
                        : item.had > 0
                          ? `had ${item.had}`
                          : "new"}{" "}
                      · type digits, + adds one
                    </span>
                  </dd>
                  <Key k="B">{setup.kind === "binder" ? "Binder" : "Box"}</Key>
                  <dd className="m-0 text-ink-2">{homeName(item.homeId)}</dd>
                  <Key k="D">Details</Key>
                  <dd className="m-0 text-ink-2">
                    {details!.condition}
                    {details!.grading
                      ? `, ${details!.grading.grader} ${details!.grading.grade} #${details!.grading.cert}`
                      : ""}
                    {details!.serial ? `, ${details!.serial}` : ""}
                    {setup.kind === "box"
                      ? `, min ${money(details!.priceCents)}`
                      : ""}
                  </dd>
                  <Key k="V">Variation</Key>
                  <dd className="m-0 text-ink-3">
                    {item.match.candidates.length || item.match.suggestion
                      ? "press V to switch"
                      : "none"}
                  </dd>
                </dl>
                <p className="m-0 font-mono text-xs text-ink-3">
                  <kbd className="text-ink">Enter</kbd> save ·{" "}
                  <kbd className="text-ink">M</kbd> pick card ·{" "}
                  {FIX_TOOLS.map((t) => (
                    <span key={t.key}>
                      <kbd className="text-ink">
                        {t.key === t.key.toUpperCase()
                          ? `⇧${t.key}`
                          : t.key.toUpperCase()}
                      </kbd>{" "}
                      {t.label.toLowerCase()} ·{" "}
                    </span>
                  ))}
                  <kbd className="text-ink">⇧Enter</kbd> save all matched ·{" "}
                  <kbd className="text-ink">?</kbd> help
                </p>
              </div>
            </div>
          </>
        )}
        <p
          role="status"
          aria-live="polite"
          className="m-0 min-h-5 font-mono text-sm text-neon-blue-text"
        >
          {flash ?? ""}
        </p>
      </section>

      <aside className="space-y-4" aria-label="Pipeline">
        <div className="rounded-lg border border-rule p-3">
          <StageCounters sim={sim} compact />
        </div>
        <ol
          className="m-0 list-none space-y-1 p-0 font-mono text-xs"
          aria-label="Queue"
        >
          {queue.map((q, n) => (
            <li key={q.id}>
              <button
                type="button"
                onClick={() => setIndex(n)}
                aria-current={q.id === item?.id ? "true" : undefined}
                className={`min-h-6 w-full truncate rounded px-1.5 py-0.5 text-left ${RING} ${q.id === item?.id ? "bg-pick-blue text-pick-blue-ink" : "text-ink-2"}`}
              >
                {bandOf(q) === "matched"
                  ? "✓"
                  : bandOf(q) === "check"
                    ? "?"
                    : "✗"}{" "}
                {cardTitle(q.match.cardId)}
              </button>
            </li>
          ))}
        </ol>
        <LoosePile sim={sim} dense />
        <AddSources sim={sim} compact />
        <button
          type="button"
          onClick={onSetup}
          className={`text-xs text-neon-blue-text underline ${RING}`}
        >
          Change the run setup
        </button>
      </aside>

      {panel && item && (
        <Overlay
          variant="modal"
          labelledBy="p4-panel-title"
          onClose={() => setPanel(null)}
        >
          <div className="space-y-3 p-4">
            <h3
              id="p4-panel-title"
              tabIndex={-1}
              className="m-0 text-base font-semibold text-ink"
            >
              {panel === "pick"
                ? "Pick the card"
                : panel === "details"
                  ? "Details for this card"
                  : "Keys"}
            </h3>
            {panel === "pick" && (
              <CardPicker item={item} sim={sim} onDone={() => setPanel(null)} />
            )}
            {panel === "details" && (
              <>
                <DetailsFields
                  kind={setup.kind}
                  value={details!}
                  onChange={(p) => sim.actions.setDetails(item.id, p)}
                  dense
                />
                <NeonButton
                  size="1"
                  variant="secondary"
                  onClick={() => setPanel(null)}
                >
                  Done (Esc)
                </NeonButton>
              </>
            )}
            {panel === "help" && (
              <>
                <p className="m-0 text-sm text-ink-2">
                  The CLI&apos;s keys, plus: J/K move through the queue, Y/N
                  answer a variant prompt, B moves this card to the next{" "}
                  {setup.kind}, P pins the found set.
                </p>
                <NeonButton
                  size="1"
                  variant="secondary"
                  onClick={() => setPanel(null)}
                  data-autofocus
                >
                  Close (Esc)
                </NeonButton>
              </>
            )}
          </div>
        </Overlay>
      )}
    </div>
  );
}

function Key({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <dt className="text-ink-3">
      <kbd className="text-neon-blue-text">({k})</kbd> {children}
    </dt>
  );
}

import { useId, useMemo, useState, type ReactNode } from "react";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import CardFace from "../../prototypes/_shared/CardFace";
import { getCard } from "../../prototypes/_shared/data";
import {
  COMMON_PRICES,
  DEFAULT_DETAILS,
  SET_LABEL,
  STAGE_LABEL,
  bandOf,
  cardTitle,
  cardsForPicking,
  money,
  type Details,
  type IntakeSim,
  type Item,
  type ScanSide,
  type Stage,
} from "./sim";

/**
 * NEO-369 — the pieces of the demo's Add cards tab (`./AddCardsTab`): scans,
 * badges, counters, the quantity field, the card picker, the prompts, the
 * fix tools and the detail fields.
 */

export const RING = "focus-outline";

/* ------------------------------------------------------------------ */
/* Scan images                                                         */
/* ------------------------------------------------------------------ */

/** A card back: no art exists for backs, so a stats-panel stand-in. */
function CardBack({ number, width }: { number: string; width: string }) {
  return (
    <div
      aria-hidden="true"
      style={{ width, aspectRatio: "2.5 / 3.5" }}
      className="flex flex-col gap-[6%] rounded-[4%] border border-rule-strong bg-sheet p-[8%]"
    >
      <div className="flex items-center justify-between">
        <span className="h-[1.2em] w-[40%] rounded-sm bg-rule-strong" />
        <span className="text-[0.6rem] font-bold text-ink-3">#{number}</span>
      </div>
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} className="h-[0.5em] rounded-sm bg-rule" style={{ width: `${90 - i * 9}%` }} />
      ))}
      <div className="mt-auto grid grid-cols-4 gap-[4%]">
        {Array.from({ length: 8 }, (_, i) => (
          <span key={i} className="h-[0.6em] rounded-sm bg-rule" />
        ))}
      </div>
    </div>
  );
}

const SIZE_WIDTH = { sm: "4.5rem", md: "7.5rem", lg: "13rem" } as const;

/**
 * One side of a scan as the pipeline sees it. While the side is still being
 * cropped it shows the raw scan (tilted, with bed margin) under a sweep; a
 * failed read is blurred; rotation is applied as the user rotates.
 */
export function ScanImage({
  item,
  side,
  size = "md",
  stage,
}: {
  item: Item;
  side: "front" | "back";
  size?: keyof typeof SIZE_WIDTH;
  stage?: Stage;
}) {
  const scan: ScanSide | null = side === "front" ? item.front : item.back;
  const width = SIZE_WIDTH[size];
  const raw = (stage ?? item.stage) === "uploading" || (stage ?? item.stage) === "reading" || scan?.recropping;
  if (!scan) {
    return (
      <div
        style={{ width, aspectRatio: "2.5 / 3.5" }}
        className="grid place-items-center rounded-md border border-dashed border-rule-strong text-center text-xs text-ink-3"
      >
        Waiting for the {side}
      </div>
    );
  }
  const card = item.truth ? getCard(item.truth) : null;
  const label = `${side === "front" ? "Front" : "Back"} scan, ${scan.file}`;
  return (
    <figure className="m-0 flex flex-col items-center gap-1">
      <div
        role="img"
        aria-label={label}
        className={`relative overflow-hidden rounded-md ${raw ? "bg-field p-[6%]" : ""}`}
        style={{ width: raw ? `calc(${width} * 1.12)` : width }}
      >
        <div
          className={`transition-transform duration-500 ease-out motion-reduce:transition-none ${scan.failed ? "blur-[3px]" : ""}`}
          style={{ transform: `rotate(${scan.rotation + (raw ? -4 : 0)}deg)` }}
          aria-hidden="true"
        >
          {side === "front" && card ? (
            <CardFace card={card} size="fill" />
          ) : (
            <CardBack number={card?.cardNumber ?? "?"} width="100%" />
          )}
        </div>
        {raw && <span aria-hidden="true" className="intake-sweep pointer-events-none absolute inset-0" />}
      </div>
      <figcaption className="max-w-full truncate text-xs text-ink-3" title={scan.file}>
        {scan.file}
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------ */
/* Badges and counters                                                 */
/* ------------------------------------------------------------------ */

export function BandBadge({ item }: { item: Item }) {
  if (item.stage !== "review" && item.stage !== "saved") {
    return <StageBadge stage={item.stage} />;
  }
  if (item.stage === "saved") {
    return <span className="rounded-full bg-wash-green px-2 py-0.5 text-xs font-semibold text-neon-green-text">Saved</span>;
  }
  const band = bandOf(item);
  const pct = `${item.match.confidence}%`;
  if (band === "matched") {
    return (
      <span className="rounded-full bg-wash-green px-2 py-0.5 text-xs font-semibold text-neon-green-text">
        {item.match.byUser ? "You picked" : `Matched ${pct}`}
      </span>
    );
  }
  if (band === "check") {
    return <span className="rounded-full bg-notice-warn-bg px-2 py-0.5 text-xs font-semibold text-notice-warn-ink">Check this {pct}</span>;
  }
  // Ink on a pink rim: pink text on the pink wash misses 4.5:1 on the drawer's
  // raised surface in dark mode.
  return <span className="rounded-full border border-neon-pink-text bg-wash-pink px-2 py-0.5 text-xs font-semibold text-ink">No match</span>;
}

export function StageBadge({ stage }: { stage: Stage }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-chip px-2 py-0.5 text-xs text-ink-2">
      <span aria-hidden="true" className="intake-dot size-1.5 rounded-full bg-neon-blue" />
      {STAGE_LABEL[stage]}
    </span>
  );
}

/**
 * The always-visible answer to "is it still working?": a count per stage and
 * one sentence. The sentence is the live region; the numbers are not, or a
 * screen reader would hear every tick.
 */
export function StageCounters({ sim, compact = false }: { sim: IntakeSim; compact?: boolean }) {
  const c = sim.counts;
  const cells: { label: string; value: number; tone: string }[] = [
    { label: "Reading", value: c.by.uploading + c.by.reading, tone: "text-neon-blue-text" },
    { label: "Pairing", value: c.by.pairing + c.loose, tone: "text-neon-purple-text" },
    { label: "Matching", value: c.by.matching, tone: "text-neon-teal-text" },
    { label: "Needs you", value: c.by.review, tone: "text-notice-warn-ink" },
    { label: "Saved", value: c.by.saved, tone: "text-neon-green-text" },
  ];
  const total = Math.max(1, c.total);
  const done = c.by.saved;
  const summary = c.working > 0 || c.arriving
    ? `Working on ${c.working} card${c.working === 1 ? "" : "s"}. ${c.by.review} waiting for you, ${done} saved.`
    : c.by.review > 0
      ? `Everything is read. ${c.by.review} waiting for you, ${done} saved.`
      : `All ${done} saved.`;
  return (
    <div className={compact ? "space-y-1" : "space-y-2"}>
      <dl className="flex flex-wrap gap-x-5 gap-y-1">
        {cells.map((cell) => (
          <div key={cell.label} className="flex items-baseline gap-1.5">
            <dt className="text-xs text-ink-3">{cell.label}</dt>
            <dd className={`m-0 text-lg font-bold tabular-nums ${cell.tone}`}>{cell.value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-chip" aria-hidden="true">
        <span className="bg-neon-green transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${(done / total) * 100}%` }} />
        <span className="bg-notice-warn-rule transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${(c.by.review / total) * 100}%` }} />
        <span className="intake-stripes bg-neon-blue transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${((c.working + c.loose) / total) * 100}%` }} />
      </div>
      <p role="status" aria-live="polite" className="text-sm text-ink-2">
        {summary}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Quantity                                                            */
/* ------------------------------------------------------------------ */

/** Marks a quantity field, so Enter can find the next one down the column. */
export const QTY_ATTR = "data-intake-qty";
export const PRICE_ATTR = "data-intake-price";

/**
 * "Had 3 → 4": the count already in this home, and the line's count once
 * saved. Enter saves the card at the number shown (Jason: entering a
 * quantity is one of the three ways a card saves) and `onEnter` moves on to
 * the next card's field. Only digits type here: any other key is left to the
 * tab's shortcuts (`./keys`), so a letter acts on this card instead of
 * landing in the box.
 */
export function QtyField({ item, sim, onEnter }: { item: Item; sim: IntakeSim; onEnter?: () => void }) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(item.qty);
  const save = (text: string) => {
    const n = Number.parseInt(text, 10);
    if (Number.isFinite(n)) sim.actions.setQty(item.id, n);
    setDraft(null);
  };
  return (
    <div className="flex items-center gap-2 text-sm">
      <label htmlFor={id} className="whitespace-nowrap text-ink-3">
        {item.had > 0 ? `Had ${item.had} →` : "Qty"}
      </label>
      <Input
        bare
        id={id}
        {...{ [QTY_ATTR]: item.id }}
        inputMode="numeric"
        value={shown}
        disabled={!item.match.cardId}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save(shown);
            onEnter?.();
          } else if (e.key === "Escape") {
            setDraft(null);
          } else if (e.key.length === 1 && !/\d/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
          }
        }}
        // However the field is reached (a click on the card, Enter from the
        // card above, the keys), the number is selected: typing replaces it.
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => {
          if (draft === null) return;
          // On to this card's price: keep the number, save with the price.
          if ((e.relatedTarget as HTMLElement | null)?.getAttribute(PRICE_ATTR) === item.id) {
            const n = Number.parseInt(draft, 10);
            if (Number.isFinite(n)) sim.actions.holdQty(item.id, n);
            setDraft(null);
          } else save(draft);
        }}
        className={`w-14 rounded-md border border-field-rule bg-field px-2 py-1 text-right tabular-nums text-ink ${RING}`}
        aria-describedby={`${id}-hint`}
        aria-keyshortcuts="Enter"
      />
      <span id={`${id}-hint`} className="sr-only">
        Enter saves and moves to the next card.
      </span>
    </div>
  );
}

/**
 * The card's lowest price, beside its quantity (Jason, 2026-10-28): p jumps
 * here. It starts at the run's default; Enter keeps the price, saves the card
 * and moves on, the way Enter in the quantity does.
 */
export function PriceField({
  item,
  sim,
  defaults,
  onEnter,
}: {
  item: Item;
  sim: IntakeSim;
  defaults: Details;
  onEnter?: (priceCents: number | null) => void;
}) {
  const id = useId();
  const cents = effectiveDetails(item, defaults).priceCents;
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (cents === null ? "" : (cents / 100).toFixed(2));
  const parse = (text: string): number | null => (text ? Math.round(Number(text) * 100) : null);
  return (
    <div className="flex items-center gap-1 text-sm">
      <label htmlFor={id} className="whitespace-nowrap text-ink-3">
        Price $
      </label>
      <Input
        bare
        id={id}
        {...{ [PRICE_ATTR]: item.id }}
        inputMode="decimal"
        value={shown}
        disabled={!item.match.cardId}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d.]/g, ""))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            setDraft(null);
            onEnter?.(parse(shown));
          } else if (e.key === "Escape") {
            setDraft(null);
          } else if (e.key.length === 1 && !/[\d.]/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
          }
        }}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => {
          if (draft === null) return;
          sim.actions.setDetails(item.id, { priceCents: parse(draft) });
          setDraft(null);
        }}
        className={`w-16 rounded-md border border-field-rule bg-field px-2 py-1 text-right tabular-nums text-ink ${RING}`}
        aria-describedby={`${id}-hint`}
        aria-keyshortcuts="p"
      />
      <span id={`${id}-hint`} className="sr-only">
        Enter keeps the price, saves and moves to the next card.
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Card picking                                                        */
/* ------------------------------------------------------------------ */

/** Search the set and pick the card by hand. */
export function CardPicker({ item, sim, onDone }: { item: Item; sim: IntakeSim; onDone?: () => void }) {
  const id = useId();
  const [q, setQ] = useState(item.read.number ? item.read.number : "");
  const all = useMemo(() => cardsForPicking(), []);
  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^#/, "");
    const list = item.match.candidates.length && !needle ? item.match.candidates.map(getCard) : all;
    return list
      .filter((c) => !needle || c.cardNumber.toLowerCase() === needle || cardTitle(c.id).toLowerCase().includes(needle))
      .slice(0, 8);
  }, [q, all, item.match.candidates]);
  const [active, setActive] = useState(0);
  const pick = (cardId: string) => {
    sim.actions.pick(item.id, cardId);
    onDone?.();
  };
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-xs font-semibold text-ink-2">
        Find the card in {SET_LABEL}
      </label>
      <Input bare
        id={id}
        role="combobox"
        aria-expanded="true"
        aria-controls={`${id}-list`}
        aria-activedescendant={hits[active] ? `${id}-${hits[active].id}` : undefined}
        autoFocus
        value={q}
        placeholder="Number or player"
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
            pick(hits[active].id);
          } else if (e.key === "Escape") {
            onDone?.();
          }
        }}
        className={`w-full rounded-md border border-field-rule bg-field px-2 py-1.5 text-sm text-ink ${RING}`}
      />
      <ul id={`${id}-list`} role="listbox" aria-label="Cards" className="m-0 max-h-56 list-none space-y-0.5 overflow-auto p-0">
        {hits.map((c, n) => (
          <li
            key={c.id}
            id={`${id}-${c.id}`}
            role="option"
            aria-selected={n === active}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(c.id)}
            className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm ${
              n === active ? "bg-pick-blue text-pick-blue-ink" : "text-ink-2 hover:bg-list-hover"
            }`}
          >
            <CardFace card={c} size="sm" className="!w-8" />
            {cardTitle(c.id)}
          </li>
        ))}
        {hits.length === 0 && <li className="px-2 py-1 text-sm text-ink-3">Nothing in this set matches.</li>}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Why it needs you                                                    */
/* ------------------------------------------------------------------ */

/**
 * The one line that says what the human is for on this card, plus the
 * one-click answers to it. Every automated decision here is "correct but
 * fixable": the suggestion is offered, never applied.
 */
export function NeedsYou({ item, sim, onPick }: { item: Item; sim: IntakeSim; onPick?: () => void }) {
  if (item.stage !== "review") return null;
  const parts: ReactNode[] = [];
  if (item.front.failed) {
    parts.push(
      <Prompt key="failed" text={item.match.reason ?? "Couldn't read this scan."}>
        <NeonButton size="1" variant="secondary" onClick={() => sim.actions.retry(item.id)}>Retry read</NeonButton>
        <NeonButton size="1" variant="negative" outline onClick={() => sim.actions.reject(item.id, "front")}>Reject front</NeonButton>
      </Prompt>,
    );
    return <div className="space-y-2">{parts}</div>;
  }
  if (item.rescanOf) {
    parts.push(
      <Prompt key="rescan" text="This card is already in this run. Is it a second copy, or the same card scanned twice?">
        <NeonButton size="1" variant="secondary" onClick={() => sim.actions.resolveRescan(item.id, true)}>Second copy</NeonButton>
        <NeonButton size="1" variant="negative" outline onClick={() => sim.actions.resolveRescan(item.id, false)}>Same card, drop it</NeonButton>
      </Prompt>,
    );
  }
  if (item.match.suggestion) {
    parts.push(
      <Prompt key="suggest" text={item.match.reason ?? "This may be a different variant."}>
        <NeonButton size="1" variant="secondary" onClick={() => sim.actions.suggestion(item.id, true)}>
          Use {cardTitle(item.match.suggestion).replace(/^#\S+ /, "")}
        </NeonButton>
        <NeonButton size="1" variant="secondary" outline onClick={() => sim.actions.suggestion(item.id, false)}>Keep as is</NeonButton>
      </Prompt>,
    );
  } else if (item.match.candidates.length > 1) {
    parts.push(
      <Prompt key="cands" text={item.match.reason ?? "More than one card fits."}>
        {item.match.candidates.map((c) => (
          <NeonButton key={c} size="1" variant="secondary" outline onClick={() => sim.actions.pick(item.id, c)}>
            {cardTitle(c)}
          </NeonButton>
        ))}
      </Prompt>,
    );
  } else if (!item.match.cardId) {
    parts.push(
      <Prompt key="none" text={item.match.reason ?? "No card matched."}>
        <NeonButton size="1" variant="secondary" onClick={onPick}>Find it</NeonButton>
        <NeonButton size="1" variant="tertiary" outline onClick={() => sim.actions.notInSet(item.id)}>Not in the catalog: request it</NeonButton>
      </Prompt>,
    );
  } else if (item.match.reason && !item.match.byUser) {
    parts.push(<Prompt key="reason" text={item.match.reason} />);
  }
  if (item.setGuess) {
    parts.push(
      <Prompt key="set" text={`Set found from the photo: ${item.setGuess}.`}>
        <NeonButton size="1" variant="secondary" outline onClick={sim.actions.pinSet}>All of these are {item.setGuess}</NeonButton>
      </Prompt>,
    );
  }
  return parts.length ? <div className="space-y-2">{parts}</div> : null;
}

function Prompt({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-notice-warn-rule bg-notice-warn-bg px-3 py-2">
      <p className="m-0 text-sm text-notice-warn-ink">{text}</p>
      {children && <div className="mt-2 flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Fix-up tools                                                        */
/* ------------------------------------------------------------------ */

export const FIX_TOOLS = [
  { key: "r", label: "Rotate front", run: (s: IntakeSim, i: Item) => s.actions.rotate(i.id, "front") },
  { key: "R", label: "Rotate back", run: (s: IntakeSim, i: Item) => s.actions.rotate(i.id, "back") },
  { key: "c", label: "Re-crop front", run: (s: IntakeSim, i: Item) => s.actions.recrop(i.id, "front") },
  { key: "C", label: "Re-crop back", run: (s: IntakeSim, i: Item) => s.actions.recrop(i.id, "back") },
  { key: "s", label: "Swap sides", run: (s: IntakeSim, i: Item) => s.actions.swap(i.id) },
  { key: "x", label: "Reject front", run: (s: IntakeSim, i: Item) => s.actions.reject(i.id, "front") },
  { key: "X", label: "Reject back", run: (s: IntakeSim, i: Item) => s.actions.reject(i.id, "back") },
  { key: "u", label: "Unpair", run: (s: IntakeSim, i: Item) => s.actions.unpair(i.id) },
  { key: "d", label: "Reject card", run: (s: IntakeSim, i: Item) => s.actions.drop(i.id) },
] as const;

export function FixTools({ item, sim, showKeys = false }: { item: Item; sim: IntakeSim; showKeys?: boolean }) {
  return (
    <div role="group" aria-label="Fix this scan" className="flex flex-wrap gap-1.5">
      {FIX_TOOLS.map((t) =>
        t.key === "d" ? (
          // Taking the whole card out is the destructive one: pink, like every
          // other remove (Jason, 2026-10-28: "a reject card button").
          <NeonButton
            key={t.key}
            size="1"
            variant="negative"
            outline
            onClick={() => t.run(sim, item)}
            aria-keyshortcuts={showKeys ? t.key : undefined}
            className="min-h-11 sm:min-h-8"
          >
            {showKeys && <kbd className="mr-1 font-mono">{t.key}</kbd>}
            {t.label}
          </NeonButton>
        ) : (
          <button
            key={t.key}
            type="button"
            onClick={() => t.run(sim, item)}
            aria-keyshortcuts={showKeys ? (t.key === t.key.toUpperCase() ? `Shift+${t.key}` : t.key) : undefined}
            className={`min-h-11 rounded-md border border-rule bg-button-neutral px-2 py-1 text-xs text-ink-2 hover:bg-button-neutral-hover sm:min-h-8 ${RING}`}
          >
            {showKeys && <kbd className="mr-1 font-mono text-ink-3">{t.key}</kbd>}
            {t.label}
          </button>
        ),
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Details                                                             */
/* ------------------------------------------------------------------ */

const CONDITIONS = ["Mint", "Near Mint", "Excellent", "Very Good", "Good", "Poor"];

export function effectiveDetails(item: Item, defaults: Details): Details {
  return { ...defaults, ...item.details, grading: item.details.grading ?? defaults.grading };
}

/**
 * Every intake field (Jason: "all of it at intake"). Used twice: once for the
 * run's defaults, and per card to override them.
 */
export function DetailsFields({
  value,
  onChange,
  kind,
  dense = false,
}: {
  value: Details;
  onChange: (patch: Partial<Details>) => void;
  kind: "binder" | "box";
  dense?: boolean;
}) {
  const id = useId();
  const field = `rounded-md border border-field-rule bg-field px-2 py-1 text-sm text-ink ${RING}`;
  const grid = dense ? "grid grid-cols-2 gap-2" : "grid gap-3 sm:grid-cols-3";
  const g = value.grading;
  return (
    <div className={grid}>
      <label className="flex flex-col gap-1 text-xs text-ink-3">
        Condition
        <select className={field} value={value.condition} onChange={(e) => onChange({ condition: e.target.value })}>
          {CONDITIONS.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-3">
        Graded by
        <select
          className={field}
          value={g?.grader ?? ""}
          onChange={(e) => onChange({ grading: e.target.value ? { grader: e.target.value, grade: g?.grade ?? "", cert: g?.cert ?? "" } : null })}
        >
          <option value="">Raw</option>
          {["PSA", "BGS", "SGC", "CGC", "TAG"].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </label>
      {g && (
        <>
          <label className="flex flex-col gap-1 text-xs text-ink-3">
            Grade
            <Input bare className={field} value={g.grade} onChange={(e) => onChange({ grading: { ...g, grade: e.target.value } })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-3">
            Cert #
            <Input bare className={field} value={g.cert} onChange={(e) => onChange({ grading: { ...g, cert: e.target.value } })} />
          </label>
        </>
      )}
      <label className="flex flex-col gap-1 text-xs text-ink-3">
        Serial #
        <Input bare className={field} placeholder="23/50" value={value.serial} onChange={(e) => onChange({ serial: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-3">
        Cost
        <Input bare
          className={field}
          inputMode="decimal"
          placeholder="$0.00"
          value={value.costCents === null ? "" : (value.costCents / 100).toFixed(2)}
          onChange={(e) => onChange({ costCents: e.target.value ? Math.round(Number(e.target.value) * 100) : null })}
        />
      </label>
      {kind === "box" && (
        <label className="flex flex-col gap-1 text-xs text-ink-3">
          Min price
          <Input bare
            className={field}
            inputMode="decimal"
            value={value.priceCents === null ? "" : (value.priceCents / 100).toFixed(2)}
            onChange={(e) => onChange({ priceCents: e.target.value ? Math.round(Number(e.target.value) * 100) : null })}
            aria-describedby={`${id}-price`}
          />
          <span id={`${id}-price`} className="text-xs">Defaults to your common price</span>
        </label>
      )}
      <label className="flex flex-col gap-1 text-xs text-ink-3">
        Location
        <Input bare className={field} placeholder="Row 2" value={value.location} onChange={(e) => onChange({ location: e.target.value })} />
      </label>
      <label className={`flex flex-col gap-1 text-xs text-ink-3 ${dense ? "col-span-2" : "sm:col-span-3"}`}>
        Notes
        <Input bare className={field} value={value.notes} onChange={(e) => onChange({ notes: e.target.value })} />
      </label>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Setup pieces                                                        */
/* ------------------------------------------------------------------ */

export interface Setup {
  /** The binder or box every card starts in; each card can move. */
  homeId: string;
  /** The picked variant's name ("Base", "Refractor"), or null when the set was skipped. */
  variant: string | null;
  defaults: Details;
  commonPrices: Record<string, number | null>;
}

export function initialSetup(homeId: string): Setup {
  return {
    homeId,
    variant: "Base",
    defaults: { ...DEFAULT_DETAILS, priceCents: COMMON_PRICES.Base },
    commonPrices: { ...COMMON_PRICES },
  };
}

/** A home the cards can go to: one of the side's binders or boxes. */
export interface HomeOption {
  id: string;
  name: string;
}

export function HomeSelect({
  value,
  homes,
  onChange,
  label = "Put them in",
}: {
  value: string;
  homes: HomeOption[];
  onChange: (homeId: string) => void;
  label?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-semibold text-ink-2">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`min-h-10 rounded-md border border-field-rule bg-field px-2 py-1.5 text-sm text-ink ${RING}`}
      >
        {homes.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Asks for the common price when the picked variant has none yet. */
export function CommonPrice({ setup, onChange }: { setup: Setup; onChange: (s: Setup) => void }) {
  const id = useId();
  if (!setup.variant) return null;
  const current = setup.commonPrices[setup.variant];
  return (
    <div className={`rounded-md border px-3 py-2 ${current === null ? "border-notice-warn-rule bg-notice-warn-bg" : "border-rule"}`}>
      <label htmlFor={id} className={`block text-sm ${current === null ? "text-notice-warn-ink" : "text-ink-2"}`}>
        {current === null
          ? `You haven't set a common card price for ${setup.variant} yet. What's the lowest you'll take?`
          : `Your common price for ${setup.variant}`}
      </label>
      <Input bare
        id={id}
        inputMode="decimal"
        placeholder="0.18"
        defaultValue={current === null ? "" : (current / 100).toFixed(2)}
        onBlur={(e) => {
          const cents = e.target.value ? Math.round(Number(e.target.value) * 100) : null;
          onChange({
            ...setup,
            commonPrices: { ...setup.commonPrices, [setup.variant!]: cents },
            defaults: { ...setup.defaults, priceCents: cents },
          });
        }}
        className={`mt-1 w-24 rounded-md border border-field-rule bg-field px-2 py-1 text-sm text-ink ${RING}`}
      />
      <span className="ml-2 text-xs text-ink-3">Saved per variant, for you only. Current: {money(current)}</span>
    </div>
  );
}

/** The drop target plus the other two ways in: phone camera and scanner. */
export function AddSources({ sim, compact = false }: { sim: IntakeSim; compact?: boolean }) {
  const [code] = useState("K7-4QX");
  return (
    <div className={`grid gap-3 ${compact ? "" : "md:grid-cols-[2fr_1fr]"}`}>
      <button
        type="button"
        onClick={sim.actions.addMore}
        className={`rounded-lg border-2 border-dashed border-rule-strong px-4 py-5 text-center text-sm text-ink-2 hover:bg-hover ${RING}`}
      >
        <span className="block font-semibold text-ink">Drop more photos or a zip</span>
        <span className="text-xs text-ink-3">Demo: click to add 12 more scans. Phones open the camera here.</span>
      </button>
      <div className="rounded-lg border border-rule px-4 py-3 text-sm">
        <p className="m-0 font-semibold text-ink">Scanner</p>
        <p className="m-0 text-xs text-ink-3">
          Run <code className="text-ink-2">neonbinder-scan</code> and enter <span className="font-mono font-bold text-neon-blue-text">{code}</span>. Cards
          arrive one at a time, already paired.
        </p>
        <p className="m-0 mt-1 flex items-center gap-1.5 text-xs text-neon-green-text">
          <span aria-hidden="true" className="intake-dot size-1.5 rounded-full bg-neon-green" /> Connected · fujitsu fi-8170
        </p>
      </div>
    </div>
  );
}

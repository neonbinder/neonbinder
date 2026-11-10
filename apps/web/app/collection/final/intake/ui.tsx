import { useId, useMemo, useState, type ReactNode } from "react";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import CardFace from "../../prototypes/_shared/CardFace";
import {
  getCard,
  getSet,
  inkOn,
  leadPlayer,
  leadTeam,
  playerInitials,
} from "../../prototypes/_shared/data";
import type { Card } from "../../prototypes/_shared/types";
import { CardPhoto } from "@/components/modules/CardPhotoViewer/EditedPhoto";
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
import type { PhotoEdit } from "@/lib/photo-edit/geometry";
import { priceProblem } from "./realLanes";

/**
 * NEO-369 — the pieces of the demo's Add cards tab (`./AddCardsTab`): scans,
 * badges, counters, the quantity field, the card picker, the prompts, the
 * fix tools and the detail fields.
 *
 * NEO-481 — the per-card price input (`PriceInput`) is shared with the
 * signed-in tab (`./RealAddCardsTab`); `demoScanUrl` is the demo's picture for
 * the card photo viewer.
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
 *
 * NEO-481 — once the collector turns or crops it in the viewer, the side is
 * drawn from the same picture the viewer edited (`demoScanUrl`) with the
 * edit over it (`CardPhoto`'s `shown`), so the crop lands where it was aimed.
 * The demo never makes a new file.
 */
export function ScanImage({
  item,
  side,
  size = "md",
  stage,
  edit,
}: {
  item: Item;
  side: "front" | "back";
  size?: keyof typeof SIZE_WIDTH;
  stage?: Stage;
  /** NEO-481 — the collector's turn and crop from the viewer, drawn over the scan (demo only). */
  edit?: PhotoEdit;
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
  const face =
    side === "front" && card ? <CardFace card={card} size="fill" /> : <CardBack number={card?.cardNumber ?? "?"} width="100%" />;
  const edited = !raw && edit ? demoScanUrl(item, side) : undefined;
  return (
    <figure className="m-0 flex flex-col items-center gap-1">
      <div
        role="img"
        aria-label={label}
        className={`relative overflow-hidden rounded-md ${raw ? "bg-field p-[6%]" : ""}`}
        style={{ width: raw ? `calc(${width} * 1.12)` : width }}
      >
        {edited && edit ? (
          <div aria-hidden="true" className={scan.failed ? "blur-[3px]" : ""}>
            <CardPhoto src={edited} alt="" shown={edit} className="block h-auto w-full" />
          </div>
        ) : (
          <div
            className={`transition-transform duration-500 ease-out motion-reduce:transition-none ${scan.failed ? "blur-[3px]" : ""}`}
            style={{ transform: `rotate(${scan.rotation + (raw ? -4 : 0)}deg)` }}
            aria-hidden="true"
          >
            {face}
          </div>
        )}
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
    // Wraps in a narrow lane (a capsule on one line, a soft box on two) rather than
    // pushing the tile wider than its column. The words stay whole in the DOM.
    <span className="inline-flex max-w-full items-start gap-1.5 rounded-xl bg-chip px-2 py-0.5 text-xs text-ink-2">
      <span aria-hidden="true" className="intake-dot mt-[0.3125rem] size-1.5 shrink-0 rounded-full bg-neon-blue" />
      <span className="min-w-0 wrap-anywhere">{STAGE_LABEL[stage]}</span>
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
        className={`w-14 rounded-md border border-field-rule bg-field px-2 py-1 text-right tabular-nums text-ink max-sm:min-h-11 ${RING}`}
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
 * NEO-481 — the card's own lowest price, beside its count: shared by the demo
 * (`PriceField`) and the signed-in box-run tiles. `p` jumps here (the tab's
 * keys). Enter keeps the price and saves the card; Escape puts back what it
 * showed (and, while there is typing to undo, stops there, so a drawer stays
 * open). Leaving the field with a change keeps the price without saving. Only
 * digits and a point type here: any other key is left to the tab's shortcuts,
 * so a letter acts on this card instead of landing in the box.
 *
 * The caller owns what the text means (`onCommit` and `onEnter` get it raw), so
 * each side parses it its own way. Its name is "Price, <card>": a column of
 * tiles has one per card.
 */
export function PriceInput({
  owner,
  cardLabel,
  cents,
  disabled = false,
  onCommit,
  onEnter,
}: {
  /** Marks the field (`PRICE_ATTR`), so `p` can find this card's. */
  owner: string;
  /** The tile's name, for the field's own ("Price, #47 Le'Veon Bell"). */
  cardLabel: string;
  /** What the field shows while nobody is typing in it; null shows blank. */
  cents: number | null;
  disabled?: boolean;
  /** Focus left with a change: keep it, don't save. Only ever handed a price (or a blank). */
  onCommit: (text: string) => void;
  /** Enter: keep it and save the card. Only ever handed a price (or a blank). */
  onEnter: (text: string) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  /** What's wrong with the price typed, shown under the field until a price is typed. */
  const [problem, setProblem] = useState<string | null>(null);
  const shown = draft ?? (cents === null ? "" : (cents / 100).toFixed(2));
  // A text that isn't a price stays in the field, with why under it; nothing is kept.
  const settle = (text: string, then: (text: string) => void) => {
    const why = priceProblem(text);
    setProblem(why);
    if (why) return;
    setDraft(null);
    then(text);
  };
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-0.5 text-sm">
      <div className="flex items-center gap-1">
        <label htmlFor={id} className="whitespace-nowrap text-ink-3">
          Price $
        </label>
        <Input
          bare
          id={id}
          {...{ [PRICE_ATTR]: owner }}
          aria-label={`Price, ${cardLabel}`}
          inputMode="decimal"
          value={shown}
          disabled={disabled}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => {
            const text = e.target.value.replace(/[^\d.]/g, "");
            setDraft(text);
            if (problem && !priceProblem(text)) setProblem(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              settle(shown, onEnter);
            } else if (e.key === "Escape") {
              if (draft !== null) e.stopPropagation();
              setDraft(null);
              setProblem(null);
            } else if (e.key.length === 1 && !/[\d.]/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
              e.preventDefault();
            }
          }}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => {
            if (draft !== null) settle(draft, onCommit);
          }}
          className={`w-16 rounded-md border bg-field px-2 py-1 text-right tabular-nums text-ink max-sm:min-h-11 ${
            problem ? "border-notice-danger-ink" : "border-field-rule"
          } ${RING}`}
          aria-describedby={problem ? `${errorId} ${id}-hint` : `${id}-hint`}
          aria-keyshortcuts="p"
        />
        <span id={`${id}-hint`} className="sr-only">
          Enter keeps the price, saves and moves to the next card.
        </span>
      </div>
      {problem && (
        <span id={errorId} role="alert" className="max-w-48 text-xs text-notice-danger-ink">
          {problem}
        </span>
      )}
    </div>
  );
}

/**
 * The demo's price field (Jason, 2026-10-28): it starts at the run's default,
 * and Enter keeps the price, saves the card and moves on, the way Enter in the
 * quantity does.
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
  // PriceInput hands over only a price or a blank (`priceProblem`).
  const parse = (text: string): number | null => (text ? Math.round(Number(text) * 100) : null);
  return (
    <PriceInput
      owner={item.id}
      cardLabel={cardTitle(item.match.cardId)}
      cents={effectiveDetails(item, defaults).priceCents}
      disabled={!item.match.cardId}
      onCommit={(text) => sim.actions.setDetails(item.id, { priceCents: parse(text) })}
      onEnter={(text) => onEnter?.(parse(text))}
    />
  );
}

/* ------------------------------------------------------------------ */
/* The card photo viewer's demo picture                                */
/* ------------------------------------------------------------------ */

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const xml = (text: string) => text.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);

/** Cuts `text` to what fits in `width` px at `size` px (a rough bold-sans measure), with an ellipsis. */
function fitText(text: string, width: number, size: number): string {
  const max = Math.floor(width / (size * 0.58));
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

const SVG_FONT = 'font-family="Lexend, system-ui, sans-serif"';
const GOLD_STOPS = ["#8a6a1c", "#f5d77a", "#b8902c", "#fff1b8", "#9c7a23"];

/**
 * The front `CardFace` draws, as an SVG 500 x 700 (one container-query unit
 * of the face is 5 px here): the livery frame, the pinstriped photo window
 * with its key light and top scrim, the set and the number badge, the big
 * initials, the print-run stamp and RC tag, and the slanted nameplate. Keep
 * in step with `../../prototypes/_shared/CardFace` (the refractor and foil
 * sheens are left out: they are light on top of the print, not the print).
 */
function demoFrontSvg(card: Card): string {
  const set = getSet(card.setId);
  const player = leadPlayer(card);
  const team = leadTeam(card);
  const primary = team.primary;
  const secondary = team.secondary;
  const bandInk = inkOn(secondary);
  const initialsInk = inkOn(primary);
  const { kind, tint } = card.finish;
  const frame =
    kind === "gold" || kind === "superfractor"
      ? "url(#frame)"
      : kind === "refractor" && tint
        ? tint
        : primary;
  const frameStops =
    kind === "gold" || kind === "superfractor"
      ? GOLD_STOPS
      : kind === "foil" && tint
        ? [tint, "#ffffff", tint, "#ffffff", tint]
        : null;
  // The inner card: 3.5 units in from the frame; the nameplate overlaps the window by 5.
  const inner = { x: 17.5, y: 17.5, w: 465, h: 665 };
  const plateTop = 541;
  const windowBottom = 566;
  const number = `#${card.cardNumber}`;
  const badgeW = number.length * 40 * 0.62 + 24;
  const stamp = card.printRun === null ? null : card.printRun === 1 ? "1/1" : `/${card.printRun}`;
  const stampW = stamp ? stamp.length * 37.5 * 0.62 + 22 : 0;
  const extra = [team.name, card.variation, card.variantPath.type !== "Base" ? card.variantPath.name : null]
    .filter(Boolean)
    .join(", ");
  const defs = `<defs>
<clipPath id="inner"><rect x="${inner.x}" y="${inner.y}" width="${inner.w}" height="${inner.h}" rx="15"/></clipPath>
<pattern id="stripes" width="45" height="45" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="35" height="45" fill="${xml(primary)}"/><rect x="35" width="10" height="45" fill="${xml(secondary)}"/></pattern>
<radialGradient id="key" cx="50%" cy="32%" r="62%"><stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
<linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000000" stop-opacity="0.6"/><stop offset="1" stop-color="#000000" stop-opacity="0"/></linearGradient>
${frameStops ? `<linearGradient id="frame" x1="0" y1="0" x2="1" y2="1">${frameStops.map((c, i) => `<stop offset="${[0, 0.28, 0.52, 0.74, 1][i]}" stop-color="${xml(c)}"/>`).join("")}</linearGradient>` : ""}
</defs>`;
  const frameFill = frameStops ? "url(#frame)" : xml(frame);
  return `${defs}
<rect width="500" height="700" rx="25" fill="${frameFill}"/>
<g clip-path="url(#inner)">
<rect x="${inner.x}" y="${inner.y}" width="${inner.w}" height="${inner.h}" fill="#0b0f1a"/>
<rect x="${inner.x}" y="${inner.y}" width="${inner.w}" height="${windowBottom - inner.y}" fill="url(#stripes)"/>
<rect x="${inner.x}" y="${inner.y}" width="${inner.w}" height="${windowBottom - inner.y}" fill="url(#key)"/>
<rect x="${inner.x}" y="${inner.y}" width="${inner.w}" height="110" fill="url(#scrim)"/>
<text x="42.5" y="72" ${SVG_FONT} font-size="32.5" font-weight="700" fill="#ffffff">${xml(fitText(`${set.season} ${set.name}`, 462.5 - badgeW - 52, 32.5))}</text>
<rect x="${462.5 - badgeW}" y="35" width="${badgeW}" height="54" rx="10" fill="#000000" fill-opacity="0.72"/>
<text x="${462.5 - badgeW / 2}" y="74" text-anchor="middle" ${SVG_FONT} font-size="40" font-weight="700" fill="#ffffff">${xml(number)}</text>
<text x="250" y="${inner.y + (windowBottom - inner.y) / 2 + 60}" text-anchor="middle" ${SVG_FONT} font-size="170" font-weight="700" letter-spacing="-6.8" fill="${initialsInk}" fill-opacity="0.92">${xml(playerInitials(player))}</text>
${card.features.includes("RC") ? `<rect x="37.5" y="${windowBottom - 20 - 46}" width="68" height="46" rx="7.5" fill="#ffffff" stroke="#E0242B" stroke-width="3.5"/><text x="71.5" y="${windowBottom - 20 - 12}" text-anchor="middle" ${SVG_FONT} font-size="32.5" font-weight="700" fill="#000000">RC</text>` : ""}
${stamp ? `<rect x="${462.5 - stampW}" y="${windowBottom - 20 - 52}" width="${stampW}" height="52" rx="7.5" fill="${card.printRun === 1 ? "#7f1d1d" : "#000000"}" fill-opacity="${card.printRun === 1 ? 1 : 0.78}" stroke="#F5D77A" stroke-width="3.5"/><text x="${462.5 - stampW / 2}" y="${windowBottom - 20 - 14}" text-anchor="middle" ${SVG_FONT} font-size="37.5" font-weight="700" fill="#F5D77A">${xml(stamp)}</text>` : ""}
<polygon points="${inner.x},${plateTop + 37} ${inner.x + inner.w},${plateTop} ${inner.x + inner.w},${inner.y + inner.h} ${inner.x},${inner.y + inner.h}" fill="${xml(secondary)}"/>
<text x="42.5" y="616" ${SVG_FONT} font-size="45" font-weight="700" fill="${bandInk}">${xml(fitText(player.name, 415, 45))}</text>
<text x="42.5" y="656" ${SVG_FONT} font-size="31" fill="${bandInk}">${xml(fitText(extra, 415, 31))}</text>
</g>`;
}

/** The back `CardBack` draws (a stats panel), as an SVG 500 x 700. */
function demoBackSvg(number: string): string {
  const lines = Array.from(
    { length: 6 },
    (_, i) => `<rect x="40" y="${130 + i * 46}" width="${420 * (0.9 - i * 0.09)}" height="18" rx="4" fill="#cbd5e1"/>`,
  ).join("");
  const grid = Array.from(
    { length: 8 },
    (_, i) => `<rect x="${40 + (i % 4) * 107}" y="${560 + Math.floor(i / 4) * 52}" width="95" height="30" rx="4" fill="#cbd5e1"/>`,
  ).join("");
  return `<rect x="1" y="1" width="498" height="698" rx="20" fill="#f1f5f9" stroke="#94a3b8" stroke-width="2"/>
<rect x="40" y="40" width="168" height="44" rx="6" fill="#94a3b8"/>
<text x="460" y="74" text-anchor="end" ${SVG_FONT} font-size="30" font-weight="700" fill="#475569">#${xml(number)}</text>
${lines}${grid}`;
}

/**
 * NEO-481 — a demo scan as a picture the card photo viewer can draw on (an
 * SVG, 500 x 700 like a card): the demo has no scanned files, only drawn
 * faces. It is the face the tile draws (`CardFace`, `CardBack`), and an
 * edited tile is drawn from it too, so a crop lands where it was aimed.
 * Undefined while that side hasn't been scanned.
 */
export function demoScanUrl(item: Item, side: "front" | "back"): string | undefined {
  const scan = side === "front" ? item.front : item.back;
  if (!scan) return undefined;
  const card = item.truth ? getCard(item.truth) : null;
  const body = side === "front" && card ? demoFrontSvg(card) : demoBackSvg(card?.cardNumber ?? "?");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="700" viewBox="0 0 500 700">${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
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
            {showKeys && <kbd className="mr-1 font-mono">{t.key}</kbd>}
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

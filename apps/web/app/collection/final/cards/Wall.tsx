import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ChevronDownIcon, ChevronLeftIcon, EllipsisHorizontalIcon, ListBulletIcon } from "@heroicons/react/24/outline";
import { StarIcon } from "@heroicons/react/20/solid";
import NeonButton from "@/components/modules/NeonButton";
import { useRoving } from "../../prototypes/p3/hooks";
import ChipGroup from "../ChipGroup";
import { haveShort, isComplete, totalKnown } from "../catalog/format";
import { copiesByCard } from "../catalog/home";
import { LoadingNote, SkeletonBars, SkeletonPips } from "../catalog/Skeleton";
import { playerNames, setLabel, variantLabel } from "../data/labels";
import {
  useBuildingSets,
  useCapabilities,
  useCollectionActions,
  useCollectionStore,
  useCopiesInVariant,
  useSetSummary,
  useVariantCards,
  useVariantCompletion,
} from "../data/store";
import type { Card, CardId, Copy, SetRef, Variant } from "../data/types";
import { useMyCards } from "./context";
import QuickAdd from "./QuickAdd";
import { baseOf } from "./Scoreboard";

/**
 * NEO-350 / NEO-358 — the wall: one lit tile per card you have, a dashed
 * outline per card you need (and, in the demo, a yellow outline and star for
 * a need on your Want List). One strip per checklist of the set: Base open,
 * every insert and parallel folded until opened, so the wall reads one
 * checklist at a time and never a whole set's cards at once.
 *
 * One Tab stop for the whole wall (roving tabindex). Arrows move, Space marks
 * have / need, Enter opens the card drawer, whose ↑ ↓ walk the wall.
 *
 * A tile's name never changes with its state: "Base #4 Reggie White", with
 * have or need in `aria-pressed` while a click marks it. When a click opens
 * details instead, the tile is not a toggle; it says have or need in its name.
 * A tile marked while a filter would now hide it stays put until the
 * keyboard leaves it, so focus is never dropped on the floor.
 */

type Filter = "all" | "needs" | "haves" | "dupes" | "wanted";
type TapDoes = "toggle" | "details";

export default function Wall({ setId, focusOnMount }: { setId: string; focusOnMount: boolean }) {
  const api = useMyCards();
  const capabilities = useCapabilities();
  const writes = useCollectionActions();
  const summary = useSetSummary(setId);
  const building = useBuildingSets();
  const heading = useRef<HTMLHeadingElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [tapDoes, setTapDoes] = useState<TapDoes>("toggle");
  const [spot, setSpot] = useState<string[]>([]);
  const [tiles, setTiles] = useState<Record<string, string[]>>({});
  /** The tile just marked, kept on the wall while it holds focus (see above). */
  const [keep, setKeep] = useState<string | null>(null);

  const variants = useMemo(() => summary?.variants ?? [], [summary]);
  const base = baseOf(variants);
  const completion = useVariantCompletion(base?.id ?? null);
  const set = summary?.set ?? null;
  const isBuilding = building?.some((s) => s.id === setId) ?? false;

  useEffect(() => {
    if (focusOnMount && summary !== undefined) heading.current?.focus();
  }, [focusOnMount, setId, summary]);

  const report = useCallback((variantId: string, ids: string[]) => {
    setTiles((prev) => {
      const before = prev[variantId];
      if (before && before.length === ids.length && before.every((id, i) => id === ids[i])) return prev;
      return { ...prev, [variantId]: ids };
    });
  }, []);
  const keys = variants.flatMap((v) => tiles[v.id] ?? []);
  const roving = useRoving(container, keys);

  /** The tiles in reading order, for the drawer's ↑ ↓. */
  const wallList = useCallback(
    (): CardId[] => [...(container.current?.querySelectorAll<HTMLElement>("[data-rove]") ?? [])].map((el) => el.dataset.rove!),
    [],
  );

  // Scroll the number box's first match into view (no glide for anyone who asks for less motion).
  useEffect(() => {
    if (spot.length === 0) return;
    const el = container.current?.querySelector(`[data-rove="${CSS.escape(spot[0])}"]`);
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    el?.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
  }, [spot]);

  if (summary === undefined) {
    return (
      <section aria-busy="true" className="mc-led shadow-offset rounded-2xl border border-rule p-5">
        <SkeletonBars rows={3} />
        <SkeletonPips size="tile" count={24} />
        <LoadingNote>Racking up the wall…</LoadingNote>
      </section>
    );
  }
  if (summary === null || !set) {
    return (
      <section aria-labelledby="mc-wall-heading" className="space-y-3">
        <BackToSets />
        <h2 id="mc-wall-heading" ref={heading} tabIndex={-1} className="text-2xl font-bold text-ink focus:outline-none">
          That set isn&apos;t in the catalog
        </h2>
        <p className="text-sm text-ink-2">It may have been taken down. Your cards stay put.</p>
      </section>
    );
  }

  const label = setLabel(set);
  const complete = completion ? isComplete(completion) : false;
  const chips: [Filter, string][] = [
    ["all", "Everything"],
    ["needs", "Needs"],
    ["haves", "Haves"],
    ["dupes", "Dupes"],
  ];
  if (capabilities.wants) chips.push(["wanted", "Wanted"]);

  const stopBuilding = (s: SetRef) => {
    void api.run(
      () => writes.setBuilding(s, false),
      () => `Took ${setLabel(s)} off the board. Your cards stay put.`,
    );
    api.go("home");
  };
  const startBuilding = (s: SetRef) => {
    void api.run(
      () => writes.setBuilding(s, true),
      () => `${setLabel(s)} is on the board. Go get 'em.`,
    );
  };

  return (
    <section aria-labelledby="mc-wall-heading">
      <BackToSets />

      <div className="mc-led shadow-offset flex flex-col gap-4 rounded-2xl border border-rule p-4 sm:flex-row sm:items-end sm:p-5">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink-3">
            {set.sport.name}, {set.brand.name}
          </p>
          <h2 id="mc-wall-heading" ref={heading} tabIndex={-1} className="text-2xl font-bold text-ink focus:outline-none sm:text-3xl">
            {label}
          </h2>
          <p className="mt-2 text-sm text-ink-2">
            {api.scopedName && <span className="text-neon-blue-text">In {api.scopedName}. </span>}
            {completion ? (
              totalKnown(completion) ? (
                <>
                  Base: <strong className="text-ink">{completion.owned}</strong> of {completion.total}.{" "}
                </>
              ) : (
                <>Base: {haveShort(completion)}. </>
              )
            ) : null}
            The whole set runs {summary.totalCards} cards across {variants.length}{" "}
            {variants.length === 1 ? "checklist" : "checklists"}.
          </p>
        </div>
        {completion && (
          <p className="text-right">
            <span
              className={`mc-percent block text-6xl sm:text-7xl ${complete ? "text-neon-green-text" : "text-neon-blue-text"}`}
              data-complete={complete}
            >
              {totalKnown(completion) ? `${completion.percent}%` : completion.owned}
            </span>
            <span className="text-xs text-ink-2">
              {complete ? "Base set complete!" : totalKnown(completion) ? "of the base set" : "base cards owned"}
            </span>
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <NeonButton type="button" variant="secondary" outline onClick={() => api.go("needs", setId)} className="min-h-11 sm:min-h-9">
          <ListBulletIcon aria-hidden="true" className="size-4" />
          Need list for this set
        </NeonButton>
        {building !== undefined &&
          (isBuilding ? (
            <NeonButton type="button" variant="negative" outline onClick={() => stopBuilding(set)} className="min-h-11 sm:min-h-9">
              Stop building this set
            </NeonButton>
          ) : (
            <NeonButton type="button" variant="primary" outline onClick={() => startBuilding(set)} className="min-h-11 sm:min-h-9">
              Build this set
            </NeonButton>
          ))}
      </div>

      <QuickAdd variants={variants} onSpot={setSpot} />

      <div className="mt-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <ChipGroup
          label="Show on the wall"
          value={filter}
          options={chips.map(([value, text]) => ({ value, label: text }))}
          onChange={setFilter}
        />
        <ChipGroup
          label="Clicking a tile"
          value={tapDoes}
          options={[
            { value: "toggle", label: "Mark have" },
            { value: "details", label: "Open details" },
          ]}
          onChange={setTapDoes}
          className="flex items-center gap-1.5"
          lead={<span className="text-sm text-ink-3">Click a tile to</span>}
        />
      </div>

      <Legend wants={capabilities.wants} />

      <p id="mc-wall-help" className="sr-only">
        {tapDoes === "toggle"
          ? "Arrow keys move between cards. A click or Space marks a card have or need. Enter opens its details."
          : "Arrow keys move between cards. A click or Enter opens a card's details. Space marks it have or need."}
      </p>
      <div
        ref={container}
        role="group"
        aria-label={`${label} checklist wall`}
        aria-describedby="mc-wall-help"
        onKeyDown={roving.onKeyDown}
        onFocus={roving.onFocus}
        className="mt-4 flex flex-col gap-5"
      >
        {variants.map((v) => (
          <WallStrip
            key={v.id}
            variant={v}
            startOpen={v.id === base?.id}
            filter={filter}
            tapDoes={tapDoes}
            spot={spot}
            keep={keep}
            onKeep={setKeep}
            tabIndexFor={roving.tabIndexFor}
            wallList={wallList}
            report={report}
          />
        ))}
      </div>
    </section>
  );
}

function BackToSets() {
  const api = useMyCards();
  return (
    <button
      type="button"
      onClick={() => api.go("home")}
      className="mb-3 inline-flex min-h-11 items-center gap-1 rounded-md pr-2 text-sm text-ink-2 hover:text-ink focus-outline sm:min-h-8"
    >
      <ChevronLeftIcon aria-hidden="true" className="size-4" />
      All my sets
    </button>
  );
}

function finishSwatch(v: Variant): string {
  const tint = v.finish.tint;
  if (v.finish.kind === "gold" || v.finish.kind === "superfractor") return "linear-gradient(135deg,#8a6a1c,#f5d77a,#9c7a23)";
  if (v.finish.kind === "refractor" && !tint) return "conic-gradient(#ff2e9a,#ffe600,#00d558,#00c2ff,#a44aff,#ff2e9a)";
  return tint ?? "transparent";
}

/** One checklist on the wall: its header and, once open, its tiles. */
function WallStrip({
  variant,
  startOpen,
  filter,
  tapDoes,
  spot,
  keep,
  onKeep,
  tabIndexFor,
  wallList,
  report,
}: {
  variant: Variant;
  startOpen: boolean;
  filter: Filter;
  tapDoes: TapDoes;
  spot: string[];
  keep: string | null;
  onKeep: (cardId: string | null) => void;
  tabIndexFor: (key: string) => number;
  wallList: () => CardId[];
  report: (variantId: string, ids: string[]) => void;
}) {
  const { kind } = useCollectionStore();
  const api = useMyCards();
  const [open, setOpen] = useState(startOpen || kind === "demo");
  const completion = useVariantCompletion(variant.id);
  const cards = useVariantCards(open ? variant.id : null);
  const copies = useCopiesInVariant(open ? variant.id : null);
  const byCard = useMemo(() => copiesByCard(copies), [copies]);
  const name = variantLabel(variant);
  const run = variant.printRun === null ? null : variant.printRun === 1 ? "1/1" : `/${variant.printRun}`;

  const countOf = (id: string) => (byCard.get(id) ?? []).reduce((n, c) => n + c.quantity, 0);
  const passes = (c: Card) => {
    if (c.id === keep) return true;
    const n = countOf(c.id);
    if (filter === "needs") return n === 0;
    if (filter === "haves") return n > 0;
    if (filter === "dupes") return n > 1;
    if (filter === "wanted") return api.isWanted(c.id);
    return true;
  };
  const visibleIds = open && cards && copies ? cards.filter(passes).map((c) => c.id) : [];
  const idsKey = visibleIds.join("|");
  useEffect(() => {
    report(variant.id, idsKey ? idsKey.split("|") : []);
  }, [report, variant.id, idsKey]);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full border border-control" style={{ background: finishSwatch(variant) }} />
        {/* The heading is the disclosure: its name ("Gold Refractor /50 tiles")
            starts with what it shows and never changes; open or folded is in
            aria-expanded, and the chevron turns. */}
        <h3 className="text-sm font-bold text-ink-2">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="inline-flex min-h-11 items-center gap-1 rounded-md pr-1.5 text-left hover:text-neon-blue-text focus-outline sm:min-h-8"
          >
            {name}
            {run && <span className="font-normal text-ink-3"> {run}</span>}
            <span className="sr-only"> tiles</span>
            <ChevronDownIcon
              aria-hidden="true"
              className={`size-3.5 shrink-0 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
            />
          </button>
        </h3>
        <span className="text-xs tabular-nums text-ink-3">{completion ? haveShort(completion) : "…"}</span>
      </div>
      {open &&
        (cards && copies ? (
          cards.length === 0 ? (
            <p className="text-sm text-ink-3">No cards on this checklist yet.</p>
          ) : (
            <div className="flex flex-wrap gap-1 sm:gap-1.5">
              {cards.map((card) => (
                <Tile
                  key={card.id}
                  card={card}
                  rowLabel={name}
                  copies={byCard.get(card.id) ?? []}
                  visible={passes(card)}
                  spot={spot.includes(card.id)}
                  tapDoes={tapDoes}
                  tabIndex={tabIndexFor(card.id)}
                  wallList={wallList}
                  onKeep={onKeep}
                />
              ))}
            </div>
          )
        ) : (
          <SkeletonPips size="tile" count={Math.min(variant.baseCardCount || 20, 40)} />
        ))}
    </div>
  );
}

function Tile({
  card,
  rowLabel,
  copies,
  visible,
  spot,
  tapDoes,
  tabIndex,
  wallList,
  onKeep,
}: {
  card: Card;
  rowLabel: string;
  copies: Copy[];
  visible: boolean;
  spot: boolean;
  tapDoes: TapDoes;
  tabIndex: number;
  wallList: () => CardId[];
  /** Keep this tile on the wall while it holds focus (null lets it go). */
  onKeep: (cardId: string | null) => void;
}) {
  const api = useMyCards();
  const count = copies.reduce((n, c) => n + c.quantity, 0);
  const have = count > 0;
  const wanted = api.isWanted(card.id);
  const small = card.cardNumber.length > 3;
  const size = "size-11 sm:size-10";

  if (!visible) {
    return (
      <span aria-hidden="true" className={`grid ${size} place-items-center rounded-md border border-rule text-[10px] text-rule-strong`}>
        {card.cardNumber}
      </span>
    );
  }

  const players = playerNames(card);
  const toggles = tapDoes === "toggle";
  // Stable while a click marks it: have or need is aria-pressed. The copy
  // count and the Want List are facts about the card, not this control's state.
  const name = `${rowLabel} #${card.cardNumber}${players ? ` ${players}` : ""}${
    card.cardVariation ? `, ${card.cardVariation} variation` : ""
  }${toggles ? "" : have ? ", have" : ", need"}${count > 1 ? `, ${count} copies` : ""}${wanted ? ", on your Want List" : ""}`;

  const open = () => api.openCard(card.id, { list: wallList(), seed: card });
  const mark = (button: HTMLButtonElement) => {
    // A filter may hide this tile once it is marked: keep it while it has focus.
    if (document.activeElement === button) onKeep(card.id);
    api.toggleHave(card, copies, wallList());
  };

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      open();
    } else if (e.key === " ") {
      e.preventDefault();
      if (!e.repeat) mark(e.currentTarget);
    }
  }
  function onClick(e: MouseEvent<HTMLButtonElement>) {
    // Keyboard presses were handled on keydown; a click with detail 0 is one.
    if (e.detail === 0) return;
    if (tapDoes === "details") open();
    else mark(e.currentTarget);
  }

  const look = have
    ? "mc-lit bg-neon-blue text-on-neon-blue hover:bg-neon-blue-hover"
    : wanted
      ? "border-[1.5px] border-dashed border-neon-yellow-text text-neon-yellow-text hover:border-neon-blue hover:text-ink"
      : "border-[1.5px] border-dashed border-control text-ink-2 hover:border-neon-blue hover:text-ink";

  return (
    <div className={`group relative ${size}`}>
      <button
        type="button"
        data-rove={card.id}
        tabIndex={tabIndex}
        aria-pressed={toggles ? have : undefined}
        aria-label={name}
        onBlur={() => onKeep(null)}
        title={`${rowLabel} #${card.cardNumber} ${players}${wanted ? " (wanted)" : ""}`}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => e.key === " " && e.preventDefault()}
        onClick={onClick}
        className={`relative grid size-full place-items-center rounded-md font-bold tabular-nums transition-colors focus-outline ${
          small ? "text-[10px]" : "text-sm"
        } ${look} ${spot ? "mc-spot" : ""}`}
      >
        {card.cardNumber}
        {card.cardVariation && (
          <span aria-hidden="true" className="absolute bottom-0.5 left-1 text-[9px] font-bold leading-none">
            v
          </span>
        )}
      </button>
      {wanted && (
        <StarIcon aria-hidden="true" className="pointer-events-none absolute -left-1.5 -top-1.5 size-3.5 text-neon-yellow-text mc-star" />
      )}
      {count > 1 && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-1.5 -top-1.5 rounded bg-neon-yellow px-1 text-[10px] font-bold leading-4 text-on-neon-yellow"
        >
          ×{count}
        </span>
      )}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onMouseDown={(e) => e.preventDefault()}
        onClick={open}
        className="absolute -bottom-1.5 -right-1.5 hidden size-5 place-items-center rounded-full border border-control bg-sheet text-ink-2 hover:border-neon-blue hover:text-ink [@media(hover:hover)]:group-hover:grid"
      >
        <EllipsisHorizontalIcon className="size-3.5" />
      </button>
    </div>
  );
}

function Legend({ wants }: { wants: boolean }) {
  return (
    <ul aria-label="How to read the wall" className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-2">
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="mc-lit grid size-5 place-items-center rounded bg-neon-blue text-[10px] font-bold text-on-neon-blue">
          7
        </span>
        Lit up: you have it
      </li>
      <li className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="grid size-5 place-items-center rounded border-[1.5px] border-dashed border-control text-[10px] font-bold text-ink-2"
        >
          7
        </span>
        Dashed: you need it
      </li>
      {wants && (
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="relative">
            <span className="grid size-5 place-items-center rounded border-[1.5px] border-dashed border-neon-yellow-text text-[10px] font-bold text-neon-yellow-text">
              7
            </span>
            <StarIcon className="absolute -left-1 -top-1 size-2.5 text-neon-yellow-text" />
          </span>
          Starred: on your Want List
        </li>
      )}
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="rounded bg-neon-yellow px-1 text-[10px] font-bold leading-4 text-on-neon-yellow">
          ×2
        </span>
        Dupes
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="font-bold text-ink-2">
          v
        </span>
        Image variation
      </li>
    </ul>
  );
}

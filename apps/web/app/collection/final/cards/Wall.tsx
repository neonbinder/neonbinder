import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ChevronLeftIcon, EllipsisHorizontalIcon, ListBulletIcon } from "@heroicons/react/24/outline";
import { StarIcon } from "@heroicons/react/20/solid";
import {
  getBrand,
  getSet,
  getSport,
  playerNames,
  setLabel,
  type Card,
  type CardId,
  type SetId,
} from "../../prototypes/_shared/data";
import Chip from "../../prototypes/p3/Chip";
import { useMediaQuery, useRoving, useWidth } from "../../prototypes/p3/hooks";
import { blocksOf, buildWall, printRunText, type WallSection } from "../../prototypes/p3/wallModel";
import { useMyCards } from "./context";
import QuickAdd from "./QuickAdd";

/**
 * NEO-350 — the wall: one lit tile per card you have, a dashed outline per
 * card you need, a yellow outline and star for a need on your Want List.
 * Parallels stack under the base row so a card's whole rainbow reads down
 * one column; inserts get their own strips below.
 *
 * One Tab stop for the whole wall (roving tabindex). Arrows move, Space marks
 * have / need, Enter opens the card drawer, whose ↑ ↓ walk the wall.
 */

type Filter = "all" | "needs" | "haves" | "dupes" | "wanted";
type TapDoes = "toggle" | "details";

export default function Wall({ setId, focusOnMount }: { setId: SetId; focusOnMount: boolean }) {
  const api = useMyCards();
  const { store, scopedName } = api;
  const set = getSet(setId);
  const wall = useMemo(() => buildWall(setId), [setId]);
  const heading = useRef<HTMLHeadingElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const width = useWidth(container);
  const wide = useMediaQuery("(min-width: 640px)");
  const [filter, setFilter] = useState<Filter>("all");
  const [tapDoes, setTapDoes] = useState<TapDoes>("toggle");
  const [spot, setSpot] = useState<string[]>([]);
  const [showParallels, setShowParallels] = useState(true);
  const hasParallels = wall.aligned.rows.length > 1;
  const aligned = showParallels ? wall.aligned : { ...wall.aligned, rows: wall.aligned.rows.slice(0, 1) };

  useEffect(() => {
    if (focusOnMount) heading.current?.focus();
  }, [focusOnMount, setId]);

  const tile = wide ? 40 : 44;
  const gap = wide ? 6 : 4;
  const labelW = wide ? 128 : 72;
  const fit = width ? Math.floor((width - labelW - gap) / (tile + gap)) : 10;
  const perBlock = fit >= 5 ? Math.floor(fit / 5) * 5 : Math.max(1, fit);

  const base = store.completionInScope(setId, { type: "Base" });
  const whole = store.completionInScope(setId);
  const allCards = [
    ...aligned.rows.flatMap((r) => r.cells),
    ...wall.inserts.flatMap((s) => s.rows[0].cells),
  ].filter((c): c is Card => c !== null);
  const counts = {
    needs: allCards.filter((c) => store.ownedInScope(c.id) === 0).length,
    haves: allCards.filter((c) => store.ownedInScope(c.id) > 0).length,
    dupes: allCards.filter((c) => store.ownedInScope(c.id) > 1).length,
    wanted: allCards.filter((c) => store.isWanted(c.id)).length,
  };
  const passes = (c: Card) => {
    const n = store.ownedInScope(c.id);
    if (filter === "needs") return n === 0;
    if (filter === "haves") return n > 0;
    if (filter === "dupes") return n > 1;
    if (filter === "wanted") return store.isWanted(c.id);
    return true;
  };
  const keys = allCards.filter(passes).map((c) => c.id);
  const roving = useRoving(container, keys);

  /** The tiles in reading order, for the drawer's ↑ ↓. */
  const wallList = (): CardId[] =>
    [...(container.current?.querySelectorAll<HTMLElement>("[data-rove]") ?? [])].map((el) => el.dataset.rove!);

  // Scroll the number box's first match into view.
  useEffect(() => {
    if (spot.length === 0) return;
    const el = container.current?.querySelector(`[data-rove="${CSS.escape(spot[0])}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [spot]);

  const complete = base.total > 0 && base.owned === base.total;
  const chips: [Filter, string][] = [
    ["all", "Everything"],
    ["needs", `Needs ${counts.needs}`],
    ["haves", `Haves ${counts.haves}`],
    ["dupes", `Dupes ${counts.dupes}`],
  ];
  if (counts.wanted > 0) chips.push(["wanted", `Wanted ${counts.wanted}`]);

  return (
    <section aria-labelledby="mc-wall-heading">
      <button
        type="button"
        onClick={() => api.go("home")}
        className="mb-3 inline-flex min-h-11 items-center gap-1 rounded-md pr-2 text-sm text-ink-2 hover:text-ink focus-outline sm:min-h-8"
      >
        <ChevronLeftIcon aria-hidden="true" className="size-4" />
        All my sets
      </button>

      <div className="mc-led shadow-offset flex flex-col gap-4 rounded-2xl border border-rule p-4 sm:flex-row sm:items-end sm:p-5">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink-3">
            {getSport(set.sportId).name}, {getBrand(set.brandId).name}
          </p>
          <h2
            id="mc-wall-heading"
            ref={heading}
            tabIndex={-1}
            className="text-2xl font-bold text-ink focus:outline-none sm:text-3xl"
          >
            {setLabel(set)}
          </h2>
          <p className="mt-2 text-sm text-ink-2">
            {scopedName && <span className="text-neon-blue-text">In {scopedName}. </span>}
            Base: <strong className="text-ink">{base.owned}</strong> of {base.total}. Whole set with inserts and
            parallels: <strong className="text-ink">{whole.owned}</strong> of {whole.total}.
          </p>
        </div>
        <p className="text-right">
          <span
            className={`mc-percent block text-6xl sm:text-7xl ${complete ? "text-neon-green-text" : "text-neon-blue-text"}`}
            data-complete={complete}
          >
            {base.percent}%
          </span>
          <span className="text-xs text-ink-2">{complete ? "Base set complete!" : "of the base set"}</span>
        </p>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => api.go("needs", setId)}
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-control px-3 text-sm text-ink-2 hover:border-neon-blue hover:text-ink focus-outline sm:min-h-9"
        >
          <ListBulletIcon aria-hidden="true" className="size-4" />
          Need list for this set
        </button>
        <button
          type="button"
          onClick={() => {
            store.toggleBuilding(setId);
            api.notify(`Took ${setLabel(set)} off the board. Your cards stay put.`, () =>
              store.toggleBuilding(setId),
            );
            api.go("home");
          }}
          className="inline-flex min-h-11 items-center rounded-md border border-control px-3 text-sm text-ink-2 hover:border-neon-pink hover:text-ink focus-outline sm:min-h-9"
        >
          Stop building this set
        </button>
      </div>

      <QuickAdd setId={setId} onSpot={setSpot} />

      <div className="mt-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div role="group" aria-label="Show on the wall" className="flex flex-wrap gap-1.5">
          {chips.map(([value, label]) => (
            <Chip key={value} pressed={filter === value} onClick={() => setFilter(value)}>
              {label}
            </Chip>
          ))}
          {hasParallels && (
            <Chip pressed={showParallels} onClick={() => setShowParallels(!showParallels)}>
              Parallel rows
            </Chip>
          )}
        </div>
        <div role="group" aria-label="Clicking a tile" className="flex items-center gap-1.5">
          <span aria-hidden="true" className="text-sm text-ink-3">
            Click a tile to
          </span>
          <Chip pressed={tapDoes === "toggle"} onClick={() => setTapDoes("toggle")}>
            Mark have
          </Chip>
          <Chip pressed={tapDoes === "details"} onClick={() => setTapDoes("details")}>
            Open details
          </Chip>
        </div>
      </div>

      <Legend />

      <p id="mc-wall-help" className="sr-only">
        Arrow keys move between cards. Space marks a card have or need. Enter opens its details.
      </p>
      <div
        ref={container}
        role="group"
        aria-label={`${setLabel(set)} checklist wall`}
        aria-describedby="mc-wall-help"
        onKeyDown={roving.onKeyDown}
        onFocus={roving.onFocus}
        className="mt-4"
      >
        <SectionBlocks
          section={aligned}
          perBlock={perBlock}
          tile={tile}
          gap={gap}
          labelW={labelW}
          passes={passes}
          spot={spot}
          tapDoes={tapDoes}
          tabIndexFor={roving.tabIndexFor}
          wallList={wallList}
        />
        {wall.inserts.length > 0 && (
          <>
            <h3 className="mb-2 mt-6 text-sm font-bold text-ink-2">
              Inserts <span className="font-normal text-ink-3">(their own numbering)</span>
            </h3>
            {wall.inserts.map((section) => (
              <SectionBlocks
                key={section.key}
                section={section}
                perBlock={perBlock}
                tile={tile}
                gap={gap}
                labelW={labelW}
                passes={passes}
                spot={spot}
                tapDoes={tapDoes}
                tabIndexFor={roving.tabIndexFor}
                wallList={wallList}
              />
            ))}
          </>
        )}
      </div>
    </section>
  );
}

function SectionBlocks({
  section,
  perBlock,
  tile,
  gap,
  labelW,
  passes,
  spot,
  tapDoes,
  tabIndexFor,
  wallList,
}: {
  section: WallSection;
  perBlock: number;
  tile: number;
  gap: number;
  labelW: number;
  passes: (c: Card) => boolean;
  spot: string[];
  tapDoes: TapDoes;
  tabIndexFor: (key: string) => number;
  wallList: () => CardId[];
}) {
  const blocks = blocksOf(section, perBlock);
  return (
    <div className="flex flex-col gap-3">
      {blocks.map((block) => (
        <div
          key={block.start}
          className="grid items-center"
          style={{
            gridTemplateColumns: `${labelW}px repeat(${perBlock}, ${tile}px)`,
            gap: `${gap}px`,
          }}
        >
          {block.rows.map(({ row, cells }) => {
            const run = printRunText(row.variant);
            const tint = row.variant.finish.tint;
            return (
              <div key={row.key} className="contents">
                <div className="flex min-w-0 items-center gap-1.5 pr-1">
                  <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0 rounded-full border border-control"
                    style={{
                      background:
                        row.variant.finish.kind === "gold" || row.variant.finish.kind === "superfractor"
                          ? "linear-gradient(135deg,#8a6a1c,#f5d77a,#9c7a23)"
                          : row.variant.finish.kind === "refractor" && !tint
                            ? "conic-gradient(#ff2e9a,#ffe600,#00d558,#00c2ff,#a44aff,#ff2e9a)"
                            : (tint ?? "transparent"),
                    }}
                  />
                  <span className="truncate text-xs text-ink-2 sm:text-sm" title={row.label}>
                    {row.label}
                    {run && <span className="text-ink-3"> {run}</span>}
                  </span>
                </div>
                {cells.map((card, i) =>
                  card ? (
                    <Tile
                      key={card.id}
                      card={card}
                      rowLabel={row.label}
                      size={tile}
                      visible={passes(card)}
                      spot={spot.includes(card.id)}
                      tapDoes={tapDoes}
                      tabIndex={tabIndexFor(card.id)}
                      wallList={wallList}
                    />
                  ) : (
                    <span key={`gap-${i}`} aria-hidden="true" />
                  ),
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Tile({
  card,
  rowLabel,
  size,
  visible,
  spot,
  tapDoes,
  tabIndex,
  wallList,
}: {
  card: Card;
  rowLabel: string;
  size: number;
  visible: boolean;
  spot: boolean;
  tapDoes: TapDoes;
  tabIndex: number;
  wallList: () => CardId[];
}) {
  const api = useMyCards();
  const count = api.store.ownedInScope(card.id);
  const have = count > 0;
  const wanted = api.store.isWanted(card.id);
  const small = card.cardNumber.length > 3;

  if (!visible) {
    return (
      <span
        aria-hidden="true"
        className="grid place-items-center rounded-md border border-rule text-[10px] text-rule-strong"
        style={{ width: size, height: size }}
      >
        {card.cardNumber}
      </span>
    );
  }

  const name = `${rowLabel} #${card.cardNumber}${card.variation ? `, ${card.variation} variation` : ""} ${playerNames(card)}, ${
    have ? (count > 1 ? `have ${count}` : "have") : "need"
  }${wanted ? ", on your Want List" : ""}`;

  const open = () => api.openCard(card.id, { list: wallList() });

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      open();
    } else if (e.key === " ") {
      e.preventDefault();
      if (!e.repeat) api.toggleHave(card, wallList());
    }
  }
  function onClick(e: MouseEvent<HTMLButtonElement>) {
    // Keyboard presses were handled on keydown; a click with detail 0 is one.
    if (e.detail === 0) return;
    if (tapDoes === "details") open();
    else api.toggleHave(card, wallList());
  }

  const look = have
    ? "mc-lit bg-neon-blue text-on-neon-blue hover:bg-neon-blue-hover"
    : wanted
      ? "border-[1.5px] border-dashed border-neon-yellow-text text-neon-yellow-text hover:border-neon-blue hover:text-ink"
      : "border-[1.5px] border-dashed border-control text-ink-2 hover:border-neon-blue hover:text-ink";

  return (
    <div className="group relative" style={{ width: size, height: size }}>
      <button
        type="button"
        data-rove={card.id}
        tabIndex={tabIndex}
        aria-pressed={have}
        aria-label={name}
        title={`${rowLabel} #${card.cardNumber} ${playerNames(card)}${wanted ? " (wanted)" : ""}`}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => e.key === " " && e.preventDefault()}
        onClick={onClick}
        className={`relative grid size-full place-items-center rounded-md font-bold tabular-nums transition-colors focus-outline ${
          small ? "text-[10px]" : "text-sm"
        } ${look} ${spot ? "mc-spot" : ""}`}
      >
        {card.cardNumber}
        {card.variation && (
          <span aria-hidden="true" className="absolute bottom-0.5 left-1 text-[9px] font-bold leading-none">
            v
          </span>
        )}
      </button>
      {wanted && (
        <StarIcon
          aria-hidden="true"
          className="pointer-events-none absolute -left-1.5 -top-1.5 size-3.5 text-neon-yellow-text mc-star"
        />
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

function Legend() {
  return (
    <ul
      aria-label="How to read the wall"
      className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-2"
    >
      <li className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="mc-lit grid size-5 place-items-center rounded bg-neon-blue text-[10px] font-bold text-on-neon-blue"
        >
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
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="relative">
          <span className="grid size-5 place-items-center rounded border-[1.5px] border-dashed border-neon-yellow-text text-[10px] font-bold text-neon-yellow-text">
            7
          </span>
          <StarIcon className="absolute -left-1 -top-1 size-2.5 text-neon-yellow-text" />
        </span>
        Starred: on your Want List
      </li>
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

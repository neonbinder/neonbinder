import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ChevronLeftIcon, EllipsisHorizontalIcon, ListBulletIcon } from "@heroicons/react/24/outline";
import {
  getBrand,
  getSet,
  getSport,
  playerNames,
  setLabel,
  type Card,
  type SetId,
} from "../_shared/data";
import { useP3 } from "./context";
import { useMediaQuery, useRoving, useWidth } from "./hooks";
import Chip from "./Chip";
import QuickAdd from "./QuickAdd";
import { blocksOf, buildWall, printRunText, type WallSection } from "./wallModel";

/**
 * NEO-350 prototype 3 — the wall: one lit tile per card you have, a dashed
 * outline per card you need. Parallels stack under the base row so a card's
 * whole rainbow reads down one column; inserts get their own strips below.
 *
 * One Tab stop for the whole wall (roving tabindex). Arrows move, Space marks
 * have / need, Enter opens the details drawer.
 */

type Filter = "all" | "needs" | "haves" | "dupes";
type TapDoes = "toggle" | "details";

export default function Wall({ setId, focusOnMount }: { setId: SetId; focusOnMount: boolean }) {
  const api = useP3();
  const { store } = api;
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

  const base = store.completion(setId, { type: "Base" });
  const whole = store.completion(setId);
  const allCards = [...aligned.rows.flatMap((r) => r.cells), ...wall.inserts.flatMap((s) => s.rows[0].cells)].filter(
    (c): c is Card => c !== null,
  );
  const counts = {
    needs: allCards.filter((c) => store.ownedCount(c.id) === 0).length,
    haves: allCards.filter((c) => store.ownedCount(c.id) > 0).length,
    dupes: allCards.filter((c) => store.ownedCount(c.id) > 1).length,
  };
  const passes = (c: Card) => {
    const n = store.ownedCount(c.id);
    if (filter === "needs") return n === 0;
    if (filter === "haves") return n > 0;
    if (filter === "dupes") return n > 1;
    return true;
  };
  const keys = allCards.filter(passes).map((c) => c.id);
  const roving = useRoving(container, keys);

  // Scroll the number box's first match into view.
  useEffect(() => {
    if (spot.length === 0) return;
    const el = container.current?.querySelector(`[data-rove="${CSS.escape(spot[0])}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [spot]);

  const complete = base.total > 0 && base.owned === base.total;

  return (
    <section aria-labelledby="p3-wall-heading">
      <button
        type="button"
        onClick={() => api.go("home")}
        className="mb-3 inline-flex min-h-11 items-center gap-1 rounded-md pr-2 text-sm text-slate-300 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] sm:min-h-8"
      >
        <ChevronLeftIcon aria-hidden="true" className="size-4" />
        All my sets
      </button>

      <div className="p3-led flex flex-col gap-4 rounded-2xl border border-slate-800 p-4 sm:flex-row sm:items-end sm:p-5">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-slate-400">
            {getSport(set.sportId).name}, {getBrand(set.brandId).name}
          </p>
          <h2
            id="p3-wall-heading"
            ref={heading}
            tabIndex={-1}
            className="text-2xl font-bold text-white focus:outline-none sm:text-3xl"
          >
            {setLabel(set)}
          </h2>
          <p className="mt-2 text-sm text-slate-300">
            Base: <strong className="text-white">{base.owned}</strong> of {base.total}.{" "}
            Whole set with inserts and parallels:{" "}
            <strong className="text-white">{whole.owned}</strong> of {whole.total}.
          </p>
        </div>
        <div className="flex items-end gap-4">
          <p className="text-right">
            <span
              className={`p3-percent block text-6xl sm:text-7xl ${complete ? "text-neon-green" : "text-neon-blue"}`}
              data-complete={complete}
            >
              {base.percent}%
            </span>
            <span className="text-xs text-slate-300">{complete ? "Base set complete!" : "of the base set"}</span>
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => api.go("needs", setId)}
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-slate-600 px-3 text-sm text-slate-200 hover:border-neon-blue hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] sm:min-h-9"
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
          className="inline-flex min-h-11 items-center rounded-md border border-slate-600 px-3 text-sm text-slate-200 hover:border-neon-pink hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] sm:min-h-9"
        >
          Stop building this set
        </button>
      </div>

      <QuickAdd setId={setId} onSpot={setSpot} />

      <div className="mt-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div role="group" aria-label="Show on the wall" className="flex flex-wrap gap-1.5">
          {(
            [
              ["all", `Everything`],
              ["needs", `Needs ${counts.needs}`],
              ["haves", `Haves ${counts.haves}`],
              ["dupes", `Dupes ${counts.dupes}`],
            ] as const
          ).map(([value, label]) => (
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
          <span aria-hidden="true" className="text-sm text-slate-400">
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

      <p id="p3-wall-help" className="sr-only">
        Arrow keys move between cards. Space marks a card have or need. Enter opens its details.
      </p>
      <div
        ref={container}
        role="group"
        aria-label={`${setLabel(set)} checklist wall`}
        aria-describedby="p3-wall-help"
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
        />
        {wall.inserts.length > 0 && (
          <>
            <h3 className="mb-2 mt-6 text-sm font-bold text-slate-200">
              Inserts <span className="font-normal text-slate-400">(their own numbering)</span>
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
                    className="size-2.5 shrink-0 rounded-full border border-slate-500"
                    style={{
                      background:
                        row.variant.finish.kind === "gold" || row.variant.finish.kind === "superfractor"
                          ? "linear-gradient(135deg,#8a6a1c,#f5d77a,#9c7a23)"
                          : row.variant.finish.kind === "refractor" && !tint
                            ? "conic-gradient(#ff2e9a,#ffe600,#00d558,#00c2ff,#a44aff,#ff2e9a)"
                            : (tint ?? "transparent"),
                    }}
                  />
                  <span className="truncate text-xs text-slate-300 sm:text-sm" title={row.label}>
                    {row.label}
                    {run && <span className="text-slate-400"> {run}</span>}
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
}: {
  card: Card;
  rowLabel: string;
  size: number;
  visible: boolean;
  spot: boolean;
  tapDoes: TapDoes;
  tabIndex: number;
}) {
  const api = useP3();
  const count = api.store.ownedCount(card.id);
  const have = count > 0;
  const small = card.cardNumber.length > 3;

  if (!visible) {
    return (
      <span
        aria-hidden="true"
        className="grid place-items-center rounded-md border border-slate-800 text-[10px] text-slate-700"
        style={{ width: size, height: size }}
      >
        {card.cardNumber}
      </span>
    );
  }

  const name = `${rowLabel} #${card.cardNumber}${card.variation ? `, ${card.variation} variation` : ""} ${playerNames(card)}, ${
    have ? (count > 1 ? `have ${count}` : "have") : "need"
  }`;

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      api.openCard(card);
    } else if (e.key === " ") {
      e.preventDefault();
      if (!e.repeat) api.toggleHave(card, rowLabel);
    }
  }
  function onClick(e: MouseEvent<HTMLButtonElement>) {
    // Keyboard presses were handled on keydown; a click with detail 0 is one.
    if (e.detail === 0) return;
    if (tapDoes === "details") api.openCard(card);
    else api.toggleHave(card, rowLabel);
  }

  return (
    <div className="group relative" style={{ width: size, height: size }}>
      <button
        type="button"
        data-rove={card.id}
        tabIndex={tabIndex}
        aria-pressed={have}
        aria-label={name}
        title={`${rowLabel} #${card.cardNumber} ${playerNames(card)}`}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => e.key === " " && e.preventDefault()}
        onClick={onClick}
        className={`relative grid size-full place-items-center rounded-md font-bold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] focus-visible:ring-offset-2 focus-visible:ring-offset-black ${
          small ? "text-[10px]" : "text-sm"
        } ${
          have
            ? "p3-lit bg-neon-blue text-black hover:bg-[#5fd9ff]"
            : "border-[1.5px] border-dashed border-slate-500 text-slate-300 hover:border-neon-blue hover:text-white"
        } ${spot ? "p3-spot" : ""}`}
      >
        {card.cardNumber}
        {card.variation && (
          <span aria-hidden="true" className="absolute bottom-0.5 left-1 text-[9px] font-bold leading-none">
            v
          </span>
        )}
      </button>
      {count > 1 && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-1.5 -top-1.5 rounded bg-neon-yellow px-1 text-[10px] font-bold leading-4 text-black"
        >
          ×{count}
        </span>
      )}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => api.openCard(card)}
        className="absolute -bottom-1.5 -right-1.5 hidden size-5 place-items-center rounded-full border border-slate-500 bg-slate-950 text-slate-200 hover:border-neon-blue hover:text-white [@media(hover:hover)]:group-hover:grid"
      >
        <EllipsisHorizontalIcon className="size-3.5" />
      </button>
    </div>
  );
}



function Legend() {
  return (
    <ul aria-label="How to read the wall" className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-300">
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="p3-lit grid size-5 place-items-center rounded bg-neon-blue text-[10px] font-bold text-black">
          7
        </span>
        Lit up: you have it
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="grid size-5 place-items-center rounded border-[1.5px] border-dashed border-slate-500 text-[10px] font-bold text-slate-300">
          7
        </span>
        Dashed: you need it
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="rounded bg-neon-yellow px-1 text-[10px] font-bold leading-4 text-black">
          ×2
        </span>
        Dupes
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="font-bold text-slate-200">v</span>
        Image variation
      </li>
    </ul>
  );
}

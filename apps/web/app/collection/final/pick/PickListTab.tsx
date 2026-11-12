import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, ChevronDownIcon, ChevronUpDownIcon, PrinterIcon } from "@heroicons/react/20/solid";
import { Input } from "@/components/primitives/Input";
import NeonButton from "@/components/modules/NeonButton";
import CardFace from "../../prototypes/_shared/CardFace";
import P3Dialog from "../../prototypes/p3/Dialog";
import { LABEL, QUIET_BUTTON, SELECT } from "../../prototypes/p3/classes";
import { SkeletonBars } from "../catalog/Skeleton";
import { playerNames, setLabel } from "../data/labels";
import { useListing } from "../data/store";
import { SALE_PARAM } from "../inventory/listing/copy";
import { ParamLink, usePushParams, useReplaceParams } from "../mode";
import { PageApiContext } from "../pageApi";
import { SPORT_LINE, SPORT_TAB, VARIANT_CHIP, VARIANT_STRIPE, sportHue } from "./colours";
import { DemoPickListProvider } from "./demoPickStore";
import PrintSheet, { usePrinting } from "./PrintSheet";
import {
  boxStops,
  buildSections,
  conditionOf,
  copiesLeft,
  hasFilters,
  isPulled,
  lineIds,
  mergeLines,
  naturalCompare,
  orderLabel,
  NOT_IN_NB,
  rowFacts,
  setSections,
  SORT_KEYS,
  VARIANT_ROLE_LABEL,
  VARIANT_ROLES,
  variantName,
  type BoxStop,
  type PickFilters,
  type PickRow,
  type PickSection,
  type SortDir,
  type SortKey,
  type VariantRole,
} from "./model";
import { PickListStoreContext } from "./store";
import type { PickListData, PickListStore, PickOrder } from "./types";
import "./pick-list.css";

/**
 * NEO-500 — the Pick List: every card the seller has sold and not yet pulled
 * from a box, in the order they walk the boxes. The public demo's runs on a
 * fixture (`?demo=on&side=inventory&tab=pick`); the signed-in seller's on
 * their orders (`./convexPickStore`). Both supply `PickListStore` (`./store`).
 *
 * Two views, each a history entry: the list (default) and By the Box
 * (`pv=box`, one box at a time, `pbox=<id>`; Next box pushes, and the walk
 * ends on Can't find it). Sort and filters ride on the URL too but REPLACE
 * the entry, so Back never steps through them. Every param is prefixed `p`
 * so it never collides with the page's own (`set`, `sport`, `year`, `box`, `q`).
 *
 * Pulling: a click on a row (wide screens), a tap on its check box, or Space
 * on it marks it; the page's status line says so with Undo. Arrow keys move
 * between rows. The header's button pulls what is in view: the whole list,
 * the filtered rows, or the box, asking first when more than one is left.
 *
 * Colour comes from the seller's box dividers (`./colours`) and is always
 * written out as words too.
 */

export const PICK_PARAMS = {
  view: "pv",
  box: "pbox",
  sort: "psort",
  dir: "pdir",
  text: "pq",
  sport: "psport",
  year: "pyear",
  type: "ptype",
  condition: "pcond",
  order: "porder",
  slabs: "pslabs",
  numbered: "pnum",
  notInNb: "pnotnb",
  group: "pgroup",
} as const;

/** The params "Back to default" clears: everything but the view and the box. */
const LIST_TWEAKS = [
  PICK_PARAMS.sort,
  PICK_PARAMS.dir,
  PICK_PARAMS.text,
  PICK_PARAMS.sport,
  PICK_PARAMS.year,
  PICK_PARAMS.type,
  PICK_PARAMS.condition,
  PICK_PARAMS.order,
  PICK_PARAMS.slabs,
  PICK_PARAMS.numbered,
  PICK_PARAMS.notInNb,
  PICK_PARAMS.group,
];

const COPY = {
  empty: "Nothing to pull. Go sell something rad.",
  done: "All pulled! Totally tubular.",
  doneNote: "Every card on the list is out of its box. Hit Undo to put the last one back.",
  noMatch: "Nothing on the list matches these filters.",
  matches: (n: number) => (n === 1 ? "1 card matches." : `${n} cards match.`),
  cantFind: "Can't find it",
  cantFindNote: "NB couldn't tie these sales to one card. Check each listing's photo to find it.",
  cantFindStopNote: "These sales don't say enough to file. The order's photo is your best clue.",
  notInBox: "Not in a box",
  notInBoxNote: "NB has no copy of these, so no box to check. Go by each listing, set by set.",
  notInNbWhy: "NB doesn't have this copy. Go by the listing.",
  notInNbWhyLinked: "NB doesn't have this copy. Go by the listing; the order link has the photo.",
  /** Read after a listing's own divider titled just like an NB set's. */
  unmatchedTwin: ", not matched to a set",
  truncated: "Your Pick List is too long to show at once, so it starts with your oldest orders. Pull these and the rest will show up.",
  saving: "Saving…",
  pullFailed: "That pull didn't save. Try it again.",
  putBackFailed: "That card didn't go back on the list. Try it again.",
  noBox: "Box not recorded",
  noBoxNote: "These sold before NB kept track of boxes. Look wherever you keep the set.",
  fresh: "Sold since you started",
  freshNote: "These came in mid-pull. Grab them on your way out.",
  boxesDone: "Every box is clear. Totally tubular.",
  lastStop: (n: number) =>
    n === 1
      ? "Plus 1 sale NB couldn't tie to a card. It waits after the boxes."
      : `Plus ${n} sales NB couldn't tie to a card. They wait after the boxes.`,
};

function filtersFrom(params: URLSearchParams): PickFilters {
  const type = params.get(PICK_PARAMS.type);
  return {
    text: params.get(PICK_PARAMS.text) ?? undefined,
    sport: params.get(PICK_PARAMS.sport) ?? undefined,
    year: params.get(PICK_PARAMS.year) ?? undefined,
    variant: VARIANT_ROLES.includes(type as VariantRole) ? (type as VariantRole) : undefined,
    condition: params.get(PICK_PARAMS.condition) ?? undefined,
    order: params.get(PICK_PARAMS.order) ?? undefined,
    slabs: params.get(PICK_PARAMS.slabs) === "1",
    numbered: params.get(PICK_PARAMS.numbered) === "1",
    notInNb: params.get(PICK_PARAMS.notInNb) === "1",
  };
}

function sortFrom(params: URLSearchParams): { sort: SortKey | null; dir: SortDir } {
  const sort = params.get(PICK_PARAMS.sort);
  return {
    sort: SORT_KEYS.includes(sort as SortKey) ? (sort as SortKey) : null,
    dir: params.get(PICK_PARAMS.dir) === "desc" ? "desc" : "asc",
  };
}

/** Wide screens pull on a row click; a phone only on the check box (a scroll is not a pull). */
function rowClickPulls(): boolean {
  return typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 48rem)").matches;
}

type TitleDetail = (detail: string | null) => void;

/**
 * The tab as the collection page mounts it: on the store the page put in
 * `PickListStoreContext`, or the demo's when there is none. `onTitleDetail`
 * hands the page the box By the Box is on, for the tab's title.
 */
export default function PickListTab({ onTitleDetail }: { onTitleDetail?: TitleDetail } = {}) {
  const store = useContext(PickListStoreContext);
  if (store) return <PickList store={store} onTitleDetail={onTitleDetail} />;
  return (
    <DemoPickListProvider>
      <DemoPickList onTitleDetail={onTitleDetail} />
    </DemoPickListProvider>
  );
}

function DemoPickList({ onTitleDetail }: { onTitleDetail?: TitleDetail }) {
  const store = useContext(PickListStoreContext);
  return store ? <PickList store={store} onTitleDetail={onTitleDetail} /> : null;
}

type Mark = (ids: readonly string[], on: boolean, message: string) => void;

/** What the header's pull button covers right now. */
interface PullScope {
  kind: "all" | "filtered" | "box" | "cantFind";
  /** Identifies the scope, so a confirm never carries over to another. */
  key: string;
  rows: PickRow[];
  name?: string;
  /** By the Box: the Box not recorded stop, which is no box. */
  unrecorded?: boolean;
  /** By the Box: the Not in a box stop. */
  notInBox?: boolean;
  /** By the Box: the stop to step to once this one is done. */
  next?: number;
}

interface ListState {
  filters: PickFilters;
  sort: SortKey | null;
  dir: SortDir;
  groupByOrder: boolean;
}

function PickList({ store, onTitleDetail }: { store: PickListStore; onTitleDetail?: TitleDetail }) {
  const [params] = useSearchParams();
  const search = params.toString();
  const push = usePushParams();
  const pageApi = useContext(PageApiContext);
  const { data, pulled, setPulled } = store;
  const byBox = params.get(PICK_PARAMS.view) === "box";
  const titleId = useId();
  const markSeq = useRef(0);

  const list = useMemo<ListState>(() => {
    const p = new URLSearchParams(search);
    return { filters: filtersFrom(p), ...sortFrom(p), groupByOrder: p.get(PICK_PARAMS.group) === "order" };
  }, [search]);
  const lines = data?.lines;
  const sections = useMemo(
    () => (lines ? buildSections(lines, list.filters, { sort: list.sort, dir: list.dir, groupByOrder: list.groupByOrder }) : []),
    [lines, list],
  );
  const allRows = useMemo(() => (lines ? mergeLines(lines) : []), [lines]);
  const stops = useMemo(() => (data ? boxStops(data.lines, data.boxes) : []), [data]);
  const wanted = params.get(PICK_PARAMS.box);
  const found = stops.findIndex((s) => s.box.id === wanted);
  const index = found < 0 ? 0 : found;

  const total = useMemo(() => lines?.reduce((n, l) => n + l.quantity, 0) ?? 0, [lines]);
  const left = copiesLeft(allRows, pulled);

  if (!data) return <SkeletonBars rows={6} />;

  /** Marks lines pulled (or not), saying so on the status line with Undo. */
  /**
   * Marks lines pulled (or not). A store that saves to a server answers with
   * a promise: the status line says "Saving…" until it lands, then the
   * message, so "Pulled" only ever means saved. A failed save says so (the
   * store has already put the tick back).
   */
  const mark: Mark = (ids, on, message) => {
    const before = ids.filter((id) => pulled.has(id));
    const failed = (wasOn: boolean) => pageApi?.notify(wasOn ? COPY.pullFailed : COPY.putBackFailed);
    const run = (lineIds: readonly string[], to: boolean) => {
      const saving = setPulled(lineIds, to);
      if (saving) saving.catch(() => failed(to));
      return saving;
    };
    const undo = () => {
      void run(ids, !on);
      if (on && before.length) void run(before, true);
    };
    const saving = setPulled(ids, on);
    if (!saving) {
      pageApi?.notify(message, undo);
      return;
    }
    const seq = ++markSeq.current;
    pageApi?.notify(COPY.saving, undo);
    saving.then(
      // A later mark owns the line by now: this one's word would be stale.
      () => seq === markSeq.current && pageApi?.notify(message, undo),
      () => failed(on),
    );
  };

  const goStop = (to: number) => push((p) => p.set(PICK_PARAMS.box, stops[to].box.id));

  const stop = stops[index];
  const scope: PullScope | null = byBox
    ? stop
      ? {
          kind: stop.cantFind || stop.notInBox ? "cantFind" : "box",
          key: `box:${stop.box.id}`,
          rows: stop.rows,
          name: stop.box.name,
          unrecorded: stop.unrecorded,
          notInBox: stop.notInBox,
          next: index + 1 < stops.length ? index + 1 : undefined,
        }
      : null
    : hasFilters(list.filters)
      ? { kind: "filtered", key: `filtered:${search}`, rows: sections.flatMap((s) => s.rows) }
      : { kind: "all", key: "all", rows: allRows };

  const pullScope = () => {
    if (!scope) return;
    const n = copiesLeft(scope.rows, pulled);
    const ids = [...new Set(lineIds(scope.rows))].filter((id) => !pulled.has(id));
    if (ids.length) {
      const message =
        scope.kind === "all"
          ? n === 1
            ? "Pulled the last card. Pull complete!"
            : `Pulled the last ${n} cards. Pull complete!`
          : scope.kind === "filtered"
            ? n === 1
              ? "Pulled the 1 card that matches."
              : `Pulled all ${n} that match.`
            : scope.unrecorded
              ? `Pulled ${n} with no box noted.`
              : scope.notInBox
                ? `Pulled ${n} not in NB.`
                : `Pulled ${n} from ${scope.name}.`;
      mark(ids, true, message);
    }
    if (scope.next !== undefined) goStop(scope.next);
  };

  const done = total > 0 && left === 0;

  return (
    <section aria-labelledby={titleId} className="nb-pick space-y-4">
      <PickHeader titleId={titleId} total={total} left={left} scope={scope} pulled={pulled} onPull={pullScope} byBox={byBox} />
      {data.lines.length === 0 ? (
        <EmptyList />
      ) : (
        <>
          {data.truncated && (
            <p className="nb-pick-noprint rounded-xl border border-notice-info-rule bg-notice-info-bg px-4 py-3 text-sm font-semibold text-notice-info-ink">
              {COPY.truncated}
            </p>
          )}
          {done && (
            <div className="nb-pick-noprint rounded-xl border border-notice-success-rule bg-notice-success-bg px-4 py-3">
              <p className="text-lg font-bold text-notice-success-ink">{COPY.done}</p>
              <p className="text-sm text-ink-2">{COPY.doneNote}</p>
            </div>
          )}
          <ViewSwitch byBox={byBox} />
          {byBox ? (
            <BoxView stops={stops} index={index} pulled={pulled} mark={mark} goStop={goStop} onTitleDetail={onTitleDetail} />
          ) : (
            <ListView data={data} list={list} sections={sections} pulled={pulled} mark={mark} />
          )}
        </>
      )}
    </section>
  );
}

/**
 * Nothing to pull: where the next pull comes from. Sales (where the store has
 * one) shows what sold; the Inventory list is what is up for sale.
 */
function EmptyList() {
  const sales = useListing() !== undefined;
  const link = "rounded-sm font-semibold text-neon-blue-text underline underline-offset-4 focus-outline";
  return (
    <div className="space-y-2 rounded-xl border border-dashed border-rule-strong px-4 py-10 text-center">
      <p className="text-lg font-semibold text-ink-2">{COPY.empty}</p>
      <p className="text-sm text-ink-2">
        {sales ? (
          <>
            New orders show up here within about 15 minutes.{" "}
            <ParamLink search={{ tab: "sales" }} className={link}>
              See what sold
            </ParamLink>{" "}
            or{" "}
          </>
        ) : null}
        <ParamLink search={{ tab: "cards" }} className={link}>
          {sales ? "open your inventory" : "Open your inventory"}
        </ParamLink>
        .
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function PickHeader({
  titleId,
  total,
  left,
  scope,
  pulled,
  onPull,
  byBox,
}: {
  titleId: string;
  total: number;
  left: number;
  scope: PullScope | null;
  pulled: ReadonlySet<string>;
  onPull: () => void;
  byBox: boolean;
}) {
  const got = total - left;
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 space-y-2">
        <h2 id={titleId} className="text-xl font-bold text-ink">
          Pick List
        </h2>
        <p className="text-sm text-ink-2">
          <span className="font-semibold text-ink tabular-nums">{got}</span> of{" "}
          <span className="tabular-nums">{total}</span> {total === 1 ? "card" : "cards"} pulled
        </p>
        {total > 0 && (
          <div aria-hidden="true" className="nb-pick-noprint h-1.5 w-56 max-w-full overflow-hidden rounded-full bg-rule">
            <div
              className="h-full w-full origin-left bg-neon-green transition-transform duration-300 motion-reduce:transition-none"
              style={{ transform: `scaleX(${got / total})` }}
            />
          </div>
        )}
      </div>
      {/* Nothing to pull: nothing to print or track either. */}
      {total > 0 && (
        <div className="nb-pick-noprint flex flex-wrap items-center gap-2">
          {/* Print shows only what is on screen: in By the Box, that is this box. */}
          <button type="button" onClick={() => window.print()} className={QUIET_BUTTON}>
            <PrinterIcon aria-hidden="true" className="size-4" />
            {byBox ? "Print this box" : "Print list"}
          </button>
          {scope && <PullButton scope={scope} pulled={pulled} onPull={onPull} />}
        </div>
      )}
    </header>
  );
}

/**
 * Pulls everything in scope. More than one card left asks first: the button
 * turns into its own confirm ("Pull all 29?"), with Not yet beside it. With
 * nothing left it stays focusable (aria-disabled), so the keyboard is never
 * dropped onto the page.
 */
function PullButton({ scope, pulled, onPull }: { scope: PullScope; pulled: ReadonlySet<string>; onPull: () => void }) {
  const n = copiesLeft(scope.rows, pulled);
  const key = `${scope.key}:${n}`;
  const [confirming, setConfirming] = useState<string | null>(null);
  const asking = confirming === key;
  const button = useRef<HTMLButtonElement>(null);
  const inBox = scope.kind === "box" || scope.kind === "cantFind";
  const off = n === 0 && (!inBox || scope.next === undefined);

  const label = asking
    ? scope.kind === "all"
      ? `Pull all ${n}?`
      : scope.kind === "filtered"
        ? `Pull these ${n}?`
        : `Pull all ${n} here?`
    : scope.kind === "all"
      ? "Pull Complete"
      : scope.kind === "filtered"
        ? `Pull these ${n}`
        : scope.kind === "box"
          ? "Box done"
          : "All found";

  const cancel = () => {
    setConfirming(null);
    button.current?.focus();
  };

  return (
    <>
      {asking && (
        <button type="button" onClick={cancel} className={QUIET_BUTTON}>
          Not yet
        </button>
      )}
      <NeonButton
        ref={button}
        type="button"
        aria-disabled={off || undefined}
        onClick={() => {
          if (off) return;
          if (n > 1 && !asking) {
            setConfirming(key);
            return;
          }
          setConfirming(null);
          onPull();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && asking) {
            e.preventDefault();
            cancel();
          }
        }}
        className="min-h-11 sm:min-h-9"
      >
        {label}
      </NeonButton>
    </>
  );
}

/** List or By the Box: two views, so each is a link and a Back step. */
function ViewSwitch({ byBox }: { byBox: boolean }) {
  const views: { key: string; text: string; search: Record<string, string> }[] = [
    { key: "list", text: "Whole list", search: { tab: "pick" } },
    { key: "box", text: "By the Box", search: { tab: "pick", [PICK_PARAMS.view]: "box" } },
  ];
  return (
    <nav aria-label="Pick List views" className="nb-pick-noprint">
      <ul className="inline-flex rounded-lg border border-control bg-field p-0.5">
        {views.map((v) => {
          const current = (v.key === "box") === byBox;
          return (
            <li key={v.key}>
              <ParamLink
                search={v.search}
                aria-current={current ? "page" : undefined}
                className={`inline-flex min-h-11 items-center rounded-md px-3 text-sm font-semibold focus-outline sm:min-h-9 ${
                  current ? "bg-neon-blue text-on-neon-blue ring-1 ring-inset ring-selection" : "text-ink-2 hover:text-ink"
                }`}
              >
                {v.text}
              </ParamLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

function ListView({
  data,
  list,
  sections,
  pulled,
  mark,
}: {
  data: PickListData;
  list: ListState;
  sections: PickSection[];
  pulled: ReadonlySet<string>;
  mark: Mark;
}) {
  const replace = useReplaceParams();
  const { filters, sort, dir, groupByOrder } = list;
  const filtered = hasFilters(filters);
  const tweaked = filtered || sort !== null || groupByOrder;
  const matching = sections.reduce((n, s) => n + s.rows.reduce((m, r) => m + r.quantity, 0), 0);

  const setParam = useCallback(
    (key: string, value: string | null) =>
      replace((p) => {
        if (value) p.set(key, value);
        else p.delete(key);
      }),
    [replace],
  );

  return (
    <>
      <FilterBar
        data={data}
        filters={filters}
        sort={sort}
        dir={dir}
        groupByOrder={groupByOrder}
        tweaked={tweaked}
        setParam={setParam}
        onDefault={() => replace((p) => LIST_TWEAKS.forEach((k) => p.delete(k)))}
      />
      {/*
        Always rendered and never display:none, so a screen reader hears the
        first count after a filter: an empty region is sr-only, not hidden.
      */}
      <p
        role="status"
        className={`nb-pick-noprint ${
          filtered && matching === 0
            ? "rounded-xl border border-dashed border-rule-strong px-4 py-8 text-center text-ink-2"
            : filtered
              ? "text-sm text-ink-2"
              : "sr-only"
        }`}
      >
        {filtered ? (matching ? COPY.matches(matching) : COPY.noMatch) : ""}
      </p>
      {sections.length > 0 && (
        <PickTable
          caption="Cards to pull"
          sections={sections}
          pulled={pulled}
          mark={mark}
          sort={sort}
          dir={dir}
          onSort={(key) => {
            replace((p) => {
              if (sort !== key) {
                p.set(PICK_PARAMS.sort, key);
                p.delete(PICK_PARAMS.dir);
              } else if (dir === "asc") p.set(PICK_PARAMS.dir, "desc");
              else {
                p.delete(PICK_PARAMS.sort);
                p.delete(PICK_PARAMS.dir);
              }
            });
          }}
          nameWithOrder={groupByOrder}
        />
      )}
    </>
  );
}

const SORT_LABEL: Record<SortKey, string> = {
  qty: "Qty",
  number: "No.",
  player: "Player",
  set: "Set",
  condition: "Condition",
  detail: "Serial",
  order: "Order",
};

function FilterBar({
  data,
  filters,
  sort,
  dir,
  groupByOrder,
  tweaked,
  setParam,
  onDefault,
}: {
  data: PickListData;
  filters: PickFilters;
  sort: SortKey | null;
  dir: SortDir;
  groupByOrder: boolean;
  tweaked: boolean;
  setParam: (key: string, value: string | null) => void;
  onDefault: () => void;
}) {
  const rows = useMemo(() => mergeLines(data.lines), [data.lines]);
  const options = useMemo(() => {
    const sports = new Map<string, { name: string; nb: boolean }>();
    const years = new Set<number>();
    const conditions = new Set<string>();
    for (const r of rows) {
      const facts = rowFacts(r);
      if (facts) {
        sports.set(facts.sportKey, { name: facts.sportName, nb: !facts.sportKey.startsWith("sport:") });
        years.add(facts.year);
      }
      conditions.add(conditionOf(r));
    }
    const orders = new Map(data.lines.map((l) => [l.order.id, l.order]));
    // A listing's sport word NB has no row for stays its own choice (never
    // matched by name); when it reads like an NB sport's, it says so.
    const nbNames = new Set([...sports.values()].filter((v) => v.nb).map((v) => v.name.trim().toLowerCase()));
    const sportChoices: [string, string][] = [...sports].map(([key, { name, nb }]) => [
      key,
      !nb && nbNames.has(name.trim().toLowerCase()) ? `${name} (from listings)` : name,
    ]);
    return {
      sports: sportChoices.sort((a, b) => naturalCompare(a[1], b[1])),
      years: [...years].sort((a, b) => b - a),
      conditions: [...conditions].sort(naturalCompare),
      orders: [...orders.values()].sort((a, b) => naturalCompare(orderLabel(a), orderLabel(b))),
    };
  }, [rows, data.lines]);

  // The find box answers each keystroke from its own state; the URL follows
  // once typing pauses (replace, never a Back step), and a URL change made
  // elsewhere (Back to default) comes back into the box.
  const urlText = filters.text ?? "";
  const [text, setText] = useState(urlText);
  const [seen, setSeen] = useState(urlText);
  if (urlText !== seen) {
    setSeen(urlText);
    setText(urlText);
  }
  useEffect(() => {
    if (text === seen || (!text.trim() && !seen)) return;
    const t = window.setTimeout(() => setParam(PICK_PARAMS.text, text.trim() ? text : null), 300);
    return () => window.clearTimeout(t);
  }, [text, seen, setParam]);
  const find = useRef<HTMLInputElement>(null);

  // A phone shows Find, Sort by and the chips; the rest open under More filters.
  const [more, setMore] = useState(false);
  const moreId = useId();
  const moreOn = [filters.order, filters.sport, filters.year, filters.variant, filters.condition].filter(Boolean).length;

  const select = (label: string, key: string, value: string | undefined, choices: [string, string][], all: string) => (
    <label className="block min-w-0">
      <span className={LABEL}>{label}</span>
      <select className={`${SELECT} w-full`} value={value ?? ""} onChange={(e) => setParam(key, e.target.value || null)}>
        <option value="">{all}</option>
        {choices.map(([v, t]) => (
          <option key={v} value={v}>
            {t}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="nb-pick-noprint space-y-3 rounded-xl border border-panel-rule bg-panel p-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <div className="col-span-2 sm:col-span-3 xl:col-span-2">
          <Input
            ref={find}
            label="Find a card"
            placeholder="Number, player, set or order"
            autoComplete="off"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        {/* The column headers sort on a wide screen; a phone hides them, so it sorts here. */}
        <label className="block min-w-0 md:hidden">
          <span className={LABEL}>Sort by</span>
          <select
            className={`${SELECT} w-full`}
            value={sort ? `${sort}:${dir}` : ""}
            onChange={(e) => {
              const [key, d] = e.target.value.split(":");
              setParam(PICK_PARAMS.sort, key || null);
              setParam(PICK_PARAMS.dir, d === "desc" ? "desc" : null);
            }}
          >
            <option value="">Pick order</option>
            {SORT_KEYS.filter((k) => k !== "set").flatMap((k) => [
              <option key={`${k}:asc`} value={`${k}:asc`}>
                {SORT_LABEL[k]}, low to high
              </option>,
              <option key={`${k}:desc`} value={`${k}:desc`}>
                {SORT_LABEL[k]}, high to low
              </option>,
            ])}
          </select>
        </label>
        <div className="flex items-end md:hidden">
          <button
            type="button"
            aria-expanded={more}
            aria-controls={moreId}
            onClick={() => setMore((m) => !m)}
            className={`${QUIET_BUTTON} min-h-11 w-full justify-between`}
          >
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              More filters
              {moreOn > 0 && (
                <>
                  <span aria-hidden="true" className="rounded-full bg-neon-blue px-1.5 text-xs font-bold leading-5 text-on-neon-blue tabular-nums">
                    {moreOn}
                  </span>
                  <span className="sr-only">({moreOn} on)</span>
                </>
              )}
            </span>
            <ChevronDownIcon aria-hidden="true" className={`size-4 transition-transform motion-reduce:transition-none ${more ? "rotate-180" : ""}`} />
          </button>
        </div>
        <div id={moreId} className={more ? "contents" : "max-md:hidden md:contents"}>
          {select(
            "Order",
            PICK_PARAMS.order,
            filters.order,
            options.orders.map((o) => [o.id, orderLabel(o)]),
            "All orders",
          )}
          {select("Sport", PICK_PARAMS.sport, filters.sport, options.sports, "Every sport")}
          {select(
            "Year",
            PICK_PARAMS.year,
            filters.year,
            options.years.map((y) => [String(y), String(y)]),
            "Every year",
          )}
          {select(
            "Type",
            PICK_PARAMS.type,
            filters.variant,
            VARIANT_ROLES.map((r) => [r, VARIANT_ROLE_LABEL[r]]),
            "Every type",
          )}
          {select(
            "Condition",
            PICK_PARAMS.condition,
            filters.condition,
            options.conditions.map((c) => [c, c]),
            "Any condition",
          )}
        </div>
      </div>
      {/* Back to default rides the last chip's row, never a row of its own. */}
      <div role="group" aria-label="Quick filters" className="flex flex-wrap items-center gap-1.5">
          <Toggle pressed={Boolean(filters.slabs)} onClick={() => setParam(PICK_PARAMS.slabs, filters.slabs ? null : "1")}>
            Only slabs
          </Toggle>
          <Toggle pressed={Boolean(filters.numbered)} onClick={() => setParam(PICK_PARAMS.numbered, filters.numbered ? null : "1")}>
            Only numbered
          </Toggle>
          <Toggle pressed={Boolean(filters.notInNb)} onClick={() => setParam(PICK_PARAMS.notInNb, filters.notInNb ? null : "1")}>
            Only not in NB
          </Toggle>
          <Toggle pressed={groupByOrder} onClick={() => setParam(PICK_PARAMS.group, groupByOrder ? null : "order")}>
            Group by order
          </Toggle>
        <button
          type="button"
          onClick={() => {
            // The button switches off once the list is back to default: the
            // keyboard goes to Find first, never down onto the page.
            find.current?.focus();
            onDefault();
          }}
          disabled={!tweaked}
          className={`ml-auto rounded-md px-2 text-sm text-ink-2 underline underline-offset-4 hover:text-ink disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50 min-h-11 sm:min-h-8 focus-outline`}
        >
          Back to default
        </button>
      </div>
    </div>
  );
}

function Toggle({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-sm font-medium focus-outline sm:min-h-8 ${
        pressed ? "border-selection bg-neon-blue text-on-neon-blue" : "border-control text-ink-2 hover:border-ink-3 hover:text-ink"
      }`}
    >
      {pressed && <CheckIcon aria-hidden="true" className="size-4" />}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// By the Box
// ---------------------------------------------------------------------------

function BoxView({
  stops,
  index,
  pulled,
  mark,
  goStop,
  onTitleDetail,
}: {
  stops: BoxStop[];
  index: number;
  pulled: ReadonlySet<string>;
  mark: Mark;
  goStop: (to: number) => void;
  onTitleDetail?: TitleDetail;
}) {
  const stop = stops[index];
  const heading = useRef<HTMLHeadingElement>(null);
  const shownStop = useRef(stop?.box.id);
  useEffect(() => {
    // A stop change (Next, Previous, Box done, Back) puts the keyboard on the new stop's heading.
    if (stop && shownStop.current !== stop.box.id) heading.current?.focus({ preventScroll: false });
    shownStop.current = stop?.box.id;
  }, [stop]);
  const stopName = stop?.box.name ?? null;
  useEffect(() => {
    onTitleDetail?.(stopName);
    return () => onTitleDetail?.(null);
  }, [stopName, onTitleDetail]);

  if (!stop) return <p className="text-ink-2">{COPY.boxesDone}</p>;
  const left = copiesLeft(stop.rows, pulled);
  const boxCount = stops.filter((s) => !s.cantFind && !s.unrecorded && !s.notInBox).length;
  const lostLeft = stops.reduce((n, s) => (s.cantFind || s.notInBox ? n + copiesLeft(s.rows, pulled) : n), 0);
  const nextStop = stops[index + 1];
  // A box of one sport says it once, beside its name, not on every row.
  const first = stop.rows[0]?.card;
  const oneSport = first && stop.rows.every((r) => r.card?.set.sport.id === first.set.sport.id) ? first : null;
  const leftText = left === 0 ? "all pulled" : `${left} to pull`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 ref={heading} tabIndex={-1} className="nb-pick-boxhead rounded px-1 -mx-1 text-lg font-bold text-ink focus-outline">
            {stop.cantFind
              ? `Last stop · ${COPY.cantFind} · ${leftText}`
              : stop.notInBox
                ? `${COPY.notInBox} · ${leftText}`
                : stop.unrecorded
                  ? `${COPY.noBox} · ${leftText}`
                  : `Box ${index + 1} of ${boxCount} · ${stop.box.name} · ${leftText}`}
          </h3>
          {oneSport && <SportChip code={stop.rows[0].sportCode} name={oneSport.set.sport.name} />}
        </div>
        <div className="nb-pick-noprint flex gap-2">
          <button
            type="button"
            className={`${QUIET_BUTTON} disabled:cursor-not-allowed disabled:opacity-50`}
            disabled={index === 0}
            onClick={() => goStop(index - 1)}
          >
            Previous box
          </button>
          <NeonButton
            type="button"
            variant="secondary"
            disabled={!nextStop}
            onClick={() => goStop(index + 1)}
            className="min-h-11 sm:min-h-9"
          >
            {nextStop?.cantFind
              ? `${COPY.cantFind} (${copiesLeft(nextStop.rows, pulled)})`
              : nextStop?.notInBox
                ? `${COPY.notInBox} (${copiesLeft(nextStop.rows, pulled)})`
                : nextStop?.unrecorded
                  ? `${COPY.noBox} (${copiesLeft(nextStop.rows, pulled)})`
                  : "Next box"}
          </NeonButton>
        </div>
      </div>
      {stop.cantFind ? (
        <p className="text-sm text-ink-2">{COPY.cantFindStopNote}</p>
      ) : stop.notInBox ? (
        <p className="text-sm text-ink-2">{COPY.notInBoxNote}</p>
      ) : stop.unrecorded ? (
        <p className="text-sm text-ink-2">{COPY.noBoxNote}</p>
      ) : (
        index === 0 && lostLeft > 0 && <p className="text-sm text-ink-2">{COPY.lastStop(lostLeft)}</p>
      )}
      <PickTable
        caption={
          stop.cantFind
            ? "Sales NB couldn't tie to a card"
            : stop.notInBox
              ? "Sales not in NB, by set"
              : stop.unrecorded
                ? "Cards with no box noted"
                : `Cards to pull from ${stop.box.name}`
        }
        // Not in a box walks by set, with the list's own dividers; a box is one run.
        sections={stop.notInBox ? setSections(stop.rows) : [{ kind: "flat", key: `box:${stop.box.id}`, rows: stop.rows }]}
        pulled={pulled}
        mark={mark}
        showSlot={stop.rows.some((r) => r.spot?.slot !== undefined)}
        hideSport={Boolean(oneSport)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * A row's name for its Pulled toggle and picture button: everything that
 * tells it from another row, so no two controls read the same. The same
 * card can sit twice in one list (two conditions, two slabs, a fresh sale
 * beside an old one, two slots in one box), and each of those is named.
 */
/** How a toggle's name says a row is not in NB: "…, not in NB, BSC 1234". */
const NOT_IN_NB_NAME = "not in NB";

function rowName(row: PickRow, options: { withOrder?: boolean; withSlot?: boolean } = {}): string {
  const c = row.card;
  const extra = row.grade
    ? `${row.grade.grader} ${row.grade.grade}, cert ${row.grade.cert}`
    : row.serial
      ? `${row.condition}, ${row.serial}`
      : row.condition;
  const orders = row.orders.map(orderLabel).join(" and ");
  // A card-less row's title (the listing's words, or "Unmatched sale") says
  // nothing of its order, so its name always carries it: two orders' strays
  // never read alike. One the listing describes also says it is not in NB.
  // The title's " · " joins read as pauses here, never as "dot".
  let name = c
    ? `#${c.cardNumber} ${playerNames(c)}, ${setLabel(c.set)}${variantName(c) ? ` ${variantName(c)}` : ""}, ${extra}`
    : `${row.listingTitle.split(" · ").join(", ")}${row.listed ? `, ${NOT_IN_NB_NAME}` : ""}, ${orders}`;
  if (options.withSlot && row.spot?.slot !== undefined) name += `, slot ${row.spot.slot}`;
  if (row.isNew) name += `, ${COPY.fresh.toLowerCase()}`;
  if (options.withOrder && c) name += `, ${orders}`;
  return name;
}

function PickTable({
  caption,
  sections,
  pulled,
  mark,
  sort = null,
  dir = "asc",
  onSort,
  showSlot = false,
  hideSport = false,
  nameWithOrder = false,
}: {
  caption: string;
  sections: PickSection[];
  pulled: ReadonlySet<string>;
  mark: Mark;
  sort?: SortKey | null;
  dir?: SortDir;
  onSort?: (key: SortKey) => void;
  showSlot?: boolean;
  /** Leave the sport off rows outside a set divider (the box heading says it). */
  hideSport?: boolean;
  nameWithOrder?: boolean;
}) {
  const tableRef = useRef<HTMLTableElement>(null);
  // A stray's order opens on the Sales tab, where the store has one.
  const salesLink = useListing() !== undefined;
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [thumb, setThumb] = useState<PickRow | null>(null);
  const printing = usePrinting();
  const keys = sections.flatMap((s) => s.rows.map((r) => `${s.key}/${r.key}`));
  const active = activeKey && keys.includes(activeKey) ? activeKey : keys[0];

  const toggle = (row: PickRow) => {
    const on = !isPulled(row, pulled);
    const name = row.card ? `#${row.card.cardNumber} ${playerNames(row.card)}` : row.listingTitle;
    mark(lineIds([row]), on, on ? `Pulled ${name}.` : `${name} is back on the list.`);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const toggles = [...(tableRef.current?.querySelectorAll<HTMLButtonElement>("button[data-pick-toggle]") ?? [])];
    const here = toggles.findIndex((b) => b.closest("tr")?.contains(e.target as Node));
    if (here < 0) return;
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? toggles.length - 1 : Math.max(0, Math.min(toggles.length - 1, here + (e.key === "ArrowDown" ? 1 : -1)));
    e.preventDefault();
    const target = toggles[next];
    if (!target) return;
    // Bring the whole row into view, clear of the sticky header and the Undo
    // toast (the page's scroll padding), then focus without a second jump.
    target.closest("tr")?.scrollIntoView?.({ block: "nearest" });
    target.focus({ preventScroll: true });
  };

  // The column headers stick just under the site header (its height is published as `--nb-header-h`, 0 on a phone).
  const headCell = "sticky top-[var(--nb-header-h,0px)] z-[5] border-b border-rule bg-surface px-2 py-2 text-left font-semibold";

  const sortButton = (key: SortKey) => {
    const on = sort === key;
    const Icon = on ? (dir === "asc" ? ArrowUpIcon : ArrowDownIcon) : ChevronUpDownIcon;
    return onSort ? (
      <button
        type="button"
        onClick={() => onSort(key)}
        className={`-mx-1 inline-flex min-h-8 items-center gap-1 rounded px-1 focus-outline ${on ? "text-ink" : "text-ink-2 hover:text-ink"}`}
      >
        {SORT_LABEL[key]}
        <Icon aria-hidden="true" className={`nb-pick-noprint size-4 ${on ? "" : "opacity-60"}`} />
      </button>
    ) : (
      SORT_LABEL[key]
    );
  };

  /** A column header that sorts; `also` is a second sort sharing the column (Serial beside Set). */
  const sortHead = (key: SortKey, className = "", also?: SortKey) => {
    const which = sort === key ? key : also && sort === also ? also : null;
    return (
      <th
        scope="col"
        aria-sort={which ? (dir === "asc" ? "ascending" : "descending") : "none"}
        className={`${headCell} max-md:hidden ${className}`}
      >
        {also ? (
          <span className="inline-flex items-center gap-2">
            {sortButton(key)}
            <span aria-hidden="true" className="text-ink-3">
              ·
            </span>
            {sortButton(also)}
          </span>
        ) : (
          sortButton(key)
        )}
      </th>
    );
  };

  // Qty shows only where a row in view sold two or more (or the list sorts by it).
  const showQty = sort === "qty" || sections.some((s) => s.rows.some((r) => r.quantity > 1));
  // The Set column holds a reading width only where its cells name the set (or
  // a stray's problem): under a set divider they hold just the variant.
  const setInCells = sections.some((s) => s.kind !== "set" && s.rows.length > 0);
  const columns = 8 + (showQty ? 1 : 0) + (showSlot ? 1 : 0);

  return (
    <>
      {/* Not focusable itself: the rows' toggles are, and arrow keys move between them. */}
      <table ref={tableRef} onKeyDown={onKeyDown} className="nb-pick-table w-full border-separate border-spacing-0 text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-xs text-ink-2">
          <tr>
            <th scope="col" className={`${headCell} w-12 px-1`}>
              <span className="sr-only">Pulled</span>
            </th>
            <th scope="col" className={`${headCell} nb-pick-pic w-14 px-1`}>
              <span className="sr-only">Picture</span>
            </th>
            {showSlot && (
              <th scope="col" className={headCell}>
                Slot
              </th>
            )}
            {showQty && sortHead("qty", "w-14")}
            {sortHead("number", "w-16")}
            {sortHead("player")}
            {sortHead("set", setInCells ? "min-w-48" : "", "detail")}
            {sortHead("condition", "w-28")}
            {sortHead("order", "w-28")}
            <th scope="col" className={`${headCell} md:hidden`}>
              Card
            </th>
          </tr>
        </thead>
        {sections.map((section) => (
          <tbody key={section.key} className="nb-pick-group">
            <SectionHead section={section} columns={columns} />
            {section.rows.map((row) => {
              const key = `${section.key}/${row.key}`;
              const inSet = section.kind === "set";
              return (
                <Row
                  key={key}
                  row={row}
                  pulled={isPulled(row, pulled)}
                  tabbable={key === active}
                  onFocus={() => setActiveKey(key)}
                  onToggle={() => toggle(row)}
                  onThumb={() => setThumb(row)}
                  showSlot={showSlot}
                  showQty={showQty}
                  salesLink={salesLink}
                  showSet={!inSet}
                  showSport={!hideSport && !inSet && section.kind !== "cantFind"}
                  name={rowName(row, { withOrder: nameWithOrder, withSlot: showSlot })}
                />
              );
            })}
          </tbody>
        ))}
      </table>
      {printing && <PrintSheet sections={sections} pulled={pulled} showSlot={showSlot} />}
      {thumb?.card && (
        <P3Dialog
          shape="center"
          title={`#${thumb.card.cardNumber} ${playerNames(thumb.card)}`}
          subtitle={`${setLabel(thumb.card.set)}${variantName(thumb.card) ? ` ${variantName(thumb.card)}` : ""}`}
          onClose={() => setThumb(null)}
        >
          <div className="flex flex-col items-center gap-3 pb-2">
            {thumb.photo ? (
              <img
                src={thumb.photo.imageUrl}
                alt={`The copy that sold: ${rowName(thumb)}`}
                className="max-h-[60vh] w-auto max-w-full rounded-md"
              />
            ) : (
              <CardFace model={thumb.card} size="lg" serial={thumb.serial} />
            )}
            <p className="text-sm text-ink-2">
              {thumb.grade ? `${thumb.grade.grader} ${thumb.grade.grade}, cert ${thumb.grade.cert}` : thumb.condition}
              {thumb.serial ? `, numbered ${thumb.serial}` : ""}
            </p>
          </div>
        </P3Dialog>
      )}
    </>
  );
}

function SectionHead({ section, columns }: { section: PickSection; columns: number }) {
  if (section.kind === "flat") return null;
  const count = section.rows.reduce((n, r) => n + r.quantity, 0);
  const cards = `${count} ${count === 1 ? "card" : "cards"}`;
  // A heading element may not sit in a table header cell, so the title takes
  // the heading role: heading navigation still reaches every set and group.
  // `label` names a heading apart when its words alone would read like another's.
  const heading = (className: string, text: ReactNode, label?: string) => (
    <span role="heading" aria-level={3} aria-label={label} className={className}>
      {text}
    </span>
  );
  let body: ReactNode;
  let line = "border-rule-strong";
  if (section.kind === "set") {
    const hue = sportHue(section.sportCode);
    line = SPORT_LINE[hue];
    body = (
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
        <span className={`nb-pick-band inline-flex items-center rounded-t-md px-3 py-1 text-xs font-bold ${SPORT_TAB[hue]}`}>
          {section.sportName}
        </span>
        {heading("pb-1 text-base font-bold text-ink", section.title, section.unmatchedTwin ? `${section.title}${COPY.unmatchedTwin}` : undefined)}
        <span className="pb-1 text-xs text-ink-3">{cards}</span>
      </div>
    );
  } else if (section.kind === "order") {
    body = (
      <div className="flex items-end gap-3 pb-1">
        {heading("text-base font-bold text-ink", orderLabel(section.order))}
        <span className="text-xs text-ink-3">{cards}</span>
      </div>
    );
  } else {
    const warn = section.kind === "cantFind";
    // The heading's words and its rule share one hue in both themes.
    line = warn ? "border-notice-warn-ink" : "border-neon-blue";
    body = (
      <div className="pb-1">
        {heading(`text-base font-bold ${warn ? "text-notice-warn-ink" : "text-neon-blue-text"}`, warn ? COPY.cantFind : COPY.fresh)}
        <span className="ml-3 text-xs text-ink-3">{warn ? COPY.cantFindNote : COPY.freshNote}</span>
      </div>
    );
  }
  return (
    <tr>
      <th scope="rowgroup" colSpan={columns} className={`border-b-[3px] px-0 pt-6 text-left font-normal ${line}`}>
        {body}
      </th>
    </tr>
  );
}

function VariantChip({ role }: { role: VariantRole }) {
  return (
    <span className={`nb-pick-band nb-pick-chip inline-flex shrink-0 items-center rounded border px-1.5 text-xs font-semibold leading-5 ${VARIANT_CHIP[role]}`}>
      {VARIANT_ROLE_LABEL[role]}
    </span>
  );
}

/** A listing's own variant word NB does not file by: plain, no divider colour, since NB never guesses its role. */
function VariantWordChip({ word }: { word: string }) {
  return (
    <span className="nb-pick-chip inline-flex shrink-0 items-center rounded border border-rule-strong px-1.5 text-xs font-semibold leading-5 text-ink">
      {word}
    </span>
  );
}

function SportChip({ code, name }: { code: string | null; name: string }) {
  const hue = sportHue(code);
  return (
    <span className={`nb-pick-band nb-pick-chip inline-flex shrink-0 items-center rounded px-1.5 text-xs font-bold leading-5 ${SPORT_TAB[hue]}`}>
      {name}
    </span>
  );
}

function Markers({ row, salesLink }: { row: PickRow; salesLink: boolean }) {
  const noBox = row.boxUnrecorded && !row.spot;
  // A sale filed with its set by the listing's words alone: NB has no card
  // for it, and the chip says so (the dashed edge echoes the "?" picture).
  // Can't find it never shows it: its heading already says as much.
  const notInNb = !row.card && rowFacts(row) !== null;
  if (!row.lastOnes && !row.short && !row.isNew && !noBox && !notInNb) return null;
  const why = salesLink ? COPY.notInNbWhyLinked : COPY.notInNbWhy;
  return (
    <span className="flex flex-wrap gap-1 whitespace-nowrap">
      {notInNb && (
        <span
          title={why}
          className="nb-pick-chip rounded border border-dashed border-notice-warn-rule bg-notice-warn-bg px-1.5 text-xs font-semibold leading-5 text-notice-warn-ink"
        >
          <span>{NOT_IN_NB}</span>
          <span className="sr-only">. {why}</span>
        </span>
      )}
      {row.isNew && <span className="nb-pick-chip rounded bg-neon-blue px-1.5 text-xs font-bold leading-5 text-on-neon-blue">New</span>}
      {row.lastOnes && (
        <span className="nb-pick-chip rounded border border-notice-info-rule bg-notice-info-bg px-1.5 text-xs font-semibold leading-5 text-notice-info-ink">
          Last ones
        </span>
      )}
      {noBox && (
        <span className="nb-pick-chip rounded border border-rule-strong px-1.5 text-xs font-semibold leading-5 text-ink-2">
          {COPY.noBox}
        </span>
      )}
      {row.short > 0 && (
        <span className="nb-pick-chip rounded border border-notice-warn-rule bg-notice-warn-bg px-1.5 text-xs font-semibold leading-5 text-notice-warn-ink">
          Short {row.short}
        </span>
      )}
    </span>
  );
}

function Row({
  row,
  pulled,
  tabbable,
  onFocus,
  onToggle,
  onThumb,
  showSlot,
  showQty,
  salesLink,
  showSet,
  showSport,
  name,
}: {
  row: PickRow;
  pulled: boolean;
  tabbable: boolean;
  onFocus: () => void;
  onToggle: () => void;
  onThumb: () => void;
  showSlot: boolean;
  showQty: boolean;
  /** A card-less row's order links to that sale on the Sales tab. */
  salesLink: boolean;
  /** Off under a set divider, which already names the set. */
  showSet: boolean;
  showSport: boolean;
  name: string;
}) {
  const c = row.card;
  // A card's facts, or a listing's when it says enough to file by (NEO-509).
  const facts = rowFacts(row);
  const role = facts?.role ?? null;
  const vWord = facts?.variantWord ?? null;
  const vName = facts?.variantName ?? null;
  const tab = tabbable ? 0 : -1;
  const cell = "border-b border-rule px-2 py-2 align-middle";

  const onRowClick = (e: MouseEvent<HTMLTableRowElement>) => {
    if ((e.target as Element).closest("button, a, input, select")) return;
    if (!rowClickPulls()) return;
    onToggle();
  };

  // One copy needs no count; two or more get the loud yellow chip.
  const qty =
    row.quantity > 1 ? (
      <span className="nb-pick-chip inline-flex min-w-8 items-center justify-center rounded-md bg-neon-yellow px-1.5 text-base font-black leading-7 text-on-neon-yellow tabular-nums">
        ×{row.quantity}
        <span className="sr-only"> copies</span>
      </span>
    ) : null;

  // The variant leads: its chip, its name, and a numbered copy's serial beside
  // it. A listing's own word NB does not file by ("Variation") gets a plain
  // chip of its own: it is what keeps the seller off the base copy.
  const variantLine = facts ? (
    <span className="flex flex-wrap items-center gap-1.5 empty:hidden">
      {role && <VariantChip role={role} />}
      {vWord && <VariantWordChip word={vWord} />}
      {(vName || row.serial) && (
        <span className="text-ink-2">
          {vName}
          {vName && row.serial && " · "}
          {row.serial && <span className="font-semibold tabular-nums text-ink">{row.serial}</span>}
        </span>
      )}
    </span>
  ) : null;

  // A sale NB has no card for keeps its next step (check the order's photo) under the variant.
  const problem = !c && row.problem ? <span className="text-xs text-notice-warn-ink">{row.problem}</span> : null;
  const setText = facts ? (
    <span className="flex min-w-0 flex-col gap-1">
      {showSet && (
        <span className="flex flex-wrap items-center gap-1.5">
          {showSport && <SportChip code={facts.sportCode} name={facts.sportName} />}
          <span className="text-ink">{facts.setTitle}</span>
        </span>
      )}
      {variantLine}
      {problem}
    </span>
  ) : (
    <span className="flex min-w-0 flex-col items-start gap-1">
      {/* The listing's sport, when it names one: the box it might sit in. */}
      {row.listed?.sportName && <SportChip code={row.listed.sportCode ?? null} name={row.listed.sportName} />}
      <span className="text-notice-warn-ink">{row.problem}</span>
    </span>
  );

  // Condition, or a slab's grade and cert.
  const condition = (
    <span className="flex flex-col">
      {row.grade ? (
        <>
          <span className="font-semibold text-ink">
            {row.grade.grader} {row.grade.grade}
          </span>
          <span className="text-xs text-ink-3 tabular-nums">Cert {row.grade.cert}</span>
        </>
      ) : (
        <span className="text-ink-2">{row.condition}</span>
      )}
    </span>
  );

  // Venue and number may wrap apart, never inside either. A stray's order
  // opens that sale on the Sales tab: the order's photo is how to find it.
  const orderText = (o: PickOrder) => (
    <>
      <span className="whitespace-nowrap">{o.venue}</span> <span className="whitespace-nowrap">{o.number}</span>
    </>
  );
  const orders = (
    <span className="flex flex-col">
      {row.orders.map((o) =>
        !c && salesLink ? (
          <ParamLink
            key={o.id}
            search={{ tab: "sales", [SALE_PARAM]: o.id }}
            tabIndex={tab}
            className="rounded-sm text-neon-blue-text underline underline-offset-2 tabular-nums focus-outline"
          >
            {orderText(o)}
            <span className="sr-only"> on your Sales tab</span>
          </ParamLink>
        ) : (
          <span key={o.id} className="text-ink-2 tabular-nums">
            {orderText(o)}
          </span>
        ),
      )}
    </span>
  );

  const who = c ? playerNames(c) : facts?.players || row.listingTitle;
  const team = c?.teams.map((t) => t.name).join(" / ");

  return (
    <tr
      onClick={onRowClick}
      onFocus={onFocus}
      data-pulled={pulled || undefined}
      className={`nb-pick-row transition-colors md:cursor-pointer md:hover:bg-list-hover ${pulled ? "nb-pick-pulled" : ""}`}
    >
      <td className={`${cell} relative w-12 pl-3`}>
        {role ? (
          <span aria-hidden="true" className={`nb-pick-band absolute inset-y-1 left-0 w-2 rounded-sm border md:w-1.5 ${VARIANT_STRIPE[role]}`} />
        ) : (
          <span aria-hidden="true" className="absolute inset-y-1 left-0 w-2 rounded-sm border border-dashed border-notice-warn-rule md:w-1.5" />
        )}
        <button
          type="button"
          data-pick-toggle
          aria-pressed={pulled}
          aria-label={`Pulled ${name}`}
          tabIndex={tab}
          onClick={onToggle}
          className={`grid size-11 place-items-center rounded-md border-2 focus-outline ${
            pulled ? "border-neon-green bg-neon-green text-on-neon-green" : "border-control text-transparent hover:border-ink-3"
          }`}
        >
          <CheckIcon aria-hidden="true" className="size-6" />
        </button>
      </td>
      <td className={`${cell} nb-pick-pic w-14 px-1`}>
        {c ? (
          <button
            type="button"
            tabIndex={tab}
            onClick={(e) => {
              // Safari does not focus a clicked button; the dialog hands focus back to it on close.
              e.currentTarget.focus();
              onThumb();
            }}
            aria-label={`Bigger picture of ${name}`}
            className="nb-pick-thumb block w-10 rounded-sm focus-outline"
          >
            {row.photo ? (
              <img src={row.photo.thumbUrl} alt="" loading="lazy" className="block aspect-[5/7] w-10 rounded-sm bg-rule object-contain" />
            ) : (
              <CardFace model={c} size="fill" serial={row.serial} />
            )}
          </button>
        ) : (
          <span
            aria-hidden="true"
            className="grid h-14 w-10 place-items-center rounded-sm border border-dashed border-notice-warn-rule text-lg font-bold text-notice-warn-ink"
          >
            ?
          </span>
        )}
      </td>
      {showSlot && <td className={`${cell} font-semibold tabular-nums text-ink`}>{row.spot?.slot ?? "–"}</td>}
      {showQty && <td className={`${cell} max-md:hidden`}>{qty}</td>}
      {facts && <td className={`${cell} whitespace-nowrap font-bold text-ink tabular-nums max-md:hidden`}>#{facts.cardNumber}</td>}
      {/* Nothing to file by: the listing's own words take the number's column too. */}
      <td colSpan={facts ? undefined : 2} className={`${cell} max-md:hidden`}>
        <span className="flex flex-col">
          <span className={facts ? "whitespace-nowrap font-semibold text-ink" : "text-ink"}>{who}</span>
          {team && <span className="text-xs text-ink-3">{team}</span>}
          <span className="mt-1 empty:hidden">
            <Markers row={row} salesLink={salesLink} />
          </span>
        </span>
      </td>
      <td className={`${cell} max-md:hidden`}>{setText}</td>
      <td className={`${cell} max-md:hidden`}>{condition}</td>
      <td className={`${cell} max-md:hidden`}>{orders}</td>
      {/* A phone has no room for columns: one cell says it all. */}
      <td className={`${cell} md:hidden`}>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            {qty}
            {facts && <span className="font-bold text-ink tabular-nums">#{facts.cardNumber}</span>}
            <span className="font-semibold text-ink">{who}</span>
          </span>
          {setText}
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {condition}
            {orders}
          </span>
          <Markers row={row} salesLink={salesLink} />
        </span>
      </td>
    </tr>
  );
}

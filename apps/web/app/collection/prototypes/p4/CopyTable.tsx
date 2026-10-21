import { useId, useState, type MouseEvent, type ReactNode } from "react";
import {
  ArrowUturnLeftIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ChevronUpDownIcon,
  PencilSquareIcon,
  TagIcon,
} from "@heroicons/react/24/outline";
import { Input } from "@/components/primitives/Input";
import { LiveLine } from "@/components/modules/RunLedger";
import CopyDetailsForm from "../_shared/CopyDetailsForm";
import {
  cardLabel,
  compareCards,
  evaluateRule,
  getCard,
  getSet,
  leadTeam,
  playerNames,
  printRunLabel,
  setLabel,
  sports,
  teamNames,
  teamTextColor,
  variantLabel,
  type Binder,
  type Card,
  type Condition,
  type Copy,
  type CopyDetails,
  type CopyId,
  type SportId,
} from "../_shared/data";
import type { PrototypeStore } from "../_shared/usePrototypeStore";
import Dialog from "./Dialog";
import {
  GO_BTN,
  ICON_BTN,
  PANEL,
  QUIET_BTN,
  RING,
  SELECT,
  STOP_BTN,
  cardsWord,
  chipClass,
  money,
} from "./ui";

/**
 * NEO-350 prototype 4 — the two piles as dense, sortable tables.
 *
 * "My Cards" is the PC; "For Sale" is stock. They are separate lists of the
 * same copies, split on `forSale`, and a copy crosses only by an explicit
 * action ("Move to For Sale" / "Back to my PC"), one row or a selection.
 *
 * Select with the checkbox column (Shift+click selects a run), then act on
 * the lot: file it in a binder, set its location, spread what the lot cost
 * across it, price it, move it, or remove it. Every bulk action has Undo.
 * Below `md` the table becomes two-line cards with the same checkboxes.
 */

export type Pile = "pc" | "sale";

type ColKey =
  | "set"
  | "number"
  | "player"
  | "team"
  | "variant"
  | "serial"
  | "qty"
  | "grade"
  | "location"
  | "binders"
  | "cost"
  | "ask";

const COLUMNS: Record<Pile, { key: ColKey; label: string; numeric?: boolean }[]> = {
  pc: [
    { key: "set", label: "Set" },
    { key: "number", label: "#" },
    { key: "player", label: "Player" },
    { key: "team", label: "Team" },
    { key: "variant", label: "Variant" },
    { key: "serial", label: "Serial" },
    { key: "qty", label: "Qty", numeric: true },
    { key: "grade", label: "Grade" },
    { key: "location", label: "Location" },
    { key: "binders", label: "Binders" },
    { key: "cost", label: "Cost", numeric: true },
  ],
  sale: [
    { key: "set", label: "Set" },
    { key: "number", label: "#" },
    { key: "player", label: "Player" },
    { key: "team", label: "Team" },
    { key: "variant", label: "Variant" },
    { key: "serial", label: "Serial" },
    { key: "qty", label: "Qty", numeric: true },
    { key: "grade", label: "Grade" },
    { key: "location", label: "Location" },
    { key: "cost", label: "Cost", numeric: true },
    { key: "ask", label: "Ask", numeric: true },
  ],
};

const CONDITION_RANK: Record<Condition, number> = {
  Mint: 6,
  "Near Mint": 5,
  Excellent: 4,
  "Very Good": 3,
  Good: 2,
  Poor: 1,
};
const CONDITION_SHORT: Record<Condition, string> = {
  Mint: "Mint",
  "Near Mint": "NM",
  Excellent: "EX",
  "Very Good": "VG",
  Good: "Good",
  Poor: "Poor",
};

function gradeScore(c: Copy): number {
  if (c.graded) {
    const n = Number(c.graded.grade);
    return 100 + (Number.isFinite(n) ? n : 0);
  }
  return c.condition ? CONDITION_RANK[c.condition] : 0;
}

function gradeText(c: Copy): string {
  if (c.graded) return `${c.graded.grader} ${c.graded.grade}`.trim();
  return c.condition ? CONDITION_SHORT[c.condition] : "Raw";
}

interface Row {
  copy: Copy;
  card: Card;
  manualBinders: string[];
  smartBinders: string[];
}

function compareRows(key: ColKey, a: Row, b: Row): number {
  const tie = compareCards(a.card, b.card);
  const text = (x: string | undefined, y: string | undefined) =>
    x === y ? 0 : x === undefined || x === "" ? 1 : y === undefined || y === "" ? -1 : x.localeCompare(y);
  const num = (x: number | undefined, y: number | undefined) =>
    x === y ? 0 : x === undefined ? 1 : y === undefined ? -1 : x - y;
  switch (key) {
    case "set":
      return tie;
    case "number":
      return (
        a.card.cardNumber.localeCompare(b.card.cardNumber, undefined, { numeric: true }) || tie
      );
    case "player":
      return playerNames(a.card).localeCompare(playerNames(b.card)) || tie;
    case "team":
      return teamNames(a.card).localeCompare(teamNames(b.card)) || tie;
    case "variant":
      return variantLabel(a.card.variantPath).localeCompare(variantLabel(b.card.variantPath)) || tie;
    case "serial":
      return text(a.copy.serialNumber, b.copy.serialNumber) || tie;
    case "qty":
      return a.copy.quantity - b.copy.quantity || tie;
    case "grade":
      return gradeScore(a.copy) - gradeScore(b.copy) || tie;
    case "location":
      return text(a.copy.location, b.copy.location) || tie;
    case "binders":
      return (
        a.manualBinders.length + a.smartBinders.length - (b.manualBinders.length + b.smartBinders.length) ||
        tie
      );
    case "cost":
      return num(a.copy.costBasis, b.copy.costBasis) || tie;
    case "ask":
      return num(a.copy.askPrice, b.copy.askPrice) || tie;
  }
}

type Flag = "graded" | "numbered" | "rookies" | "hits";
const FLAGS: { key: Flag; label: string; test: (r: Row) => boolean }[] = [
  { key: "graded", label: "Slabs", test: (r) => r.copy.graded !== undefined },
  { key: "numbered", label: "Numbered", test: (r) => r.card.printRun !== null },
  { key: "rookies", label: "Rookies", test: (r) => r.card.features.includes("RC") },
  {
    key: "hits",
    label: "Autos & relics",
    test: (r) => r.card.features.includes("AU") || r.card.features.includes("Relic"),
  },
];

type Panel = "binder" | "location" | "lot" | "ask" | null;

interface Toast {
  text: string;
  undo?: () => void;
}

/** CopyDetails without the copy's identity, for snapshot-and-restore Undo. */
function detailsOf(c: Copy): CopyDetails {
  const { id: _id, cardId: _cardId, ...rest } = c;
  void _id;
  void _cardId;
  return {
    // Explicit keys so restoring a field that was blank blanks it again.
    condition: undefined,
    graded: undefined,
    serialNumber: undefined,
    costBasis: undefined,
    location: undefined,
    askPrice: undefined,
    ...rest,
  };
}

export default function CopyTable({ store, pile }: { store: PrototypeStore; pile: Pile }) {
  const headingId = useId();
  const [text, setText] = useState("");
  const [sportsOn, setSportsOn] = useState<SportId[]>([]);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [location, setLocation] = useState("");
  const [sort, setSort] = useState<{ key: ColKey; dir: "asc" | "desc" }>({ key: "set", dir: "asc" });
  const [selected, setSelected] = useState<CopyId[]>([]);
  const [anchor, setAnchor] = useState<CopyId | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [live, setLive] = useState("");
  const [editing, setEditing] = useState<{ copy: Copy; value: CopyDetails } | null>(null);

  const binders = store.state.binders;
  const smart = binders.filter((b) => b.kind === "smart");
  const binderName = new Map(binders.map((b) => [b.id, b.name]));

  const pileCopies = store.state.copies.filter((c) => (pile === "sale" ? c.forSale : !c.forSale));
  const allRows: Row[] = pileCopies.map((copy) => {
    const card = getCard(copy.cardId);
    return {
      copy,
      card,
      manualBinders: copy.binderIds.map((id) => binderName.get(id)).filter(Boolean) as string[],
      smartBinders: smart.filter((b) => b.kind === "smart" && evaluateRule(b.rule, card)).map((b) => b.name),
    };
  });
  const locations = [...new Set(allRows.map((r) => r.copy.location).filter(Boolean) as string[])].sort();

  const needle = text.trim().toLowerCase();
  const rows = allRows
    .filter((r) => {
      if (sportsOn.length && !sportsOn.includes(getSet(r.card.setId).sportId)) return false;
      if (location && r.copy.location !== location) return false;
      for (const f of FLAGS) if (flags.includes(f.key) && !f.test(r)) return false;
      if (needle) {
        const hay = `${cardLabel(r.card)} ${r.copy.location ?? ""} ${r.copy.notes} ${gradeText(r.copy)} ${r.copy.serialNumber ?? ""}`.toLowerCase();
        if (!needle.split(/\s+/).every((t) => hay.includes(t.replace(/^#/, "")))) return false;
      }
      return true;
    })
    .sort((a, b) => (sort.dir === "asc" ? 1 : -1) * compareRows(sort.key, a, b));

  const liveIds = new Set(pileCopies.map((c) => c.id));
  const sel = selected.filter((id) => liveIds.has(id));
  const selSet = new Set(sel);
  const selCopies = pileCopies.filter((c) => selSet.has(c.id));
  const selCards = selCopies.reduce((n, c) => n + c.quantity, 0);
  const visibleSelected = rows.filter((r) => selSet.has(r.copy.id)).length;

  const totalCards = rows.reduce((n, r) => n + r.copy.quantity, 0);
  const totalCost = rows.reduce((n, r) => n + (r.copy.costBasis ?? 0), 0);
  const totalAsk = rows.reduce((n, r) => n + (r.copy.askPrice ?? 0) * r.copy.quantity, 0);
  const filtering = Boolean(needle || sportsOn.length || flags.length || location);

  function say(t: Toast) {
    setToast(t);
    setLive(t.text);
  }

  function toggleRow(id: CopyId, e: MouseEvent) {
    if (e.shiftKey && anchor) {
      const ids = rows.map((r) => r.copy.id);
      const a = ids.indexOf(anchor);
      const b = ids.indexOf(id);
      if (a !== -1 && b !== -1) {
        const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
        const turnOn = selSet.has(anchor);
        setSelected((prev) => {
          const next = new Set(prev.filter((x) => liveIds.has(x)));
          for (const r of range) {
            if (turnOn) next.add(r);
            else next.delete(r);
          }
          return [...next];
        });
        return;
      }
    }
    setAnchor(id);
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleAllVisible() {
    const ids = rows.map((r) => r.copy.id);
    const all = ids.length > 0 && ids.every((id) => selSet.has(id));
    setSelected((prev) =>
      all ? prev.filter((id) => !ids.includes(id)) : [...new Set([...prev, ...ids])],
    );
  }

  /** Apply a patch to each copy, with an Undo that puts every one back. */
  function bulkUpdate(copies: Copy[], patchFor: (c: Copy) => Partial<CopyDetails>, done: string) {
    const before = copies.map((c) => [c.id, detailsOf(c)] as const);
    for (const c of copies) store.updateCopy(c.id, patchFor(c));
    setPanel(null);
    say({
      text: done,
      undo: () => {
        for (const [id, d] of before) store.updateCopy(id, d);
        say({ text: "Undone. Back the way it was." });
      },
    });
  }

  function moveToOtherPile(copies: Copy[]) {
    const toSale = pile === "pc";
    bulkUpdate(
      copies,
      () => (toSale ? { forSale: true } : { forSale: false, askPrice: undefined }),
      toSale
        ? `Moved ${cardsWord(copies.reduce((n, c) => n + c.quantity, 0))} to For Sale.`
        : `Moved ${cardsWord(copies.reduce((n, c) => n + c.quantity, 0))} back to your PC.`,
    );
    setSelected((prev) => prev.filter((id) => !copies.some((c) => c.id === id)));
  }

  function removeCopies(copies: Copy[]) {
    const removed = copies.map((c) => store.removeCopy(c.id)).filter(Boolean) as Copy[];
    setSelected([]);
    setPanel(null);
    say({
      text: `Removed ${cardsWord(removed.reduce((n, c) => n + c.quantity, 0))} from your collection.`,
      undo: () => {
        for (const c of removed) store.restoreCopy(c);
        say({ text: "Put back." });
      },
    });
  }

  const columns = COLUMNS[pile];
  const sortLabel = columns.find((c) => c.key === sort.key)?.label ?? "Set";

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-xl font-bold text-white">
          {pile === "pc" ? "My Cards" : "For Sale"}
        </h2>
        <p className="text-sm text-slate-300">
          <span className="font-semibold tabular-nums text-white">{cardsWord(totalCards)}</span>
          {filtering ? " match" : ""}
          {totalCost > 0 ? `, ${money(totalCost)} cost` : ""}
          {pile === "sale" && totalAsk > 0 ? `, asking ${money(totalAsk)}` : ""}
        </p>
      </div>
      {pile === "sale" && (
        <p className="text-sm text-slate-400">
          Your stock, kept apart from the PC. Set an ask on each card, or price a lot at once.
        </p>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-full sm:w-64">
          <Input
            label={pile === "pc" ? "Filter my cards" : "Filter for-sale cards"}
            placeholder="Player, set, team, #, box…"
            inputSize="small"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-300">Location</span>
          <select className={SELECT} value={location} onChange={(e) => setLocation(e.target.value)}>
            <option value="">Anywhere</option>
            {locations.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick filters">
        {sports.map((s) => {
          const on = sportsOn.includes(s.id);
          return (
            <button
              key={s.id}
              type="button"
              aria-pressed={on}
              onClick={() =>
                setSportsOn((prev) => (on ? prev.filter((x) => x !== s.id) : [...prev, s.id]))
              }
              className={chipClass(on)}
            >
              {on && <span aria-hidden="true">✓</span>}
              {s.name}
            </button>
          );
        })}
        {FLAGS.map((f) => {
          const on = flags.includes(f.key);
          return (
            <button
              key={f.key}
              type="button"
              aria-pressed={on}
              onClick={() => setFlags((prev) => (on ? prev.filter((x) => x !== f.key) : [...prev, f.key]))}
              className={chipClass(on)}
            >
              {on && <span aria-hidden="true">✓</span>}
              {f.label}
            </button>
          );
        })}
        {filtering && (
          <button
            type="button"
            onClick={() => {
              setText("");
              setSportsOn([]);
              setFlags([]);
              setLocation("");
            }}
            className={`rounded-sm px-2 text-xs text-slate-300 underline underline-offset-2 hover:text-white min-h-11 sm:min-h-7 ${RING}`}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Toast: what just happened, with Undo beside it. */}
      {toast && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100">
          <span className="mr-auto">{toast.text}</span>
          {toast.undo && (
            <button type="button" onClick={toast.undo} className={QUIET_BTN}>
              <ArrowUturnLeftIcon aria-hidden="true" className="h-4 w-4" />
              Undo
            </button>
          )}
          <button
            type="button"
            onClick={() => setToast(null)}
            className={`rounded-sm px-1 text-xs text-slate-400 hover:text-white ${RING}`}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Bulk actions */}
      {sel.length > 0 && (
        <BulkBar
          pile={pile}
          count={sel.length}
          cards={selCards}
          hiddenCount={sel.length - visibleSelected}
          panel={panel}
          setPanel={setPanel}
          binders={binders}
          onBinder={(binderId) =>
            bulkUpdate(
              selCopies,
              (c) => ({ binderIds: c.binderIds.includes(binderId) ? c.binderIds : [...c.binderIds, binderId] }),
              `Filed ${cardsWord(selCards)} in ${binderName.get(binderId)}.`,
            )
          }
          onLocation={(loc) =>
            bulkUpdate(selCopies, () => ({ location: loc || undefined }), `${cardsWord(selCards)} now in ${loc || "no set location"}.`)
          }
          onLot={(total) => {
            const shares = spreadCost(selCopies, total);
            bulkUpdate(
              selCopies,
              (c) => ({ costBasis: shares.get(c.id) }),
              `Spread ${money(total)} across ${cardsWord(selCards)} (${money(Math.round((total / selCards) * 100) / 100)} each).`,
            );
          }}
          onAsk={(each) =>
            bulkUpdate(selCopies, () => ({ askPrice: each }), `Asking ${money(each)} each on ${cardsWord(selCards)}.`)
          }
          onMove={() => moveToOtherPile(selCopies)}
          onRemove={() => removeCopies(selCopies)}
          onClear={() => {
            setSelected([]);
            setPanel(null);
          }}
        />
      )}

      {/* Phone: sort control (the column headers are hidden). */}
      <div className="flex items-center gap-2 md:hidden">
        <label className="flex items-center gap-2 text-sm text-slate-300">
          Sort by
          <select
            className={SELECT}
            value={`${sort.key}|${sort.dir}`}
            onChange={(e) => {
              const [key, dir] = e.target.value.split("|") as [ColKey, "asc" | "desc"];
              setSort({ key, dir });
            }}
          >
            {columns.flatMap((c) => [
              <option key={`${c.key}-a`} value={`${c.key}|asc`}>
                {c.label === "#" ? "Card number" : c.label}
                {c.numeric ? ", low to high" : ""}
              </option>,
              ...(c.numeric || c.key === "grade"
                ? [
                    <option key={`${c.key}-d`} value={`${c.key}|desc`}>
                      {c.label}, high to low
                    </option>,
                  ]
                : []),
            ])}
          </select>
        </label>
        <button type="button" onClick={toggleAllVisible} className={`${QUIET_BTN} ml-auto`}>
          {rows.length > 0 && rows.every((r) => selSet.has(r.copy.id)) ? "Select none" : "Select all"}
        </button>
      </div>

      {rows.length === 0 ? (
        <div className={`${PANEL} p-6 text-center`}>
          <p className="text-base font-semibold text-white">
            {filtering
              ? "No cards match those filters."
              : pile === "sale"
                ? "Nothing for sale yet."
                : "Your PC is empty. Head to the Counter and key your first card."}
          </p>
          <p className="mt-1 text-sm text-slate-400">
            {filtering
              ? "Clear a chip or two."
              : pile === "sale"
                ? "Pick cards in My Cards and choose Move to For Sale."
                : ""}
          </p>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className={`${PANEL} relative hidden overflow-x-auto md:block`}>
            <table className="w-full border-collapse text-left text-xs">
              <caption className="sr-only">
                {pile === "pc" ? "My Cards" : "For Sale"}, sorted by {sortLabel}{" "}
                {sort.dir === "asc" ? "ascending" : "descending"}
              </caption>
              <thead className="border-b border-slate-800 bg-slate-900 text-slate-300">
                <tr>
                  <th scope="col" className="w-8 px-2 py-1.5">
                    <input
                      type="checkbox"
                      aria-label={`Select all ${rows.length} shown`}
                      className={`h-4 w-4 accent-[#00C2FF] ${RING}`}
                      checked={rows.length > 0 && rows.every((r) => selSet.has(r.copy.id))}
                      ref={(el) => {
                        if (el) el.indeterminate = visibleSelected > 0 && visibleSelected < rows.length;
                      }}
                      onChange={toggleAllVisible}
                    />
                  </th>
                  {columns.map((c) => {
                    const on = sort.key === c.key;
                    const Icon = on ? (sort.dir === "asc" ? ChevronUpIcon : ChevronDownIcon) : ChevronUpDownIcon;
                    return (
                      <th
                        key={c.key}
                        scope="col"
                        aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                        className={`px-0.5 py-1 font-semibold ${c.numeric ? "text-right" : ""}`}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setSort((prev) =>
                              prev.key === c.key
                                ? { key: c.key, dir: prev.dir === "asc" ? "desc" : "asc" }
                                : { key: c.key, dir: c.numeric || c.key === "grade" ? "desc" : "asc" },
                            )
                          }
                          aria-label={c.label === "#" ? "Card number" : undefined}
                          className={`inline-flex min-h-6 items-center gap-0.5 rounded px-1 hover:text-white ${
                            on ? "text-neon-blue" : ""
                          } ${RING}`}
                        >
                          {c.label}
                          <Icon aria-hidden="true" className="h-3 w-3" />
                        </button>
                      </th>
                    );
                  })}
                  <th scope="col" className="px-2 py-1.5 text-right font-semibold">
                    <span className="sr-only">Row actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {rows.map((r) => (
                  <TableRow
                    key={r.copy.id}
                    row={r}
                    pile={pile}
                    columns={columns.map((c) => c.key)}
                    selected={selSet.has(r.copy.id)}
                    onToggle={(e) => toggleRow(r.copy.id, e)}
                    onEdit={() => setEditing({ copy: r.copy, value: detailsOf(r.copy) })}
                    onMove={() => moveToOtherPile([r.copy])}
                    onAsk={(ask) =>
                      bulkUpdate([r.copy], () => ({ askPrice: ask }), `Ask on #${r.card.cardNumber} ${playerNames(r.card)} is ${ask === undefined ? "cleared" : money(ask)}.`)
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Phone list */}
          <ul className="space-y-2 md:hidden">
            {rows.map((r) => (
              <PhoneRow
                key={r.copy.id}
                row={r}
                pile={pile}
                selected={selSet.has(r.copy.id)}
                onToggle={(e) => toggleRow(r.copy.id, e)}
                onEdit={() => setEditing({ copy: r.copy, value: detailsOf(r.copy) })}
                onMove={() => moveToOtherPile([r.copy])}
              />
            ))}
          </ul>
        </>
      )}

      <LiveLine text={live} />

      {editing && (
        <Dialog
          title={`#${getCard(editing.copy.cardId).cardNumber} ${playerNames(getCard(editing.copy.cardId))}`}
          description={cardLabel(getCard(editing.copy.cardId))}
          onClose={() => setEditing(null)}
        >
          <div className="p-3">
            <CopyDetailsForm
              card={getCard(editing.copy.cardId)}
              value={editing.value}
              onChange={(value) => setEditing({ copy: editing.copy, value })}
              onSave={(value) => {
                const moved = value.forSale !== editing.copy.forSale;
                const c = editing.copy;
                setEditing(null);
                bulkUpdate(
                  [c],
                  () => value,
                  moved
                    ? value.forSale
                      ? "Saved and moved to For Sale."
                      : "Saved and moved back to your PC."
                    : "Saved.",
                );
              }}
              onCancel={() => setEditing(null)}
              binders={binders}
              heading={null}
              saveLabel="Save changes"
            />
          </div>
        </Dialog>
      )}
    </section>
  );
}

/** Spread a lot's cost by quantity, to the cent, the remainder on the last copy. */
function spreadCost(copies: Copy[], total: number): Map<CopyId, number> {
  const cards = copies.reduce((n, c) => n + c.quantity, 0);
  const cents = Math.round(total * 100);
  const out = new Map<CopyId, number>();
  let given = 0;
  copies.forEach((c, i) => {
    const share =
      i === copies.length - 1 ? cents - given : Math.floor((cents * c.quantity) / cards);
    given += share;
    out.set(c.id, share / 100);
  });
  return out;
}

function TeamCell({ card }: { card: Card }) {
  return (
    <span style={{ color: teamTextColor(leadTeam(card), "#020617") }} className="font-medium">
      {teamNames(card)}
    </span>
  );
}

function BinderCell({ row }: { row: Row }) {
  const all = [...row.manualBinders, ...row.smartBinders];
  if (all.length === 0) return <span className="text-slate-400">—</span>;
  return (
    <span title={all.join(", ")} className="text-slate-200">
      {row.manualBinders.join(", ")}
      {row.smartBinders.length > 0 && (
        <span className="text-slate-400">
          {row.manualBinders.length ? ", " : ""}+{row.smartBinders.length} smart
        </span>
      )}
    </span>
  );
}

function TableRow({
  row,
  pile,
  columns,
  selected,
  onToggle,
  onEdit,
  onMove,
  onAsk,
}: {
  row: Row;
  pile: Pile;
  columns: ColKey[];
  selected: boolean;
  onToggle: (e: MouseEvent) => void;
  onEdit: () => void;
  onMove: () => void;
  onAsk: (ask: number | undefined) => void;
}) {
  const { copy, card } = row;
  const set = getSet(card.setId);
  const label = cardLabel(card);
  const run = printRunLabel(card);
  const cell: Record<ColKey, ReactNode> = {
    set: (
      <span className="block text-slate-200">
        {setLabel(set)}
      </span>
    ),
    number: <span className="tabular-nums text-slate-100">{card.cardNumber}</span>,
    player: (
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit details of ${label}`}
        title="Edit details"
        className={`rounded-sm text-left font-semibold text-white underline decoration-slate-600 underline-offset-2 hover:decoration-neon-blue ${RING}`}
      >
        {playerNames(card)}
        {card.features.includes("RC") && <span className="ml-1 text-[10px] font-bold text-slate-300">RC</span>}
      </button>
    ),
    team: <TeamCell card={card} />,
    variant: (
      <span className="block text-slate-200">
        {variantLabel(card.variantPath)}
        {card.variation ? `, ${card.variation}` : ""}
      </span>
    ),
    serial: <span className="whitespace-nowrap tabular-nums text-slate-200">{copy.serialNumber ?? run ?? ""}</span>,
    qty: <span className="tabular-nums text-slate-100">{copy.quantity}</span>,
    grade: (
      <span className={`whitespace-nowrap ${copy.graded ? "font-semibold text-white" : "text-slate-300"}`}>{gradeText(copy)}</span>
    ),
    location: <span className="text-slate-200">{copy.location ?? ""}</span>,
    binders: <BinderCell row={row} />,
    cost: <span className="whitespace-nowrap tabular-nums text-slate-200">{money(copy.costBasis)}</span>,
    ask: <AskCell copy={copy} label={label} onCommit={onAsk} />,
  };
  return (
    <tr className={selected ? "bg-neon-blue/10" : "hover:bg-slate-900/70"}>
      <td className="px-2 py-1 align-top">
        <input
          type="checkbox"
          aria-label={`Select ${label}`}
          className={`h-4 w-4 accent-[#00C2FF] ${RING}`}
          checked={selected}
          onChange={() => {}}
          onClick={onToggle}
        />
      </td>
      {columns.map((k) => (
        <td
          key={k}
          className={`px-1.5 py-1 align-top ${k === "qty" || k === "cost" || k === "ask" ? "text-right" : ""}`}
        >
          {cell[k]}
        </td>
      ))}
      <td className="px-1 py-0.5 align-top">
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onMove}
            aria-label={pile === "pc" ? `Move ${label} to For Sale` : `Move ${label} back to my PC`}
            title={pile === "pc" ? "Move to For Sale" : "Back to my PC"}
            className={ICON_BTN}
          >
            {pile === "pc" ? (
              <TagIcon aria-hidden="true" className="h-4 w-4" />
            ) : (
              <ArrowUturnLeftIcon aria-hidden="true" className="h-4 w-4" />
            )}
          </button>
        </div>
      </td>
    </tr>
  );
}

function AskCell({
  copy,
  label,
  onCommit,
}: {
  copy: Copy;
  label: string;
  onCommit: (ask: number | undefined) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (copy.askPrice === undefined ? "" : String(copy.askPrice));
  function commit() {
    if (draft === null) return;
    const n = draft.trim() === "" ? undefined : Number(draft);
    setDraft(null);
    if (n !== undefined && (!Number.isFinite(n) || n < 0)) return;
    if (n !== copy.askPrice) onCommit(n);
  }
  return (
    <span className="inline-flex items-center gap-0.5">
      <span aria-hidden="true" className="text-slate-400">$</span>
      <Input
        bare
        type="number"
        inputMode="decimal"
        min={0}
        step="0.01"
        aria-label={`Ask price for ${label}`}
        placeholder="—"
        value={shown}
        onFocus={() => setDraft(shown)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(null);
        }}
        className="w-16 px-1.5 py-0.5 text-right text-xs tabular-nums"
      />
    </span>
  );
}

function PhoneRow({
  row,
  pile,
  selected,
  onToggle,
  onEdit,
  onMove,
}: {
  row: Row;
  pile: Pile;
  selected: boolean;
  onToggle: (e: MouseEvent) => void;
  onEdit: () => void;
  onMove: () => void;
}) {
  const { copy, card } = row;
  const label = cardLabel(card);
  const run = printRunLabel(card);
  return (
    <li
      className={`flex items-start gap-2 rounded-lg border px-2 py-2 ${
        selected ? "border-neon-blue bg-neon-blue/10" : "border-slate-800 bg-slate-950"
      }`}
    >
      <label className="flex h-11 w-11 shrink-0 items-center justify-center">
        <input
          type="checkbox"
          aria-label={`Select ${label}`}
          className={`h-5 w-5 accent-[#00C2FF] ${RING}`}
          checked={selected}
          onChange={() => {}}
          onClick={onToggle}
        />
      </label>
      <div className="min-w-0 flex-1 py-1">
        <p className="truncate text-sm text-white">
          <span className="font-bold tabular-nums">#{card.cardNumber}</span>{" "}
          <span className="font-semibold">{playerNames(card)}</span> <TeamCell card={card} />
        </p>
        <p className="truncate text-xs text-slate-400">
          {setLabel(getSet(card.setId))}, {variantLabel(card.variantPath)}
          {copy.serialNumber ? ` ${copy.serialNumber}` : run ? ` ${run}` : ""}
          {", "}
          {gradeText(copy)}
          {copy.location ? `, ${copy.location}` : ""}
          {copy.quantity > 1 ? `, ×${copy.quantity}` : ""}
        </p>
        <p className="text-xs tabular-nums text-slate-300">
          {copy.costBasis !== undefined ? `Cost ${money(copy.costBasis)}` : "No cost"}
          {pile === "sale" ? `, ask ${copy.askPrice !== undefined ? money(copy.askPrice) : "not set"}` : ""}
        </p>
      </div>
      <div className="flex shrink-0 flex-col">
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit details of ${label}`}
          className={ICON_BTN}
        >
          <PencilSquareIcon aria-hidden="true" className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={onMove}
          aria-label={pile === "pc" ? `Move ${label} to For Sale` : `Move ${label} back to my PC`}
          className={ICON_BTN}
        >
          {pile === "pc" ? (
            <TagIcon aria-hidden="true" className="h-5 w-5" />
          ) : (
            <ArrowUturnLeftIcon aria-hidden="true" className="h-5 w-5" />
          )}
        </button>
      </div>
    </li>
  );
}

function BulkBar({
  pile,
  count,
  cards,
  hiddenCount,
  panel,
  setPanel,
  binders,
  onBinder,
  onLocation,
  onLot,
  onAsk,
  onMove,
  onRemove,
  onClear,
}: {
  pile: Pile;
  count: number;
  cards: number;
  hiddenCount: number;
  panel: Panel;
  setPanel: (p: Panel) => void;
  binders: Binder[];
  onBinder: (binderId: string) => void;
  onLocation: (loc: string) => void;
  onLot: (total: number) => void;
  onAsk: (each: number) => void;
  onMove: () => void;
  onRemove: () => void;
  onClear: () => void;
}) {
  const manual = binders.filter((b) => b.kind === "manual");
  const [binderId, setBinderId] = useState(manual[0]?.id ?? "");
  const [loc, setLoc] = useState("");
  const [lot, setLot] = useState("");
  const [ask, setAsk] = useState("");
  const lotN = Number(lot);
  const askN = Number(ask);
  const lotOk = lot.trim() !== "" && Number.isFinite(lotN) && lotN >= 0;
  const askOk = ask.trim() !== "" && Number.isFinite(askN) && askN >= 0;

  const toggle = (p: Exclude<Panel, null>) => setPanel(panel === p ? null : p);

  return (
    <div
      role="group"
      aria-label="Bulk actions"
      className="z-10 rounded-lg border border-neon-blue/60 bg-slate-950 p-2 shadow-lg md:sticky md:top-20"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="mr-1 text-sm font-semibold text-white">
          {count} selected
          <span className="font-normal text-slate-300">
            {" "}
            ({cardsWord(cards)}
            {hiddenCount > 0 ? `, ${hiddenCount} hidden by filters` : ""})
          </span>
        </p>
        <button type="button" aria-expanded={panel === "binder"} onClick={() => toggle("binder")} className={QUIET_BTN}>
          Move to binder
        </button>
        <button type="button" aria-expanded={panel === "location"} onClick={() => toggle("location")} className={QUIET_BTN}>
          Set location
        </button>
        <button type="button" aria-expanded={panel === "lot"} onClick={() => toggle("lot")} className={QUIET_BTN}>
          Spread lot cost
        </button>
        {pile === "sale" && (
          <button type="button" aria-expanded={panel === "ask"} onClick={() => toggle("ask")} className={QUIET_BTN}>
            Set ask price
          </button>
        )}
        <button type="button" onClick={onMove} className={QUIET_BTN}>
          {pile === "pc" ? (
            <>
              <TagIcon aria-hidden="true" className="h-4 w-4" />
              Move to For Sale
            </>
          ) : (
            <>
              <ArrowUturnLeftIcon aria-hidden="true" className="h-4 w-4" />
              Back to my PC
            </>
          )}
        </button>
        <button type="button" onClick={onRemove} className={STOP_BTN}>
          Remove
        </button>
        <button
          type="button"
          onClick={onClear}
          className={`ml-auto rounded-sm px-2 text-xs text-slate-300 underline underline-offset-2 hover:text-white min-h-11 sm:min-h-7 ${RING}`}
        >
          Clear selection
        </button>
      </div>

      {panel && (
        <form
          className="mt-2 flex flex-wrap items-end gap-2 border-t border-slate-800 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (panel === "binder" && binderId) onBinder(binderId);
            if (panel === "location") onLocation(loc.trim());
            if (panel === "lot" && lotOk) onLot(lotN);
            if (panel === "ask" && askOk) onAsk(askN);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setPanel(null);
          }}
        >
          {panel === "binder" &&
            (manual.length === 0 ? (
              <p className="text-sm text-slate-300">No manual binders yet. Make one on the Binders tab.</p>
            ) : (
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-300">Binder</span>
                <select
                  autoFocus
                  className={SELECT}
                  value={binderId}
                  onChange={(e) => setBinderId(e.target.value)}
                >
                  {manual.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          {panel === "location" && (
            <div className="w-48">
              <Input
                autoFocus
                label="Location"
                placeholder="Box 3"
                inputSize="small"
                value={loc}
                onChange={(e) => setLoc(e.target.value)}
              />
            </div>
          )}
          {panel === "lot" && (
            <>
              <div className="w-40">
                <Input
                  autoFocus
                  label="What the lot cost"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  placeholder="20.00"
                  inputSize="small"
                  value={lot}
                  onChange={(e) => setLot(e.target.value)}
                />
              </div>
              <p className="pb-2 text-sm text-slate-300">
                {lotOk && cards > 0
                  ? `${money(Math.round((lotN / cards) * 100) / 100)} a card across ${cardsWord(cards)}. Replaces their cost.`
                  : `Split evenly across ${cardsWord(cards)}.`}
              </p>
            </>
          )}
          {panel === "ask" && (
            <div className="w-36">
              <Input
                autoFocus
                label="Ask each"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                placeholder="5.00"
                inputSize="small"
                value={ask}
                onChange={(e) => setAsk(e.target.value)}
              />
            </div>
          )}
          {!(panel === "binder" && manual.length === 0) && (
            <button
              type="submit"
              disabled={(panel === "lot" && !lotOk) || (panel === "ask" && !askOk)}
              className={GO_BTN}
            >
              {panel === "binder"
                ? "File them"
                : panel === "location"
                  ? "Set location"
                  : panel === "lot"
                    ? "Spread cost"
                    : "Set ask"}
            </button>
          )}
        </form>
      )}
    </div>
  );
}

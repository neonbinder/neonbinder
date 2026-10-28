import { useEffect, useMemo, useRef, useState } from "react";
import NeonButton from "@/components/modules/NeonButton";
import Overlay from "../../prototypes/p1/Overlay";
import {
  homesOnSide,
  useCards,
  useCollectionActions,
  useContainers,
  useCopiesOfCards,
  useSide,
  writeErrorMessage,
} from "../data/store";
import type { Card, Condition, CopyDetails, Grader } from "../data/types";
import { usePageApi } from "../pageApi";
import LoosePile from "./loose";
import SetButton, { type SetPick } from "./SetButton";
import {
  STAGE_LABEL,
  bandOf,
  cardTitle,
  cardsForPicking,
  needsDrawer,
  useIntakeSim,
  type Details,
  type HadOf,
  type IntakeSim,
  type Item,
  type Stage,
} from "./sim";
import {
  AddSources,
  BandBadge,
  CardPicker,
  CommonPrice,
  DetailsFields,
  FIX_TOOLS,
  FixTools,
  HomeSelect,
  NeedsYou,
  PRICE_ATTR,
  PriceField,
  QTY_ATTR,
  QtyField,
  RING,
  ScanImage,
  StageCounters,
  effectiveDetails,
  initialSetup,
  type Setup,
} from "./ui";
import "./intake.css";

/**
 * NEO-369 — Add cards: the demo's intake, the "Mission Control" prototype
 * Jason picked (2026-10-27), as a tab on both sides of the demo (the
 * collection files into binders, the inventory into boxes). Saved cards land
 * in the demo store, so they show up in the binder or box straight away.
 *
 * One screen, the full width. The run's setup is a control bar that stays
 * editable the whole run; below it one lane per stage, and every card
 * travels left to right as the (scripted) pipeline works on it.
 *
 * Built for speed:
 * - The first card waiting for you always sits in the same place, its Yes
 *   first on its second line, so the pointer can rest on Yes and keep
 *   clicking as the next card slides up into the spot.
 * - Enter in a quantity saves that card and moves to the next quantity down
 *   the column.
 * - A selected card (green, in any lane) takes the CLI's keys: the fix tools
 *   (r R c C s x X u), y for yes, o to open it, j/k and h/l to move. In a
 *   quantity field only digits type; a letter is that card's shortcut.
 */

const LANES: { stages: Stage[]; label: string }[] = [
  { stages: ["uploading", "reading"], label: STAGE_LABEL.reading },
  { stages: ["pairing"], label: STAGE_LABEL.pairing },
  { stages: ["matching"], label: STAGE_LABEL.matching },
  { stages: ["review"], label: STAGE_LABEL.review },
  { stages: ["saved"], label: STAGE_LABEL.saved },
];
const REVIEW_LANE = 3;

/** A lane's tile, for focus and scrolling. */
const TILE_ATTR = "data-intake-tile";

const KEY_HELP: { keys: string; does: string }[] = [
  { keys: "j k ↓ ↑", does: "next, previous card" },
  { keys: "h l", does: "lane left, right" },
  { keys: "y", does: "yes, save it" },
  { keys: "o", does: "open it" },
  { keys: "p", does: "jump to its price" },
  ...FIX_TOOLS.map((t) => ({ keys: t.key, does: t.label.toLowerCase() })),
  { keys: "Enter", does: "in a quantity: save, next card" },
];

const today = () => new Date().toISOString().slice(0, 10);

/** The run's per-card details as the store's copy fields, for `quantity` new copies. */
function copyDetails(d: Details, quantity: number, homeId: string): CopyDetails {
  return {
    quantity,
    condition: d.condition as Condition,
    graded: d.grading ? { grader: d.grading.grader as Grader, grade: d.grading.grade, cert: d.grading.cert || undefined } : undefined,
    serialNumber: d.serial || undefined,
    costBasis: d.costCents === null ? undefined : d.costCents / 100,
    acquiredAt: today(),
    location: d.location || undefined,
    notes: d.notes,
    homeId,
  };
}

export default function AddCardsTab() {
  const side = useSide();
  const homes = homesOnSide(useContainers(), side);
  const actions = useCollectionActions();
  const { notify } = usePageApi();

  // Every card the pile can turn out to be: what the collector owns of each
  // (the "Had 3 →" counts) and the store's own card to file a copy of.
  const pileIds = useMemo(() => cardsForPicking().map((c) => c.id), []);
  const copies = useCopiesOfCards(pileIds);
  const storeCards = useCards(pileIds);
  const cardById = new Map<string, Card>();
  for (const c of storeCards ?? []) if (c) cardById.set(c.id, c);
  const hadOf: HadOf = (cardId, homeId) =>
    (copies?.[cardId] ?? []).filter((c) => c.homeId === homeId).reduce((n, c) => n + c.quantity, 0);

  const [setup, setSetup] = useState<Setup>(() => initialSetup(homes[0]?.id ?? ""));
  const homeId = homes.some((h) => h.id === setup.homeId) ? setup.homeId : (homes[0]?.id ?? "");
  const [setPick, setSetPick] = useState<SetPick | null | undefined>(undefined);
  const [panel, setPanel] = useState<null | "set" | "defaults">(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sim = useIntakeSim({ setChosen: setPick !== null, homeId, hadOf });

  // --- Saving: a card saves when you say yes, enter a quantity, or save the batch.
  const written = useRef(new Set<string>());
  const write = (list: Item[]) => {
    for (const item of list) {
      const card = item.match.cardId ? cardById.get(item.match.cardId) : undefined;
      const adding = item.qty - item.had;
      if (!card || adding < 1 || written.current.has(item.id)) continue;
      written.current.add(item.id);
      const details = copyDetails(effectiveDetails(item, setup.defaults), adding, item.homeId);
      actions.addLineItem(card, details).catch((error: unknown) => notify(writeErrorMessage(error)));
    }
  };
  const find = (id: string) => sim.items.find((i) => i.id === id);
  const intake: IntakeSim = {
    ...sim,
    actions: {
      ...sim.actions,
      confirm: (id) => {
        const item = find(id);
        sim.actions.confirm(id);
        if (item?.stage === "review" && item.match.cardId) write([item]);
      },
      setQty: (id, qty) => {
        const item = find(id);
        sim.actions.setQty(id, qty);
        if (item?.stage === "review" && item.match.cardId) write([{ ...item, qty: Math.max(0, qty) }]);
      },
      saveAllConfident: () => {
        const ready = sim.items.filter((i) => i.stage === "review" && bandOf(i) === "matched");
        sim.actions.saveAllConfident();
        write(ready);
      },
    },
  };

  // --- Lanes and selection.
  const lanes = LANES.map((lane) => sim.items.filter((i) => lane.stages.includes(i.stage)));
  const selected = selectedId ? (find(selectedId) ?? null) : null;
  const open = openId ? (find(openId) ?? null) : null;

  /** The card after (or else before) this one in its lane: where selection goes when it leaves. */
  const neighbour = (id: string): string | null => {
    const lane = lanes.find((l) => l.some((i) => i.id === id));
    if (!lane) return null;
    const at = lane.findIndex((i) => i.id === id);
    return (lane[at + 1] ?? lane[at - 1])?.id ?? null;
  };

  const focusTile = (id: string | null, preferQty: boolean, scroll = true) => {
    if (!id) return;
    requestAnimationFrame(() => {
      const tile = document.querySelector<HTMLElement>(`[${TILE_ATTR}="${id}"]`);
      if (!tile) return;
      if (scroll) tile.scrollIntoView({ block: "nearest" });
      const qty = tile.querySelector<HTMLInputElement>(`[${QTY_ATTR}]:not(:disabled)`);
      const target = (preferQty && qty) || tile.querySelector<HTMLElement>("button:not(:disabled)");
      target?.focus({ preventScroll: true });
    });
  };

  /** Select a card. One that can't be saved as it stands opens its drawer;
   *  any other gets the focus (its quantity when asked). */
  const land = (id: string | null, preferQty: boolean, scroll = true) => {
    if (id !== shut.current) shut.current = null;
    setSelectedId(id);
    const item = id ? find(id) : undefined;
    if (item && needsDrawer(item)) setOpenId(item.id);
    else focusTile(id, preferQty, scroll);
  };

  /** Enter in a quantity or price: the card saved, on to the next one down
   *  the column (its drawer, when it can't be saved as it stands). */
  const nextQty = (id: string) => {
    const lane = lanes[REVIEW_LANE];
    const at = lane.findIndex((i) => i.id === id);
    land(lane[at + 1]?.id ?? null, true);
  };

  /** Yes clicked: exactly Enter in the quantity (Jason, 2026-10-28), the
   *  next card selected and its quantity focused, but nothing scrolls out
   *  from under the pointer. */
  const yesClicked = (id: string) => {
    const lane = lanes[REVIEW_LANE];
    const next = lane[lane.findIndex((i) => i.id === id) + 1]?.id ?? null;
    intake.actions.confirm(id);
    land(next, true, false);
  };

  /** Enter in a price: that price kept, the card saved, on to the next. */
  const savePriced = (id: string, priceCents: number | null) => {
    const item = find(id);
    sim.actions.setDetails(id, { priceCents });
    sim.actions.confirm(id);
    if (item?.stage === "review" && item.match.cardId) write([{ ...item, details: { ...item.details, priceCents } }]);
    nextQty(id);
  };

  // The card whose drawer was just closed: focus coming back to it must not
  // open the drawer again.
  const shut = useRef<string | null>(null);
  const closeDrawer = () => {
    shut.current = openId;
    setOpenId(null);
  };

  // --- Keys, on the selected card. The handler reads this render's state
  // through a ref, so the listener is added once.
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    const inPrice = !!target?.closest?.(`[${PRICE_ATTR}]`);
    const inQty = inPrice || !!target?.closest?.(`[${QTY_ATTR}]`);
    if (!inQty && target?.closest?.('input, textarea, select, [contenteditable="true"], [role="combobox"]')) return;
    // The arrows step through a lane like j and k, once a card is selected.
    const arrow = e.key === "ArrowDown" ? "j" : e.key === "ArrowUp" ? "k" : null;
    if (arrow && !selected) return;
    if (inQty && !arrow && (e.key.length !== 1 || /[\d.]/.test(e.key))) return;
    const key = arrow ?? e.key;
    const move = (to: string | null) => {
      if (!to) return;
      e.preventDefault();
      land(to, inQty);
    };
    if (key === "j" || key === "k" || key === "h" || key === "l") {
      if (!selected) {
        move(lanes[REVIEW_LANE][0]?.id ?? lanes.find((l) => l.length)?.[0]?.id ?? null);
        return;
      }
      const laneAt = lanes.findIndex((l) => l.some((i) => i.id === selected.id));
      const lane = lanes[laneAt];
      const at = lane.findIndex((i) => i.id === selected.id);
      if (key === "j") move(lane[at + 1]?.id ?? null);
      if (key === "k") move(lane[at - 1]?.id ?? null);
      if (key === "h" || key === "l") {
        const step = key === "h" ? -1 : 1;
        for (let n = laneAt + step; n >= 0 && n < lanes.length; n += step) {
          if (lanes[n].length) {
            move(lanes[n][Math.min(at, lanes[n].length - 1)].id);
            break;
          }
        }
      }
      return;
    }
    if (key === "Escape" && selected && !open) {
      setSelectedId(null);
      return;
    }
    if (!selected) return;
    if (key === "y" && inPrice) {
      // y in a price keeps what was typed there, like Enter.
      e.preventDefault();
      const typed = (target as HTMLInputElement).value;
      if (selected.stage === "review" && selected.match.cardId) savePriced(selected.id, typed ? Math.round(Number(typed) * 100) : null);
      return;
    }
    if (key === "y") {
      e.preventDefault();
      if (selected.stage !== "review" || !selected.match.cardId) return;
      const next = neighbour(selected.id);
      // y in a quantity saves the number typed there.
      const typed = inQty ? Number.parseInt((target as HTMLInputElement).value, 10) : NaN;
      if (Number.isFinite(typed)) intake.actions.setQty(selected.id, typed);
      else intake.actions.confirm(selected.id);
      land(next, inQty);
      return;
    }
    if (key === "o") {
      e.preventDefault();
      setOpenId(selected.id);
      return;
    }
    if (key === "p") {
      e.preventDefault();
      document.querySelector<HTMLInputElement>(`[${PRICE_ATTR}="${selected.id}"]:not(:disabled)`)?.focus();
      return;
    }
    const tool = FIX_TOOLS.find((t) => t.key === key);
    if (tool) {
      e.preventDefault();
      // Reject and unpair take the card out of its lane: selection moves on.
      if (key === "x" || key === "X" || key === "u" || key === "d") setSelectedId(neighbour(selected.id));
      tool.run(intake, selected);
    }
  };
  const keyRef = useRef(onKey);
  useEffect(() => {
    keyRef.current = onKey;
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const kind = side === "inventory" ? "box" : "binder";

  return (
    <div data-motion="high" className="space-y-4">
      <div className="flex flex-wrap items-end gap-4 rounded-lg border border-panel-rule bg-panel p-4 shadow-offset">
        <HomeSelect
          value={homeId}
          homes={homes}
          label={side === "inventory" ? "Put them in this box" : "Put them in this binder"}
          onChange={(id) => setSetup({ ...setup, homeId: id })}
        />
        <SetButton
          open={panel === "set"}
          onOpenChange={(o) => setPanel(o ? "set" : null)}
          onPick={(pick) => {
            setSetPick(pick);
            const variant = pick?.variant ?? null;
            const price = variant ? (setup.commonPrices[variant] ?? null) : null;
            setSetup({ ...setup, variant, defaults: { ...setup.defaults, priceCents: price } });
          }}
        />
        <NeonButton
          variant="secondary"
          outline
          aria-expanded={panel === "defaults"}
          aria-controls="intake-defaults-panel"
          onClick={() => setPanel(panel === "defaults" ? null : "defaults")}
        >
          Defaults: {setup.defaults.condition}
          {setup.defaults.grading ? `, ${setup.defaults.grading.grader}` : ""}
        </NeonButton>
        <div className="ml-auto min-w-[18rem] flex-1">
          <StageCounters sim={sim} compact />
        </div>
        {panel === "defaults" && (
          <div id="intake-defaults-panel" className="w-full space-y-3 border-t border-rule pt-3">
            {kind === "box" && <CommonPrice setup={setup} onChange={setSetup} />}
            <DetailsFields
              kind={kind}
              value={setup.defaults}
              onChange={(patch) => setSetup({ ...setup, defaults: { ...setup.defaults, ...patch } })}
            />
          </div>
        )}
      </div>

      <AddSources sim={intake} />

      <details className="rounded-md border border-rule px-3 py-2 text-sm text-ink-2">
        <summary className={`cursor-pointer rounded-sm text-ink ${RING}`}>Keyboard shortcuts</summary>
        <p className="mt-2 text-xs text-ink-3">Click or tab to a card to select it (it turns green), then:</p>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs sm:grid-cols-[auto_1fr_auto_1fr]">
          {KEY_HELP.map((k) => (
            <div key={k.keys} className="contents">
              <dt>
                <kbd className="font-mono text-ink">{k.keys}</kbd>
              </dt>
              <dd className="m-0">{k.does}</dd>
            </div>
          ))}
        </dl>
      </details>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[repeat(3,minmax(0,0.8fr))_minmax(0,1.5fr)_minmax(0,0.9fr)]">
        {LANES.map((lane, n) => {
          const items = lanes[n];
          const isReview = n === REVIEW_LANE;
          return (
            <section
              key={lane.label}
              aria-label={`${lane.label}, ${items.length}`}
              className={`flex min-h-[16rem] flex-col rounded-lg border p-2 ${isReview ? "border-notice-warn-rule bg-notice-warn-bg/40" : "border-rule bg-raised"}`}
            >
              <header className="mb-2 flex items-center justify-between px-1">
                <h2 className="m-0 text-sm font-semibold text-ink">{lane.label}</h2>
                <span className="text-sm font-bold tabular-nums text-ink-2">{items.length}</span>
              </header>
              {isReview && (
                // Always there, so the cards below it never shift when it would appear.
                <NeonButton
                  size="1"
                  variant="primary"
                  className="mb-2"
                  disabled={sim.counts.matched === 0}
                  onClick={intake.actions.saveAllConfident}
                >
                  Save {sim.counts.matched} matched
                </NeonButton>
              )}
              <ul className={`m-0 list-none space-y-2 overflow-auto p-0 ${isReview ? "" : "max-h-[34rem]"}`}>
                {items.map((i) => (
                  <li
                    key={`${i.id}-${i.stage}`}
                    {...{ [TILE_ATTR]: i.id }}
                    onFocusCapture={() => {
                      setSelectedId(i.id);
                      if (!open && needsDrawer(i) && shut.current !== i.id) setOpenId(i.id);
                    }}
                    onClick={(e) => {
                      if (needsDrawer(i)) {
                        setSelectedId(i.id);
                        if (!(e.target as HTMLElement).closest("button, input, select, a, label")) setOpenId(i.id);
                        return;
                      }
                      setSelectedId(i.id);
                      // A click on a waiting card (not on one of its controls)
                      // puts the caret in its quantity, number selected, so
                      // typing replaces it (Jason, 2026-10-28).
                      if (isReview && !(e.target as HTMLElement).closest("button, input, select, a, label")) {
                        e.currentTarget.querySelector<HTMLInputElement>(`[${QTY_ATTR}]:not(:disabled)`)?.focus();
                      }
                    }}
                    className={i.stage === "saved" ? "intake-arrive intake-saved rounded-md" : "intake-arrive"}
                  >
                    {isReview ? (
                      <ReviewTile
                        item={i}
                        sim={intake}
                        selected={i.id === selectedId}
                        onOpen={() => setOpenId(i.id)}
                        onYes={() => yesClicked(i.id)}
                        onEnter={() => nextQty(i.id)}
                        onPriceEnter={(cents) => savePriced(i.id, cents)}
                        defaults={setup.defaults}
                      />
                    ) : (
                      <MiniTile item={i} selected={i.id === selectedId} />
                    )}
                  </li>
                ))}
              </ul>
              {lane.stages.includes("pairing") && (
                <div className="mt-2">
                  <LoosePile sim={intake} dense />
                </div>
              )}
            </section>
          );
        })}
      </div>

      {open && (
        <Overlay labelledBy="intake-drawer-title" onClose={closeDrawer}>
          <Drawer
            item={open}
            sim={intake}
            setup={setup}
            homes={homes}
            kind={kind}
            onClose={closeDrawer}
          />
        </Overlay>
      )}
    </div>
  );
}

/** The border every tile shares: green when selected, else pink (no match) or orange (check it). */
function edge(item: Item, selected: boolean): string {
  if (selected) return "border-neon-green-text";
  if (item.stage !== "review") return "border-rule";
  const band = bandOf(item);
  return band === "none" ? "border-neon-pink-text" : band === "check" ? "border-notice-warn-rule" : "border-rule";
}

function MiniTile({ item, selected }: { item: Item; selected: boolean }) {
  const title = item.stage === "saved" ? cardTitle(item.match.cardId) : (item.read.player ?? "Reading…");
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={`flex w-full items-center gap-2 rounded-md border-2 bg-surface p-1.5 text-left ${edge(item, selected)} ${RING}`}
    >
      <ScanImage item={item} side="front" size="sm" />
      <span className="min-w-0 text-xs">
        <span className="block truncate font-medium text-ink-2">{title}</span>
        <span className="block text-ink-3">
          {item.stage === "saved"
            ? `qty ${item.qty}`
            : item.read.number
              ? `#${item.read.number}`
              : item.front.file}
        </span>
      </span>
    </button>
  );
}

/**
 * A card waiting for you. Clicking it (anywhere but a control) puts the
 * caret in its quantity. Its first line is the scans beside the title, a
 * fixed height; its second line starts with Yes. So the top card's Yes is
 * always in the same spot, and the next card slides up under the pointer.
 */
function ReviewTile({
  item,
  sim,
  selected,
  onOpen,
  onYes,
  onEnter,
  onPriceEnter,
  defaults,
}: {
  item: Item;
  sim: IntakeSim;
  selected: boolean;
  onOpen: () => void;
  onYes: () => void;
  onEnter: () => void;
  onPriceEnter: (priceCents: number | null) => void;
  defaults: Details;
}) {
  return (
    <div className={`rounded-md border-2 bg-surface p-2 ${edge(item, selected)}`}>
      <div className="flex gap-2">
        <div className="flex shrink-0 gap-1">
          <ScanImage item={item} side="front" size="sm" />
          <ScanImage item={item} side="back" size="sm" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="m-0 truncate text-sm font-semibold text-ink">{cardTitle(item.match.cardId)}</p>
          <BandBadge item={item} />
          {item.match.reason && <p className="m-0 line-clamp-3 text-xs text-ink-3">{item.match.reason}</p>}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <NeonButton
          size="1"
          variant="primary"
          disabled={!item.match.cardId}
          onClick={(e) => {
            // The card's own click would select the card just saved.
            e.stopPropagation();
            onYes();
          }}
          aria-keyshortcuts="y"
        >
          Yes
        </NeonButton>
        <NeonButton size="1" variant="secondary" outline onClick={onOpen} aria-keyshortcuts="o">
          Review
        </NeonButton>
        <QtyField item={item} sim={sim} onEnter={onEnter} />
        <PriceField item={item} sim={sim} defaults={defaults} onEnter={onPriceEnter} />
      </div>
    </div>
  );
}

function Drawer({
  item,
  sim,
  setup,
  homes,
  kind,
  onClose,
}: {
  item: Item;
  sim: IntakeSim;
  setup: Setup;
  homes: { id: string; name: string }[];
  kind: "binder" | "box";
  onClose: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const details = effectiveDetails(item, setup.defaults);
  return (
    <div className="space-y-4 p-5">
      <div className="flex items-start justify-between gap-2">
        <h2 id="intake-drawer-title" tabIndex={-1} className="m-0 text-xl font-bold text-ink">
          {cardTitle(item.match.cardId)}
        </h2>
        <NeonButton size="1" variant="secondary" outline onClick={onClose}>
          Close
        </NeonButton>
      </div>
      <BandBadge item={item} />
      <div className="flex gap-3">
        <ScanImage item={item} side="front" size="lg" />
        <ScanImage item={item} side="back" size="lg" />
      </div>
      <NeedsYou item={item} sim={sim} onPick={() => setPicking(true)} />
      {picking ? (
        <CardPicker item={item} sim={sim} onDone={() => setPicking(false)} />
      ) : (
        <button type="button" onClick={() => setPicking(true)} className={`text-sm text-neon-blue-text underline ${RING}`}>
          Wrong card? Find it
        </button>
      )}
      <FixTools item={item} sim={sim} showKeys />
      <HomeSelect
        value={item.homeId}
        homes={homes}
        label="This card goes in"
        onChange={(id) => sim.actions.moveHome(item.id, id)}
      />
      <DetailsFields kind={kind} value={details} onChange={(p) => sim.actions.setDetails(item.id, p)} dense />
      <div className="flex flex-wrap items-center gap-3 border-t border-rule pt-3">
        <QtyField item={item} sim={sim} onEnter={onClose} />
        <NeonButton
          variant="primary"
          disabled={!item.match.cardId || item.stage !== "review"}
          onClick={() => {
            sim.actions.confirm(item.id);
            onClose();
          }}
        >
          Save this card
        </NeonButton>
      </div>
    </div>
  );
}

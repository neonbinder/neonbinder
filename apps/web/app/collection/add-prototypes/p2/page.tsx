import { useState } from "react";
import NeonButton from "@/components/modules/NeonButton";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import Overlay from "../../prototypes/p1/Overlay";
import LoosePile from "../_shared/loose";
import {
  STAGE_LABEL,
  bandOf,
  cardTitle,
  useIntakeSim,
  type IntakeSim,
  type Item,
  type Stage,
} from "../_shared/sim";
import {
  AddSources,
  BandBadge,
  CardPicker,
  CommonPrice,
  DetailsFields,
  FixTools,
  HomeSelect,
  IntakeBanner,
  KindToggle,
  NeedsYou,
  QtyField,
  RING,
  ScanImage,
  StageCounters,
  VariantSelect,
  effectiveDetails,
  homeName,
  homesFor,
  initialSetup,
  type Setup,
} from "../_shared/ui";
import PublicFrame from "../_shared/PublicFrame";
import "../_shared/intake.css";

/**
 * NEO-369 — add-cards prototype 2, "Mission Control".
 *
 * One screen, the full width, lots of motion. The setup is a control bar
 * across the top that stays editable the whole run (no wizard). Below it,
 * one lane per stage, and every card visibly travels left to right as the
 * pipeline works on it. Clicking a card in "Needs you" opens it in a drawer.
 */

const LANES: { stages: Stage[]; label: string }[] = [
  { stages: ["uploading", "reading"], label: STAGE_LABEL.reading },
  { stages: ["pairing"], label: STAGE_LABEL.pairing },
  { stages: ["matching"], label: STAGE_LABEL.matching },
  { stages: ["review"], label: STAGE_LABEL.review },
  { stages: ["saved"], label: STAGE_LABEL.saved },
];

export default function AddCardsPrototype2() {
  useDocumentTitle("Mission Control · Add cards prototype");
  const [setup, setSetup] = useState<Setup>(initialSetup("binder"));
  const [showDefaults, setShowDefaults] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const sim = useIntakeSim({
    setChosen: setup.variant !== null,
    homeId: setup.homeId,
  });
  const open = sim.items.find((i) => i.id === openId) ?? null;

  return (
    <PublicFrame>
      <div data-motion="high">
        <IntakeBanner current={2} note="one screen, full width, high motion" />
        <div className="mb-4 flex flex-wrap items-end gap-4 rounded-lg border border-panel-rule bg-panel p-4 shadow-offset">
          <div className="space-y-1">
            <p className="m-0 text-xs font-semibold text-ink-2">Adding to</p>
            <KindToggle setup={setup} onChange={setSetup} />
          </div>
          <HomeSelect setup={setup} onChange={setSetup} />
          <VariantSelect setup={setup} onChange={setSetup} />
          <NeonButton
            variant="secondary"
            outline
            aria-expanded={showDefaults}
            onClick={() => setShowDefaults((s) => !s)}
          >
            Defaults: {setup.defaults.condition}
            {setup.defaults.grading ? `, ${setup.defaults.grading.grader}` : ""}
          </NeonButton>
          <div className="ml-auto min-w-[18rem] flex-1">
            <StageCounters sim={sim} compact />
          </div>
          {showDefaults && (
            <div className="w-full space-y-3 border-t border-rule pt-3">
              <CommonPrice setup={setup} onChange={setSetup} />
              <DetailsFields
                kind={setup.kind}
                value={setup.defaults}
                onChange={(patch) =>
                  setSetup({
                    ...setup,
                    defaults: { ...setup.defaults, ...patch },
                  })
                }
              />
            </div>
          )}
        </div>

        <AddSources sim={sim} />

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[repeat(3,minmax(0,0.8fr))_minmax(0,1.5fr)_minmax(0,0.9fr)]">
          {LANES.map((lane) => {
            const items = sim.items.filter((i) =>
              lane.stages.includes(i.stage),
            );
            const isReview = lane.stages[0] === "review";
            return (
              <section
                key={lane.label}
                aria-label={`${lane.label}, ${items.length}`}
                className={`flex min-h-[16rem] flex-col rounded-lg border p-2 ${isReview ? "border-notice-warn-rule bg-notice-warn-bg/40" : "border-rule bg-raised"}`}
              >
                <header className="mb-2 flex items-center justify-between px-1">
                  <h3 className="m-0 text-sm font-semibold text-ink">
                    {lane.label}
                  </h3>
                  <span className="text-sm font-bold tabular-nums text-ink-2">
                    {items.length}
                  </span>
                </header>
                {isReview && sim.counts.matched > 0 && (
                  <NeonButton
                    size="1"
                    variant="primary"
                    className="mb-2"
                    onClick={sim.actions.saveAllConfident}
                  >
                    Save {sim.counts.matched} matched
                  </NeonButton>
                )}
                <ul
                  className={`m-0 list-none space-y-2 overflow-auto p-0 ${isReview ? "" : "max-h-[34rem]"}`}
                >
                  {items.map((i) => (
                    <li
                      key={`${i.id}-${i.stage}`}
                      className={
                        i.stage === "saved"
                          ? "intake-arrive intake-saved rounded-md"
                          : "intake-arrive"
                      }
                    >
                      {isReview ? (
                        <ReviewTile
                          item={i}
                          sim={sim}
                          onOpen={() => setOpenId(i.id)}
                        />
                      ) : (
                        <MiniTile item={i} />
                      )}
                    </li>
                  ))}
                </ul>
                {lane.stages.includes("pairing") && (
                  <div className="mt-2">
                    <LoosePile sim={sim} dense />
                  </div>
                )}
              </section>
            );
          })}
        </div>

        {open && (
          <Overlay labelledBy="p2-drawer-title" onClose={() => setOpenId(null)}>
            <Drawer
              item={open}
              sim={sim}
              setup={setup}
              onClose={() => setOpenId(null)}
            />
          </Overlay>
        )}
      </div>
    </PublicFrame>
  );
}

function MiniTile({ item }: { item: Item }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-rule bg-surface p-1.5">
      <ScanImage item={item} side="front" size="sm" />
      <div className="min-w-0 text-xs">
        <p className="m-0 truncate font-medium text-ink-2">
          {item.stage === "saved"
            ? cardTitle(item.match.cardId)
            : (item.read.player ?? "Reading…")}
        </p>
        {item.stage === "saved" ? (
          <p className="m-0 text-ink-3">qty {item.qty}</p>
        ) : (
          <p className="m-0 text-ink-3">
            {item.read.number ? `#${item.read.number}` : item.front.file}
          </p>
        )}
      </div>
    </div>
  );
}

function ReviewTile({
  item,
  sim,
  onOpen,
}: {
  item: Item;
  sim: IntakeSim;
  onOpen: () => void;
}) {
  const band = bandOf(item);
  return (
    <div
      className={`rounded-md border bg-surface p-2 ${
        band === "none"
          ? "border-neon-pink-text"
          : band === "check"
            ? "border-notice-warn-rule"
            : "border-rule"
      }`}
    >
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onOpen}
          className={`flex shrink-0 gap-1 rounded-md ${RING}`}
          aria-label={`Open ${cardTitle(item.match.cardId)}`}
        >
          <ScanImage item={item} side="front" size="sm" />
          <ScanImage item={item} side="back" size="sm" />
        </button>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="m-0 text-sm font-semibold text-ink">
            {cardTitle(item.match.cardId)}
          </p>
          <BandBadge item={item} />
          {item.match.reason && (
            <p className="m-0 text-xs text-ink-3">{item.match.reason}</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <QtyField item={item} sim={sim} />
            <NeonButton
              size="1"
              variant="primary"
              disabled={!item.match.cardId}
              onClick={() => sim.actions.confirm(item.id)}
            >
              Yes
            </NeonButton>
            <NeonButton size="1" variant="secondary" outline onClick={onOpen}>
              Review
            </NeonButton>
          </div>
        </div>
      </div>
    </div>
  );
}

function Drawer({
  item,
  sim,
  setup,
  onClose,
}: {
  item: Item;
  sim: IntakeSim;
  setup: Setup;
  onClose: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const details = effectiveDetails(item, setup.defaults);
  return (
    <div className="space-y-4 p-5">
      <div className="flex items-start justify-between gap-2">
        <h3
          id="p2-drawer-title"
          tabIndex={-1}
          className="m-0 text-xl font-bold text-ink"
        >
          {cardTitle(item.match.cardId)}
        </h3>
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
        <button
          type="button"
          onClick={() => setPicking(true)}
          className={`text-sm text-neon-blue-text underline ${RING}`}
        >
          Wrong card? Find it
        </button>
      )}
      <FixTools item={item} sim={sim} />
      <label className="flex items-center gap-2 text-xs text-ink-3">
        Put in
        <select
          className={`rounded-md border border-field-rule bg-field px-2 py-1 text-sm text-ink ${RING}`}
          value={item.homeId}
          onChange={(e) => sim.actions.moveHome(item.id, e.target.value)}
        >
          {homesFor(setup.kind).map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
        <span>(run default: {homeName(setup.homeId)})</span>
      </label>
      <DetailsFields
        kind={setup.kind}
        value={details}
        onChange={(p) => sim.actions.setDetails(item.id, p)}
        dense
      />
      <div className="flex flex-wrap items-center gap-3 border-t border-rule pt-3">
        <QtyField item={item} sim={sim} />
        <NeonButton
          variant="primary"
          disabled={!item.match.cardId}
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
